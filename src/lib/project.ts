/**
 * pi-sop project keys: map the *current* working directory to a project-scoped
 * SOP directory inside the library.
 *
 * Layout (backward compatible — old libraries without `projects/` are
 * unaffected):
 *
 *   <libDir>/
 *   ├── MANIFEST.md
 *   ├── sop/                          ← global SOPs (unchanged)
 *   └── projects/<project-key>/<name>.md
 *
 *   <project-key> = normalized remote origin URL, e.g.
 *   `git.woa.com/csig_tdmq/tdmq-appserver`
 *
 * Design decisions (confirmed, do not re-litigate):
 *   - the key is the normalized origin URL, NOT a short name: two different
 *     hosts can both own `foo/bar`, and a short name would silently merge them
 *   - `/` inside the key is kept: POSIX paths allow it and `ls projects/` then
 *     groups by host/organization for free
 *   - `origin` only; no origin ⇒ no project key (degrade to global-only)
 *
 * Everything here is pure `node:fs`, zero spawn, zero network, sub-millisecond:
 * it runs on `resources_discover` (startup/reload path) and on every
 * `sop_save`.
 */

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { readOriginUrlFromGitDir, resolveCommonGitDir, resolveGitDir } from "./probe.ts";

/** Directory name holding project-scoped SOPs, relative to the library root. */
export const PROJECTS_DIR = "projects";

/**
 * Normalize a remote URL into a project key.
 *
 * Verified against five real-world variants of the same repository; all five
 * must collapse to `git.woa.com/csig_tdmq/tdmq-appserver`:
 *
 *   git@git.woa.com:csig_tdmq/tdmq-appserver.git
 *   ssh://git@git.woa.com/csig_tdmq/tdmq-appserver.git
 *   https://git.woa.com/csig_tdmq/tdmq-appserver.git
 *   git://git.woa.com/csig_tdmq/tdmq-appserver
 *   git@GIT.WOA.COM:csig_tdmq/tdmq-appserver.git
 *
 * Returns null when the URL carries no usable host/path (then there is no
 * project key and the caller falls back to global-only behavior).
 */
