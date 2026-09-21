/**
 * commands/init.ts tests: argument parsing and the non-destructive guards.
 *
 * The wizard itself is TUI-driven (`ctx.ui.select` / `confirm` / `input`) and is
 * covered by the manual checklist in the report; what is worth unit-testing is
 * the pure logic that decides whether the wizard may touch a path at all, plus
 * the non-interactive argument contract (design §3.5).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertCloneTargetUsable,
	assertCreatable,
	parseInitArgs,
	toHttpsUrl,
	tokenize,
} from "../src/commands/init.ts";

function withDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-sop-init-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("no arguments → the interactive wizard", () => {
	assert.deepEqual(parseInitArgs(""), { mode: "wizard" });
	assert.deepEqual(parseInitArgs("   "), { mode: "wizard" });
});

test("--clone requires a URL", () => {
	const missing = parseInitArgs("--clone");
	assert.equal(missing.mode, "clone");
	assert.ok(missing.error?.includes("--clone"));

	const withUrl = parseInitArgs("--clone git@github.com:you/sop-library.git");
	assert.equal(withUrl.mode, "clone");
	assert.equal(withUrl.value, "git@github.com:you/sop-library.git");
	assert.equal(withUrl.error, undefined);
});

test("--clone accepts a quoted URL with spaces preserved", () => {
	const parsed = parseInitArgs(`--clone "https://example.com/a b.git"`);
	assert.equal(parsed.value, "https://example.com/a b.git");
});

test("--local works with and without a path", () => {
	assert.deepEqual(parseInitArgs("--local"), { mode: "local", value: undefined });
	const withPath = parseInitArgs("--local ~/my-sops");
	assert.equal(withPath.mode, "local");
	assert.equal(withPath.value, "~/my-sops");
});

test("--link requires a path", () => {
	const missing = parseInitArgs("--link");
	assert.equal(missing.mode, "link");
	assert.ok(missing.error?.includes("--link"));
	assert.equal(parseInitArgs("--link /tmp/lib").value, "/tmp/lib");
});

test("--disable takes no arguments", () => {
	assert.deepEqual(parseInitArgs("--disable"), { mode: "disable" });
});

test("unknown flags are reported instead of silently ignored", () => {
	const parsed = parseInitArgs("--wat");
	assert.equal(parsed.mode, "wizard");
	assert.match(parsed.error ?? "", /未知参数/);
});

test("tokenize respects single and double quotes", () => {
	assert.deepEqual(tokenize(`a "b c" 'd e' f`), ["a", "b c", "d e", "f"]);
	assert.deepEqual(tokenize(""), []);
	assert.deepEqual(tokenize("   spaced   out  "), ["spaced", "out"]);
});

test("toHttpsUrl converts scp-style SSH URLs", () => {
	assert.equal(toHttpsUrl("git@github.com:you/sop-library.git"), "https://github.com/you/sop-library.git");
	assert.equal(toHttpsUrl("git@github.com:you/sop-library"), "https://github.com/you/sop-library");
	// already-https URLs are left alone
	assert.equal(toHttpsUrl("https://github.com/you/x.git"), "https://github.com/you/x.git");
});

test("assertCloneTargetUsable accepts a missing or empty dir", () => {
	withDir((dir) => {
		assert.doesNotThrow(() => assertCloneTargetUsable(join(dir, "fresh")));
		const empty = join(dir, "empty");
		mkdirSync(empty);
		assert.doesNotThrow(() => assertCloneTargetUsable(empty));
	});
});

test("assertCloneTargetUsable refuses a non-empty dir (never overwrites)", () => {
	withDir((dir) => {
		writeFileSync(join(dir, "existing.md"), "precious");
		assert.throws(() => assertCloneTargetUsable(dir), /拒绝覆盖/);
	});
});

test("assertCreatable accepts a missing dir or an existing empty one", () => {
	withDir((dir) => {
		assert.doesNotThrow(() => assertCreatable(join(dir, "new")));
		const empty = join(dir, "empty");
		mkdirSync(empty);
		assert.doesNotThrow(() => assertCreatable(empty));
	});
});

test("assertCreatable refuses a non-empty directory", () => {
	withDir((dir) => {
		writeFileSync(join(dir, "x.md"), "content");
		assert.throws(() => assertCreatable(dir), /已存在且非空/);
	});
});

test("assertCreatable refuses a path occupied by a file", () => {
	withDir((dir) => {
		const file = join(dir, "not-a-dir");
		writeFileSync(file, "x");
		assert.throws(() => assertCreatable(file), /已被文件占用/);
	});
});

test("assertCreatable refuses an existing populated SOP library (use --link)", () => {
	withDir((dir) => {
		// a library-shaped dir is "not empty", so --local must redirect the user
		writeFileSync(join(dir, "MANIFEST.md"), "| name |");
		mkdirSync(join(dir, "sop"));
		assert.throws(() => assertCreatable(dir), /已存在且非空/);
	});
});

// ---------------------------------------------------------------------------
// Wizard interaction branches via a scriptable fake ctx (review finding:
// zero coverage of the ctx.ui.select/confirm/input decision paths).
// ---------------------------------------------------------------------------

import { runInit as _runInit, cloneFlow, linkFlow } from "../src/commands/init.ts";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createSandbox } from "./helpers.ts";

interface ScriptedCtx {
	mode: string;
	hasUI: boolean;
	ui: {
		select: (title: string, options: string[]) => Promise<string | undefined>;
		confirm: (title: string, message: string) => Promise<boolean>;
		input: (title: string, placeholder?: string) => Promise<string | undefined>;
		notify: (message: string, level: string) => void;
	};
	reload: () => Promise<void>;
	reloaded: boolean;
	notifications: string[];
}

/** Fake command ctx with pre-scripted answers, consumed in call order. */
function scriptedCtx(options: {
	selects?: (string | undefined)[];
	confirms?: boolean[];
	inputs?: (string | undefined)[];
	mode?: string;
}): ScriptedCtx {
	let selectIdx = 0;
	let confirmIdx = 0;
	let inputIdx = 0;
	const ctx: ScriptedCtx = {
		mode: options.mode ?? "tui",
		hasUI: true,
		reloaded: false,
		notifications: [],
		ui: {
			async select(_title, _opts) {
				return options.selects?.[selectIdx++];
			},
			async confirm(_title, _message) {
				return options.confirms?.[confirmIdx++] ?? false;
			},
			async input(_title, _placeholder) {
				return options.inputs?.[inputIdx++];
			},
			notify(message, _level) {
				ctx.notifications.push(message);
			},
		},
		async reload() {
			ctx.reloaded = true;
		},
	};
	return ctx;
}

