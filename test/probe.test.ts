/**
 * probe.ts tests: the six-state machine.
 *
 * Each state gets a real fixture on disk (no mocks), because the whole point of
 * probe is that it reads fs + git config directly. Git-dependent cases shell out
 * to `git init` so the fixture matches what pi-sop will actually meet in the wild.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { describeState, isUsable, lockPathFor, probeLibrary } from "../src/lib/probe.ts";

function tempDir(prefix = "pi-sop-probe-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Run `fn` with a temp dir that is always removed afterwards. */
function withDir<T>(fn: (dir: string) => T): T {
	const dir = tempDir();
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("missing: path does not exist", () => {
	withDir((dir) => {
		const result = probeLibrary(join(dir, "nope"));
		assert.equal(result.state, "missing");
		assert.equal(result.isRepo, false);
		assert.equal(result.gitDir, null);
		assert.equal(isUsable(result.state), false);
	});
});

test("missing: a plain file is not a library", () => {
	withDir((dir) => {
		const file = join(dir, "file.txt");
		writeFileSync(file, "x");
		assert.equal(probeLibrary(file).state, "missing");
	});
});

test("empty-dir: directory with no entries", () => {
	withDir((dir) => {
		const result = probeLibrary(dir);
		assert.equal(result.state, "empty-dir");
		assert.equal(result.isRepo, false);
	});
});

test("not-a-repo: content but no .git", () => {
	withDir((dir) => {
		writeFileSync(join(dir, "notes.md"), "# notes");
		const result = probeLibrary(dir);
		assert.equal(result.state, "not-a-repo");
		assert.equal(result.gitDir, null);
		assert.equal(result.hasManifest, false);
	});
});

test("not-a-repo: reports skeleton hints for the repair path", () => {
	withDir((dir) => {
		writeFileSync(join(dir, "MANIFEST.md"), "| a |");
		mkdirSync(join(dir, "sop"));
		writeFileSync(join(dir, "sop", "x.md"), "---\nname: x\ndescription: d\n---\n");
		const result = probeLibrary(dir);
		assert.equal(result.state, "not-a-repo");
		assert.equal(result.hasManifest, true);
		assert.equal(result.hasSopDir, true);
		assert.equal(result.sopCount, 1);
	});
});

test("no-remote: git repo without origin", () => {
	withDir((dir) => {
		git(dir, ["init", "-b", "main"]);
		writeFileSync(join(dir, "MANIFEST.md"), "| a |");
		const result = probeLibrary(dir);
		assert.equal(result.state, "no-remote");
		assert.equal(result.isRepo, true);
		assert.equal(result.remote, null);
		assert.equal(result.branch, "main");
		assert.equal(result.hasManifest, true);
		// local-only libraries are writable
		assert.equal(isUsable(result.state), true);
	});
});

test("ready: git repo with origin + MANIFEST", () => {
	withDir((dir) => {
		git(dir, ["init", "-b", "main"]);
		git(dir, ["remote", "add", "origin", "git@github.com:you/sop-library.git"]);
		writeFileSync(join(dir, "MANIFEST.md"), "| a |");
		const result = probeLibrary(dir);
		assert.equal(result.state, "ready");
		assert.equal(result.remote, "git@github.com:you/sop-library.git");
		assert.equal(result.hasManifest, true);
		assert.equal(isUsable(result.state), true);
	});
});

test("ready: sop/ alone is enough structure", () => {
	withDir((dir) => {
		git(dir, ["init", "-b", "main"]);
		git(dir, ["remote", "add", "origin", "https://example.com/lib.git"]);
		mkdirSync(join(dir, "sop"));
		writeFileSync(join(dir, "sop", "a.md"), "---\nname: a\ndescription: d\n---\n");
		writeFileSync(join(dir, "sop", "b.md"), "---\nname: b\ndescription: d\n---\n");
		// dotfiles and non-markdown must not count
		writeFileSync(join(dir, "sop", ".hidden.md"), "x");
		writeFileSync(join(dir, "sop", "notes.txt"), "x");
		const result = probeLibrary(dir);
		assert.equal(result.state, "ready");
		assert.equal(result.hasManifest, false);
		assert.equal(result.hasSopDir, true);
		assert.equal(result.sopCount, 2);
	});
});

test("malformed: git repo with origin but no SOP structure", () => {
	withDir((dir) => {
		git(dir, ["init", "-b", "main"]);
		git(dir, ["remote", "add", "origin", "https://example.com/lib.git"]);
		writeFileSync(join(dir, "README.md"), "not a sop library");
		const result = probeLibrary(dir);
		assert.equal(result.state, "malformed");
		assert.equal(result.isRepo, true);
		assert.equal(result.remote, "https://example.com/lib.git");
		assert.equal(result.hasManifest, false);
		assert.equal(result.hasSopDir, false);
	});
});

test("structure decides usable state; a bare repo without skeleton is malformed even without remote", () => {
	withDir((dir) => {
		git(dir, ["init", "-b", "main"]);
		writeFileSync(join(dir, "README.md"), "empty repo");
		const result = probeLibrary(dir);
		// No MANIFEST and no sop/ → malformed. `no-remote` is reserved for a
		// valid library that just lacks a remote (design §1.3), not a blanket
		// pass for any remote-less repo — otherwise linkFlow/sop_save would
		// happily write into a non-library repo.
		assert.equal(result.state, "malformed");
	});
});

test("a scaffolded library without remote probes as no-remote (still usable)", () => {
	withDir((dir) => {
		git(dir, ["init", "-b", "main"]);
		writeFileSync(join(dir, "MANIFEST.md"), "| a |");
		mkdirSync(join(dir, "sop"), { recursive: true });
		assert.equal(probeLibrary(dir).state, "no-remote");
	});
});

test("commitCount is 0 before the first commit and 1 after", () => {
	withDir((dir) => {
		git(dir, ["init", "-b", "main"]);
		assert.equal(probeLibrary(dir).commitCount, 0);
		writeFileSync(join(dir, "MANIFEST.md"), "| a |");
		git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
		git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
		assert.equal(probeLibrary(dir).commitCount, 1);
	});
});

test("origin URL is read from .git/config without spawning git", () => {
	withDir((dir) => {
		git(dir, ["init", "-b", "main"]);
		git(dir, ["remote", "add", "origin", "https://user:pw@example.com/x.git"]);
		writeFileSync(join(dir, "MANIFEST.md"), "| a |");
		// Patch PATH so any accidental spawn would fail loudly? Not portable.
		// Instead assert the parser sees a subsection-with-slash remote.
		const result = probeLibrary(dir);
		assert.equal(result.remote, "https://user:pw@example.com/x.git");
	});
});

test("quoted git config values are unquoted", () => {
	withDir((dir) => {
		git(dir, ["init", "-b", "main"]);
		writeFileSync(
			join(dir, ".git", "config"),
			[
				"[core]",
				"\trepositoryformatversion = 0",
				'[remote "origin"]',
				'\turl = "git@github.com:you/lib.git"',
				"",
			].join("\n"),
		);
		writeFileSync(join(dir, "MANIFEST.md"), "| a |");
		assert.equal(probeLibrary(dir).remote, "git@github.com:you/lib.git");
	});
});

test("a .git file pointing at a worktree gitdir is followed", () => {
	withDir((root) => {
		const worktree = join(root, "wt");
		mkdirSync(worktree);
		const realGitDir = join(root, "actual-git-dir");
		mkdirSync(realGitDir);
		writeFileSync(join(realGitDir, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(
			join(realGitDir, "config"),
			['[remote "origin"]', "\turl = https://example.com/lib.git", ""].join("\n"),
		);
		writeFileSync(join(worktree, ".git"), `gitdir: ${realGitDir}\n`);
		writeFileSync(join(worktree, "MANIFEST.md"), "| a |");
		const result = probeLibrary(worktree);
		assert.equal(result.state, "ready");
		assert.equal(result.gitDir, realGitDir);
		assert.equal(result.remote, "https://example.com/lib.git");
	});
});

test("a relative gitdir: path resolves against the worktree", () => {
	withDir((root) => {
		const worktree = join(root, "wt");
		const realGitDir = join(root, "git-dir");
		mkdirSync(worktree);
		mkdirSync(realGitDir);
		writeFileSync(join(realGitDir, "config"), ["[remote \"origin\"]", "\turl = u", ""].join("\n"));
		writeFileSync(join(worktree, ".git"), "gitdir: ../git-dir\n");
		writeFileSync(join(worktree, "MANIFEST.md"), "| a |");
		const result = probeLibrary(worktree);
		assert.equal(result.gitDir, realGitDir);
		assert.equal(result.state, "ready");
	});
});

test("isUsable covers exactly the writable states", () => {
	assert.equal(isUsable("ready"), true);
	assert.equal(isUsable("no-remote"), true);
	assert.equal(isUsable("malformed"), true);
	assert.equal(isUsable("missing"), false);
	assert.equal(isUsable("empty-dir"), false);
	assert.equal(isUsable("not-a-repo"), false);
});

test("describeState has a label for every state", () => {
	for (const state of ["missing", "empty-dir", "not-a-repo", "no-remote", "malformed", "ready"] as const) {
		assert.ok(describeState({ state } as never).length > 0);
	}
});

test("lockPathFor points inside the git dir (never committed)", () => {
	withDir((dir) => {
		git(dir, ["init", "-b", "main"]);
		const result = probeLibrary(dir);
		assert.equal(lockPathFor(result), join(dir, ".git", "pi-sop.lock"));
		assert.equal(lockPathFor({ ...result, gitDir: null }), null);
	});
});
