/**
 * pi-sop — SOP library for pi coding agents.
 *
 * git-synced, machine-shared, agent-discoverable.
 *
 * Four capabilities (README):
 *   1. auto sync        — `session_start` best-effort `git pull --rebase`
 *   2. SOP → skills     — `resources_discover` registers `<libDir>/sop`
 *   3. write back       — `sop_save` writes a SOP, rebuilds MANIFEST, commits, pushes
 *   4. lookup           — `/sop <keyword>` greps the library for humans
 *
 * Frozen rules (README / design §0):
 *   - `session_start` NEVER blocks and never prompts: fs-only probe + one notify
 *   - every git operation is best-effort; offline degrades to a read-only local
 *     cache and never blocks a session
 *   - never force-push, never rewrite history
 */

import { join, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";

import { withFileMutationQueue, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { parseInitArgs, runInit } from "./commands/init.ts";
import {
	readConfig,
	resolveLibDir,
	writeConfig,
} from "./lib/config.ts";
import {
	describeState,
	isSaveable,
	isUsable,
	lockPathForDir,
	probeLibrary,
	type ProbeResult,
} from "./lib/probe.ts";
import {
	scaffoldLibrary,
	today,
} from "./lib/scaffold.ts";
import {
	findNameConflicts,
	findSopConflicts,
	GLOBAL_SCOPE,
	countSops,
	mostRecentVerification,
	renderManifest,
	renderSop,
	scanSopDir,
	slugifySopName,
} from "./lib/sop.ts";
import {
	existingProjectDirs,
	projectDir,
	resolveProjectKeys,
} from "./lib/project.ts";
import {
	commitAll,
	pushLibrary,
	syncLibrary,
	withLock,
} from "./lib/sync.ts";

/** Notify text (design §7, one-pass final wording). */
const NOTIFY = {
	uninitialized: "pi-sop: SOP 库未初始化，运行 /sop init 开始",
	disabledSave: "pi-sop 已禁用，请用户运行 /sop init 重新启用",
	notInitialized:
		"SOP 库未初始化。请让用户运行 /sop init，或将 PI_SOP_DIR 指向已有库。",
	conflict: "pi-sop: 同步冲突，本地修改已保留。运行 /sop init → 状态面板处理",
} as const;

/** Once-per-process flag: `resume`/`fork` must not re-notify. */
let notifiedUninitialized = false;

/** Conflict signatures already warned about in this process. */
const reportedConflicts = new Set<string>();

/** Test seam: allow re-notifying in a fresh process-like context. */
export function resetNotifyFlag(): void {
	notifiedUninitialized = false;
	reportedConflicts.clear();
}

/** ------------------------------------------------------------------ */
/** Path + state helpers                                                 */
/** ------------------------------------------------------------------ */

interface Resolved {
	dir: string;
	probe: ProbeResult;
}

function resolveState(): Resolved {
	const { dir } = resolveLibDir();
	return { dir, probe: probeLibrary(dir) };
}

/** ------------------------------------------------------------------ */
/** Extension entrypoint                                                 */
/** ------------------------------------------------------------------ */

export default function piSop(pi: ExtensionAPI): void {
	// ---------------------------------------------------------------- //
	// 1. session_start: probe + single notify + background best-effort  //
	//    sync. Never blocks, never prompts.                             //
	// ---------------------------------------------------------------- //
	pi.on("session_start", async (_event, ctx) => {
		const config = readConfig();
		if (config.enabled === false) return;

		const { dir, probe } = resolveState();
		if (isSaveable(probe.state)) {
			// Duplicate-name guard, fs-only and best-effort: `sop_save` refuses such
			// writes, but a hand-written file can still collide, and pi silently
			// drops the loser skill (first registration wins). Never prompts.
			warnOnConflicts(dir, ctx);
		}
		if (probe.state === "ready") {
			// Fire and forget: the sync has its own timeout and throttle, and
		// it must never delay the session. Errors are swallowed by design.
		// The ctx may go stale (reload/session switch) before the promise
		// settles, so guard every use of it.
		void syncLibrary(dir, { probe: { remote: probe.remote, branch: probe.branch } }).then(
			(result) => {
				if (result.verdict === "conflict") {
					try {
						ctx.ui.notify(NOTIFY.conflict, "warning");
					} catch {
						// Stale ctx after reload/session switch — nothing to do.
					}
				}
				if (result.verdict === "ok") {
					writeConfig({ lastSyncAt: new Date().toISOString() });
				}
			},
				() => {
					// Best-effort by design: never let a sync failure surface.
				},
			);
			return;
		}

		// Never initialized: one notification per process, and only when the
		// user has not already made a choice (config file absent).
		if (!notifiedUninitialized && !config.initializedAt && probe.state === "missing") {
			notifiedUninitialized = true;
			ctx.ui.notify(NOTIFY.uninitialized, "info");
			void dir;
		}
	});

	// ---------------------------------------------------------------- //
	// 2. resources_discover: register project SOPs + <libDir>/sop         //
	// ---------------------------------------------------------------- //
	pi.on("resources_discover", async (event, ctx) => {
		const config = readConfig();
		if (config.enabled === false) return {};
		const { dir, probe } = resolveState();
		// Only expose the skill path when the library can actually serve it.
		if (!isUsable(probe.state)) return {};

		// Project SOPs first: pi's loader keeps the FIRST skill registered under a
		// name and silently drops later duplicates, so the more specific
		// (project) SOP must win over a global one of the same name.
		const cwd = event?.cwd ?? ctx?.cwd;
		if (!cwd) {
			// No cwd at all (should not happen in practice): project SOPs silently
			// unavailable — leave a breadcrumb instead of a mystery.
			console.debug("pi-sop: resources_discover without cwd; project SOPs not loaded");
		}
		const paths = cwd ? existingProjectDirs(dir, cwd) : [];

		const sopPath = join(dir, "sop");
		if (existsSync(sopPath)) paths.push(sopPath);
		// A library without the global dir but with project SOPs is still usable.
		if (paths.length === 0) return {};
		return { skillPaths: paths };
	});

	// ---------------------------------------------------------------- //
	// 3. sop_save: agent writeback with an autoInit fallback             //
	// ---------------------------------------------------------------- //
	pi.registerTool({
		name: "sop_save",
		label: "Save SOP",
		description:
			"Save or update a reusable Standard Operating Procedure (SOP) in the shared pi-sop library. Use this when you discovered a repeatable workflow, a tricky fix, or project-specific quirks worth remembering across sessions and machines. The SOP becomes an auto-loaded skill for future sessions.",
		promptSnippet: "Save a reusable SOP / procedure to the shared SOP library",
		promptGuidelines: [
			"Use sop_save when you complete a non-obvious, repeatable task and the steps would help a future session (deploy steps, incident fixes, project quirks, environment gotchas).",
			"Do not use sop_save for one-off notes or for information already covered by an existing SOP — update that SOP instead by passing its name.",
		],
		parameters: Type.Object({
			name: Type.String({
				description:
					'SOP name / slug, lowercase hyphenated, e.g. "deploy-mysql-replica". Passing an existing name updates that SOP.',
			}),
			description: Type.String({
				description:
					"Required for skill discovery. Say WHEN to use it, e.g. 'USE FOR deploying MySQL replicas, setting up replication, GTID config'.",
			}),
			content: Type.String({
				description: "SOP body in Markdown: concrete numbered steps, copy-pasteable commands, failure branches.",
			}),
			triggers: Type.Optional(
				Type.String({
					description: 'Comma-separated lookup keywords, Chinese and English, e.g. "mysql replica, 主从, GTID".',
				}),
			),
			last_verified: Type.Optional(
				Type.String({ description: "Verification date YYYY-MM-DD. Defaults to today." }),
			),
			project: Type.Optional(
				Type.Boolean({
					description:
						"Set true ONLY when the SOP documents a workflow specific to the git repository you are currently working in (deploy steps, env quirks of this repo). The project is derived from that repo's origin URL automatically; there is no need to pass a project name. Defaults to false = the global SOP library shared by all projects.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return saveSop(params, ctx?.cwd);
		},
	});

	// ---------------------------------------------------------------- //
	// 4. /sop — init / status / sync / grep                              //
	// ---------------------------------------------------------------- //
	pi.registerCommand("sop", {
		description: "SOP library: init wizard, status, sync, or search the library",
		getArgumentCompletions: (prefix) => {
			const subcommands = ["init", "status", "sync"];
			const matches = subcommands.filter((s) => s.startsWith(prefix.trim()));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [head, ...rest] = trimmed.split(/\s+/);
			switch (head) {
				case "":
					await commandStatus(ctx);
					return;
				case "init":
					await runInit(parseInitArgs(rest.join(" ")), ctx);
					return;
				case "status":
					await commandStatus(ctx);
					return;
				case "sync":
					await commandSync(ctx);
					return;
				case "help":
					ctx.ui.notify(
						[
							"pi-sop: /sop init 初始化向导 · /sop status 状态 · /sop sync 同步",
							"/sop <关键词> 在库中检索 SOP（含项目专属 SOP，结果标注范围）",
						].join("\n"),
						"info",
					);
					return;
				default:
					await commandSearch(trimmed, ctx);
					return;
			}
		},
	});
}

/** ------------------------------------------------------------------ */
/** session_start conflict warning (fs-only, best-effort)                  */
/** ------------------------------------------------------------------ */

/**
 * Warn once per (process, conflict-set) when two SOPs share a frontmatter name.
 *
 * This is the safety net for files a human added by hand: `sop_save` refuses
 * such writes up front, but nothing stops a manual `cp`. pi's loader keeps the
 * first registration and silently drops the loser, so the only symptom is a
 * skill quietly going missing — worth one non-blocking notify.
 */
function warnOnConflicts(dir: string, ctx: { ui?: { notify(text: string, type?: string): void } }): void {	let conflicts;
	try {
		conflicts = findSopConflicts(dir);
	} catch {
		return; // never let a scan failure touch session start
	}
	if (conflicts.length === 0) return;
	const signature = conflicts
		.map((conflict) => `${conflict.name}:${conflict.occurrences.map((o) => o.filePath).join(",")}`)
		.join("|");
	if (reportedConflicts.has(signature)) return;
	reportedConflicts.add(signature);

	const lines = [
		`pi-sop: 发现 ${conflicts.length} 组重名 SOP（同名 skill 只有先注册者生效，其余会被静默丢弃）：`,
	];
	for (const conflict of conflicts.slice(0, 5)) {
		lines.push(`• ${conflict.name}`);
		for (const occurrence of conflict.occurrences) {
			lines.push(`  [${occurrence.scope}] ${occurrence.filePath}`);
		}
	}
	if (conflicts.length > 5) lines.push(`…另有 ${conflicts.length - 5} 组`);
	lines.push("请重命名其中之一（如加项目前缀）。");
	try {
		ctx?.ui?.notify(lines.join("\n"), "warning");
	} catch {
		// Stale ctx after reload/session switch — nothing to do.
	}
}

/** ------------------------------------------------------------------ */
/** sop_save implementation                                              */
/** ------------------------------------------------------------------ */

interface SaveParams {
	name: string;
	description: string;
	content: string;
	triggers?: string;
	last_verified?: string;
	/** Write into `projects/<key>/` of the current repo instead of global `sop/`. */
	project?: boolean;
}

interface ToolText {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

function text(message: string, details: Record<string, unknown> = {}): ToolText {
	return { content: [{ type: "text", text: message }], details };
}

async function saveSop(params: SaveParams, cwd?: string): Promise<ToolText> {
	const config = readConfig();
	if (config.enabled === false) return text(NOTIFY.disabledSave, { saved: false, reason: "disabled" });

	const { dir, probe: initialProbe } = resolveState();
	let probe = initialProbe;
	let autoInitialized = false;

	// Degradation path (design §4): knowledge capture must not be blocked by
	// initialization state. Silent local-only scaffold, no UI at all.
	// `malformed` is NOT saveable without a human confirm (SAVEABLE_STATES):
	// agent must never silently commit into a random repo.
	if (probe.state === "malformed") {
		return text(
			`目标路径已是 git 仓库但缺少 SOP 库结构（无 MANIFEST.md 也无 sop/）：${dir}。请让用户运行 /sop init 补齐骨架。`,
			{ saved: false, reason: "malformed" },
		);
	}
	if (!isSaveable(probe.state)) {
		if (probe.state === "not-a-repo") {
			return text(
				`目标路径 ${dir} 存在内容但不是 git 仓库。请让用户运行 /sop init 选择「关联本机已有目录」，或将 PI_SOP_DIR 指向已有库。`,
				{ saved: false, reason: "not-a-repo" },
			);
		}
		if (config.autoInit === false) return text(NOTIFY.notInitialized, { saved: false, reason: "not-initialized" });
		const result = await scaffoldLibrary(dir, { now: new Date() });
		if (!result.initializedRepo && !existsSync(join(dir, ".git"))) {
			return text(
				`无法在该路径创建 git 仓库：${dir}。请让用户运行 /sop init。`,
				{ saved: false, reason: "init-failed" },
			);
		}
		probe = probeLibrary(dir);
		autoInitialized = true;
		// Machine-private bookkeeping only; no interactive step happens here.
		writeConfig({ enabled: true, libDir: dir, initializedAt: new Date().toISOString() });
	}

	const slug = slugifySopName(params.name);
	if (!slug) {
		return text(
			`无效的 SOP 名称：${params.name}。请使用小写字母、数字和连字符（如 deploy-mysql-replica）。`,
			{ saved: false, reason: "invalid-name" },
		);
	}
	if (!params.description.trim()) {
		return text(
			`sop_save 需要 description（pi 靠它判断何时加载这条 skill）。请说明「什么时候用」。`,
			{ saved: false, reason: "missing-description" },
		);
	}

	// Scope resolution. `project: true` is an explicit opt-in (default stays
	// global): a mis-guessed project dir is much worse than a too-broad global
	// SOP, so the agent must say so on purpose.
	let scope = GLOBAL_SCOPE;
	let targetDir = resolve(dir, "sop");
	if (params.project) {
		const keys = resolveProjectKeys(cwd ?? process.cwd());
		if (keys.length === 0) {
			return text(
				`无法写入项目 SOP：当前目录（${cwd ?? process.cwd()}）向上没有找到带 origin 远端的 git 仓库。\n` +
					`请确认在项目仓库内，或去掉 project 参数写入全局 sop/。`,
				{ saved: false, reason: "no-project" },
			);
		}
		// Most specific key wins (submodule dir before its parent repo).
		scope = keys[0] as string;
		targetDir = projectDir(dir, scope);
	}

	const sopPath = resolve(targetDir, `${slug}.md`);

	// Duplicate-name guard. pi keeps the FIRST skill registered under a name and
	// silently drops the rest (verified behavior), so a second file with the same
	// frontmatter name is a silent loss, not a harmless copy. Refuse instead —
	// but rewriting the very same file is the normal update path.
	const clash = findNameConflicts(dir, slug).find((doc) => !samePath(doc.filePath, sopPath));
	if (clash) {
		// Suggest a prefix taken from the OTHER scope's project name — that is the
		// distinction the two files actually encode.
		const otherKey = clash.scope === GLOBAL_SCOPE ? scope : clash.scope;
		const prefix = otherKey === GLOBAL_SCOPE ? "" : `${otherKey.split("/").pop()}-`;
		return text(
			`SOP 名称冲突：「${slug}」已存在于 ${clash.scope === GLOBAL_SCOPE ? "全局 sop/" : `项目 ${clash.scope}`}：${clash.filePath}。\n` +
				`同名 skill 会被 pi 静默去重（先注册者胜出），所以请改名，例如：${prefix}${slug}。`,
			{ saved: false, reason: "name-conflict", conflict: clash.filePath },
		);
	}

	const existed = existsSync(sopPath);
	const lastVerified = (params.last_verified ?? today()).trim() || today();
	const document = renderSop({
		name: slug,
		description: params.description.trim(),
		triggers: (params.triggers ?? "").trim(),
		lastVerified,
		body: params.content,
	});

	// Whole read-modify-write window (SOP file + MANIFEST) runs in the shared
	// per-file queue so a parallel built-in `write`/`edit` cannot lose an update.
	// The disk write + commit + push also run under the library flock so a
	// concurrent session_start pull (autostash window) cannot interleave with
	// the commit (review finding: two lock systems must not be strangers).
	return withFileMutationQueue(sopPath, async () => {
		const writeAndCommit = async (): Promise<ToolText> => {
			const { mkdirSync, writeFileSync } = await import("node:fs");
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(sopPath, document, "utf8");

			// Rebuild MANIFEST from disk (never hand-patch it) so drift self-heals.
			// The manifest indexes every scope, hence the whole-library scan.
			const { docs } = scanSopDir(dir);
			writeFileSync(join(dir, "MANIFEST.md"), renderManifest(docs), "utf8");

			const relativePath = relativeTo(dir, sopPath);
			const commit = await commitAll(dir, `${existed ? "docs: update" : "docs: add"} SOP ${slug}`, [
				relativePath,
				"MANIFEST.md",
			]);
			if (!commit.committed) {
				return text(
					`SOP 已写入，但 git 提交失败（${commit.detail ?? commit.reason ?? "unknown"}）。本地文件已保存：${sopPath}`,
					{ saved: true, committed: false, slug, path: sopPath, scope, autoInitialized },
				);
			}

			const lines = [
				`SOP ${existed ? "已更新" : "已保存"}：${slug}`,
				`文件：${sopPath}`,
				`范围：${scope === GLOBAL_SCOPE ? "全局（所有项目）" : `项目 ${scope}`}`,
				`已提交：${existed ? "docs: update" : "docs: add"} SOP ${slug}`,
			];

			// Push is best-effort; failure is reported, never fatal (design §7).
			// alreadyLocked: we hold the library flock here, pushLibrary must
			// not try to take it again (flock is not reentrant).
			if (probe.remote) {
				const pushed = await pushLibrary(dir, probe.branch, { alreadyLocked: true });
				if (pushed.verdict === "ok") {
					lines.push("已推送到远端。");
				} else {
					lines.push(`已本地提交；推送失败（${pushed.detail ?? pushed.message}），将在下次会话重试。`);
				}
			} else {
				lines.push("库为本地模式（无远端），未推送。");
			}

			if (autoInitialized) {
				lines.push(
					`已自动创建本地 SOP 库 ${dir}（local-only）。提醒用户运行 /sop init 配置远端可实现多机同步。`,
				);
			}

			return text(lines.join("\n"), {
				saved: true,
				committed: true,
				slug,
				path: sopPath,
				scope,
				autoInitialized,
			});
		};

		const lock = await withLock(lockPathForDir(dir), writeAndCommit);
		if (!lock.acquired) {
			return text(
				`SOP 未保存：另一进程正在同步 SOP 库，请稍后重试。`,
				{ saved: false, reason: "locked" },
			);
		}
		return lock.value;
	});
}

/** ------------------------------------------------------------------ */
/** /sop status                                                          */
/** ------------------------------------------------------------------ */

async function commandStatus(ctx: ExtensionCommandContext): Promise<void> {
	const config = readConfig();
	const { dir, probe } = resolveState();
	const lines = [
		config.enabled ? "pi-sop: 已启用" : "pi-sop: 已禁用（/sop init 重新启用）",
		`库路径: ${dir}`,
		`状态:   ${describeState(probe)}`,
	];
	if (probe.remote) lines.push(`远端:   ${probe.remote} (${probe.branch ?? "?"})`);
	if (isUsable(probe.state)) {
		const { docs } = scanSopDir(dir);
		lines.push(`SOP 数量: ${countSops(dir)}`);
		const projectScopes = new Set(docs.filter((doc) => doc.scope !== GLOBAL_SCOPE).map((doc) => doc.scope));
		if (projectScopes.size > 0) {
			lines.push(`项目专属: ${projectScopes.size} 个项目目录`);
		}
		const recent = mostRecentVerification(docs);
		if (recent) lines.push(`最近验证: ${recent.name} (${recent.date})`);
		if (config.lastSyncAt) lines.push(`上次同步: ${config.lastSyncAt}`);
	} else {
		lines.push("提示: 运行 /sop init 初始化 SOP 库");
	}
	ctx.ui.notify(lines.join("\n"), config.enabled ? "info" : "warning");
}

/** ------------------------------------------------------------------ */
/** /sop sync                                                            */
/** ------------------------------------------------------------------ */

async function commandSync(ctx: ExtensionCommandContext): Promise<void> {
	const { dir, probe } = resolveState();
	if (!isUsable(probe.state) || !probe.gitDir) {
		ctx.ui.notify(`pi-sop: 库尚未就绪（${describeState(probe)}），运行 /sop init 初始化`, "warning");
		return;
	}
	if (!probe.remote) {
		ctx.ui.notify("pi-sop: 本地模式（无远端），无需同步。运行 /sop init 可配置远端。", "info");
		return;
	}
	// An explicit user action ignores the 10-minute session throttle.
	const result = await syncLibrary(dir, { force: true, probe: { remote: probe.remote, branch: probe.branch } });
	if (result.verdict === "ok") {
		writeConfig({ lastSyncAt: new Date().toISOString() });
		ctx.ui.notify("pi-sop: 同步完成", "info");
		return;
	}
	if (result.verdict === "conflict") {
		ctx.ui.notify(NOTIFY.conflict, "warning");
		return;
	}
	ctx.ui.notify(`pi-sop: ${result.message}${result.detail ? `（${result.detail}）` : ""}`, "warning");
}

/** ------------------------------------------------------------------ */
/** /sop <keyword>                                                       */
/** ------------------------------------------------------------------ */

/**
 * Grep the library for humans. The library is small (dozens of files), so a
 * case-insensitive substring scan over frontmatter + body is enough and needs no
 * index. Results are ranked: name match, then triggers, then description, then
 * body. Every hit is labelled with its scope (global vs. project key) because
 * the same keyword may exist in both worlds.
 */
async function commandSearch(query: string, ctx: ExtensionCommandContext): Promise<void> {
	const { dir, probe } = resolveState();
	if (!isUsable(probe.state)) {
		ctx.ui.notify(`pi-sop: 库尚未就绪（${describeState(probe)}），运行 /sop init 初始化`, "warning");
		return;
	}
	const needle = query.toLowerCase();
	const { docs } = scanSopDir(dir);
	const scored: { doc: (typeof docs)[number]; score: number }[] = [];
	for (const doc of docs) {
		const name = doc.name.toLowerCase();
		const triggers = doc.triggers.toLowerCase();
		const description = doc.description.toLowerCase();
		const body = doc.body.toLowerCase();
		let score = 0;
		if (name.includes(needle)) score += 8;
		if (triggers.includes(needle)) score += 4;
		if (description.includes(needle)) score += 2;
		if (body.includes(needle)) score += 1;
		if (score > 0) scored.push({ doc, score });
	}

	if (scored.length === 0) {
		ctx.ui.notify(`pi-sop: 没有匹配「${query}」的 SOP（库中共 ${docs.length} 条）`, "info");
		return;
	}
	scored.sort((a, b) => b.score - a.score || a.doc.name.localeCompare(b.doc.name));

	const lines = [`SOP 检索「${query}」— ${scored.length}/${docs.length} 条匹配:`, ""];
	for (const { doc } of scored.slice(0, 15)) {
		lines.push(`• ${doc.name}  [${scopeLabel(doc.scope)}]`);
		lines.push(`  ${doc.description}`);
		if (doc.triggers) lines.push(`  triggers: ${doc.triggers}`);
		if (doc.lastVerified) lines.push(`  last_verified: ${doc.lastVerified}`);
		lines.push(`  ${doc.filePath}`);
	}
	if (scored.length > 15) lines.push("", `…另有 ${scored.length - 15} 条，请用更具体的关键词`);
	lines.push("", "用 read 工具打开文件查看完整步骤。");
	// Multi-line results go through notify (the only channel a command
	// context offers here); long tails are trimmed above to keep it readable.
	pi_sendMessage(ctx, lines.join("\n"));
}

/** Short scope label for search output. */
function scopeLabel(scope: string): string {
	return scope === GLOBAL_SCOPE ? "全局" : `项目: ${scope}`;
}

/**
 * Path of `target` relative to `dir`, as git wants it in `git add`.
 *
 * `projectDir` exits through `realpath`, so under a symlinked library the two
 * can differ lexically while pointing at the same file; try both spellings
 * before falling back to the absolute path (which git can still handle, but
 * which would look wrong in a commit message).
 */
function relativeTo(dir: string, target: string): string {
	for (const base of [resolve(dir), canonical(dir)]) {
		if (target.startsWith(`${base}/`)) return target.slice(base.length + 1);
	}
	return target;
}

function canonical(path: string): string {
	try {
		return realpathSync(resolve(path));
	} catch {
		return resolve(path);
	}
}

/**
 * True when two paths denote the same file. Compares canonical forms because
 * `sop_save` builds its target through `projectDir` (realpath) while the scan
 * yields lexical paths — under a symlinked library a naive string compare would
 * reject an in-place update as a name conflict.
 */
function samePath(a: string, b: string): boolean {
	return resolve(a) === resolve(b) || canonical(a) === canonical(b);
}

/** Commands have no access to `pi` here; keep the notify fallback simple. */
function pi_sendMessage(ctx: ExtensionCommandContext, body: string): void {
	ctx.ui.notify(body, "info");
}
