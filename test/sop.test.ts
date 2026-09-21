/**
 * sop.ts tests: frontmatter parsing, slug rules, MANIFEST rendering.
 *
 * The parse rules deliberately mirror pi's own frontmatter reader, so several
 * cases here assert compatibility with that reader (BOM, CRLF, `---` boundary).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	countSops,
	isValidSopName,
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

test("renderManifest emits a four-column table sorted by name", () => {
	const docs = [
		{ name: "zebra", description: "z", triggers: "t", lastVerified: "2026-01-01", filePath: "/z", slug: "zebra", body: "" },
		{ name: "alpha", description: "a", triggers: "t", lastVerified: "2026-01-02", filePath: "/a", slug: "alpha", body: "" },
	];
	const manifest = renderManifest(docs, "2026-09-21T00:00:00.000Z");
	assert.match(manifest, /\| name \| description \| triggers \| last_verified \|/);
	const alphaIndex = manifest.indexOf("| alpha |");
	const zebraIndex = manifest.indexOf("| zebra |");
	assert.ok(alphaIndex < zebraIndex, "rows sorted alphabetically");
	assert.match(manifest, /最后生成: 2026-09-21T00:00:00\.000Z/);
});

test("renderManifest escapes pipes so a description cannot break the table", () => {
	const docs = [
		{
			name: "piped",
			description: "a | b | c",
			triggers: "x|y",
			lastVerified: "2026-01-01",
			filePath: "/p",
			slug: "piped",
			body: "",
		},
	];
	const manifest = renderManifest(docs);
	const row = manifest.split("\n").find((line) => line.startsWith("| piped |"));
	assert.ok(row);
	// Every non-delimiter pipe must be escaped, otherwise a cell value would
	// silently create extra columns.
	const withoutEscaped = row.replaceAll("\\|", "\u0000");
	assert.equal(withoutEscaped.split("|").length - 2, 4, "still exactly four cells");
	assert.match(row, /a \\\| b \\\| c/);
});

test("renderManifest has an explicit empty marker", () => {
	const manifest = renderManifest([]);
	assert.match(manifest, /_\(empty\)_/);
});

test("renderManifest flattens newlines so rows stay single-line", () => {
	const docs = [
		{
			name: "multi",
			description: "line one\nline two",
			triggers: "",
			lastVerified: "",
			filePath: "/m",
			slug: "multi",
			body: "",
		},
	];
	const manifest = renderManifest(docs);
	const row = manifest.split("\n").find((line) => line.startsWith("| multi |"));
	assert.ok(row);
	assert.match(row, /line one line two/);
});

test("mostRecentVerification picks the newest date", () => {
	const make = (name: string, date: string) =>
		({ name, description: "", triggers: "", lastVerified: date, filePath: `/${name}`, slug: name, body: "" });
	assert.equal(mostRecentVerification([]), null);
	assert.equal(mostRecentVerification([make("a", "")]), null);
	const result = mostRecentVerification([make("old", "2026-01-01"), make("new", "2026-09-01")]);
	assert.deepEqual(result, { name: "new", date: "2026-09-01" });
});

test("readSopFile returns an issue for a missing file", () => {
	const result = readSopFile("/definitely/not/here.md");
	assert.ok("issue" in result);
});
