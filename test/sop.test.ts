/**
 * sop.ts tests: frontmatter parsing, slug rules, MANIFEST rendering.
 *
 * The parse rules deliberately mirror pi's own frontmatter reader, so several
 * cases here assert compatibility with that reader (BOM, CRLF, `---` boundary).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	countSops,
	descriptionHead,
	findNameConflicts,
	findSopConflicts,
	frontmatterIssue,
	GLOBAL_SCOPE,
	isValidSopName,
	listSopFiles,
	mostRecentVerification,
	parseSop,
	readSopFile,
	renderManifest,
	renderSop,
	scanSopDir,
	slugifySopName,
	splitFrontmatter,
} from "../src/lib/sop.ts";

function withSopDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-sop-sop-"));
	try {
		mkdirSync(join(dir, "sop"), { recursive: true });
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("parseSop reads all four fields", () => {
	const doc = parseSop(
		[
			"---",
			"name: deploy-mysql-replica",
			"description: USE FOR deploying MySQL replicas",
			"triggers: mysql replica, 主从, GTID",
			"last_verified: 2026-09-21",
			"---",
			"",
			"# Body",
		].join("\n"),
		"deploy-mysql-replica",
	);
	assert.equal(doc.name, "deploy-mysql-replica");
	assert.equal(doc.description, "USE FOR deploying MySQL replicas");
	assert.equal(doc.triggers, "mysql replica, 主从, GTID");
	assert.equal(doc.lastVerified, "2026-09-21");
});

test("parseSop normalizes a YAML list into the comma-separated MANIFEST cell", () => {
	const doc = parseSop(
		["---", "name: a", "description: d", "triggers: [alpha, beta,   gamma]", "---"].join("\n"),
		"a",
	);
	assert.equal(doc.triggers, "alpha, beta, gamma");
});

test("parseSop strips quotes from values", () => {
	const doc = parseSop(
		['---', 'name: "quoted-name"', "description: 'single quoted'", "---"].join("\n"),
		"fallback",
	);
	assert.equal(doc.name, "quoted-name");
	assert.equal(doc.description, "single quoted");
});

test("parseSop falls back to the slug when name is missing", () => {
	const doc = parseSop("---\ndescription: only a description\n---\n", "from-filename");
	assert.equal(doc.name, "from-filename");
});

test("parseSop tolerates CRLF and a BOM (pi normalizes both)", () => {
	const doc = parseSop(
		`\uFEFF---\r\nname: win-line\r\ndescription: d\r\nlast_verified: 2026-01-02\r\n---\r\n\r\nbody\r\n`,
		"x",
	);
	assert.equal(doc.name, "win-line");
	assert.equal(doc.description, "d");
	assert.equal(doc.lastVerified, "2026-01-02");
});

test("splitFrontmatter handles a document without frontmatter", () => {
	const { yaml, body } = splitFrontmatter("# no frontmatter here\n");
	assert.equal(yaml, null);
	assert.match(body, /no frontmatter/);
});

test("splitFrontmatter requires a closing --- (matches pi's parser)", () => {
	const { yaml } = splitFrontmatter("---\nname: unterminated\nno closing marker\n");
	assert.equal(yaml, null);
});

test("splitFrontmatter keeps the body intact", () => {
	const { body } = splitFrontmatter("---\nname: a\n---\n\nline1\n\nline2\n");
	assert.equal(body, "line1\n\nline2");
});

test("slugifySopName produces valid names", () => {
	assert.equal(slugifySopName("Deploy MySQL Replica"), "deploy-mysql-replica");
	assert.equal(slugifySopName("  spaces   and___underscores "), "spaces-and-underscores");
	assert.equal(slugifySopName("weird!!chars??"), "weird-chars");
	assert.equal(slugifySopName("--leading-and-trailing--"), "leading-and-trailing");
	assert.equal(slugifySopName("café"), "caf");
	assert.equal(slugifySopName(""), "");
	assert.ok(slugifySopName("x".repeat(200)).length <= 64);
});

test("isValidSopName matches the Agent Skills spec", () => {
	assert.equal(isValidSopName("good-name"), true);
	assert.equal(isValidSopName("good-name-2"), true);
	assert.equal(isValidSopName("UPPER"), false);
	assert.equal(isValidSopName("-leading"), false);
	assert.equal(isValidSopName("trailing-"), false);
	assert.equal(isValidSopName("double--hyphen"), false);
	assert.equal(isValidSopName(""), false);
	assert.equal(isValidSopName("x".repeat(65)), false);
	assert.equal(isValidSopName("x".repeat(64)), true);
});

test("renderSop round-trips through parseSop", () => {
	const rendered = renderSop({
		name: "round-trip",
		description: "USE FOR round tripping",
		triggers: "a, b",
		lastVerified: "2026-09-21",
		body: "# Heading\n\n1. step",
	});
	const parsed = parseSop(rendered, "round-trip");
	assert.equal(parsed.name, "round-trip");
	assert.equal(parsed.description, "USE FOR round tripping");
	assert.equal(parsed.triggers, "a, b");
	assert.equal(parsed.lastVerified, "2026-09-21");
	// body survives, and the frontmatter is a valid YAML block
	assert.match(rendered, /^---\nname: round-trip\n/);
	assert.match(rendered, /\n---\n\n# Heading/);
});

// --- Loadability: the property that actually matters ---------------------
//
// A SOP that parses happily in pi-sop but not in pi is a SILENT loss: pi emits
// no diagnostic for root-level `.md` skills, so the file stays in MANIFEST,
// answers `/sop <keyword>`, and never reaches the agent. These tests therefore
// assert against pi's own parser and loader, not just against parseSop.

type PiFrontmatter = (content: string) => { frontmatter: Record<string, unknown> };

type PiLoader = (options: { dir: string; source: string }) => {
	skills: { name: string; description: string; filePath: string }[];
	diagnostics: unknown[];
};

/** pi's own parser, taken from the package root (no deep import). */
async function piApi(): Promise<{ parseFrontmatter: PiFrontmatter; loadSkillsFromDir: PiLoader }> {
	const mod = (await import("@earendil-works/pi-coding-agent")) as unknown as {
		parseFrontmatter: PiFrontmatter;
		loadSkillsFromDir: PiLoader;
	};
	assert.equal(typeof mod.parseFrontmatter, "function", "pi must export parseFrontmatter");
	assert.equal(typeof mod.loadSkillsFromDir, "function", "pi must export loadSkillsFromDir");
	return mod;
}

