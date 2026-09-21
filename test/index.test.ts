/**
 * End-to-end wiring test for src/index.ts.
 *
 * This drives the *real* extension factory against a minimal fake `pi` API, so
 * the four capabilities are exercised the way pi would call them:
 *   - session_start must never prompt and must not throw when uninitialized
 *   - resources_discover must expose <libDir>/sop only when usable, and the
 *     registered dir must actually yield skills through pi's own loader
 *   - sop_save must write + MANIFEST + commit, and autoInit must degrade
 *     silently to a local-only library
 *   - /sop init --local must be fully non-interactive
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { loadSkills } from "@earendil-works/pi-coding-agent";

import piSop, { resetNotifyFlag } from "../src/index.ts";
import { readConfig, writeConfig } from "../src/lib/config.ts";
import { probeLibrary } from "../src/lib/probe.ts";
import { withSandbox } from "./helpers.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface FakeApi {
	handlers: Record<string, Handler[]>;
	tools: Record<string, unknown>;
	commands: Record<string, unknown>;
	factories: unknown[];
}

/** Minimal stand-in for the parts of ExtensionAPI that src/index.ts uses. */
function createFakePi(): FakeApi {
	const api: FakeApi = { handlers: {}, tools: {}, commands: {}, factories: [] };
	return api;
}

function loadExtension(api: FakeApi): void {
	const fake = {
		on(event: string, handler: Handler) {
			(api.handlers[event] ??= []).push(handler);
		},
		registerTool(tool: { name: string }) {
			api.tools[tool.name] = tool;
		},
		registerCommand(name: string, definition: unknown) {
			api.commands[name] = definition;
		},
	};
	piSop(fake as never);
}

interface FakeNotifies {
	messages: { text: string; type: string }[];
}

/** A fake command context that records UI calls and fails on any prompt. */
function createCtx(options: { mode?: "tui" | "print"; notifies?: FakeNotifies; allowPrompts?: boolean; cwd?: string } = {}) {
	const notifies = options.notifies ?? { messages: [] };
	const mode = options.mode ?? "print";
	const ctx = {
		mode,
		hasUI: mode === "tui",
		cwd: options.cwd ?? process.cwd(),
		ui: {
			notify(text: string, type = "info") {
				notifies.messages.push({ text, type });
			},
			async select() {
				if (!options.allowPrompts) throw new Error("session_start/tool must not prompt");
				return undefined;
			},
			async confirm() {
				if (!options.allowPrompts) throw new Error("session_start/tool must not prompt");
				return false;
			},
			async input() {
				if (!options.allowPrompts) throw new Error("session_start/tool must not prompt");
				return undefined;
			},
		},
		async reload() {
			ctx.reloaded = true;
		},
		reloaded: false,
	};
	return ctx;
}

function runGit(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	});
}

async function withExtension(
	fn: (ctx: { api: FakeApi; libDir: string; root: string }) => Promise<void>,
	options: { libDir?: (root: string) => string } = {},
): Promise<void> {
	await withSandbox(async (sandbox) => {
		resetNotifyFlag();
		const libDir = options.libDir ? options.libDir(sandbox.root) : join(sandbox.root, "sop-library");
		process.env.PI_SOP_DIR = libDir;
		const api = createFakePi();
		loadExtension(api);
		await fn({ api, libDir, root: sandbox.root });
	});
}

/**
 * Create a real git repo (with an origin) inside the sandbox.
 * The project key is derived from the origin URL, so tests assert against that
 * key rather than against an invented directory name.
 */
function makeRepo(root: string, relative: string, origin: string | null = null): string {
	const dir = join(root, relative);
	mkdirSync(dir, { recursive: true });
	runGit(dir, ["init", "-q", "-b", "main"]);
	if (origin) runGit(dir, ["remote", "add", "origin", origin]);
	return dir;
}

const TDMQ_ORIGIN = "git@git.woa.com:csig_tdmq/tdmq-appserver.git";
const TDMQ_KEY = "git.woa.com/csig_tdmq/tdmq-appserver";

/** Fetch a registered event handler, asserting it exists. */
function handlerFor(api: FakeApi, event: string): Handler {
	const [handler] = api.handlers[event] ?? [];
	assert.ok(handler, `${event} must be registered`);
	return handler;
}

interface ToolResult {
	content: { type: string; text: string }[];
	details: Record<string, unknown>;
}

type SaveTool = {
	execute: (
		id: string,
		params: unknown,
		signal: unknown,
		update: unknown,
		ctx: unknown,
	) => Promise<ToolResult>;
};

/** Fetch the registered sop_save tool, asserting it exists. */
function saveTool(api: FakeApi): SaveTool {
	const tool = api.tools.sop_save as SaveTool | undefined;
	assert.ok(tool, "sop_save must be registered");
	return tool;
}

