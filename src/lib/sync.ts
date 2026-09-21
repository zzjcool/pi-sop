/**
 * pi-sop sync: cross-process locking + best-effort pull/push.
 *
 * Design: docs/init-design.md §5
 *
 * Frozen rules (README):
 *   - every git operation is best-effort; offline degrades to a read-only local
 *     cache and never blocks session start
 *   - never force-push, never rewrite history
 *   - commit always lands locally first; push failure is reported, not fatal
 *
 * Concurrency: every mutating git operation runs under a non-blocking `flock`
 * on `<gitDir>/pi-sop.lock`. Losing the lock means another process is already
 * syncing, which is a skip, not an error.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { lockPathForDir, resolveGitDir } from "./probe.ts";

/** Timeouts (ms) — design §0: network ops stay in the 5–8s band. */
export const TIMEOUTS = {
	lsRemote: 5_000,
	pull: 8_000,
	push: 30_000,
	clone: 30_000,
	/** Local-only operations: no network, generous but finite. */
	local: 15_000,
} as const;

/** In-process throttle window for the automatic session_start pull. */
export const SYNC_THROTTLE_MS = 10 * 60 * 1000;

export type SyncVerdict =
	| "ok"
	| "skipped"
	| "throttled"
	| "locked"
	| "conflict"
	| "failed"
	| "no-remote";

export interface GitResult {
	ok: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
	/** True when the child was killed because it exceeded its timeout. */
	timedOut: boolean;
	/** undefined when the process could not be spawned at all. */
	command: string;
}

export interface SyncResult {
	verdict: SyncVerdict;
	/** Human readable, already localized (design §7 wording). */
	message: string;
	detail?: string;
}

const lastAttempt = new Map<string, number>();

/** Test seam: reset the in-process throttle. */
export function resetSyncThrottle(): void {
	lastAttempt.clear();
}

/** Environment that keeps git from ever blocking on a prompt. */
function gitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		// `GIT_ASKPASS` pointing at a no-op makes https auth fail fast instead of
		// opening a TTY prompt.
		GIT_ASKPASS: process.env.GIT_ASKPASS ?? "/bin/true",
		SSH_ASKPASS: process.env.SSH_ASKPASS ?? "/bin/true",
	};
	if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) {
		// Non-interactive ssh: never wait for a passphrase prompt.
		env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=5";
	}
	return env;
}

function run(command: string, args: string[], options: { cwd?: string; timeout: number }): Promise<GitResult> {
	// execFile's own `timeout` + `killSignal: "SIGKILL"` is the single timeout
	// mechanism: Node kills the child and reports error.killed === true.
	return new Promise((resolvePromise) => {
		execFile(
			command,
			args,
			{
				cwd: options.cwd,
				timeout: options.timeout,
				killSignal: "SIGKILL",
				maxBuffer: 4 * 1024 * 1024,
				encoding: "utf8",
				env: gitEnv(),
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				const exitError = error as (Error & { code?: number | string; killed?: boolean }) | null;
				resolvePromise({
					ok: !error,
					code: error ? (typeof exitError?.code === "number" ? exitError.code : null) : 0,
					stdout: stdout ?? "",
					stderr: stderr ?? "",
					timedOut: exitError?.killed === true,
					command: `${command} ${args.join(" ")}`,
				});
			},
		);
	});
}

/** Run git in `dir`. Exported for the init wizard. */
export function git(
	dir: string,
	args: string[],
	timeout: number = TIMEOUTS.local,
): Promise<GitResult> {
	return run("git", args, { cwd: dir, timeout });
}

/** Run git without a working tree (used before the dir exists). */
export function firstLine(text: string): string {
	const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
	return line.trim().slice(0, 300);
}

/** True when a failed git command looks like a merge/rebase conflict. */
export function looksLikeConflict(result: GitResult): boolean {
	const blob = `${result.stdout}\n${result.stderr}`;
	return /CONFLICT|conflict \(content\)|Automatic merge failed|cannot pull with rebase|would be overwritten by merge|needs merge/i.test(
		blob,
	);
}