/** Descriptions that broke pi's YAML reader in production (v0.4.0). */
const HOSTILE_DESCRIPTIONS = [
	"USE FOR maintaining routing (GitHub: zzjcool/home-router-proxy-kit, Release v1.0.2)",
	"USE FOR `make run` — dropping into pi: `make run` defaults to hy4",
	"USE FOR x | English: with a colon and a #hash and *asterisk",
	"USE FOR trailing colon:",
	"USE FOR a leading dash - and 'single quotes' and \"double\" quotes",
	"USE FOR 中文描述（含 colon: 冒号）、以及 [方括号] 和 {花括号}",
	"USE FOR value starting with a bracket [not a list]",
];

test("renderSop emits frontmatter pi's YAML reader accepts (regression: silent skill loss)", async () => {
	const { parseFrontmatter } = await piApi();
	for (const description of HOSTILE_DESCRIPTIONS) {
		const rendered = renderSop({
			name: "hostile",
			description,
			triggers: "a: b, c # d, [e]",
			lastVerified: "2026-10-17",
			body: "body",
		});
		// Must not throw — a throw is exactly what makes pi drop the skill.
		const { frontmatter } = parseFrontmatter(rendered);
		assert.equal(frontmatter.description, description, `pi must read back: ${description}`);
		assert.equal(frontmatter.triggers, "a: b, c # d, [e]");
		assert.equal(frontmatter.name, "hostile");
		assert.equal(frontmatter.last_verified, "2026-10-17");
	}
});

test("renderSop keeps each value on one line (no YAML wrapping)", () => {
	const rendered = renderSop({
		name: "long",
		description: `USE FOR ${"very long prose ".repeat(40)}end`,
		triggers: "a",
		lastVerified: "2026-10-17",
		body: "b",
	});
	const { yaml } = splitFrontmatter(rendered);
	const lines = (yaml ?? "").split("\n").filter((line) => line.trim() !== "");
	assert.equal(lines.length, 4, "four keys, one line each — no continuation lines");
});

