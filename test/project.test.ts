/**
 * project.ts tests: project-key normalization + upward .git discovery.
 *
 * Every fixture is a real directory tree (and real git repos for the discovery
 * cases) because the entire point of this module is reading the filesystem the
 * way git does — a mock would only test the mock.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	existingProjectDirs,
	normalizeProjectKey,
	projectDir,
	projectKeyForRepo,
	PROJECTS_DIR,
	resolveProjectKeys,
} from "../src/lib/project.ts";

function withRoot<T>(fn: (root: string) => T): T {
	const root = mkdtempSync(join(tmpdir(), "pi-sop-project-"));
	try {
		return fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A git repo at `dir` with an origin URL. */
function repoAt(dir: string, origin: string): void {
	mkdirSync(dir, { recursive: true });
	git(dir, ["init", "-q", "-b", "main"]);
	git(dir, ["remote", "add", "origin", origin]);
}

test("all five URL variants of one repository collapse to the same key", () => {
	const expected = "git.woa.com/csig_tdmq/tdmq-appserver";
	const variants = [
		"git@git.woa.com:csig_tdmq/tdmq-appserver.git",
		"ssh://git@git.woa.com/csig_tdmq/tdmq-appserver.git",
		"https://git.woa.com/csig_tdmq/tdmq-appserver.git",
		"git://git.woa.com/csig_tdmq/tdmq-appserver",
		"git@GIT.WOA.COM:csig_tdmq/tdmq-appserver.git",
	];
	for (const variant of variants) {
		assert.equal(normalizeProjectKey(variant), expected, variant);
	}
});

test("normalizeProjectKey strips .git, trailing slashes and whitespace", () => {
	assert.equal(normalizeProjectKey("  https://example.com/org/repo.git  "), "example.com/org/repo");
	assert.equal(normalizeProjectKey("https://example.com/org/repo/"), "example.com/org/repo");
});

test("normalizeProjectKey drops credentials and ports (same repo, different access)", () => {
	assert.equal(normalizeProjectKey("https://user:pw@example.com/org/repo.git"), "example.com/org/repo");
	assert.equal(normalizeProjectKey("ssh://git@example.com:2222/org/repo.git"), "example.com/org/repo");
});

test("normalizeProjectKey ignores query strings and fragments", () => {
	assert.equal(normalizeProjectKey("https://example.com/org/repo.git?ref=main"), "example.com/org/repo");
});

test("normalizeProjectKey refuses values without a host/path pair", () => {
	assert.equal(normalizeProjectKey(""), null);
	assert.equal(normalizeProjectKey("   "), null);
	assert.equal(normalizeProjectKey("just-a-name"), null);
	assert.equal(normalizeProjectKey("/local/path/to/repo"), null);
	// a key becomes a directory name: never allow traversal segments
	assert.equal(normalizeProjectKey("https://example.com/org/../etc"), null);
});

test("projectKeyForRepo returns null for a repo with no origin", () => {
	withRoot((root) => {
		const dir = join(root, "no-origin");
		mkdirSync(dir);
		git(dir, ["init", "-q", "-b", "main"]);
		assert.equal(projectKeyForRepo(dir), null);
	});
});

test("projectKeyForRepo returns null for a non-git directory", () => {
	withRoot((root) => {
		assert.equal(projectKeyForRepo(root), null);
	});
});

test("resolveProjectKeys walks up from a nested subdirectory", () => {
	withRoot((root) => {
		const repo = join(root, "work", "repo");
		repoAt(repo, "git@git.woa.com:csig_tdmq/tdmq-appserver.git");
		const nested = join(repo, "src", "deep", "nested");
		mkdirSync(nested, { recursive: true });
		// regression guard for the bug this module exists to fix: `resolveGitDir`
		// on the nested dir finds nothing.
		assert.deepEqual(resolveProjectKeys(nested), ["git.woa.com/csig_tdmq/tdmq-appserver"]);
	});
});