/**
 * Acquire the library lock (non-blocking) and run `fn` while holding it.
 *
 * The lock file lives inside the git dir (`<gitDir>/pi-sop.lock`) so it is never
 * committed. `flock` locks a file descriptor, so a leftover lock file is never
 * stale.
 *
 * A holder process (`flock -n <file> -c 'echo LOCKED; cat'`) prints `LOCKED`
 * once it owns the lock and then blocks on stdin. That gives deterministic
 * detection: seeing `LOCKED` means acquired, the process exiting first means
 * another process holds it. No fixed probe latency, and release is awaited so a
 * subsequent acquisition in the same process cannot race the release.
 *
 * When `flock` is unavailable (non-POSIX platforms) we degrade to an in-process
 * queue: correct within one pi process, no cross-process guarantee.
 */
export async function withLock<T>(
	lockPath: string,
	fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
	mkdirSync(dirname(lockPath), { recursive: true });
	const holder = await acquireLock(lockPath);
	if (!holder.acquired) return { acquired: false };
	try {
		return { acquired: true, value: await fn() };
	} finally {
		await holder.release();
	}
}

interface LockHandle {
	acquired: boolean;
	release(): Promise<void>;
}

/** In-process fallback chain, used only when `flock` is missing. */
const inProcessQueues = new Map<string, Promise<unknown>>();

async function acquireLock(lockPath: string): Promise<LockHandle> {
	const child = spawn("flock", ["-n", lockPath, "-c", "echo LOCKED; cat"], {
		stdio: ["pipe", "pipe", "ignore"],
	});

	const outcome = await detectLock(child);
	if (outcome === "unavailable") {
		return acquireInProcess(lockPath);
	}
	if (outcome === "busy") {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
		return { acquired: false, release: async () => {} };
	}
	return {
		acquired: true,
		release: async () => {
			child.kill("SIGTERM");
			await waitForExit(child, 2000);
		},
	};
}

/**
 * Resolve to `locked` on the `LOCKED` marker, `busy` if the child exits first,
 * or `unavailable` when `flock` itself cannot be spawned (ENOENT).
 */
function detectLock(child: ReturnType<typeof spawn>): Promise<"locked" | "busy" | "unavailable"> {
	return new Promise((resolvePromise) => {
		let settled = false;
		let buffer = "";
		const finish = (value: "locked" | "busy" | "unavailable") => {
			if (settled) return;
			settled = true;
			child.stdout?.off("data", onData);
			child.off("exit", onExit);
			child.off("error", onError);
			resolvePromise(value);
		};
		const onData = (chunk: Buffer | string) => {
			buffer += String(chunk);
			if (buffer.includes("LOCKED")) finish("locked");
		};
		const onExit = () => finish("busy");
		const onError = (error: NodeJS.ErrnoException) =>
			finish(error.code === "ENOENT" ? "unavailable" : "busy");
		child.stdout?.on("data", onData);
		child.on("exit", onExit);
		child.on("error", onError);
	});
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolvePromise) => {
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already gone */
			}
			resolvePromise();
		}, timeoutMs);
		timer.unref?.();
		child.once("exit", () => {
			clearTimeout(timer);
			resolvePromise();
		});
	});
}

/** Serialize lock holders inside this process only (no `flock` available). */
async function acquireInProcess(lockPath: string): Promise<LockHandle> {
	const previous = inProcessQueues.get(lockPath) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolvePromise) => {
		release = resolvePromise;
	});
	// Capture the exact promise stored below; comparing a freshly created
	// `previous.then(...)` would never match (new reference every time).
	const chained = previous.then(() => current);
	inProcessQueues.set(lockPath, chained);
	await previous;
	return {
		acquired: true,
		release: async () => {
			release();
			if (inProcessQueues.get(lockPath) === chained) {
				inProcessQueues.delete(lockPath);
			}
		},
	};
}

/**
 * Pull with `--rebase --autostash` under the library lock.
 *
 * `dir` is the library WORKTREE (not `<dir>/.git`): `git pull` refuses to run
 * with `cwd` inside a bare git dir. The lock is derived from the resolved git
 * dir so linked worktrees share one lock.
 *
 * Never forces, never resets. A conflict is surfaced (the human resolves it from
 * the status panel); network/timeout failures degrade silently.
 */
