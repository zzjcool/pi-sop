/**
 * `/sop init` — the interactive initialization wizard.
 *
 * Design: docs/init-design.md §3
 *
 * Flow:
 *   step 0  probe + short-circuit (disabled / ready → status panel)
 *   step 1  main menu: clone / create / link / disable
 *   step 2+ branch-specific work
 *   finish  first pull (best-effort) → write config → notify → `await ctx.reload()`
 *
 * Hard rules:
 *   - never overwrite existing files (clone target, skeleton repair are additive)
 *   - in non-TUI modes (`print`/`json`/`rpc`) the wizard never prompts: it
 *     requires `--clone/--local/--link/--disable` and fails loudly otherwise
 *   - the wizard runs from a command handler, so `ctx.reload()` is available
 *     (it is NOT available from tools / event handlers)
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	defaultLibDir,
	expandHome,
	markInitialized,
	readConfig,
	resolveLibDir,
	writeConfig,
} from "../lib/config.ts";
import { describeState, probeLibrary, type ProbeResult } from "../lib/probe.ts";
import { refreshManifest, scaffoldLibrary } from "../lib/scaffold.ts";
import { mostRecentVerification, scanSopDir } from "../lib/sop.ts";
import {
	MAX_REMOTE_RETRIES,
	checkRemote,
	formatRemoteError,
	summarizeRemoteError,
} from "../lib/remote.ts";
import {
	clone,
	countUnpushed,
	firstLine,
	git,
	hasGhCli,
	initRepo,
	pullLibrary,
	pushLibrary,
	addRemote,
	resetSyncThrottle,
} from "../lib/sync.ts";

/** ------------------------------------------------------------------ */
/** Options parsed from `/sop init ...`                                  */
/** ------------------------------------------------------------------ */

export interface InitArgs {
	mode: "wizard" | "clone" | "local" | "link" | "disable";
	value?: string;
	error?: string;
}

const MENU_CLONE = "1. 克隆已有的 SOP 库（多机：远端已有仓库）";
const MENU_CREATE = "2. 全新创建一个 SOP 库（第一台机器）";
const MENU_LINK = "3. 关联本机已有目录（已手动 clone 过，或自定义路径）";
const MENU_DISABLE = "4. 暂不使用 pi-sop（禁用，扩展静默）";

export function parseInitArgs(raw: string): InitArgs {
	const tokens = tokenize(raw);
	if (tokens.length === 0) return { mode: "wizard" };

	const first = tokens[0];
	const rest = tokens.slice(1);
	switch (first) {
		case "--disable":
			return { mode: "disable" };
		case "--clone":
			if (!rest[0]) return { mode: "clone", error: "--clone 需要一个远端地址，例如 /sop init --clone git@github.com:you/sop-library.git" };
			return { mode: "clone", value: rest[0] };
		case "--local":
			return { mode: "local", value: rest[0] };
		case "--link":
			if (!rest[0]) return { mode: "link", error: "--link 需要一个已有目录路径，例如 /sop init --link ~/sop-library" };
			return { mode: "link", value: rest[0] };
		case "help":
		case "--help":
			return { mode: "wizard", value: "help" };
		default:
			return { mode: "wizard", error: `未知参数：${first}` };
	}
}

/** Split a command string, keeping quoted segments intact. */
function tokenize(raw: string): string[] {
	const tokens: string[] = [];
	const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(raw)) !== null) {
		tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return tokens;
}

/** ------------------------------------------------------------------ */
/** Entry point                                                          */
/** ------------------------------------------------------------------ */

export async function runInit(args: InitArgs, ctx: ExtensionCommandContext): Promise<void> {
	const interactive = ctx.mode === "tui" && ctx.hasUI;

	if (args.error) {
		ctx.ui.notify(`pi-sop: ${args.error}`, "error");
		if (!interactive) return;
	}
	if (args.value === "help" && args.mode === "wizard") {
		printHelp(ctx);
		return;
	}

	switch (args.mode) {
		case "disable":
			await disable(ctx);
			return;
		case "clone":
			await nonInteractive(ctx, () => cloneFlow(args.value as string, ctx));
			return;
		case "local":
			await nonInteractive(ctx, () => createFlow(args.value, ctx, { interactive: false }));
			return;
		case "link":
			await nonInteractive(ctx, () => linkFlow(args.value as string, ctx, { interactive: false }));
			return;
		case "wizard":
			break;
	}

	// Wizard mode needs a real user.
	if (!interactive) {
		await printStatus(ctx);
		ctx.ui.notify(
			"pi-sop: 非交互模式需要显式参数：--clone <url> / --local [path] / --link <path> / --disable",
			"warning",
		);
		return;
	}

	await wizard(ctx);
}