// The end-to-end property: a sop/ directory written by renderSop must come out
// of PI'S OWN loader with every file loadable as a skill.
test("pi's loader reads every renderSop-written file in a sop/ dir (no silent drops)", async () => {
	const { loadSkillsFromDir } = await piApi();
	const dir = mkdtempSync(join(tmpdir(), "pi-sop-loadable-"));
	try {
		HOSTILE_DESCRIPTIONS.forEach((description, index) => {
			writeFileSync(
				join(dir, `hostile-${index}.md`),
				renderSop({
					name: `hostile-${index}`,
					description,
					triggers: "a: b",
					lastVerified: "2026-10-17",
					body: "body",
				}),
			);
		});
		const result = loadSkillsFromDir({ dir, source: "path" });
		assert.equal(
			result.skills.length,
			HOSTILE_DESCRIPTIONS.length,
			"pi must load every SOP (a drop here is invisible in production)",
		);
		// And the descriptions survive verbatim (no mangling by quoting).
		for (let index = 0; index < HOSTILE_DESCRIPTIONS.length; index += 1) {
			const skill = result.skills.find((entry) => entry.name === `hostile-${index}`);
			assert.equal(skill?.description, HOSTILE_DESCRIPTIONS[index]);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pi's loader drops a hand-written unquoted-colon SOP — the bug this fixes", async () => {
	const { loadSkillsFromDir } = await piApi();
	const dir = mkdtempSync(join(tmpdir(), "pi-sop-loadable-bad-"));
	try {
		// Exactly the v0.4.0 shape: unquoted description with `GitHub: org/repo`.
		writeFileSync(
			join(dir, "broken.md"),
			"---\nname: broken\ndescription: routing (GitHub: org/repo)\n---\n\nbody\n",
		);
		const result = loadSkillsFromDir({ dir, source: "path" });
		assert.equal(result.skills.length, 0, "pi drops it silently — no skill, no diagnostic");
		assert.equal(result.diagnostics.length, 0, "...and reports nothing at all");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("frontmatterIssue names the exact failure pi would hide", async () => {
	// Valid + readable → no issue.
	assert.equal(frontmatterIssue("---\nname: a\ndescription: d\n---\n"), null);
	// The production bug: unquoted value containing `: `.
	const broken = "---\nname: a\ndescription: routing (GitHub: org/repo)\n---\n";
	const issue = frontmatterIssue(broken);
	assert.ok(issue, "broken YAML must be reported");
	assert.match(issue, /YAML/);
	// Missing description is the other silent-skip path.
	assert.match(frontmatterIssue("---\nname: a\n---\n") ?? "", /description/);
	// No frontmatter at all.
	assert.match(frontmatterIssue("# just a heading\n") ?? "", /frontmatter/);
});

// The pathological file above must be caught by readSopFile/scanSopDir rather
// than being reported as a healthy document (pre-v0.5 behavior).
test("scanSopDir reports YAML-invalid frontmatter as an issue and omits the doc", async () => {
	const { parseFrontmatter } = await piApi();
	withSopDir((dir) => {
		const broken = "---\nname: broken\ndescription: routing (GitHub: org/repo)\n---\n\nbody\n";
		writeFileSync(join(dir, "sop", "broken.md"), broken);
		writeFileSync(join(dir, "sop", "fine.md"), "---\nname: fine\ndescription: d\n---\n");
		// Sanity: this is genuinely invalid for pi.
		assert.throws(() => parseFrontmatter(broken));

		const result = scanSopDir(dir);
		assert.deepEqual(result.docs.map((doc) => doc.name), ["fine"]);
		assert.equal(result.issues.length, 1);
		assert.equal(result.issues[0]?.filePath, join(dir, "sop", "broken.md"));
	});
});

test("scanSopDir collects docs, sorted, and ignores non-markdown + dotfiles", () => {
	withSopDir((dir) => {
		assert.equal(scanSopDir(dir).docs.length, 0, "empty sop/ → no docs");
		writeFileSync(join(dir, "sop", "zebra.md"), "---\nname: zebra\ndescription: d\n---\n");
		writeFileSync(join(dir, "sop", "alpha.md"), "---\nname: alpha\ndescription: d\n---\n");
		writeFileSync(join(dir, "sop", ".hidden.md"), "---\nname: hidden\ndescription: d\n---\n");
		writeFileSync(join(dir, "sop", "notes.txt"), "ignored");
		mkdirSync(join(dir, "sop", "nested"));
		const result = scanSopDir(dir);
		assert.deepEqual(result.docs.map((d) => d.name), ["alpha", "zebra"]);
		assert.equal(result.issues.length, 0);
	});
});

test("scanSopDir reports a doc missing description as an issue, not a crash", () => {
	withSopDir((dir) => {
		writeFileSync(join(dir, "sop", "good.md"), "---\nname: good\ndescription: d\n---\n");
		writeFileSync(join(dir, "sop", "bad.md"), "---\nname: bad\n---\n");
		const result = scanSopDir(dir);
		assert.deepEqual(result.docs.map((d) => d.name), ["good"]);
		assert.equal(result.issues.length, 1);
		assert.match(result.issues[0]?.message ?? "", /description/);
	});
});

test("scanSopDir on a missing sop/ dir returns empty, never throws", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-sop-nosop-"));
	try {
		const result = scanSopDir(dir);
		assert.deepEqual(result, { docs: [], issues: [] });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("countSops counts only markdown files", () => {
	withSopDir((dir) => {
		assert.equal(countSops(dir), 0);
		writeFileSync(join(dir, "sop", "a.md"), "---\nname: a\ndescription: d\n---\n");
		writeFileSync(join(dir, "sop", "b.md"), "---\nname: b\ndescription: d\n---\n");
		writeFileSync(join(dir, "sop", "c.txt"), "x");
		assert.equal(countSops(dir), 2);
	});
});

test("renderManifest emits a five-column table (scope included) sorted by name", () => {
	const docs = [
		{ name: "zebra", scope: "global", description: "z", triggers: "t", lastVerified: "2026-01-01", filePath: "/z", slug: "zebra", body: "", extra: {} },
		{ name: "alpha", scope: "global", description: "a", triggers: "t", lastVerified: "2026-01-02", filePath: "/a", slug: "alpha", body: "", extra: {} },
	];
	const manifest = renderManifest(docs, "2026-09-21T00:00:00.000Z");
	assert.match(manifest, /\| name \| scope \| description \| triggers \| last_verified \|/);
	const alphaIndex = manifest.indexOf("| alpha |");
	const zebraIndex = manifest.indexOf("| zebra |");
	assert.ok(alphaIndex < zebraIndex, "rows sorted alphabetically");
	assert.match(manifest, /最后生成: 2026-09-21T00:00:00\.000Z/, "explicit generatedAt renders the footer");
	// Default rendering carries no timestamp: deterministic bytes across
	// machines (the cross-machine conflict fix).
	assert.doesNotMatch(renderManifest(docs), /最后生成/);
});

test("renderManifest labels the scope of a project SOP with its project key", () => {
	const docs = [
		{
			name: "tdmq-deploy",
			scope: "git.woa.com/csig_tdmq/tdmq-appserver",
			description: "d",
			triggers: "t",
			lastVerified: "2026-01-01",
			filePath: "/p",
			slug: "tdmq-deploy",
			body: "",
			extra: {},
		},
	];
	const row = renderManifest(docs).split("\n").find((line) => line.startsWith("| tdmq-deploy |"));
	assert.ok(row);
	assert.match(row, /\| git\.woa\.com\/csig_tdmq\/tdmq-appserver \|/);
});

test("renderManifest shows only the English segment of a bilingual description", () => {
	const docs = [
		{
			name: "bilingual",
			scope: "global",
			description: "USE FOR thing | 用于某件事",
			triggers: "",
			lastVerified: "",
			filePath: "/b",
			slug: "bilingual",
			body: "",
			extra: {},
		},
	];
	const row = renderManifest(docs).split("\n").find((line) => line.startsWith("| bilingual |"));
	assert.ok(row);
	// The table stays narrow; pi itself still reads the full bilingual value
	// from the SOP frontmatter (only the MANIFEST projection is trimmed).
	assert.match(row, /USE FOR thing \|/);
	assert.doesNotMatch(row, /用于某件事/);
});

test("renderManifest escapes pipes so a cell value cannot break the table", () => {
	const docs = [
		{
			name: "piped",
			scope: "global",
			description: "no pipes here",
			triggers: "x|y",
			lastVerified: "2026-01-01",
			filePath: "/p",
			slug: "piped",
			body: "",
			extra: {},
		},
	];
	const manifest = renderManifest(docs);
	const row = manifest.split("\n").find((line) => line.startsWith("| piped |"));
	assert.ok(row);
	// Every non-delimiter pipe must be escaped, otherwise a cell value would
	// silently create extra columns.
	const withoutEscaped = row.replaceAll("\\|", "\u0000");
	assert.equal(withoutEscaped.split("|").length - 2, 5, "still exactly five cells");
	assert.match(row, /x\\\|y/);
});

test("descriptionHead falls back to the full text when the first segment is empty", () => {
	assert.equal(descriptionHead("English part | 中文部分"), "English part");
	assert.equal(descriptionHead("only english"), "only english");
	assert.equal(descriptionHead("| 只有中文"), "| 只有中文");
	assert.equal(descriptionHead("line one\nline two"), "line one line two");
});

test("renderManifest has an explicit empty marker", () => {
	const manifest = renderManifest([]);
	assert.match(manifest, /_\(empty\)_/);
});

test("renderManifest flattens newlines so rows stay single-line", () => {
	const docs = [
		{
			name: "multi",
			scope: "global",
			description: "line one\nline two",
			triggers: "",
			lastVerified: "",
			filePath: "/m",
			slug: "multi",
			body: "",
			extra: {},
		},
	];
	const manifest = renderManifest(docs);
	const row = manifest.split("\n").find((line) => line.startsWith("| multi |"));
	assert.ok(row);
	assert.match(row, /line one line two/);
});

test("mostRecentVerification picks the newest date", () => {
	const make = (name: string, date: string) =>
		({ name, scope: "global", description: "", triggers: "", lastVerified: date, filePath: `/${name}`, slug: name, body: "", extra: {} });
	assert.equal(mostRecentVerification([]), null);
	assert.equal(mostRecentVerification([make("a", "")]), null);
	const result = mostRecentVerification([make("old", "2026-01-01"), make("new", "2026-09-01")]);
	assert.deepEqual(result, { name: "new", date: "2026-09-01" });
});

test("readSopFile returns an issue for a missing file", () => {
	const result = readSopFile("/definitely/not/here.md");
	assert.ok("issue" in result);
});

test("readSopFile stamps the scope it is given (global by default)", () => {
	withSopDir((dir) => {
		const path = join(dir, "sop", "scoped.md");
		writeFileSync(path, "---\nname: scoped\ndescription: d\n---\n");
		const viaDefault = readSopFile(path);
		assert.ok("doc" in viaDefault);
		assert.equal(viaDefault.doc.scope, GLOBAL_SCOPE);
		const viaArg = readSopFile(path, "git.woa.com/org/repo");
		assert.ok("doc" in viaArg);
		assert.equal(viaArg.doc.scope, "git.woa.com/org/repo");
	});
});

test("scanSopDir reads global + nested project SOPs, each with its scope", () => {
	withSopDir((dir) => {
		writeFileSync(join(dir, "sop", "global-one.md"), "---\nname: global-one\ndescription: d\n---\n");
		const project = join(dir, "projects", "git.woa.com", "org", "repo");
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, "proj-one.md"), "---\nname: proj-one\ndescription: d\n---\n");
		// a file directly in projects/ has no key ⇒ ignored, not guessed
		writeFileSync(join(dir, "projects", "stray.md"), "---\nname: stray\ndescription: d\n---\n");
		const result = scanSopDir(dir);
		const byName = new Map(result.docs.map((doc) => [doc.name, doc.scope]));
		assert.equal(byName.get("global-one"), "global");
		assert.equal(byName.get("proj-one"), "git.woa.com/org/repo");
		assert.equal(byName.has("stray"), false);
	});
});

test("listSopFiles lists every scope and skips non-markdown + dotfiles", () => {
	withSopDir((dir) => {
		writeFileSync(join(dir, "sop", "a.md"), "x");
		writeFileSync(join(dir, "sop", "notes.txt"), "x");
		writeFileSync(join(dir, "sop", ".hidden.md"), "x");
		const project = join(dir, "projects", "host", "org", "repo");
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, "b.md"), "x");
		const files = listSopFiles(dir);
		assert.deepEqual(files.map((f) => f.scope), ["global", "host/org/repo"]);
		assert.equal(countSops(dir), 2);
	});
});

test("countSops counts every scope", () => {
	withSopDir((dir) => {
		writeFileSync(join(dir, "sop", "a.md"), "x");
		mkdirSync(join(dir, "projects", "h", "o", "r"), { recursive: true });
		writeFileSync(join(dir, "projects", "h", "o", "r", "b.md"), "x");
		writeFileSync(join(dir, "projects", "h", "o", "r", "c.md"), "x");
		assert.equal(countSops(dir), 3);
	});
});

test("findSopConflicts reports a name present in two scopes, with both paths", () => {
	withSopDir((dir) => {
		writeFileSync(join(dir, "sop", "shared.md"), "---\nname: shared\ndescription: d\n---\n");
		const project = join(dir, "projects", "host", "org", "repo");
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, "shared.md"), "---\nname: shared\ndescription: d2\n---\n");
		writeFileSync(join(dir, "sop", "unique.md"), "---\nname: unique\ndescription: d\n---\n");
		const conflicts = findSopConflicts(dir);
		assert.equal(conflicts.length, 1);
		assert.equal(conflicts[0]?.name, "shared");
		assert.deepEqual(
			conflicts[0]?.occurrences.map((o) => o.scope),
			["global", "host/org/repo"],
		);
		// the guard consults the same data
		assert.deepEqual(findNameConflicts(dir, "shared").map((doc) => doc.scope), [
			"global",
			"host/org/repo",
		]);
		assert.equal(findNameConflicts(dir, "unique").length, 1);
		assert.deepEqual(findNameConflicts(dir, "absent"), []);
	});
});

test("findSopConflicts is empty for a healthy cross-scope library", () => {
	withSopDir((dir) => {
		writeFileSync(join(dir, "sop", "a.md"), "---\nname: a\ndescription: d\n---\n");
		const project = join(dir, "projects", "host", "org", "repo");
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, "b.md"), "---\nname: b\ndescription: d\n---\n");
		assert.deepEqual(findSopConflicts(dir), []);
	});
});