export async function pullLibrary(dir: string, branch: string | null): Promise<SyncResult> {
	const lock = await withLock(lockPathForDir(dir), async () => {
		const args = ["pull", "--rebase", "--autostash"];
		const result = await git(dir, args, TIMEOUTS.pull);
		if (result.ok) return { verdict: "ok" as SyncVerdict, message: "已同步" };
		if (looksLikeConflict(result)) {
			return {
				verdict: "conflict" as SyncVerdict,
				message: "pi-sop: 同步冲突，本地修改已保留。运行 /sop init → 状态面板处理",
				detail: firstLine(result.stderr || result.stdout),
			};
		}
		return {
			verdict: "failed" as SyncVerdict,
			message: "同步失败，已降级为本地缓存",
			detail: result.timedOut ? "timeout" : firstLine(result.stderr || result.stdout),
		};
	});
	void branch;
	if (!lock.acquired) {
		return { verdict: "locked", message: "另一进程正在同步，已跳过" };
	}
	return lock.value;
}

/**
 * Throttled, best-effort pull for `session_start`.
 *
 * Silently returns `throttled` when the same library was attempted less than
 * `SYNC_THROTTLE_MS` ago (guards `/resume` and `/fork` from re-pulling).
 * `force` bypasses the throttle for explicit user actions (`/sop sync`).
 */
export async function syncLibrary(
	dir: string,
	options: { force?: boolean; probe?: { remote: string | null; branch: string | null } } = {},
): Promise<SyncResult> {
	const key = resolveGitDir(dir) ?? dir;
	const now = Date.now();
	const previous = lastAttempt.get(key);
	if (!options.force && previous !== undefined && now - previous < SYNC_THROTTLE_MS) {
		return { verdict: "throttled", message: "节流中" };
	}
	lastAttempt.set(key, now);
	const result = await pullLibrary(dir, null);
	if (result.verdict === "failed" || result.verdict === "locked") {
		// The attempt timestamp set above already keeps the throttle window —
		// no need to touch it again (the old second set was a same-value no-op).
		return result;
	}
	// Design §5: sync is pull AND push — without the push leg, local commits
	// made on this machine silently diverge from the remote.
	if (result.verdict === "ok" && options.probe?.remote) {
		const branch = options.probe.branch ?? "main";
		const push = await pushLibrary(dir, branch);
		if (push.verdict !== "ok" && push.verdict !== "no-remote") {
			return push;
		}
	}
	return result;
}

export interface CommitResult {
	committed: boolean;
	reason?: string;
	detail?: string;
}

/**
 * `git add` + `git commit`, always local. Falls back to an explicit identity so
 * a machine without git user.name/user.email still records the SOP.
 *
 * `dir` is the library worktree.
 */
export async function commitAll(
	dir: string,
	message: string,
	paths: string[] = ["-A"],
): Promise<CommitResult> {
	// Guard 1: an in-progress rebase/merge must never be advanced by a plain
	// `git commit` — it would silently drop the commits the rebase is replaying
	// and leave the repo stuck mid-rebase (data loss).
	const gitDir = resolveGitDir(dir) ?? join(dir, ".git");
	for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
		if (existsSync(join(gitDir, marker))) {
			return {
				committed: false,
			reason: "sync-conflict-pending",
				detail: "库存在未解决的同步冲突（rebase/merge 进行中），请运行 /sop init 在状态面板处理",
			};
		}
	}
	// Guard 2: refuse to sweep up changes the user staged outside `paths` —
	// a bare `git commit` commits the whole index, not just our files.
	if (paths.length > 0 && !paths.includes("-A")) {
		const staged = await git(dir, ["diff", "--cached", "--name-only"], TIMEOUTS.local);
		if (staged.ok) {
			const stagedPaths = staged.stdout.split(/\r?\n/).filter(Boolean);
			const outside = stagedPaths.filter((p) => !paths.includes(p));
			if (outside.length > 0) {
				return {
					committed: false,
					reason: "foreign-staged-changes",
					detail: `暂存区有本次 SOP 之外的文件（${outside.slice(0, 3).join(", ")}），已拒绝提交以免裹入`,
				};
			}
		}
	}
	const add = await git(dir, ["add", ...paths], TIMEOUTS.local);
	if (!add.ok) {
		return { committed: false, reason: "add-failed", detail: firstLine(add.stderr) };
	}
	const status = await git(dir, ["status", "--porcelain"], TIMEOUTS.local);
	if (status.ok && status.stdout.trim() === "") {
		return { committed: false, reason: "nothing-to-commit" };
	}
	let commit = await git(dir, ["commit", "-m", message], TIMEOUTS.local);
	if (!commit.ok && /Please tell me who you are|empty ident|unable to auto-detect email/i.test(commit.stderr + commit.stdout)) {
		commit = await git(
			dir,
			[
				"-c",
				"user.name=pi-sop",
				"-c",
				"user.email=pi-sop@localhost",
				"commit",
				"-m",
				message,
			],
			TIMEOUTS.local,
		);
	}
	if (!commit.ok) {
		return { committed: false, reason: "commit-failed", detail: firstLine(commit.stderr || commit.stdout) };
	}
	return { committed: true };
}