/** Fetch the registered /sop command, asserting it exists. */
function sopCommand(api: FakeApi): { handler: (args: string, ctx: unknown) => Promise<void> } {
	const command = api.commands.sop as { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
	assert.ok(command, "/sop command must be registered");
	return command;
}

/** The sandbox agent dir, required by pi's loadSkills(). */
function agentDirFromEnv(): string {
	return process.env.PI_CODING_AGENT_DIR as string;
}

/** Collapse a tool result into one string for assertions. */
function toolText(result: ToolResult): string {
	return result.content.map((c) => c.text).join("\n");
}

test("resources_discover exposes nothing when the library is missing", async () => {
	await withExtension(async ({ api, libDir }) => {
		const handler = handlerFor(api, "resources_discover");
		const result = await handler({ cwd: process.cwd(), reason: "startup" }, createCtx());
		assert.deepEqual(result, {}, "no skillPaths for an uninitialized library");
		assert.ok(!existsSync(libDir));
	});
});

test("resources_discover exposes <libDir>/sop when ready", async () => {
	await withExtension(async ({ api, libDir }) => {
		// build a ready library by hand
		await import("../src/lib/scaffold.ts").then(({ scaffoldLibrary }) => scaffoldLibrary(libDir, { commit: false }));
		const handler = handlerFor(api, "resources_discover");
		const result = (await handler({ cwd: process.cwd(), reason: "startup" }, createCtx())) as {
			skillPaths?: string[];
		};
		assert.deepEqual(result.skillPaths, [join(libDir, "sop")]);
	});
});

test("resources_discover is silent when disabled in config", async () => {
	await withExtension(async ({ api, libDir }) => {
		await import("../src/lib/scaffold.ts").then(({ scaffoldLibrary }) => scaffoldLibrary(libDir, { commit: false }));
		writeConfig({ enabled: false });
		const handler = handlerFor(api, "resources_discover");
		assert.deepEqual(await handler({ cwd: process.cwd(), reason: "startup" }, createCtx()), {});
	});
});

test("session_start never prompts and notifies once when uninitialized", async () => {
	await withExtension(async ({ api }) => {
		const handler = handlerFor(api, "session_start");
		const notifies: FakeNotifies = { messages: [] };

		// createCtx throws on any prompt, so this also proves non-blocking UX
		await handler({ reason: "startup" }, createCtx({ notifies }));
		await handler({ reason: "resume" }, createCtx({ notifies }));
		await handler({ reason: "fork" }, createCtx({ notifies }));

		const messages = notifies.messages.map((m) => m.text);
		assert.equal(messages.length, 1, "exactly one notify per process");
		assert.match(messages[0] ?? "", /SOP 库未初始化/);
	});
});

test("session_start is silent when the extension is disabled", async () => {
	await withSandbox(async (sandbox) => {
		resetNotifyFlag();
		process.env.PI_SOP_DIR = join(sandbox.root, "lib");
		writeConfig({ enabled: false });
		const api = createFakePi();
		loadExtension(api);
		const notifies: FakeNotifies = { messages: [] };
		await handlerFor(api, "session_start")({ reason: "startup" }, createCtx({ notifies }));
		assert.equal(notifies.messages.length, 0);
	});
});

test("sop_save auto-inits a local-only library and commits locally", async () => {
	await withExtension(async ({ api, libDir }) => {
		const tool = saveTool(api);

		const before = readConfig();
		assert.equal(before.libDir, null);

		const result = await tool.execute(
			"call-1",
			{
				name: "Deploy MySQL Replica",
				description: "USE FOR deploying MySQL replicas",
				content: "# Steps\n\n1. do the thing",
				triggers: "mysql, 主从",
			},
			undefined,
			undefined,
			createCtx(),
		);

		const text = result.content.map((c) => c.text).join("\n");
		assert.match(text, /已保存|已更新/);
		assert.match(text, /已自动创建本地 SOP 库/);
		assert.equal(result.details.saved, true);
		assert.equal(result.details.autoInitialized, true);

		// the library exists, is a git repo, and has the SOP + MANIFEST
		const probe = probeLibrary(libDir);
		assert.equal(probe.state, "no-remote", "autoInit is local-only, never a remote");
		assert.ok(existsSync(join(libDir, "sop", "deploy-mysql-replica.md")));
		const sop = readFileSync(join(libDir, "sop", "deploy-mysql-replica.md"), "utf8");
		assert.match(sop, /^---\nname: deploy-mysql-replica\n/);
		assert.match(sop, /triggers: mysql, 主从/);
		const manifest = readFileSync(join(libDir, "MANIFEST.md"), "utf8");
		assert.match(manifest, /deploy-mysql-replica/);

		// committed locally (design: commit always lands before push)
		const log = runGit(libDir, ["log", "--pretty=%s"]);
		assert.match(log, /docs: add SOP deploy-mysql-replica/);

		// config now points at the auto-created library
		const after = readConfig();
		assert.equal(after.libDir, libDir);
	});
});
test("sop_save updates an existing SOP in place", async () => {
	await withExtension(async ({ api, libDir }) => {
		const tool = saveTool(api);
		const params = {
			name: "first-sop",
			description: "USE FOR the first case",
			content: "# v1",
		};
		await tool.execute("1", params, undefined, undefined, createCtx());
		const second = await tool.execute(
			"2",
			{ ...params, content: "# v2", description: "USE FOR the second case" },
			undefined,
			undefined,
			createCtx(),
		);
		assert.match(toolText(second), /已更新/);
		const sop = readFileSync(join(libDir, "sop", "first-sop.md"), "utf8");
		assert.match(sop, /# v2/);
		const log = runGit(libDir, ["log", "--pretty=%s"]);
		assert.match(log, /docs: update SOP first-sop/);
		// MANIFEST reflects the new description
		assert.match(readFileSync(join(libDir, "MANIFEST.md"), "utf8"), /the second case/);
	});
});

test("sop_save refuses when the extension is disabled", async () => {
	await withSandbox(async (sandbox) => {
		resetNotifyFlag();
		process.env.PI_SOP_DIR = join(sandbox.root, "lib");
		writeConfig({ enabled: false });
		const api = createFakePi();
		loadExtension(api);
		const result = await saveTool(api).execute(
			"1",
			{ name: "x", description: "d", content: "c" },
			undefined,
			undefined,
			createCtx(),
		);
		assert.match(toolText(result), /已禁用/);
		assert.equal(result.details.saved, false);
		assert.ok(!existsSync(join(sandbox.root, "lib")));
	});
});

test("sop_save respects autoInit: false", async () => {
	await withSandbox(async (sandbox) => {
		resetNotifyFlag();
		process.env.PI_SOP_DIR = join(sandbox.root, "lib");
		writeConfig({ autoInit: false });
		const api = createFakePi();
		loadExtension(api);
		const result = await saveTool(api).execute(
			"1",
			{ name: "x", description: "d", content: "c" },
			undefined,
			undefined,
			createCtx(),
		);
		assert.match(toolText(result), /SOP 库未初始化/);
		assert.equal(result.details.saved, false);
	});
});

test("sop_save rejects an invalid name and a missing description", async () => {
	await withExtension(async ({ api }) => {
		const tool = saveTool(api);
		const badName = await tool.execute(
			"1",
			{ name: "!!!", description: "d", content: "c" },
			undefined,
			undefined,
			createCtx(),
		);
		assert.equal(badName.details.saved, false);
		assert.match(toolText(badName), /无效的 SOP 名称/);

		const noDesc = await tool.execute(
			"2",
			{ name: "valid-name", description: "   ", content: "c" },
			undefined,
			undefined,
			createCtx(),
		);
		assert.equal(noDesc.details.saved, false);
		assert.match(toolText(noDesc), /需要 description/);
	});
});

test("/sop init --local works non-interactively in print mode", async () => {
	await withExtension(async ({ api, libDir }) => {
		const notifies: FakeNotifies = { messages: [] };
		await sopCommand(api).handler("init --local", createCtx({ mode: "print", notifies }));

		assert.match(notifies.messages.map((m) => m.text).join("\n"), /SOP 库就绪/);
		assert.equal(probeLibrary(libDir).state, "no-remote");
		assert.ok(existsSync(join(libDir, "MANIFEST.md")));
		assert.equal(readConfig().libDir, libDir);
	});
});

test("/sop init --disable disables and persists", async () => {
	await withExtension(async ({ api }) => {
		const notifies: FakeNotifies = { messages: [] };
		await sopCommand(api).handler("init --disable", createCtx({ mode: "print", notifies }));
		assert.equal(readConfig().enabled, false);
		assert.match(notifies.messages.map((m) => m.text).join(""), /已禁用/);
	});
});

test("/sop init in print mode without flags explains the required flags", async () => {
	await withExtension(async ({ api }) => {
		const notifies: FakeNotifies = { messages: [] };
		await sopCommand(api).handler("init", createCtx({ mode: "print", notifies }));
		assert.match(notifies.messages.map((m) => m.text).join("\n"), /非交互模式需要显式参数/);
	});
});

test("/sop status reports state without prompting", async () => {
	await withExtension(async ({ api, libDir }) => {
		const notifies: FakeNotifies = { messages: [] };
		await sopCommand(api).handler("status", createCtx({ mode: "print", notifies }));
		const text = notifies.messages.map((m) => m.text).join("\n");
		assert.match(text, /pi-sop/);
		assert.ok(text.includes(libDir), "status shows the resolved library path");
	});
});

test("/sop <keyword> finds a saved SOP", async () => {
	await withExtension(async ({ api, libDir }) => {
		await saveTool(api).execute(
			"1",
			{
				name: "redis-cluster-recovery",
				description: "USE FOR recovering a broken Redis cluster",
				content: "1. investigate",
				triggers: "redis, 集群, failover",
			},
			undefined,
			undefined,
			createCtx(),
		);
		const notifies: FakeNotifies = { messages: [] };
		await sopCommand(api).handler("redis", createCtx({ mode: "print", notifies }));
		const text = notifies.messages.map((m) => m.text).join("\n");
		assert.match(text, /redis-cluster-recovery/);
		assert.ok(existsSync(join(libDir, "sop", "redis-cluster-recovery.md")));
	});
});

test("/sop <keyword> with no match says so instead of erroring", async () => {
	await withExtension(async ({ api, libDir }) => {
		const { scaffoldLibrary } = await import("../src/lib/scaffold.ts");
		await scaffoldLibrary(libDir, { commit: false });
		const notifies: FakeNotifies = { messages: [] };
		await sopCommand(api).handler("nonexistent-keyword-xyz", createCtx({ mode: "print", notifies }));
		assert.match(notifies.messages.map((m) => m.text).join("\n"), /没有匹配/);
	});
});

test("sop_save output message is honest in local-only mode", async () => {
	await withExtension(async ({ api }) => {
		const result = await saveTool(api).execute(
			"1",
			{ name: "local-only-sop", description: "d", content: "c" },
			undefined,
			undefined,
			createCtx(),
		);
		assert.match(toolText(result), /库为本地模式（无远端），未推送/);
	});
});

test("the registered skillPath actually yields skills via pi's loader", async () => {
	await withExtension(async ({ api, libDir }) => {
		const { scaffoldLibrary } = await import("../src/lib/scaffold.ts");
		await scaffoldLibrary(libDir, { commit: false });
		const handler = handlerFor(api, "resources_discover");
		const result = (await handler({ cwd: process.cwd(), reason: "startup" }, createCtx())) as {
			skillPaths?: string[];
		};
		const skillPath = result.skillPaths?.[0];
		assert.ok(skillPath);

		// Design §6 risk point: use pi's own loader on the exact registered path.
		// This is the contract that must hold — if it ever stops holding, the
		// fallback is the `sop/<name>/SKILL.md` layout.
		const loaded = loadSkills({
			cwd: process.cwd(),
			agentDir: agentDirFromEnv(),
			skillPaths: [skillPath],
			includeDefaults: false,
		});
		const names = loaded.skills.map((s) => s.name);
		assert.ok(names.includes("writing-sops"), `seed SOP must be discovered, got: ${names.join(", ")}`);
	});
});
test("two-machine flow: A saves → B clones and discovers the SOP as a skill", async () => {
	// Machine A: init a library with a bare remote, then save a SOP.
	const root = mkdtempSync(join(tmpdir(), "pi-sop-two-"));
	try {
		const remote = join(root, "remote.git");
		execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "ignore" });

		await withSandbox(async (sandboxA) => {
			resetNotifyFlag();
			const libA = join(sandboxA.root, "lib");
			process.env.PI_SOP_DIR = libA;
			const apiA = createFakePi();
			loadExtension(apiA);
			const { scaffoldLibrary } = await import("../src/lib/scaffold.ts");
			await scaffoldLibrary(libA, { now: new Date() });
			await runGitAsync(libA, ["remote", "add", "origin", remote]);

			const saved = await saveTool(apiA).execute(
				"1",
				{ name: "shared-runbook", description: "USE FOR the shared case", content: "1. step" },
				undefined,
				undefined,
				createCtx(),
			);
			assert.equal(saved.details.saved, true);
			assert.match(toolText(saved), /已推送到远端/, "A must push to the shared remote");

			// Machine B: a different HOME/agent dir, pointing at the same remote.
			await withSandbox(async (sandboxB) => {
				resetNotifyFlag();
				const libB = join(sandboxB.root, "lib");
				const cloned = await gitClone(remote, libB);
				assert.equal(cloned, true);
				process.env.PI_SOP_DIR = libB;
				const apiB = createFakePi();
				loadExtension(apiB);

				// B discovers the SOP that A authored, through the real loader.
				const handler = handlerFor(apiB, "resources_discover");
				const result = (await handler({ cwd: process.cwd(), reason: "startup" }, createCtx())) as {
					skillPaths?: string[];
				};
				const skillPath = result.skillPaths?.[0];
				assert.ok(skillPath, "B must expose the sop/ skill path");
				const loaded = loadSkills({
					cwd: process.cwd(),
					agentDir: agentDirFromEnv(),
					skillPaths: [skillPath],
					includeDefaults: false,
				});
				const names = loaded.skills.map((s) => s.name);
				assert.ok(names.includes("shared-runbook"), `B should see A's SOP, got: ${names.join(", ")}`);
				assert.ok(names.includes("writing-sops"), "B should also see the seed SOP");
			});
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

async function runGitAsync(cwd: string, args: string[]): Promise<string> {
	const { execFile } = await import("node:child_process");
	return new Promise((resolvePromise, rejectPromise) => {
		execFile("git", args, {
			cwd,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		}, (error, stdout) => (error ? rejectPromise(error) : resolvePromise(stdout)));
	});
}

async function gitClone(url: string, dest: string): Promise<boolean> {
	try {
		await runGitAsync(dirname(dest), ["clone", url, dest]);
		return true;
	} catch {
		return false;
	}
}

test("sop_save refuses to write into a malformed repo (no silent scaffold)", async () => {
	await withExtension(async ({ api, libDir }) => {
		// A repo with commits but no MANIFEST.md / sop/ — a stranger's repo.
		mkdirSync(libDir, { recursive: true });
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: libDir });
		writeFileSync(join(libDir, "README.md"), "not a sop library\n");
		execFileSync("git", ["add", "README.md"], { cwd: libDir });
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: libDir });

		const tool = api.tools["sop_save"] as {
			execute: (_id: string, params: Record<string, string>) => Promise<{ content: { type: string; text: string }[]; details: { saved?: boolean } }>;
		};
		assert.ok(tool, "sop_save tool must be registered");
		const result = await tool.execute("t1", {
			name: "should-be-refused",
			description: "USE FOR testing malformed refusal",
			content: "body",
		});
		assert.equal(result.details.saved, false);
		assert.match(result.content?.[0]?.text ?? "", /缺少 SOP 库结构|sop init/);
		assert.equal(existsSync(join(libDir, "sop")), false, "must not scaffold into the repo");
	});
});

/** ------------------------------------------------------------------ */
/** Project-scoped SOPs (projects/<normalized origin key>/)              */
/** ------------------------------------------------------------------ */

test("resources_discover puts the project dir BEFORE the global sop/ dir", async () => {
	await withExtension(async ({ api, libDir, root }) => {
		const { scaffoldLibrary } = await import("../src/lib/scaffold.ts");
		await scaffoldLibrary(libDir, { commit: false });
		const repo = makeRepo(root, "work/repo", TDMQ_ORIGIN);
		const projectDir = join(libDir, "projects", TDMQ_KEY);
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(projectDir, "deploy.md"),
			"---\nname: tdmq-deploy\ndescription: USE FOR deploying tdmq | 用于部署 tdmq\n---\n\n1. step\n",
		);

		const handler = handlerFor(api, "resources_discover");
		const result = (await handler(
			{ cwd: join(repo, "src"), reason: "startup" },
			createCtx({ cwd: join(repo, "src") }),
		)) as { skillPaths?: string[] };

		// Project first: pi keeps the first registration for a duplicate name.
		assert.deepEqual(result.skillPaths, [projectDir, join(libDir, "sop")]);

		// …and pi's own loader really discovers the project SOP through it.
		const loaded = loadSkills({
			cwd: process.cwd(),
			agentDir: agentDirFromEnv(),
			skillPaths: result.skillPaths ?? [],
			includeDefaults: false,
		});
		const names = loaded.skills.map((s) => s.name);
		assert.ok(names.includes("tdmq-deploy"), `project SOP must load, got: ${names.join(", ")}`);
		assert.ok(names.includes("writing-sops"), "global SOP must still load");
	});
});