// ---------------------------------------------------------------------------
// Review round (project mapping): symlink skip, scope validation, port keys
// ---------------------------------------------------------------------------

test("walkProjectFiles never follows symlinks (foreign dir / cycle)", async () => {
	const { scanSopDir } = await import("../src/lib/sop.ts");
	const root = mkdtempSync(join(tmpdir(), "pi-sop-symlink-"));
	const libDir = join(root, "lib");
	// Real SOP under a valid two-segment key
	const projDir = join(libDir, "projects", "host.example", "org", "repo");
	mkdirSync(projDir, { recursive: true });
	writeFileSync(join(projDir, "real.md"), "---\nname: real\ndescription: d\n---\n# real\n");
	// Foreign directory with .md outside the library
	const foreign = join(root, "foreign");
	mkdirSync(foreign, { recursive: true });
	writeFileSync(join(foreign, "outsider.md"), "---\nname: outsider\ndescription: d\n---\n");
	// Symlink pointing outside the library must be ignored
	symlinkSync(foreign, join(libDir, "projects", "host.example", "org", "leak"));
	// Cyclic symlink must not multiply entries
	symlinkSync(".", join(libDir, "projects", "host.example", "org", "repo", "loop"));
	const { docs } = scanSopDir(libDir);
	const names = docs.map((d) => d.name);
	assert.ok(names.includes("real"));
	assert.ok(!names.includes("outsider"), "symlinked foreign dir must not leak in");
	assert.equal(names.filter((n) => n === "real").length, 1, "cyclic link must not duplicate");
	rmSync(root, { recursive: true, force: true });
});

