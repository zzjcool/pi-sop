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