test("resources_discover ignores a project dir that does not exist yet", async () => {
	await withExtension(async ({ api, libDir, root }) => {
		const { scaffoldLibrary } = await import("../src/lib/scaffold.ts");
		await scaffoldLibrary(libDir, { commit: false });
		const repo = makeRepo(root, "work/repo", TDMQ_ORIGIN);
		const result = (await handlerFor(api, "resources_discover")(
			{ cwd: repo, reason: "startup" },
			createCtx({ cwd: repo }),
		)) as { skillPaths?: string[] };
		assert.deepEqual(result.skillPaths, [join(libDir, "sop")]);
	});
});

test("resources_discover is unchanged for a cwd outside any git repo", async () => {
	await withExtension(async ({ api, libDir, root }) => {
		const { scaffoldLibrary } = await import("../src/lib/scaffold.ts");
		await scaffoldLibrary(libDir, { commit: false });
		const plain = join(root, "not-a-repo");
		mkdirSync(plain, { recursive: true });
		const result = (await handlerFor(api, "resources_discover")(
			{ cwd: plain, reason: "startup" },
			createCtx({ cwd: plain }),
		)) as { skillPaths?: string[] };
		assert.deepEqual(result.skillPaths, [join(libDir, "sop")]);
	});
});

test("sop_save with project:true writes into projects/<key>/ and commits", async () => {
	await withExtension(async ({ api, libDir, root }) => {
		const repo = makeRepo(root, "work/repo", TDMQ_ORIGIN);
		const result = await saveTool(api).execute(
			"1",
			{
				name: "tdmq-deploy",
				description: "USE FOR deploying tdmq | 用于部署 tdmq",
				content: "1. step",
				project: true,
			},
			undefined,
			undefined,
			createCtx({ cwd: join(repo, "src", "deep") }),
		);

		assert.equal(result.details.saved, true);
		assert.equal(result.details.scope, TDMQ_KEY);
		const expected = join(libDir, "projects", TDMQ_KEY, "tdmq-deploy.md");
		assert.equal(result.details.path, expected);
		assert.ok(existsSync(expected), "SOP lands in the project directory");
		assert.ok(!existsSync(join(libDir, "sop", "tdmq-deploy.md")), "and NOT in the global dir");
		assert.match(toolText(result), /范围：项目 git\.woa\.com\/csig_tdmq\/tdmq-appserver/);

		// committed, with the path relative to the library root
		assert.match(runGit(libDir, ["log", "--pretty=%s"]), /docs: add SOP tdmq-deploy/);
		const committed = runGit(libDir, ["show", "--name-only", "--pretty=format:", "HEAD"]);
		assert.match(committed, /projects\/git\.woa\.com\/csig_tdmq\/tdmq-appserver\/tdmq-deploy\.md/);

		// MANIFEST carries the scope column for both files
		const manifest = readFileSync(join(libDir, "MANIFEST.md"), "utf8");
		assert.match(manifest, new RegExp(`\\| tdmq-deploy \\| ${TDMQ_KEY.replace(/\./g, "\\.")} \\|`));
		assert.match(manifest, /\| writing-sops \| global \|/);
	});
});