test("single-segment directories under projects/ are excluded (mistaken clone)", async () => {
	const { scanSopDir } = await import("../src/lib/sop.ts");
	const root = mkdtempSync(join(tmpdir(), "pi-sop-misclone-"));
	const libDir = join(root, "lib");
	// A repo cloned straight into projects/ → single-segment scope, exclude
	const cloneDir = join(libDir, "projects", "random-repo");
	mkdirSync(join(cloneDir, "docs"), { recursive: true });
	writeFileSync(join(cloneDir, "README.md"), "# not a sop\n");
	writeFileSync(join(cloneDir, "docs", "guide.md"), "# not a sop\n");
	const { docs } = scanSopDir(libDir);
	assert.equal(docs.length, 0, "single-segment scope must be excluded");
	rmSync(root, { recursive: true, force: true });
});

test("normalizeProjectKey: bare host:port form matches ssh://host:port form", async () => {
	const { normalizeProjectKey } = await import("../src/lib/project.ts");
	assert.equal(
		normalizeProjectKey("host:2222/org/repo.git"),
		normalizeProjectKey("ssh://git@host:2222/org/repo.git"),
	);
	assert.equal(normalizeProjectKey("host:2222/org/repo.git"), "host/org/repo");
});

test("readOriginUrlFromGitDir follows [include] config via git fallback", async () => {
	const { readOriginUrlFromGitDir } = await import("../src/lib/probe.ts");
	const root = mkdtempSync(join(tmpdir(), "pi-sop-include-"));
	const included = join(root, "included.conf");
	writeFileSync(included, '[remote "origin"]\n\turl = git@example.com:org/repo.git\n');
	const gitDir = join(root, "repo.git");
	mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
	mkdirSync(join(gitDir, "objects"), { recursive: true });
	writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(
		join(gitDir, "config"),
		`[core]\n\trepositoryformatversion = 0\n[include]\n\tpath = ${included}\n`,
	);
	// git needs a minimally valid git dir (HEAD/refs/objects) before it will
	// even parse the config for `--get`.
	assert.equal(readOriginUrlFromGitDir(gitDir), "git@example.com:org/repo.git");
	rmSync(root, { recursive: true, force: true });
});