/**
 * Best-effort push. Never force, never `+refspec`. Remote/auth failures are
 * reported so the caller can append the design §7 warning.
 *
 * `dir` is the library worktree.
 */
export async function pushLibrary(
	dir: string,
	branch: string | null,
	options?: { alreadyLocked?: boolean },
): Promise<SyncResult> {
	if (!branch) {
		return { verdict: "no-remote", message: "无远端，仅本地提交" };
	}
	const pushOnce = async (): Promise<SyncResult> => {
		const result = await git(dir, ["push", "--set-upstream", "origin", branch], TIMEOUTS.push);
		if (result.ok) return { verdict: "ok" as SyncVerdict, message: "已推送" };
		return {
			verdict: "failed" as SyncVerdict,
			message: "推送失败",
			detail: result.timedOut ? "timeout" : firstLine(result.stderr || result.stdout),
		};
	};
	if (options?.alreadyLocked) return pushOnce();
	const lock = await withLock(lockPathForDir(dir), pushOnce);
	if (!lock.acquired) return { verdict: "locked", message: "另一进程正在同步，暂未推送" };
	return lock.value;
}

/** True when `gh` is on PATH (used by the init wizard, design §3.2 branch 2). */
export async function hasGhCli(): Promise<boolean> {
	const result = await run("gh", ["--version"], { timeout: 5000 });
	return result.ok;
}

/**
 * `git ls-remote <url>` pre-flight for branch 1 of the wizard.
 *
 * No `--exit-code`: it exits 2 when no ref matches (e.g. an empty library
 * repo), which is a reachable, healthy remote — not an error. Reachability is
 * judged by exit status alone: 0 = reachable (empty output = empty repo),
 * non-zero = unreachable/auth failure.
 */
export async function lsRemote(url: string): Promise<GitResult> {
	return run("git", ["ls-remote", url], {
		cwd: homedir(),
		timeout: TIMEOUTS.lsRemote,
	});
}

/** `git clone <url> <dir>` (no --depth: the library is tiny and gets rebased). */
export async function clone(url: string, dir: string): Promise<GitResult> {
	return run("git", ["clone", url, dir], { cwd: homedir(), timeout: TIMEOUTS.clone });
}

/** `git init -b main` (falls back for git < 2.28). */
export async function initRepo(dir: string): Promise<GitResult> {
	mkdirSync(dir, { recursive: true });
	const result = await git(dir, ["init", "-b", "main"], TIMEOUTS.local);
	if (!result.ok && /unknown switch|unknown option/i.test(result.stderr)) {
		return git(dir, ["init"], TIMEOUTS.local);
	}
	return result;
}

export async function addRemote(dir: string, url: string): Promise<GitResult> {
	const existing = await git(dir, ["remote", "get-url", "origin"], TIMEOUTS.local);
	if (existing.ok) return git(dir, ["remote", "set-url", "origin", url], TIMEOUTS.local);
	return git(dir, ["remote", "add", "origin", url], TIMEOUTS.local);
}

/** Commit count on a branch — used by the status panel. `dir` is the worktree. */
export async function countUnpushed(dir: string, branch: string | null): Promise<number | null> {
	if (!branch) return null;
	const result = await git(dir, ["rev-list", "--count", `@{upstream}..${branch}`], TIMEOUTS.local);
	if (!result.ok) return null;
	const parsed = Number.parseInt(result.stdout.trim(), 10);
	return Number.isFinite(parsed) ? parsed : null;
}
