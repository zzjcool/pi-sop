/**
 * scaffold.ts tests: library skeleton, seed SOP, MANIFEST generation.
 *
 * The git history is asserted through real `git log` because the design
 * promises "additive, never destructive", which is exactly what a scaffold
 * re-run must prove.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { probeLibrary } from "../src/lib/probe.ts";
import {
	GITIGNORE_CONTENT,
	MANIFEST_FILE,
	SEED_SOP_SLUG,
	SOP_DIR,
	hasSkeleton,
	refreshManifest,
	scaffoldLibrary,
	seedSopBody,
	today,
} from "../src/lib/scaffold.ts";
import { parseSop, splitFrontmatter } from "../src/lib/sop.ts";

interface Ctx {
	dir: string;
}

async function withDir(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pi-sop-scaffold-"));
	try {
		await fn({ dir });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function gitLog(dir: string): string[] {
	return execFileSync("git", ["log", "--pretty=%s"], { cwd: dir, encoding: "utf8" })
		.split("\n")
		.filter(Boolean);
}

const FIXED_DATE = new Date("2026-09-21T07:00:00Z");

test("scaffold creates MANIFEST, seed SOP, .gitignore and a repo", async () => {
	await withDir(async ({ dir }) => {
		const result = await scaffoldLibrary(dir, { now: FIXED_DATE });
		assert.equal(result.initializedRepo, true);
		assert.equal(result.committed, true);
		assert.equal(existsSync(join(dir, MANIFEST_FILE)), true);
		assert.equal(existsSync(join(dir, SOP_DIR, `${SEED_SOP_SLUG}.md`)), true);
		assert.equal(existsSync(join(dir, ".gitignore")), true);
		assert.deepEqual(gitLog(dir), ["init: scaffold SOP library"]);
	});
});

test("a freshly scaffolded library probes as no-remote (usable, local-only)", async () => {
	await withDir(async ({ dir }) => {
		await scaffoldLibrary(dir, { now: FIXED_DATE });
		const probe = probeLibrary(dir);
		assert.equal(probe.state, "no-remote");
		assert.equal(probe.branch, "main");
		assert.equal(probe.hasManifest, true);
		assert.equal(probe.hasSopDir, true);
		assert.equal(probe.sopCount, 1);
	});
});

test("the seed SOP has frontmatter pi will accept as a skill", async () => {
	await withDir(async ({ dir }) => {
		await scaffoldLibrary(dir, { now: FIXED_DATE });
		const raw = readFileSync(join(dir, SOP_DIR, `${SEED_SOP_SLUG}.md`), "utf8");
		const { yaml, body } = splitFrontmatter(raw);
		assert.ok(yaml, "must start with frontmatter");
		const fm = parseSop(raw, SEED_SOP_SLUG);
		assert.equal(fm.name, SEED_SOP_SLUG);
		assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
		assert.ok(fm.description.length > 0);
		assert.ok(fm.description.length <= 1024);
		assert.equal(fm.lastVerified, "2026-09-21");
		assert.ok(fm.triggers.includes("save sop"));
		assert.ok(body.length > 100, "body should carry real instructions");
	});
});

test("MANIFEST indexes the seed SOP with all five columns", async () => {
	await withDir(async ({ dir }) => {
		await scaffoldLibrary(dir, { now: FIXED_DATE });
		const manifest = readFileSync(join(dir, MANIFEST_FILE), "utf8");
		assert.match(manifest, /\| name \| scope \| description \| triggers \| last_verified \|/);
		assert.match(manifest, /\| writing-sops \| global \|/);
		assert.match(manifest, /\| 2026-09-21 \|/);
		// the generated date is injectable, so output is deterministic under test
		assert.match(manifest, /2026-09-21T07:00:00\.000Z/);
	});
});

test("scaffold is additive: a second run keeps user files and makes no new commit", async () => {
	await withDir(async ({ dir }) => {
		await scaffoldLibrary(dir, { now: FIXED_DATE });
		writeFileSync(join(dir, SOP_DIR, "my-runbook.md"), "---\nname: my-runbook\ndescription: d\n---\n\nhi\n");
		writeFileSync(join(dir, MANIFEST_FILE), "custom manifest, do not clobber\n");

		const second = await scaffoldLibrary(dir, { now: FIXED_DATE });
		assert.equal(second.initializedRepo, false, "must not re-init an existing repo");
		assert.equal(second.committed, false, "no files created ⇒ nothing committed");
		assert.deepEqual(second.created, []);
		assert.equal(readFileSync(join(dir, MANIFEST_FILE), "utf8"), "custom manifest, do not clobber\n");
		assert.equal(existsSync(join(dir, SOP_DIR, "my-runbook.md")), true);
		// the user's uncommitted working tree must be left alone
		assert.match(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }), /MANIFEST\.md/);
		assert.deepEqual(gitLog(dir), ["init: scaffold SOP library"]);
	});
});

test("rebuild: true regenerates MANIFEST from disk", async () => {
	await withDir(async ({ dir }) => {
		await scaffoldLibrary(dir, { now: FIXED_DATE });
		writeFileSync(join(dir, SOP_DIR, "my-runbook.md"), "---\nname: my-runbook\ndescription: d\n---\n\nhi\n");
		const result = await scaffoldLibrary(dir, { rebuild: true, now: FIXED_DATE });
		const manifest = readFileSync(join(dir, MANIFEST_FILE), "utf8");
		assert.match(manifest, /\| my-runbook \|/);
		assert.match(manifest, /\| writing-sops \|/);
		assert.ok(result.created.some((path) => path.includes(MANIFEST_FILE)));
		assert.equal(result.committed, true);
	});
});

test("scaffold repairs a dir that is already a git repo (no re-init)", async () => {
	await withDir(async ({ dir }) => {
		execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
		const result = await scaffoldLibrary(dir, { now: FIXED_DATE, commit: false });
		assert.equal(result.initializedRepo, false);
		assert.equal(probeLibrary(dir).state, "no-remote");
		assert.equal(hasSkeleton(dir).seed, true);
	});
});

test("scaffolding inside an existing repo with an origin gives ready", async () => {
	await withDir(async ({ dir }) => {
		execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
		execFileSync("git", ["remote", "add", "origin", "https://example.com/lib.git"], {
			cwd: dir,
			stdio: "ignore",
		});
		await scaffoldLibrary(dir, { now: FIXED_DATE });
		const probe = probeLibrary(dir);
		assert.equal(probe.state, "ready");
		assert.equal(probe.remote, "https://example.com/lib.git");
	});
});

test("refreshManifest rewrites on drift and commits", async () => {
	await withDir(async ({ dir }) => {
		await scaffoldLibrary(dir, { now: FIXED_DATE });
		// A hand-added SOP is a real drift: the file is untracked and the index
		// does not mention it yet.
		writeFileSync(join(dir, SOP_DIR, "drifted.md"), "---\nname: drifted\ndescription: d\n---\n\nx\n");
		const result = await refreshManifest(dir, "chore: rebuild MANIFEST", FIXED_DATE);
		assert.equal(result.changed, true);
		assert.equal(result.committed, true);
		assert.equal(result.count, 2);
		assert.deepEqual(gitLog(dir), ["chore: rebuild MANIFEST", "init: scaffold SOP library"]);
		assert.match(readFileSync(join(dir, MANIFEST_FILE), "utf8"), /drifted/);
	});
});

test("refreshManifest is a no-op when nothing drifted", async () => {
	await withDir(async ({ dir }) => {
		await scaffoldLibrary(dir, { now: FIXED_DATE });
		const before = readFileSync(join(dir, MANIFEST_FILE), "utf8");
		const result = await refreshManifest(dir, "chore: rebuild MANIFEST", FIXED_DATE);
		assert.equal(result.changed, false);
		assert.equal(result.committed, false);
		assert.equal(readFileSync(join(dir, MANIFEST_FILE), "utf8"), before);
	});
});

test("refreshManifest drops SOPs that vanish from disk", async () => {
	await withDir(async ({ dir }) => {
		await scaffoldLibrary(dir, { now: FIXED_DATE });
		writeFileSync(join(dir, SOP_DIR, "temp.md"), "---\nname: temp\ndescription: d\n---\n\nx\n");
		await refreshManifest(dir, "add", FIXED_DATE);
		assert.match(readFileSync(join(dir, MANIFEST_FILE), "utf8"), /temp/);

		rmSync(join(dir, SOP_DIR, "temp.md"));
		const result = await refreshManifest(dir, "drop", FIXED_DATE);
		assert.equal(result.count, 1);
		assert.doesNotMatch(readFileSync(join(dir, MANIFEST_FILE), "utf8"), /temp/);
	});
});

test("hasSkeleton reports what is missing", async () => {
	await withDir(async ({ dir }) => {
		assert.deepEqual(hasSkeleton(dir), { manifest: false, sopDir: false, seed: false });
		mkdirSync(join(dir, SOP_DIR), { recursive: true });
		assert.deepEqual(hasSkeleton(dir), { manifest: false, sopDir: true, seed: false });
		await scaffoldLibrary(dir, { now: FIXED_DATE });
		assert.deepEqual(hasSkeleton(dir), { manifest: true, sopDir: true, seed: true });
	});
});

test("scaffold works with commit: false (dry skeleton)", async () => {
	await withDir(async ({ dir }) => {
		const result = await scaffoldLibrary(dir, { commit: false, now: FIXED_DATE });
		assert.equal(result.committed, false);
		assert.equal(existsSync(join(dir, MANIFEST_FILE)), true);
		assert.throws(() => gitLog(dir), "no commit exists yet");
	});
});

test("today() formats as YYYY-MM-DD", () => {
	assert.equal(today(new Date("2026-01-05T12:00:00Z")), "2026-01-05");
	assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
});

test("seed body documents all four frontmatter fields", () => {
	const body = seedSopBody();
	for (const key of ["name", "description", "triggers", "last_verified"]) {
		assert.ok(body.includes(key), `seed body should mention ${key}`);
	}
});

test("seed body carries the multi-language conventions", () => {
	const body = seedSopBody();
	assert.match(body, /## Language/);
	assert.match(body, /正文单语/);
	assert.match(body, /triggers/, "triggers 混语言规则要写清楚");
	assert.match(body, /英文 \| 中文/);
	// the rules the design explicitly rejected must be stated as rejected, not
	// silently omitted (an agent reading this seed is the one writing new SOPs)
	assert.match(body, /zh-CN/);
});

test("seed body documents the project scope and its uniqueness rule", () => {
	const body = seedSopBody();
	assert.match(body, /projects\/<项目键>\//);
	assert.match(body, /project=true/);
	assert.match(body, /不允许同名/);
});

test(".gitignore ignores OS noise and the lock file", () => {
	assert.ok(GITIGNORE_CONTENT.includes(".DS_Store"));
	assert.ok(GITIGNORE_CONTENT.includes("*.swp"));
	assert.ok(GITIGNORE_CONTENT.includes(".pi-sop-lock"));
	// an empty entry from the join() padding must not swallow the newline format
	assert.ok(!GITIGNORE_CONTENT.startsWith("\n"));
});