test("wizard: disable branch writes enabled=false and skips reload", async () => {
	const sandbox = createSandbox("pi-sop-wiz-disable-");
	process.env.PI_SOP_DIR = join(sandbox.root, "missing-lib");
	try {
		const ctx = scriptedCtx({ selects: ["4. 暂不使用 pi-sop"] });
		await _runInit({ mode: "wizard" }, ctx as never);
		assert.ok(ctx.notifications.some((n) => n.includes("已禁用")));
		const config = JSON.parse(
			readFileSync(join(sandbox.agentDir, "pi-sop.json"), "utf8") as string,
		) as { enabled?: boolean };
		assert.equal(config.enabled, false);
		// Disable must NOT reload — nothing to re-discover.
		assert.equal(ctx.reloaded, false);
	} finally {
		sandbox.cleanup();
	}
});

test("wizard: user cancels the main menu — disk untouched", async () => {
	const sandbox = createSandbox("pi-sop-wiz-cancel-");
	const libDir = join(sandbox.root, "missing-lib");
	process.env.PI_SOP_DIR = libDir;
	try {
		const ctx = scriptedCtx({ selects: [undefined] });
		await _runInit({ mode: "wizard" }, ctx as never);
		assert.equal(existsSync(libDir), false);
		assert.equal(ctx.reloaded, false);
	} finally {
		sandbox.cleanup();
	}
});