export function normalizeProjectKey(url: string): string | null {
	let rest = url.trim();
	if (!rest) return null;
	// A bare local path is not a remote URL: its key would differ on every
	// machine that has the same repo checked out, which defeats the purpose of
	// a shared project key. (This also catches `file://` URLs, whose host is
	// empty and which end up looking like an absolute path here.)
	if (/^(\/|\.\.?\/)/.test(rest)) return null;

	// scp-like syntax first: `git@host:path` — the colon is not a port here, so
	// it must be handled before generic scheme stripping.
	const scp = /^([^/@:\s]+@)?([^/:\s]+):(?!\/)(.+)$/.exec(rest);
	if (scp && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rest)) {
		// A leading all-digit segment after the colon is a PORT (`host:2222/path`),
		// not a path — strip it so the bare form matches `ssh://host:2222/path`
		// (review finding: the two used to normalize to different keys).
		const portMatch = /^(\d+)\/(.+)$/.exec(scp[3] ?? "");
		rest = portMatch ? `${scp[2]}/${portMatch[2]}` : `${scp[2]}/${scp[3]}`;
	} else {
		// scheme form: strip `ssh://`, `https://`, `git://`, `http://`, …
		rest = rest.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
		// strip credentials (`user@` / `user:pw@`); the user is never part of
		// the project identity — the same repo cloned by two users must map to
		// the same directory.
		rest = rest.replace(/^[^/@]*@/, "");
		// drop an explicit port: `host:2222/org/repo` and `host/org/repo` are the
		// same project (the port is an access detail, not an identity).
		rest = rest.replace(/^([^/]+?):\d+\//, "$1/");
		// `file:///x/y` (and friends) leave an empty host behind; their key would
		// be a machine-local path, not a project identity.
		if (rest.startsWith("/")) return null;
	}

	rest = rest.replace(/\/+$/, "");
	// Drop a query string / fragment before the `.git` suffix: they follow it
	// (`…/repo.git?ref=main`) and would otherwise hide it.
	rest = rest.split(/[?#]/)[0] ?? rest;
	rest = rest.replace(/\.git$/i, "");
	rest = rest.replace(/\/{2,}/g, "/");
	rest = rest.replace(/^\/+/, "").toLowerCase();

	if (!rest || !rest.includes("/")) return null;
	// Reject values that would escape the projects/ directory or be unusable as
	// a path (defensive: the key becomes a directory name).
	if (rest.split("/").some((segment) => !segment || segment === "." || segment === "..")) return null;
	return rest;
}

/**
 * Walk up from `cwd` looking for `.git` entries and collect the project keys of
 * every repository found on the way.
 *
 * `resolveGitDir` is unusable here: it only inspects the directory it is given,
 * so a shell sitting in `<repo>/src/deep/nested` reports "not a git repo".
 * Walking up is what a developer expects (and what `git` itself does).
 *
 * Submodules: a `.git` *file* (`gitdir: …`) marks the boundary of a nested
 * repository. Per the design we do NOT descend into that gitdir as if it were
 * the project boundary; we skip past it and keep walking so the parent project
 * is collected too, giving both keys (submodule first — the more specific
 * project wins the skill registration).
 *
 * Stops at the home directory or the filesystem root: repositories *above* $HOME
 * (dotfiles-style repos) are not the user's project context.
 */
export function resolveProjectKeys(cwd: string, homeOverride?: string): string[] {
	const home = safeRealpath(resolve(homeOverride ?? homedir()));
	const keys: string[] = [];
	const seen = new Set<string>();

	let dir = safeRealpath(resolve(cwd));
	for (;;) {
		// $HOME itself is excluded: a dotfiles repo at the root of the home
		// directory is not the project a shell under it is working on.
		if (dir !== home) {
			const key = projectKeyForRepo(dir);
			if (key && !seen.has(key)) {
				seen.add(key);
				keys.push(key);
			}
		}
		if (dir === home) break;
		const parent = dirname(dir);
		if (parent === dir) break; // filesystem root
		dir = parent;
	}
	return keys;
}

/**
 * Project key for the repository whose worktree root is exactly `dir`.
 * Returns null when `dir` has no `.git`, no readable config or no origin.
 *
 * Both `.git` directories and `.git` files (worktrees, submodules) are handled:
 * for a `.git` file the config lives in the pointed-at git dir (or, for linked
 * worktrees, in its `commondir`).
 */
export function projectKeyForRepo(dir: string): string | null {
	const gitDir = resolveGitDir(dir);
	if (!gitDir) return null;
	const commonDir = resolveCommonGitDir(gitDir);
	const url = readOriginUrlFromGitDir(commonDir);
	if (!url) return null;
	return normalizeProjectKey(url);
}

/** `realpath` that degrades to the lexical path when the target is gone. */
function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Absolute directory holding the project SOPs for `key`.
 *
 * Exits through `realpath` so two libraries reached via different symlinked
 * paths cannot fan out into two directories holding the same logical project.
 * The target usually does NOT exist yet (that is the write path), so symlinks
 * are resolved on the deepest existing ancestor and the rest is re-appended.
 */
export function projectDir(libDir: string, key: string): string {
	return canonicalJoin(resolve(libDir), PROJECTS_DIR, key);
}

/** `join` that canonicalizes the symlinks of the deepest existing ancestor. */
function canonicalJoin(...segments: string[]): string {
	const full = join(...segments);
	const tail: string[] = [];
	let head = full;
	for (;;) {
		try {
			const real = realpathSync(head);
			return tail.length > 0 ? join(real, ...tail.reverse()) : real;
		} catch {
			// not present yet: peel one segment and retry
		}
		const parent = dirname(head);
		if (parent === head) return full; // nothing on this path exists
		tail.push(head.slice(parent.length + 1));
		head = parent;
	}
}

/**
 * The project directories that exist for `cwd`, most specific first.
 * Callers (resources_discover) only add directories that actually exist, so a
 * project without SOPs costs nothing.
 */
export function existingProjectDirs(libDir: string, cwd: string, homeOverride?: string): string[] {
	const dirs: string[] = [];
	for (const key of resolveProjectKeys(cwd, homeOverride)) {
		const dir = projectDir(libDir, key);
		try {
			if (statSync(dir).isDirectory()) dirs.push(dir);
		} catch {
			// no SOPs for this project yet — skip it
		}
	}
	return dirs;
}
