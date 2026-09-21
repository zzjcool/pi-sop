/**
 * pi-sop probe: the library state machine.
 *
 * Design: docs/init-design.md §1.3
 *
 *   missing      路径不存在
 *   empty-dir    目录存在但为空
 *   not-a-repo   有内容但不是 git 仓库
 *   no-remote    是 git 仓库但 origin 未配置（local-only）
 *   ready        git 仓库 + 结构合法（MANIFEST.md 或 sop/ 存在）
 *   malformed    是仓库但结构不对（无 MANIFEST 且无 sop/）
 *
 * Deliberately pure `node:fs`: no process spawn, no network. It runs on every
 * `session_start`, so it must stay in the low-millisecond range and must never
 * throw. The single exception to "no spawn" is an exotic-git-config fallback
 * (see `readOriginUrl`) that is only reached when `.git/config` uses
 * `include`/`includeIf`, which a hand-written parser cannot follow.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type LibraryState =
	| "missing"
	| "empty-dir"
	| "not-a-repo"
	| "no-remote"
	| "malformed"
	| "ready";

export interface ProbeResult {
	/** Absolute path that was probed. */
	dir: string;
	state: LibraryState;
	/** True for no-remote / malformed / ready. */
	isRepo: boolean;
	/** Resolved git dir (handles `.git` files from worktrees/submodules). */
	gitDir: string | null;
	/** `remote.origin.url`, null when unset. */
	remote: string | null;
	/** Current branch from HEAD, null when unborn/unknown. */
	branch: string | null;
	/** Number of commits on the current branch (0 for a fresh `git init`). */
	commitCount: number;
	hasManifest: boolean;
	hasSopDir: boolean;
	/**
	 * True when `projects/` exists. Optional structure: a library that only
	 * carries project-scoped SOPs is still a valid library (design: `projects/`
	 * was added after v1, so old libraries without it must keep probing as
	 * ready — and a library that only has it must not probe as malformed).
	 */
	hasProjectsDir: boolean;
	/** Number of `sop/*.md` files (global scope only; see `scanSopDir`). */
	sopCount: number;
}

/** States in which the library can serve skills and accept writes. */
export const USABLE_STATES: readonly LibraryState[] = ["ready", "no-remote", "malformed"];

/**
 * States in which `sop_save` may write without asking a human. `malformed` is
 * deliberately excluded: writing into a repo that lacks the library skeleton
 * needs the confirm of `/sop init` (design §3.2 branch 3), not a silent tool
 * call (review finding: agent happily committed into a random repo).
 */
export const SAVEABLE_STATES: readonly LibraryState[] = ["ready", "no-remote"];

export function isUsable(state: LibraryState): boolean {
	return USABLE_STATES.includes(state);
}

/** True only for states `sop_save` may write into without a human confirm. */
export function isSaveable(state: LibraryState): boolean {
	return SAVEABLE_STATES.includes(state);
}

function statOrNull(path: string) {
	try {
		return statSync(path);
	} catch {
		return null;
	}
}

function isDirectory(path: string): boolean {
	return statOrNull(path)?.isDirectory() ?? false;
}

/**
 * Resolve the git dir for `dir`.
 *
 * A git dir is either a `.git` directory, or a `.git` file containing
 * `gitdir: <path>` (linked worktrees, submodules). Relative gitdir paths are
 * resolved against `dir`, per git's own rule.
 */
export function resolveGitDir(dir: string): string | null {
	const dotGit = join(dir, ".git");
	const stat = statOrNull(dotGit);
	if (!stat) return null;
	if (stat.isDirectory()) return dotGit;
	if (!stat.isFile()) return null;
	let content: string;
	try {
		content = readFileSync(dotGit, "utf8");
	} catch {
		return null;
	}
	const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(content);
	const target = match?.[1];
	if (!target) return null;
	return isAbsolute(target) ? resolve(target) : resolve(dir, target);
}

/**
 * Resolve the common git dir (shared across linked worktrees).
 *
 * A linked worktree's private git dir (`.git/worktrees/<name>`) contains a
 * `commondir` file pointing at the shared `.git`; refs and config live there.
 * Callers that read refs/config or derive the cross-process lock MUST use the
 * common dir, otherwise two worktrees of one repo get different locks and
 * `refExists`/`readOriginUrl` see nothing.
 */
export function resolveCommonGitDir(gitDir: string): string {
	try {
		const content = readFileSync(join(gitDir, "commondir"), "utf8").trim();
		if (!content) return gitDir;
		return isAbsolute(content) ? resolve(content) : resolve(gitDir, content);
	} catch {
		return gitDir; // regular repo: no commondir file
	}
}