test("a bilingual description stays intact in the SOP file (only MANIFEST trims it)", async () => {
	await withExtension(async ({ api, libDir, root }) => {
		const repo = makeRepo(root, "work/repo", TDMQ_ORIGIN);
		await saveTool(api).execute(
			"1",
			{
				name: "bilingual",
				description: "USE FOR doing the thing | 用于做这件事",
				content: "1. step",
				project: true,
			},
			undefined,
			undefined,
			createCtx({ cwd: repo }),
		);
		const file = readFileSync(join(libDir, "projects", TDMQ_KEY, "bilingual.md"), "utf8");
		// pi reads the frontmatter verbatim: both languages must survive there.
		assert.match(file, /description: USE FOR doing the thing \| 用于做这件事/);
		assert.match(file, /^---\nname: bilingual\n/);
		const row = readFileSync(join(libDir, "MANIFEST.md"), "utf8")
			.split("\n")
			.find((line) => line.startsWith("| bilingual |"));
		assert.ok(row);
		assert.match(row, /USE FOR doing the thing/);
		assert.doesNotMatch(row, /用于做这件事/);
	});
});

test("sop_save project:true inside a submodule writes under the submodule key", async () => {
	await withExtension(async ({ api, libDir, root }) => {
		// Parent repo + a submodule whose .git is a file pointing into the
		// parent's module storage — exactly what `git submodule add` produces.
		const parent = makeRepo(root, "work/parent", TDMQ_ORIGIN);
		const moduleGitDir = join(parent, ".git", "modules", "sub");
		mkdirSync(moduleGitDir, { recursive: true });
		writeFileSync(join(moduleGitDir, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(
			join(moduleGitDir, "config"),
			['[remote "origin"]', "\turl = git@git.woa.com:csig/tdmq-sdk.git", ""].join("\n"),
		);
		const child = join(parent, "sub");
		mkdirSync(child);
		writeFileSync(join(child, ".git"), "gitdir: ../.git/modules/sub\n");

		const result = await saveTool(api).execute(
			"1",
			{ name: "sdk-build", description: "d", content: "c", project: true },
			undefined,
			undefined,
			createCtx({ cwd: join(child, "src") }),
		);
		assert.equal(result.details.scope, "git.woa.com/csig/tdmq-sdk");
		assert.ok(existsSync(join(libDir, "projects", "git.woa.com", "csig", "tdmq-sdk", "sdk-build.md")));
	});
});

test("resources_discover injects BOTH submodule and parent project dirs (submodule first)", async () => {
	await withExtension(async ({ api, libDir, root }) => {
		const { scaffoldLibrary } = await import("../src/lib/scaffold.ts");
		await scaffoldLibrary(libDir, { commit: false });
		const parent = makeRepo(root, "work/parent", TDMQ_ORIGIN);
		const moduleGitDir = join(parent, ".git", "modules", "sub");
		mkdirSync(moduleGitDir, { recursive: true });
		writeFileSync(join(moduleGitDir, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(
			join(moduleGitDir, "config"),
			['[remote "origin"]', "\turl = git@git.woa.com:csig/tdmq-sdk.git", ""].join("\n"),
		);
		const child = join(parent, "sub");
		mkdirSync(child);
		writeFileSync(join(child, ".git"), "gitdir: ../.git/modules/sub\n");

		const subDir = join(libDir, "projects", "git.woa.com", "csig", "tdmq-sdk");
		const parentDir = join(libDir, "projects", TDMQ_KEY);
		mkdirSync(subDir, { recursive: true });
		mkdirSync(parentDir, { recursive: true });

		const result = (await handlerFor(api, "resources_discover")(
			{ cwd: join(child, "src"), reason: "startup" },
			createCtx({ cwd: join(child, "src") }),
		)) as { skillPaths?: string[] };
		assert.deepEqual(result.skillPaths, [subDir, parentDir, join(libDir, "sop")]);
	});
});

test("sop_save defaults to the global scope (project is opt-in)", async () => {
	await withExtension(async ({ api, libDir, root }) => {
		const repo = makeRepo(root, "work/repo", TDMQ_ORIGIN);
		const result = await saveTool(api).execute(
			"1",
			{ name: "global-note", description: "d", content: "c" },
			undefined,
			undefined,
			createCtx({ cwd: repo }),
		);
		assert.equal(result.details.scope, "global");
		assert.ok(existsSync(join(libDir, "sop", "global-note.md")));
		assert.ok(!existsSync(join(libDir, "projects")), "no project dir is created implicitly");
	});
});

test("sop_save with project:true outside a git repo fails loudly, never falls back", async () => {
	await withExtension(async ({ api, libDir, root }) => {
		const { scaffoldLibrary } = await import("../src/lib/scaffold.ts");
		await scaffoldLibrary(libDir, { commit: false });
		const plain = join(root, "plain");
		mkdirSync(plain, { recursive: true });
		const result = await saveTool(api).execute(
			"1",
			{ name: "orphan", description: "d", content: "c", project: true },
			undefined,
			undefined,
			createCtx({ cwd: plain }),
		);
		assert.equal(result.details.saved, false);
		assert.equal(result.details.reason, "no-project");
		assert.match(toolText(result), /没有找到带 origin/);
		assert.ok(!existsSync(join(libDir, "sop", "orphan.md")), "must not silently write global");
	});
});

test("sop_save with project:true on a repo without origin fails loudly", async () => {
	await withExtension(async ({ api, libDir, root }) => {
		const { scaffoldLibrary } = await import("../src/lib/scaffold.ts");
		await scaffoldLibrary(libDir, { commit: false });
		const repo = makeRepo(root, "work/no-origin", null);
		const result = await saveTool(api).execute(
			"1",
			{ name: "orphan", description: "d", content: "c", project: true },
			undefined,
			undefined,
			createCtx({ cwd: repo }),
		);
		assert.equal(result.details.saved, false);
		assert.equal(result.details.reason, "no-project");
	});
});

test("duplicate-name guard: a global SOP blocks the same name in a project", async () => {
	await withExtension(async ({ api, libDir, root }) => {
		const repo = makeRepo(root, "work/repo", TDMQ_ORIGIN);
		await saveTool(api).execute(
			"1",
			{ name: "deploy", description: "global one", content: "c" },
			undefined,
			undefined,
			createCtx({ cwd: repo }),
		);
		const result = await saveTool(api).execute(
			"2",
			{ name: "deploy", description: "project one", content: "c", project: true },
			undefined,
			undefined,
			createCtx({ cwd: repo }),
		);
		assert.equal(result.details.saved, false);
		assert.equal(result.details.reason, "name-conflict");
		assert.match(toolText(result), /名称冲突/);
		assert.match(toolText(result), /全局 sop\//);
		assert.ok(
			!existsSync(join(libDir, "projects", TDMQ_KEY, "deploy.md")),
			"the conflicting project file must not be written",
		);
	});
});

test("duplicate-name guard: a project SOP blocks the same name globally", async () => {
	await withExtension(async ({ api, libDir, root }) => {
		const repo = makeRepo(root, "work/repo", TDMQ_ORIGIN);
		await saveTool(api).execute(
			"1",
			{ name: "deploy", description: "project one", content: "c", project: true },
			undefined,
			undefined,
			createCtx({ cwd: repo }),
		);
		const result = await saveTool(api).execute(
			"2",
			{ name: "deploy", description: "global one", content: "c" },
			undefined,
			undefined,
			createCtx({ cwd: repo }),
		);
		assert.equal(result.details.saved, false);
		assert.equal(result.details.reason, "name-conflict");
		assert.match(toolText(result), /项目 git\.woa\.com\/csig_tdmq\/tdmq-appserver/);
		// the suggested rename uses the project short name
		assert.match(toolText(result), /tdmq-appserver-deploy/);
		assert.ok(!existsSync(join(libDir, "sop", "deploy.md")));
	});
});

test("duplicate-name guard: a name already used by another project is refused too", async () => {
	await withExtension(async ({ api, root }) => {
		const repoA = makeRepo(root, "work/a", "git@git.woa.com:csig_tdmq/tdmq-appserver.git");
		const repoB = makeRepo(root, "work/b", "git@git.woa.com:csig/other-service.git");
		await saveTool(api).execute(
			"1",
			{ name: "deploy", description: "a", content: "c", project: true },
			undefined,
			undefined,
			createCtx({ cwd: repoA }),
		);
		const second = await saveTool(api).execute(
			"2",
			{ name: "deploy", description: "b", content: "c", project: true },
			undefined,
			undefined,
			createCtx({ cwd: repoB }),
		);
		// The skill name is global across the loader, so a cross-project clash is
		// still a silent drop — refuse it.
		assert.equal(second.details.saved, false);
		assert.equal(second.details.reason, "name-conflict");
	});
});

test("re-saving the same SOP project:true updates in place (guard allows the same path)", async () => {
	await withExtension(async ({ api, libDir, root }) => {
		const repo = makeRepo(root, "work/repo", TDMQ_ORIGIN);
		const params = { name: "tdmq-deploy", description: "v1", content: "c", project: true };
		await saveTool(api).execute("1", params, undefined, undefined, createCtx({ cwd: repo }));
		const second = await saveTool(api).execute(
			"2",
			{ ...params, description: "v2" },
			undefined,
			undefined,
			createCtx({ cwd: repo }),
		);
		assert.equal(second.details.saved, true);
		assert.match(toolText(second), /已更新/);
		assert.match(runGit(libDir, ["log", "--pretty=%s"]), /docs: update SOP tdmq-deploy/);
	});
});

test("/sop <keyword> finds project SOPs and labels their scope", async () => {
	await withExtension(async ({ api, libDir, root }) => {
		const repo = makeRepo(root, "work/repo", TDMQ_ORIGIN);
		await saveTool(api).execute(
			"1",
			{ name: "tdmq-deploy", description: "USE FOR deploying tdmq", content: "1. step", project: true },
			undefined,
			undefined,
			createCtx({ cwd: repo }),
		);
		await saveTool(api).execute(
			"2",
			{ name: "global-redis", description: "d", content: "c" },
			undefined,
			undefined,
			createCtx({ cwd: repo }),
		);

		const notifies: FakeNotifies = { messages: [] };
		await sopCommand(api).handler("deploy", createCtx({ mode: "print", notifies }));
		const text = notifies.messages.map((m) => m.text).join("\n");
		assert.match(text, /tdmq-deploy\s+\[项目: git\.woa\.com\/csig_tdmq\/tdmq-appserver\]/);
		assert.match(text, new RegExp(join(libDir, "projects", TDMQ_KEY, "tdmq-deploy.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});
});

test("session_start warns once about a hand-made duplicate name, without prompting", async () => {
	await withExtension(async ({ api, libDir, root }) => {
		const { scaffoldLibrary } = await import("../src/lib/scaffold.ts");
		await scaffoldLibrary(libDir, { commit: false });
		const repo = makeRepo(root, "work/repo", TDMQ_ORIGIN);
		await saveTool(api).execute(
			"1",
			{ name: "deploy", description: "global", content: "c" },
			undefined,
			undefined,
			createCtx({ cwd: repo }),
		);
		// A human bypasses sop_save: same frontmatter name, different file.
		const projectDir = join(libDir, "projects", TDMQ_KEY);
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "manual.md"), "---\nname: deploy\ndescription: manual\n---\n\nx\n");

		const notifies: FakeNotifies = { messages: [] };
		const handler = handlerFor(api, "session_start");
		await handler({ reason: "startup" }, createCtx({ notifies }));
		await handler({ reason: "resume" }, createCtx({ notifies }));

		const warnings = notifies.messages.filter((m) => /重名 SOP/.test(m.text));
		assert.equal(warnings.length, 1, "one warn per process, even across resume");
		assert.match(warnings[0]?.text ?? "", /deploy/);
		assert.match(warnings[0]?.text ?? "", /global/);
		assert.match(warnings[0]?.text ?? "", new RegExp(TDMQ_KEY.replace(/\./g, "\\.")));
	});
});

test("session_start stays silent when there are no duplicates", async () => {
	await withExtension(async ({ api, libDir }) => {
		const { scaffoldLibrary } = await import("../src/lib/scaffold.ts");
		await scaffoldLibrary(libDir, { commit: false });
		const notifies: FakeNotifies = { messages: [] };
		await handlerFor(api, "session_start")({ reason: "startup" }, createCtx({ notifies }));
		assert.equal(
			notifies.messages.filter((m) => /重名 SOP/.test(m.text)).length,
			0,
		);
	});
});

test("a library whose only SOP is project-scoped still serves it as a skill path", async () => {
	await withExtension(async ({ api, libDir, root }) => {
		// No global sop/ dir at all: probe must say ready (projects/ is legal
		// structure) and resources_discover must still hand out a path.
		mkdirSync(libDir, { recursive: true });
		runGit(libDir, ["init", "-q", "-b", "main"]);
		const repo = makeRepo(root, "work/repo", TDMQ_ORIGIN);
		const projectDir = join(libDir, "projects", TDMQ_KEY);
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "only.md"), "---\nname: only-project\ndescription: d\n---\n");

		assert.equal(probeLibrary(libDir).state, "no-remote");
		const result = (await handlerFor(api, "resources_discover")(
			{ cwd: repo, reason: "startup" },
			createCtx({ cwd: repo }),
		)) as { skillPaths?: string[] };
		assert.deepEqual(result.skillPaths, [projectDir]);
	});
});

test("sop_save project:true works when the library is reached through a symlink", async () => {
	await withExtension(async ({ api, root }) => {
		const realLib = join(root, "real-lib");
		const linkLib = join(root, "link-lib");
		mkdirSync(realLib, { recursive: true });
		symlinkSync(realLib, linkLib);
		process.env.PI_SOP_DIR = linkLib;
		const repo = makeRepo(root, "work/repo", TDMQ_ORIGIN);

		const result = await saveTool(api).execute(
			"1",
			{ name: "via-link", description: "d", content: "c", project: true },
			undefined,
			undefined,
			createCtx({ cwd: repo }),
		);
		assert.equal(result.details.saved, true);
		assert.ok(existsSync(join(realLib, "projects", TDMQ_KEY, "via-link.md")));
		// The commit must record a library-relative path, not an absolute one.
		const files = runGit(realLib, ["show", "--name-only", "--pretty=format:", "HEAD"]);
		assert.match(files, /^MANIFEST\.md$/m);
		assert.match(files, new RegExp(`^projects/${TDMQ_KEY}/via-link\.md$`, "m"));
	});
});

test("/sop status reports the number of project scopes", async () => {
	await withExtension(async ({ api, root }) => {
		const repo = makeRepo(root, "work/repo", TDMQ_ORIGIN);
		await saveTool(api).execute(
			"1",
			{ name: "tdmq-deploy", description: "d", content: "c", project: true },
			undefined,
			undefined,
			createCtx({ cwd: repo }),
		);
		const notifies: FakeNotifies = { messages: [] };
		await sopCommand(api).handler("status", createCtx({ mode: "print", notifies }));
		const text = notifies.messages.map((m) => m.text).join("\n");
		assert.match(text, /项目专属: 1 个项目目录/);
		assert.match(text, /SOP 数量: 2/, "both the project SOP and the seed are counted");
	});
});
