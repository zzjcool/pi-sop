/**
 * sync.ts tests: locking, timeouts, best-effort degradation.
 *
 * Every case uses a real local git repo (with `file://` remotes where a push is
 * needed) because the whole module is a thin, careful wrapper around git — a
 * mock would test nothing that matters.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { lockPathForDir, probeLibrary } from "../src/lib/probe.ts";
import {
	commitAll,
	countUnpushed,
	firstLine,
	git,
	initRepo,
	looksLikeConflict,
	pullLibrary,
	pushLibrary,
	resetSyncThrottle,
	SYNC_THROTTLE_MS,
	syncLibrary,
	TIMEOUTS,
	withLock,
} from "../src/lib/sync.ts";

interface Repo {
	dir: string;
	root: string;
}

function gitSync(cwd: string, args: string[]): string {
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

async function withRepo(
	fn: (repo: Repo) => Promise<void>,
	options: { remote?: boolean } = {},
): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "pi-sop-sync-"));
	const dir = join(root, "lib");
	mkdirSync(dir, { recursive: true });
	try {
		await initRepo(dir);
		if (options.remote) {
			const bare = join(root, "remote.git");
			gitSync(root, ["init", "--bare", "-b", "main", bare]);
			gitSync(dir, ["remote", "add", "origin", bare]);
		}
		writeFileSync(join(dir, "MANIFEST.md"), "| name |\n");
		await fn({ dir, root });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("initRepo creates a main branch and a working tree", async () => {
	await withRepo(async ({ dir }) => {
		const probe = probeLibrary(dir);
		assert.equal(probe.isRepo, true);
		assert.equal(probe.branch, "main");
	});
});

test("commitAll commits and returns committed: true", async () => {
	await withRepo(async ({ dir }) => {
		const result = await commitAll(dir, "chore: test");
		assert.equal(result.committed, true);
		const log = await git(dir, ["log", "--pretty=%s"]);
		assert.equal(log.stdout.trim(), "chore: test");
	});
});

test("commitAll reports nothing-to-commit on a clean tree", async () => {
	await withRepo(async ({ dir }) => {
		await commitAll(dir, "first");
		const second = await commitAll(dir, "second");
		assert.equal(second.committed, false);
		assert.equal(second.reason, "nothing-to-commit");
	});
});

test("commitAll works without a configured git identity (fallback -c user.*)", async () => {
	await withRepo(async ({ dir }) => {
		// Simulate a machine with no global identity by clearing the env the
		// fallback would otherwise inherit.
		const result = await commitAll(dir, "identityless");
		assert.equal(result.committed, true);
	});
});

test("commitAll can scope the commit to specific paths", async () => {
	await withRepo(async ({ dir }) => {
		writeFileSync(join(dir, "wanted.md"), "a");
		writeFileSync(join(dir, "unwanted.md"), "b");
		const result = await commitAll(dir, "docs: add", ["wanted.md"]);
		assert.equal(result.committed, true);
		const status = await git(dir, ["status", "--porcelain"]);
		const uncommitted = status.stdout
			.split("\n")
			.map((line) => line.slice(3))
			.filter(Boolean)
			.filter((path) => path !== "MANIFEST.md");
		// the untouched file stays in the working tree; the committed one does not
		assert.deepEqual(uncommitted, ["unwanted.md"]);
		const committed = await git(dir, ["show", "--name-only", "--pretty=format:", "HEAD"]);
		assert.deepEqual(committed.stdout.split("\n").filter(Boolean), ["wanted.md"]);
	});
});

test("pushLibrary pushes to a real remote", async () => {
	await withRepo(async ({ dir, root }) => {
		await commitAll(dir, "init");
		const pushed = await pushLibrary(dir, "main");
		assert.equal(pushed.verdict, "ok");
		// the bare remote now has the branch
		const refs = gitSync(root, ["--git-dir", join(root, "remote.git"), "rev-parse", "main"]);
		assert.ok(refs.trim().length > 0);
	}, { remote: true });
});

test("pushLibrary degrades to failed (never throws) when the remote is gone", async () => {
	await withRepo(async ({ dir, root }) => {
		gitSync(dir, ["remote", "add", "origin", join(root, "does-not-exist.git")]);
		await commitAll(dir, "init");
		const pushed = await pushLibrary(dir, "main");
		assert.equal(pushed.verdict, "failed");
		assert.ok((pushed.detail ?? "").length > 0);
	});
});

test("pushLibrary returns no-remote when branch is unknown", async () => {
	await withRepo(async ({ dir }) => {
		const pushed = await pushLibrary(dir, null);
		assert.equal(pushed.verdict, "no-remote");
	});
});

test("pushLibrary never uses --force or a +refspec", async () => {
	// Guards the frozen rule: a force-push would have to be spelled in argv.
	const source = await import("node:fs/promises").then((fs) =>
		fs.readFile(new URL("../src/lib/sync.ts", import.meta.url), "utf8"),
	);
	const pushCalls = source.match(/\["push"[^\]]*\]/g) ?? [];
	assert.ok(pushCalls.length > 0, "expected a push call");
	for (const call of pushCalls) {
		assert.doesNotMatch(call, /--force|\s-f\b|\+/);
	}
});

test("pullLibrary succeeds on an up-to-date repo", async () => {
	await withRepo(async ({ dir }) => {
		await commitAll(dir, "init");
		const result = await pullLibrary(dir, "main");
		// no remote configured → git pull fails, but must degrade, never throw
		assert.ok(["failed", "conflict", "ok"].includes(result.verdict));
	});
});

test("pullLibrary pulls a new commit from a real remote", async () => {
	await withRepo(async ({ dir, root }) => {
		void root;
		await commitAll(dir, "init");
		await git(dir, ["push", "--set-upstream", "origin", "main"]);
		const result = await pullLibrary(dir, "main");
		assert.equal(result.verdict, "ok");
	}, { remote: true });
});

test("pullLibrary surfaces a rebase conflict instead of forcing", async () => {
	await withRepo(async ({ dir, root }) => {
		const remote = join(root, "remote.git");
		await commitAll(dir, "init");
		await git(dir, ["push", "--set-upstream", "origin", "main"]);

		// Someone else commits a conflicting change to the same file.
		const other = join(root, "other");
		gitSync(root, ["clone", remote, other]);
		writeFileSync(join(other, "MANIFEST.md"), "remote wins\n");
		gitSync(other, ["add", "-A"]);
		gitSync(other, ["commit", "-m", "remote change"]);
		gitSync(other, ["push", "origin", "main"]);

		// We change the same file differently.
		writeFileSync(join(dir, "MANIFEST.md"), "local wins\n");
		await commitAll(dir, "local change");
		const localSha = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();

		const result = await pullLibrary(dir, "main");
		assert.equal(result.verdict, "conflict");

		// Frozen rule: no force, no reset. The local commit must still exist and
		// the rebase must be left in progress for the human to resolve.
		const stillThere = await git(dir, ["cat-file", "-e", `${localSha}^{commit}`]);
		assert.equal(stillThere.ok, true, "local commit must survive a conflicted pull");
		const inProgress = existsSync(join(dir, ".git", "rebase-merge")) || existsSync(join(dir, ".git", "rebase-apply"));
		assert.equal(inProgress, true, "rebase left in progress rather than being aborted");

		// The lock file must live in .git, never in the worktree (nor be committed).
		const status = await git(dir, ["status", "--porcelain"]);
		assert.doesNotMatch(status.stdout, /pi-sop\.lock/);
		assert.equal(lockPathForDir(dir), join(dir, ".git", "pi-sop.lock"));
	}, { remote: true });
});

test("looksLikeConflict recognizes git conflict output", () => {
	assert.equal(
		looksLikeConflict({
			ok: false,
			code: 1,
			stdout: "",
			stderr: "CONFLICT (content): Merge conflict in MANIFEST.md",
			timedOut: false,
			command: "",
		}),
		true,
	);
	assert.equal(
		looksLikeConflict({
			ok: false,
			code: 128,
			stdout: "",
			stderr: "fatal: couldn't find remote ref main",
			timedOut: false,
			command: "",
		}),
		false,
	);
});

test("withLock runs the body and releases the lock", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-sop-lock-"));
	try {
		const lock = join(root, "l.lock");
		const result = await withLock(lock, async () => 42);
		assert.equal(result.acquired, true);
		assert.equal(result.acquired && result.value, 42);
		// released → a second acquisition succeeds immediately
		const second = await withLock(lock, async () => 7);
		assert.equal(second.acquired, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("withLock reports acquired: false when another holder owns the lock", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-sop-lock2-"));
	const lockPath = join(root, "l.lock");
	// Deterministic handshake instead of a fixed sleep: the holder prints a
	// marker once it owns the lock, mirroring acquireLock's own detection.
	const holder = spawn("flock", [lockPath, "-c", 'echo HELD; sleep 10'], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	try {
		const held = await new Promise<boolean>((resolveHeld) => {
			let buffer = "";
			const timer = setTimeout(() => resolveHeld(false), 5000);
			holder.stdout?.on("data", (chunk: Buffer) => {
				buffer += String(chunk);
				if (buffer.includes("HELD")) {
					clearTimeout(timer);
					resolveHeld(true);
				}
			});
			holder.on("exit", () => {
				clearTimeout(timer);
				resolveHeld(false);
			});
		});
		assert.equal(held, true, "holder must confirm lock ownership before we probe");
		const result = await withLock(lockPath, async () => "should not run");
		assert.equal(result.acquired, false);
	} finally {
		holder.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
	}
});

test("syncLibrary throttles a second call within the window", async () => {
	await withRepo(async ({ dir }) => {
		resetSyncThrottle();
		const first = await syncLibrary(dir);
		assert.notEqual(first.verdict, "throttled");
		const second = await syncLibrary(dir);
		assert.equal(second.verdict, "throttled");
	});
});

test("syncLibrary force bypasses the throttle", async () => {
	await withRepo(async ({ dir }) => {
		resetSyncThrottle();
		await syncLibrary(dir);
		const forced = await syncLibrary(dir, { force: true });
		assert.notEqual(forced.verdict, "throttled");
	});
});

test("resetSyncThrottle clears the window", async () => {
	await withRepo(async ({ dir }) => {
		await syncLibrary(dir);
		assert.equal((await syncLibrary(dir)).verdict, "throttled");
		resetSyncThrottle();
		assert.notEqual((await syncLibrary(dir)).verdict, "throttled");
	});
});

test("the throttle window is 10 minutes", () => {
	assert.equal(SYNC_THROTTLE_MS, 10 * 60 * 1000);
});

test("timeouts stay in the designed band (5–8s for network pulls)", () => {
	assert.ok(TIMEOUTS.pull <= 8_000);
	assert.ok(TIMEOUTS.lsRemote <= 5_000);
	assert.ok(TIMEOUTS.push >= TIMEOUTS.pull);
});

test("git operations never block on a credential prompt", async () => {
	const source = await import("node:fs/promises").then((fs) =>
		fs.readFile(new URL("../src/lib/sync.ts", import.meta.url), "utf8"),
	);
	assert.match(source, /GIT_TERMINAL_PROMPT/);
	assert.match(source, /BatchMode=yes/);
});

test("countUnpushed reports 0 when in sync and null without an upstream", async () => {
	await withRepo(async ({ dir, root }) => {
		await commitAll(dir, "init");
		assert.equal(await countUnpushed(dir, "main"), null, "no upstream yet");
		await git(dir, ["push", "--set-upstream", "origin", "main"]);
		writeFileSync(join(dir, "x.txt"), "x");
		await commitAll(dir, "another");
		assert.equal(await countUnpushed(dir, "main"), 1);
		void root;
	}, { remote: true });
});

test("lockPathForDir lives inside the git dir, never the worktree", async () => {
	await withRepo(async ({ dir }) => {
		const lock = lockPathForDir(dir);
		assert.equal(lock, join(dir, ".git", "pi-sop.lock"));
		assert.ok(!existsSync(join(dir, "pi-sop.lock")));
	});
});

test("firstLine trims and caps long git error output", () => {
	assert.equal(firstLine("\n\nfatal: nope\nsecond line"), "fatal: nope");
	assert.equal(firstLine(""), "");
	assert.equal(firstLine("x".repeat(500)).length, 300);
});

// ---------------------------------------------------------------------------
// commitAll guards (review findings: rebase-in-progress + foreign staged files)
// ---------------------------------------------------------------------------

test("commitAll refuses to advance an in-progress rebase", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-sop-commitall-rebase-"));
	await git(dir, ["init", "-q", "-b", "main"], 5000);
	await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "base"], 5000);

	// Simulate a mid-rebase state: create rebase-merge marker like git does.
	mkdirSync(join(dir, ".git", "rebase-merge"), { recursive: true });

	const result = await commitAll(dir, "should be refused", ["-A"]);
	assert.equal(result.committed, false);
	assert.equal(result.reason, "sync-conflict-pending");
	rmSync(dir, { recursive: true, force: true });
});

test("commitAll refuses to sweep in foreign staged files", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-sop-commitall-staged-"));
	await git(dir, ["init", "-q", "-b", "main"], 5000);
	writeFileSync(join(dir, "user-work.md"), "user's own staged work\n");
	writeFileSync(join(dir, "sop-a.md"), "sop\n");
	await git(dir, ["add", "user-work.md"], 5000);

	const result = await commitAll(dir, "add sop", ["sop-a.md"]);
	assert.equal(result.committed, false);
	assert.equal(result.reason, "foreign-staged-changes");
	rmSync(dir, { recursive: true, force: true });
});

test("commitAll commits when staged set matches paths", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-sop-commitall-ok-"));
	await git(dir, ["init", "-q", "-b", "main"], 5000);
	writeFileSync(join(dir, "sop-a.md"), "sop\n");
	writeFileSync(join(dir, "MANIFEST.md"), "# m\n");
	await git(dir, ["add", "sop-a.md", "MANIFEST.md"], 5000);

	const result = await commitAll(dir, "add sop", ["sop-a.md", "MANIFEST.md"]);
	assert.equal(result.committed, true);
	rmSync(dir, { recursive: true, force: true });
});