test("wizard: not-a-repo confirm-no leaves the directory alone", async () => {
	const sandbox = createSandbox("pi-sop-wiz-notrepo-");
	const libDir = join(sandbox.root, "has-files");
	process.env.PI_SOP_DIR = libDir;
	mkdirSync(libDir, { recursive: true });
	writeFileSync(join(libDir, "random.txt"), "data");
	try {
		const ctx = scriptedCtx({ confirms: [false] });
		await _runInit({ mode: "wizard" }, ctx as never);
		assert.deepEqual(readdirSync(libDir), ["random.txt"]);
	} finally {
		sandbox.cleanup();
	}
});

test("wizard: not-a-repo confirm-yes scaffolds and finishes with reload", async () => {
	const sandbox = createSandbox("pi-sop-wiz-notrepo-yes-");
	const libDir = join(sandbox.root, "has-files");
	process.env.PI_SOP_DIR = libDir;
	mkdirSync(libDir, { recursive: true });
	writeFileSync(join(libDir, "random.txt"), "data");
	try {
		const ctx = scriptedCtx({ confirms: [true] });
		await _runInit({ mode: "wizard" }, ctx as never);
		assert.equal(ctx.reloaded, true, "finish() must reload so skillPaths register");
		assert.ok(existsSync(join(libDir, "MANIFEST.md")));
		assert.ok(existsSync(join(libDir, "sop", "writing-sops.md")));
	} finally {
		sandbox.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Review round 2: retry-limit pin, linkFlow malformed guard, remote error text
// ---------------------------------------------------------------------------

test("cloneFlow non-interactive: unreachable remote throws immediately (no retry loop)", async () => {
	const sandbox = createSandbox("pi-sop-clone-nonint-");
	process.env.PI_SOP_DIR = join(sandbox.root, "lib");
	try {
		const ctx = scriptedCtx({ mode: "print" });
		ctx.hasUI = false;
		await assert.rejects(
			cloneFlow("git@127.0.0.1:1/definitely/unreachable.git", ctx as never),
			/远端不可用|不可达|unreachable|失败|无法/,
		);
	} finally {
		sandbox.cleanup();
	}
});

test("linkFlow non-interactive: malformed repo must fail loudly, never silently scaffold", async () => {
	const sandbox = createSandbox("pi-sop-link-malformed-");
	const libDir = join(sandbox.root, "lib");
	process.env.PI_SOP_DIR = join(sandbox.root, "elsewhere");
	// Build a repo that has commits but no MANIFEST.md and no sop/ dir.
	mkdirSync(libDir, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: libDir });
	writeFileSync(join(libDir, "some-file.txt"), "existing content\n");
	execFileSync("git", ["add", "some-file.txt"], { cwd: libDir });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: libDir });
	try {
		const ctx = scriptedCtx({ mode: "print" });
		ctx.hasUI = false;
		await assert.rejects(
			linkFlow(libDir, ctx as never, { interactive: false }),
			/缺少 SOP 库结构/,
		);
		// The user's file must be untouched, no scaffold committed.
		assert.ok(existsSync(join(libDir, "some-file.txt")));
		assert.equal(existsSync(join(libDir, "MANIFEST.md")), false);
	} finally {
		sandbox.cleanup();
	}
});

test("summarizeRemoteError: SSH / auth / missing-repo families are distinguishable", async () => {
	const { summarizeRemoteError } = await import("../src/lib/remote.ts");
	const mk = (stderr: string) =>
		({ ok: false, code: 128, stdout: "", stderr, timedOut: false, command: "" }) as never;
	assert.match(String(summarizeRemoteError("git@github.com:you/lib.git", mk("Permission denied (publickey)"))), /SSH|密钥/);
	assert.match(String(summarizeRemoteError("https://github.com/you/lib.git", mk("Authentication failed for 'https://github.com/you/lib.git'"))), /凭证|认证|凭据/);
	assert.match(String(summarizeRemoteError("https://github.com/you/lib.git", mk("Repository not found."))), /不存在|not found|仓库/);
});