/**
 * In non-interactive modes, any decision that would need a prompt fails loudly
 * with the reason instead of guessing (design §3.5).
 */
async function nonInteractive(ctx: ExtensionCommandContext, run: () => Promise<void>): Promise<void> {
	try {
		await run();
	} catch (error) {
		ctx.ui.notify(`pi-sop: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

/** ------------------------------------------------------------------ */
/** Wizard                                                               */
/** ------------------------------------------------------------------ */

async function wizard(ctx: ExtensionCommandContext): Promise<void> {
	const config = readConfig();

	// step 0a: explicit disable is a sticky state the user opted into.
	if (config.enabled === false) {
		const reenable = await ctx.ui.confirm("pi-sop 已禁用", "重新启用 pi-sop？");
		if (!reenable) {
			ctx.ui.notify("pi-sop 仍处于禁用状态", "info");
			return;
		}
		writeConfig({ enabled: true });
	}

	const probe = probeLibrary(resolveTarget());

	// step 0b: usable library → jump straight to the status panel.
	if (probe.state === "ready" || probe.state === "no-remote" || probe.state === "malformed") {
		await statusPanel(probe, ctx);
		return;
	}

	if (probe.state === "not-a-repo") {
		const adopt = await ctx.ui.confirm(
			"该目录不是 git 仓库",
			`${probe.dir}\n\n初始化为 git 仓库并补齐 SOP 库骨架？`,
		);
		if (!adopt) {
			ctx.ui.notify("pi-sop: 初始化已取消", "info");
			return;
		}
		await scaffoldAndFinish(probe.dir, ctx, { remote: undefined, interactive: true });
		return;
	}

	// step 1: main menu
	const choice = await ctx.ui.select(menuTitle(probe), [MENU_CLONE, MENU_CREATE, MENU_LINK, MENU_DISABLE]);
	if (choice === undefined) {
		ctx.ui.notify("pi-sop: 初始化已取消", "info");
		return;
	}
	if (choice === MENU_CLONE) return cloneFlow(undefined, ctx);
	if (choice === MENU_CREATE) return createFlow(undefined, ctx, { interactive: true });
	if (choice === MENU_LINK) return linkFlow(undefined, ctx, { interactive: true });
	return disable(ctx);
}

/**
 * The library path the wizard should operate on.
 *
 * Delegates to the single resolver so the wizard can never disagree with
 * `session_start` / `sop_save` about precedence (design §1.1:
 * env PI_SOP_DIR > config libDir > ~/sop-library).
 */
function resolveTarget(): string {
	return resolveLibDir().dir;
}

function menuTitle(probe: ProbeResult): string {
	return `SOP 库初始化（当前: ${probe.dir} — ${describeState(probe)}）`;
}

/** ------------------------------------------------------------------ */
/** Branch 1: clone an existing library                                  */
/** ------------------------------------------------------------------ */

export async function cloneFlow(initialUrl: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	const interactive = ctx.mode === "tui" && ctx.hasUI;
	const targetDir = resolveTarget();
	assertCloneTargetUsable(targetDir);

	let url = initialUrl;
	let attempts = 0;
	for (;;) {
		if (!url) {
			if (!interactive) throw new Error("--clone 需要一个远端地址");
			const answer = await ctx.ui.input("远端地址", "git@github.com:you/sop-library.git");
			if (answer === undefined) {
				ctx.ui.notify("pi-sop: 初始化已取消", "info");
				return;
			}
			url = answer.trim();
			if (!url) {
				ctx.ui.notify("pi-sop: 远端地址不能为空", "warning");
				continue;
			}
		}

		const check = await checkRemote(url);
		if (!check.ok) {
			const reason = summarizeRemoteError(url, check.result);
			if (!interactive) throw new Error(reason);
			const next = await ctx.ui.select(`远端不可用：${reason}`, [
				"重新输入地址",
				"改用 https",
				"返回主菜单",
			]);
			if (next === "改用 https") {
				url = toHttpsUrl(url);
				continue;
			}
			if (next === "返回主菜单") return wizard(ctx);
			if (attempts++ >= MAX_REMOTE_RETRIES) {
				ctx.ui.notify("pi-sop: 重试次数过多，已放弃", "warning");
				return;
			}
			url = undefined;
			continue;
		}

		const cloned = await clone(url, targetDir);
		if (!cloned.ok) {
			throw new Error(`克隆失败：${formatRemoteError(cloned)}\n${firstLine(cloned.stderr)}`);
		}
		break;
	}

	const probe = probeLibrary(targetDir);
	if (!probe.hasManifest && !probe.hasSopDir) {
		const repair = !interactive
			? probe.isRepo && probe.commitCount === 0
			: await ctx.ui.confirm(
					"仓库结构不像 SOP 库",
					`${targetDir} 里没有 MANIFEST.md 也没有 sop/ 目录。\n\n补齐缺失的骨架文件？（不会覆盖已有文件）`,
				);
			if (repair) {
				await scaffoldLibrary(targetDir, { init: false, commit: true, now: new Date() });
		} else if (!interactive) {
			throw new Error("克隆下来的仓库缺少 SOP 库结构（无 MANIFEST.md 也无 sop/）");
		}
	}

	await finish(targetDir, ctx, { interactive });
}

/**
 * Refuse to clone into a directory that exists with content — the design
 * explicitly forbids overwriting anything (design §3.2 branch 1, detail 1).
 */
function assertCloneTargetUsable(dir: string): void {
	if (!existsSync(dir)) return;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (error) {
		throw new Error(`无法读取目标路径 ${dir}：${error instanceof Error ? error.message : String(error)}`);
	}
	if (entries.length > 0) {
		throw new Error(`目标路径已存在且非空，拒绝覆盖：${dir}（请先移走或改用 --link）`);
	}
}

function toHttpsUrl(url: string): string {
	const ssh = /^git@([^:]+):(.+?)(\.git)?$/.exec(url);
	if (ssh) return `https://${ssh[1]}/${ssh[2]}${ssh[3] ?? ""}`;
	return url;
}

/** ------------------------------------------------------------------ */
/** Branch 2: create a brand new library                                 */
/** ------------------------------------------------------------------ */

export async function createFlow(
	initialPath: string | undefined,
	ctx: ExtensionCommandContext,
	options: { interactive: boolean },
): Promise<void> {
	// Default to the resolved target so `--local` honors PI_SOP_DIR and any
	// previously configured libDir instead of always landing on ~/sop-library.
	const defaultDir = resolveTarget();
	let dir = initialPath ? resolve(expandHome(initialPath)) : defaultDir;
	if (options.interactive && !initialPath) {
		const location = await ctx.ui.select("库位置", [
			`a. 默认 ${defaultDir}`,
			"b. 自定义路径",
		]);
		if (location === undefined) {
			ctx.ui.notify("pi-sop: 初始化已取消", "info");
			return;
		}
		if (location.startsWith("b.")) {
			const typed = await ctx.ui.input("绝对路径", defaultDir);
			if (typed === undefined) {
				ctx.ui.notify("pi-sop: 初始化已取消", "info");
				return;
			}
			dir = resolve(expandHome(typed.trim() || defaultDir));
		}
	}

	if (!isAbsolute(dir)) throw new Error(`库路径必须是绝对路径：${dir}`);
	assertCreatable(dir);

	await scaffoldAndFinish(dir, ctx, { remote: undefined, interactive: options.interactive });
}

/** The target must be absent or an empty directory (design §3.2 branch 2 detail). */
function assertCreatable(dir: string): void {
	if (!existsSync(dir)) return;
	const stat = statSync(dir);
	if (!stat.isDirectory()) throw new Error(`目标路径已被文件占用：${dir}`);
	const entries = readdirSync(dir);
	if (entries.length > 0) {
		// An existing library is a "link", not a "create".
		const probe = probeLibrary(dir);
		if (probe.state !== "empty-dir") {
			throw new Error(
				`目标目录已存在且非空：${dir}（当前 ${describeState(probe)}）。如需使用请用 --link，或换个路径`,
			);
		}
	}
}

/**
 * Scaffold `dir`, optionally wire a remote, then finish.
 * Shared by the "not-a-repo" repair path, branch 2 and `--local`.
 */
async function scaffoldAndFinish(
	dir: string,
	ctx: ExtensionCommandContext,
	options: { remote: string | undefined; interactive: boolean },
): Promise<void> {
	const scaffolded = await scaffoldLibrary(dir, { now: new Date() });
	if (!scaffolded.initializedRepo && !existsSync(resolve(dir, ".git"))) {
		const init = await initRepo(dir);
		if (!init.ok) throw new Error(`git init 失败：${firstLine(init.stderr)}`);
	}

	let remote = options.remote ?? "";
	if (!remote && options.interactive) {
		remote = await promptForRemote(dir, ctx);
	}

	if (remote) {
		const added = await addRemote(dir, remote);
		if (!added.ok) throw new Error(`配置远端失败：${firstLine(added.stderr)}`);
		const pushed = await pushLibrary(dir, probeLibrary(dir).branch);
		if (pushed.verdict !== "ok") {
			// Push failure never fails init: the library stays local and we say so.
			ctx.ui.notify(`pi-sop: 远端已配置，但首次推送失败（${pushed.detail ?? pushed.message}）`, "warning");
		}
	} else {
		ctx.ui.notify(
			`已创建本地 SOP 库：${dir}。运行 /sop init 可随时补充远端实现多机同步。`,
			"info",
		);
	}

	await finish(dir, ctx, { interactive: options.interactive });
}

/**
 * Remote setup for a fresh library: offer `gh repo create` when the CLI is
 * present, otherwise fall back to a manual URL (design §3.2 branch 2).
 */
async function promptForRemote(dir: string, ctx: ExtensionCommandContext): Promise<string> {
	if (await hasGhCli()) {
		const useGh = await ctx.ui.confirm("检测到 GitHub CLI", "用 gh 创建私有远端仓库并推送？");
		if (useGh) {
			const name = await ctx.ui.input("仓库名", "sop-library");
			const repoName = (name ?? "sop-library").trim() || "sop-library";
			const gh = await runGh([
				"repo",
				"create",
				repoName,
				"--private",
				"--source",
				".",
				"--push",
			], dir);
			if (gh.ok) {
				const url = await git(dir, ["remote", "get-url", "origin"], 5000);
				return url.ok && url.stdout.trim() ? url.stdout.trim() : "";
			}
			ctx.ui.notify(`gh 创建仓库失败：${firstLine(gh.stderr || gh.stdout)}，改为手动输入远端`, "warning");
		}
	}
	const typed = await ctx.ui.input("远端地址（留空 = 先只用本地，之后 /sop init 可补）", "git@github.com:you/sop-library.git");
	return (typed ?? "").trim();
}

async function runGh(args: string[], cwd: string) {
	const { spawn } = await import("node:child_process");
	return new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolvePromise) => {
		const child = spawn("gh", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolvePromise({ ok: false, stdout, stderr: `${stderr}${error.message}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ ok: code === 0, stdout, stderr });
		});
	});
}

/** ------------------------------------------------------------------ */
/** Branch 3: link an existing directory                                 */
/** ------------------------------------------------------------------ */

export async function linkFlow(
	initialPath: string | undefined,
	ctx: ExtensionCommandContext,
	options: { interactive: boolean },
): Promise<void> {
	let dir = initialPath ? resolve(expandHome(initialPath)) : "";
	if (!dir) {
		const typed = await ctx.ui.input("库路径", defaultLibDir());
		if (typed === undefined) {
			ctx.ui.notify("pi-sop: 初始化已取消", "info");
			return;
		}
		dir = resolve(expandHome(typed.trim() || defaultLibDir()));
	}
	if (!isAbsolute(dir)) throw new Error(`库路径必须是绝对路径：${dir}`);

	const probe = probeLibrary(dir);
	switch (probe.state) {
		case "ready":
		case "no-remote":
			await finish(dir, ctx, { interactive: options.interactive });
			return;
		case "malformed": {
			// Design §3.5: in non-interactive mode an exception that needs a
			// decision must fail loudly, never guess. Scaffolding into someone's
			// existing repo unasked is exactly such a decision.
			if (!options.interactive) {
				throw new Error(
					`目录已是 git 仓库但缺少 SOP 库结构（无 MANIFEST.md 也无 sop/）：${dir}。交互模式下运行 /sop init 可补齐骨架`,
				);
			}
			const repair = await ctx.ui.confirm("缺少 SOP 库结构", `${dir}\n\n补齐骨架文件？（不会覆盖已有文件）`);
			if (!repair) {
				ctx.ui.notify("pi-sop: 初始化已取消", "info");
				return;
			}
			await scaffoldLibrary(dir, { init: false, commit: true, now: new Date() });
			await finish(dir, ctx, { interactive: true });
			return;
		}
		case "not-a-repo": {
			if (!options.interactive) {
				const init = await initRepo(dir);
				if (!init.ok) throw new Error(`git init 失败：${firstLine(init.stderr)}`);
				await scaffoldLibrary(dir, { init: false, commit: true, now: new Date() });
				await finish(dir, ctx, { interactive: false });
				return;
			}
			const adopt = await ctx.ui.confirm("该目录不是 git 仓库", `${dir}\n\n初始化为 git 仓库并补齐骨架？`);
			if (!adopt) {
				ctx.ui.notify("pi-sop: 初始化已取消", "info");
				return;
			}
			const init = await initRepo(dir);
			if (!init.ok) throw new Error(`git init 失败：${firstLine(init.stderr)}`);
			await scaffoldLibrary(dir, { init: false, commit: true, now: new Date() });
			await finish(dir, ctx, { interactive: true });
			return;
		}
		case "empty-dir":
		case "missing": {
			if (probe.state === "empty-dir") {
				await scaffoldAndFinish(dir, ctx, { remote: undefined, interactive: options.interactive });
				return;
			}
			// "missing" through --link is a typo, not an intent to create.
			throw new Error(`路径不存在：${dir}（如要新建请用 --local）`);
		}
	}
}

/** ------------------------------------------------------------------ */
/** Branch 4: disable                                                    */
/** ------------------------------------------------------------------ */

export async function disable(ctx: ExtensionCommandContext): Promise<void> {
	writeConfig({ enabled: false });
	ctx.ui.notify("pi-sop 已禁用，/sop init 可重新启用", "info");
}

/** ------------------------------------------------------------------ */
/** Shared finish + status panel                                         */
/** ------------------------------------------------------------------ */

interface FinishOptions {
	interactive: boolean;
}

/**
 * Convergence for every success branch (design §3.3):
 * first pull → write config → notify → reload.
 */
async function finish(dir: string, ctx: ExtensionCommandContext, _options: FinishOptions): Promise<void> {
	// 1. first sync (only when a remote exists); failure is a warning, not an error
	const probe = probeLibrary(dir);
	if (probe.isRepo && probe.remote) {
		const pull = await pullLibrary(dir);
		if (pull.verdict === "conflict") ctx.ui.notify(pull.message, "warning");
	}

	// 2. persist config
	markInitialized(dir, { enabled: true, lastSyncAt: new Date().toISOString() });
	// A user-initiated init should also clear the throttle so the next sync is real.
	resetSyncThrottle();

	// 3. notify
	const after = probeLibrary(dir);
	const { docs } = scanSopDir(dir);
	const remoteLabel = after.remote ? after.remote : "本地模式";
	ctx.ui.notify(`SOP 库就绪：${dir}（${docs.length} 个 SOP，远端: ${remoteLabel}）`, "info");

	// 4. reload so resources_discover re-runs and skillPaths take effect.
	//    Treat reload as terminal for this handler.
	await ctx.reload();
}

/** `/sop init` on a usable library lands here (design §3.4). */
async function statusPanel(probe: ProbeResult, ctx: ExtensionCommandContext): Promise<void> {
	const actions = ["立即同步", "配置远端", "重建 MANIFEST", "退出"];
	for (;;) {
		const summary = await buildStatusLines(probe);
		const choice = await ctx.ui.select(`SOP 库状态\n${summary}`, actions);
		if (choice === undefined || choice === "退出") {
			ctx.ui.notify("pi-sop: 已退出状态面板", "info");
			return;
		}
		if (choice === "立即同步") {
			if (!probe.remote) {
				ctx.ui.notify("pi-sop: 本地模式，无远端可同步（先配置远端）", "warning");
				continue;
			}
			if (!probe.gitDir) continue;
			// An explicit user action overrides the session_start throttle.
			resetSyncThrottle();
			const result = await pullLibrary(probe.dir);
			ctx.ui.notify(result.message, result.verdict === "ok" ? "info" : "warning");
			continue;
		}
		if (choice === "配置远端") {
			await configureRemote(probe, ctx);
			return;
		}
		if (choice === "重建 MANIFEST") {
			const result = await refreshManifest(probe.dir, "chore: rebuild MANIFEST", new Date());
			ctx.ui.notify(
				result.changed
					? `MANIFEST 已重建（${result.count} 个 SOP${result.committed ? "，已提交" : ""}）`
					: `MANIFEST 已是最新（${result.count} 个 SOP）`,
				"info",
			);
			continue;
		}
	}
}

async function buildStatusLines(probe: ProbeResult): Promise<string> {
	const lines = [`  路径:     ${probe.dir}`];
	const remote = probe.remote ? `${probe.remote} (${probe.branch ?? "?"})` : "无（本地模式）";
	lines.push(`  远端:     ${remote}`);
	const { docs } = scanSopDir(probe.dir);
	lines.push(`  SOP 数量: ${docs.length}`);
	if (probe.gitDir) {
		const pending = await countUnpushed(probe.dir, probe.branch);
		if (pending !== null) lines.push(`  待推送:   ${pending} 个本地提交`);
	}
	const recent = mostRecentVerification(docs);
	if (recent) lines.push(`  最近验证: ${recent.name} (${recent.date})`);
	return lines.join("\n");
}

async function configureRemote(probe: ProbeResult, ctx: ExtensionCommandContext): Promise<void> {
	const typed = await ctx.ui.input("远端地址", "git@github.com:you/sop-library.git");
	const url = (typed ?? "").trim();
	if (!url) {
		ctx.ui.notify("pi-sop: 未配置远端", "info");
		return;
	}
	const check = await checkRemote(url);
	if (!check.ok) {
		ctx.ui.notify(`pi-sop: 远端不可用 — ${summarizeRemoteError(url, check.result)}`, "error");
		return;
	}
	const added = await addRemote(probe.dir, url);
	if (!added.ok) {
		ctx.ui.notify(`pi-sop: 配置远端失败 — ${firstLine(added.stderr)}`, "error");
		return;
	}
	const pushed = await pushLibrary(probe.dir, probe.branch);
	if (pushed.verdict === "ok") {
		ctx.ui.notify(`pi-sop: 远端已配置并推送（${url}）`, "info");
	} else {
		ctx.ui.notify(`pi-sop: 远端已配置，推送失败（${pushed.detail ?? pushed.message}）`, "warning");
	}
}

/** ------------------------------------------------------------------ */
/** Read-only status + help (also used by non-interactive `/sop init`)    */
/** ------------------------------------------------------------------ */

export async function printStatus(ctx: ExtensionCommandContext): Promise<void> {
	const config = readConfig();
	const dir = resolveTarget();
	const probe = probeLibrary(dir);
	const lines = [
		`pi-sop: ${config.enabled ? "已启用" : "已禁用"}`,
		`库路径: ${dir} (${describeState(probe)})`,
	];
	if (probe.remote) lines.push(`远端: ${probe.remote} (${probe.branch ?? "?"})`);
	const { docs } = scanSopDir(dir);
	lines.push(`SOP 数量: ${docs.length}`);
	ctx.ui.notify(lines.join("\n"), "info");
}

function printHelp(ctx: ExtensionCommandContext): void {
	ctx.ui.notify(
		[
			"pi-sop 用法：",
			"  /sop init               交互式向导（TUI）",
			"  /sop init --clone <url> 克隆已有库",
			"  /sop init --local [path] 新建 local-only 库",
			"  /sop init --link <path> 关联已有目录",
			"  /sop init --disable     禁用扩展",
			"  /sop status             查看库状态",
			"  /sop sync               立即同步",
			"  /sop <关键词>           在库中检索 SOP",
		].join("\n"),
		"info",
	);
}

/** Exported for tests: URL sanitization used by the "改用 https" path. */
export { toHttpsUrl, tokenize, assertCloneTargetUsable, assertCreatable };