test("resolveProjectKeys stops at $HOME and ignores repos above it", () => {
	withRoot((root) => {
		const home = join(root, "home");
		// A dotfiles-style repo at the root of the fake home must NOT be picked
		// up by a shell sitting in a subdirectory of home.
		repoAt(home, "git@example.com:me/dotfiles.git");
		const nested = join(home, "scratch", "nothing-here");
		mkdirSync(nested, { recursive: true });
		assert.deepEqual(resolveProjectKeys(nested, home), []);

		// …and the repo below home still wins.
		const project = join(home, "work", "repo");
		repoAt(project, "git@example.com:org/proj.git");
		const deep = join(project, "a", "b");
		mkdirSync(deep, { recursive: true });
		assert.deepEqual(resolveProjectKeys(deep, home), ["example.com/org/proj"]);
	});
});

test("resolveProjectKeys terminates at the filesystem root", () => {
	// '/tmp' has no .git above it on any sane machine; the call must simply
	// return (empty or not) without looping forever.
	const keys = resolveProjectKeys("/tmp");
	assert.ok(Array.isArray(keys));
});

test("resolveProjectKeys collects BOTH keys for a submodule working dir", () => {
	withRoot((root) => {
		// Minimal submodule layout: the parent repo, and a child dir whose `.git`
		// is a file pointing into the parent's module storage — which is exactly
		// what a real `git submodule add` produces.
		const parent = join(root, "parent");
		repoAt(parent, "git@git.woa.com:csig_tdmq/tdmq-appserver.git");
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
		const deeper = join(child, "src");
		mkdirSync(deeper);

		// Submodule (most specific) first, then the parent project.
		assert.deepEqual(resolveProjectKeys(deeper), [
			"git.woa.com/csig/tdmq-sdk",
			"git.woa.com/csig_tdmq/tdmq-appserver",
		]);
	});
});

test("resolveProjectKeys de-duplicates a worktree that maps to its parent key", () => {
	withRoot((root) => {
		const repo = join(root, "repo");
		repoAt(repo, "git@host:org/repo.git");
		const linked = join(repo, "linked");
		mkdirSync(linked, { recursive: true });
		// `.git` file pointing back at the same repo → same key, must appear once.
		writeFileSync(join(linked, ".git"), `gitdir: ${join(repo, ".git")}\n`);
		assert.deepEqual(resolveProjectKeys(linked), ["host/org/repo"]);
	});
});

test("existingProjectDirs returns only directories that exist, most specific first", () => {
	withRoot((root) => {
		const lib = join(root, "lib");
		const repo = join(root, "work", "repo");
		repoAt(repo, "git@git.woa.com:csig_tdmq/tdmq-appserver.git");
		const nested = join(repo, "pkg");
		mkdirSync(nested, { recursive: true });

		assert.deepEqual(existingProjectDirs(lib, nested), [], "nothing written yet");

		const project = projectDir(lib, "git.woa.com/csig_tdmq/tdmq-appserver");
		mkdirSync(project, { recursive: true });
		assert.deepEqual(existingProjectDirs(lib, nested), [project]);
	});
});

test("projectDir keeps the `/` of the key as real path separators", () => {
	withRoot((root) => {
		const dir = projectDir(root, "git.woa.com/csig_tdmq/tdmq-appserver");
		assert.equal(dir, join(root, PROJECTS_DIR, "git.woa.com", "csig_tdmq", "tdmq-appserver"));
	});
});

test("projectDir resolves symlinked libraries to one canonical path", () => {
	withRoot((root) => {
		const real = join(root, "real-lib");
		mkdirSync(join(real, PROJECTS_DIR, "host", "org"), { recursive: true });
		const link = join(root, "link-lib");
		symlinkSync(real, link);
		assert.equal(projectDir(link, "host/org/repo"), projectDir(real, "host/org/repo"));
	});
});