/** Minimal git-config reader: `section.subsection.key` → value. */
function parseGitConfig(content: string): Map<string, string> {
	const values = new Map<string, string>();
	let section = "";
	let subsection = "";
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		const header = /^\[([^\]"\s]+)(?:\s+"((?:[^"\\]|\\.)*)")?\]$/.exec(line);
		if (header) {
			section = (header[1] ?? "").toLowerCase();
			const sub = header[2];
			subsection = sub ? sub.replace(/\\(.)/g, "$1") : "";
			continue;
		}
		const eq = line.indexOf("=");
		const key = (eq === -1 ? line : line.slice(0, eq)).trim().toLowerCase();
		let value = eq === -1 ? "true" : line.slice(eq + 1).trim();
		if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
			value = value.slice(1, -1).replace(/\\(.)/g, "$1");
		}
		if (!section || !key) continue;
		const full = section === "" ? key : `${section}\u0000${subsection}\u0000${key}`;
		if (!values.has(full)) values.set(full, value);
	}
	return values;
}

function configValue(
	values: Map<string, string>,
	section: string,
	subsection: string,
	key: string,
): string | null {
	return values.get(`${section}\u0000${subsection}\u0000${key}`) ?? null;
}
/**
 * Read `remote.origin.url` without spawning git in the common case.
 *
 * When `.git/config` pulls in extra files via `include`/`includeIf`, our parser
 * cannot see the origin; only then do we fall back to `git config`, bounded by
 * a short timeout so session start stays non-blocking.
 */
function readOriginUrl(gitDir: string, configContent: string | null): string | null {
	if (configContent !== null) {
		const values = parseGitConfig(configContent);
		const direct = configValue(values, "remote", "origin", "url");
		if (direct) return direct;
		const pushUrl = configValue(values, "remote", "origin", "pushurl");
		if (pushUrl) return pushUrl;
		if (!/(^|\n)\s*\[include/i.test(configContent)) return null;
	}
	try {
		const out = execFileSync("git", ["--git-dir", gitDir, "config", "--get", "remote.origin.url"], {
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		return out.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Read `remote.origin.url` for a git dir straight from its config file.
 *
 * Pure fs in the common case. When the config uses `[include]`/`[includeIf]`
 * (our parser can't follow those), fall back to one bounded `git config`
 * spawn — the same fallback `probeLibrary` uses. Without it, a repo whose
 * origin lives in an included file would silently lose its project SOP
 * (review finding: resolver and probe disagreed on the same config).
 */
export function readOriginUrlFromGitDir(gitDir: string): string | null {
	let content: string;
	try {
		content = readFileSync(join(gitDir, "config"), "utf8");
	} catch {
		return null;
	}
	const values = parseGitConfig(content);
	const direct =
		configValue(values, "remote", "origin", "url") ?? configValue(values, "remote", "origin", "pushurl");
	if (direct) return direct;
	if (!/(^|\n)\s*\[include/i.test(content)) return null;
	try {
		const out = execFileSync("git", ["--git-dir", gitDir, "config", "--get", "remote.origin.url"], {
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		return out.trim() || null;
	} catch {
		return null;
	}
}

/** True when `ref` exists as a loose ref or inside `packed-refs`. */
function refExists(gitDir: string, ref: string): boolean {
	const common = resolveCommonGitDir(gitDir);
	if (statOrNull(join(common, ...ref.split("/")))) return true;
	try {
		return readFileSync(join(common, "packed-refs"), "utf8").includes(` ${ref}\n`);
	} catch {
		return false;
	}
}

/**
 * Read HEAD without spawning git.
 *
 * `commitCount` is a 0/1 "has any commit" signal: walking history is not worth
 * the cost on the session-start path, and the only consumer (status panel)
 * needs exactly this bit (`git init` with no commit vs. a real history).
 */
function readHead(gitDir: string): { branch: string | null; commitCount: number } {
	let head: string;
	try {
		head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
	} catch {
		return { branch: null, commitCount: 0 };
	}
	const refMatch = /^ref:\s*(.+)$/.exec(head);
	const ref = refMatch?.[1];
	if (!ref) {
		// Detached HEAD: the SHA itself is the only name we have.
		return { branch: head ? `(detached ${head.slice(0, 7)})` : null, commitCount: head ? 1 : 0 };
	}
	const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
	return { branch, commitCount: refExists(gitDir, ref) ? 1 : 0 };
}

function listSopFiles(dir: string): string[] {
	const sopDir = join(dir, "sop");
	try {
		return readdirSync(sopDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/** Probe a library directory. Sync, side-effect free, never throws. */
export function probeLibrary(dir: string): ProbeResult {
	const absolute = resolve(dir);
	const base: ProbeResult = {
		dir: absolute,
		state: "missing",
		isRepo: false,
		gitDir: null,
		remote: null,
		branch: null,
		commitCount: 0,
		hasManifest: false,
		hasSopDir: false,
		hasProjectsDir: false,
		sopCount: 0,
	};

	const dirStat = statOrNull(absolute);
	if (!dirStat || !dirStat.isDirectory()) return base;

	let entries: string[];
	try {
		entries = readdirSync(absolute);
	} catch {
		return { ...base, state: "not-a-repo" };
	}
	if (entries.length === 0) return { ...base, state: "empty-dir" };

	const gitDir = resolveGitDir(absolute);
	if (!gitDir || !isDirectory(gitDir)) {
		const hasManifest = entries.includes("MANIFEST.md");
		const hasSopDir = isDirectory(join(absolute, "sop"));
		return {
			...base,
			state: "not-a-repo",
			hasManifest,
			hasSopDir,
			hasProjectsDir: isDirectory(join(absolute, "projects")),
			sopCount: listSopFiles(absolute).length,
		};
	}

	// Config lives in the COMMON dir for linked worktrees; the worktree-private
	// git dir usually has no config file at all.
	const commonDir = resolveCommonGitDir(gitDir);
	let configContent: string | null = null;
	try {
		configContent = readFileSync(join(commonDir, "config"), "utf8");
	} catch {
		configContent = null;
	}
	const remote = readOriginUrl(commonDir, configContent);
	const { branch, commitCount } = readHead(gitDir);

	let hasManifest = false;
	try {
		hasManifest = statOrNull(join(absolute, "MANIFEST.md"))?.isFile() ?? false;
	} catch {
		hasManifest = false;
	}
	const hasSopDir = isDirectory(join(absolute, "sop"));
	const hasProjectsDir = isDirectory(join(absolute, "projects"));
	const sopFiles = listSopFiles(absolute);

	// Structure first, then remote: a repo that has no remote AND no library
	// skeleton is malformed, not "local-only usable" — `no-remote` means
	// "a valid library that just lacks a remote" (design §1.3).
	// `projects/` counts as structure for the same reason `sop/` does: it is a
	// legal (optional) part of the library layout.
	const structure = hasManifest || hasSopDir || hasProjectsDir ? "ready" : "malformed";
	if (!remote) {
		return {
			...base,
			state: structure === "ready" ? "no-remote" : "malformed",
			isRepo: true,
			gitDir,
			remote,
			branch,
			commitCount,
			hasManifest,
			hasSopDir,
			hasProjectsDir,
			sopCount: sopFiles.length,
		};
	}

	return {
		...base,
		state: structure,
		isRepo: true,
		gitDir,
		remote,
		branch,
		commitCount,
		hasManifest,
		hasSopDir,
		hasProjectsDir,
		sopCount: sopFiles.length,
	};
}

/** Human-readable one-liner for a probe result (used by status/notify). */
export function describeState(result: ProbeResult): string {
	switch (result.state) {
		case "missing":
			return "路径不存在";
		case "empty-dir":
			return "目录为空";
		case "not-a-repo":
			return "目录存在但不是 git 仓库";
		case "no-remote":
			return "本地 git 仓库（未配置远端）";
		case "malformed":
			return "git 仓库但缺少 SOP 库结构";
		case "ready":
			return "就绪";
	}
}

/** Lock file used for cross-process mutual exclusion (design §5). */
export function lockPathFor(result: ProbeResult): string | null {
	return result.gitDir ? join(result.gitDir, "pi-sop.lock") : null;
}

/**
 * Lock path for a library worktree. Prefers the resolved git dir (so linked
 * worktrees share one lock and nothing ever lands in the worktree), falling
 * back to `<dir>/.git` for a plain checkout.
 */
export function lockPathForDir(libDir: string): string {
	// Common dir, always: linked worktrees must share ONE lock — a per-worktree
	// path would let two pi processes race the same repo (review finding).
	const gitDir = resolveGitDir(libDir) ?? join(libDir, ".git");
	return join(resolveCommonGitDir(gitDir), "pi-sop.lock");
}