// --- Frontmatter preservation (pi's own keys must survive a rewrite) ------
//
// `sop_save` rewrites the whole file from parsed fields. Before v0.5.1 that
// dropped every key pi-sop did not model, including pi's
// `disable-model-invocation` — so re-saving a hidden SOP silently re-exposed it
// to the model. Same silent-loss shape as the YAML quoting bug.

test("parseSop round-trip preserves frontmatter keys pi-sop does not own", () => {
	const source = [
		"---",
		"name: hidden-one",
		"description: hidden from model",
		"disable-model-invocation: true",
		"triggers: a",
		"last_verified: 2026-10-17",
		"---",
		"",
		"body",
	].join("\n");
	withSopDir((dir) => {
		const path = join(dir, "sop", "hidden-one.md");
		writeFileSync(path, source);
		const read = readSopFile(path);
		if (!("doc" in read)) throw new Error("expected a doc");
		assert.equal(read.doc.extra["disable-model-invocation"], "true");

		// Rewriting must carry the key through.
		const rendered = renderSop({ ...read.doc, body: read.doc.body });
		assert.match(rendered, /^disable-model-invocation: true$/m);
		const again = readSopFile(path);
		assert.ok("doc" in again);
		const rerendered = renderSop({ ...again.doc, body: read.doc.body });
		assert.equal(rerendered, rendered, "re-save must be byte-stable");
	});
});

test("renderSop keeps owned keys first and unknown keys after", () => {
	const rendered = renderSop({
		name: "n",
		description: "d",
		triggers: "t",
		lastVerified: "2026-10-17",
		body: "b",
		extra: { "disable-model-invocation": "true", "custom-note": "keep: me" },
	});
	const keys = splitFrontmatter(rendered)
		.yaml!.split("\n")
		.map((line) => line.slice(0, line.indexOf(":")));
	assert.deepEqual(keys, ["name", "description", "triggers", "last_verified", "disable-model-invocation", "custom-note"]);
	// A value with ': ' must still be quoted even in the unknown-key position.
	assert.match(rendered, /^custom-note: "keep: me"$/m);
});

test("renderSop never duplicates a key that extra tries to claim", () => {
	const rendered = renderSop({
		name: "n",
		description: "d",
		triggers: "t",
		lastVerified: "2026-10-17",
		body: "b",
		extra: { name: "sneaky", description: "sneaky" },
	});
	assert.equal((rendered.match(/^name:/gm) ?? []).length, 1);
	assert.equal((rendered.match(/^description:/gm) ?? []).length, 1);
});
