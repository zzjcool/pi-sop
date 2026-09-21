/**
 * pi-sop SOP documents: frontmatter parsing, MANIFEST generation.
 *
 * Design: docs/init-design.md §6
 *
 *   sop/<name>.md       frontmatter + body
 *   MANIFEST.md         table: name | description | triggers | last_verified
 *
 * The frontmatter is the same shape pi's skill discovery understands
 * (`name` + non-empty `description`), plus two pi-sop specific keys:
 * `triggers` (comma separated search hints) and `last_verified` (shot-clock for
 * stale SOPs). Do not rename `description`: skill discovery ignores root `.md`
 * files without it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface SopFrontmatter {
	name: string;
	description: string;
	triggers: string;
	lastVerified: string;
}

export interface SopDoc extends SopFrontmatter {
	/** Absolute path of the .md file. */
	filePath: string;
	/** File name without the `.md` extension. */
	slug: string;
	body: string;
}

export interface ParseIssue {
	filePath: string;
	message: string;
}

export interface ScanResult {
	docs: SopDoc[];
	issues: ParseIssue[];
}

/** A valid skill name per the Agent Skills spec (and what pi warns about). */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidSopName(name: string): boolean {
	return name.length > 0 && name.length <= 64 && NAME_PATTERN.test(name);
}

/** Normalize an arbitrary title/slug into a valid SOP name. */
export function slugifySopName(input: string): string {
	const slug = input
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64)
		.replace(/-$/, "");
	return slug;
}

function normalizeNewlines(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Split frontmatter from body. Mirrors pi's own parser (including the
 * `startsWith("---")` requirement) so a file we accept is a file pi accepts.
 */
export function splitFrontmatter(content: string): { yaml: string | null; body: string } {
	const normalized = normalizeNewlines(content.replace(/^\uFEFF/, ""));
	if (!normalized.startsWith("---")) return { yaml: null, body: normalized.trim() };
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return { yaml: null, body: normalized.trim() };
	return {
		yaml: normalized.slice(4, endIndex),
		body: normalized.slice(endIndex + 4).trim(),
	};
}

/**
 * Minimal scalar parser for our flat frontmatter. Only handles the keys we own:
 * `key: value` and `key: [a, b]` / comma-separated lists. Anything else is
 * treated as a string, which is exactly what `triggers` needs.
 */
function parseScalars(yaml: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const rawLine of yaml.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim().toLowerCase();
		let value = line.slice(colon + 1).trim();
		if (value.startsWith("[") && value.endsWith("]")) {
			value = value.slice(1, -1);
		}
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (!values.has(key)) values.set(key, value.trim());
	}
	return values;
}

export function parseSop(content: string, slug: string): SopFrontmatter {
	const { yaml } = splitFrontmatter(content);
	const scalars = yaml ? parseScalars(yaml) : new Map<string, string>();
	const rawTriggers = scalars.get("triggers") ?? "";
	return {
		name: scalars.get("name")?.trim() || slug,
		description: scalars.get("description")?.trim() ?? "",
		// Normalize list-ish syntax into the comma-separated MANIFEST cell.
		triggers: rawTriggers
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean)
			.join(", "),
		lastVerified: scalars.get("last_verified")?.trim() ?? "",
	};
}

/** Serialize an SOP document (frontmatter + body). */
export function renderSop(doc: {
	name: string;
	description: string;
	triggers: string;
	lastVerified: string;
	body: string;
}): string {
	const body = doc.body.trim();
	return [
		"---",
		`name: ${doc.name}`,
		`description: ${doc.description}`,
		`triggers: ${doc.triggers}`,
		`last_verified: ${doc.lastVerified}`,
		"---",
		"",
		body,
		"",
	].join("\n");
}

/** Read one SOP file. Returns null when the file has no usable frontmatter. */
export function readSopFile(filePath: string): { doc: SopDoc } | { issue: ParseIssue } {
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch (error) {
		return { issue: { filePath, message: error instanceof Error ? error.message : "read failed" } };
	}
	const slug = filePath.split(/[\\/]/).pop()?.replace(/\.md$/, "") ?? "";
	const frontmatter = parseSop(content, slug);
	if (!frontmatter.description) {
		return { issue: { filePath, message: "缺少 description（不会被 pi 识别为 skill）" } };
	}
	return {
		doc: {
			...frontmatter,
			filePath,
			slug,
			body: splitFrontmatter(content).body,
		},
	};
}

/** Scan `<libDir>/sop/*.md`. Never throws; unreadable files become issues. */
export function scanSopDir(libDir: string): ScanResult {
	const sopDir = join(libDir, "sop");
	let entries: string[];
	try {
		entries = readdirSync(sopDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return { docs: [], issues: [] };
	}
	const docs: SopDoc[] = [];
	const issues: ParseIssue[] = [];
	for (const name of entries) {
		const result = readSopFile(join(sopDir, name));
		if ("doc" in result) docs.push(result.doc);
		else issues.push(result.issue);
	}
	return { docs, issues };
}

/** Escape a value for a Markdown table cell. */
function cell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/** Render MANIFEST.md from the scanned SOPs (deterministic ordering). */
export function renderManifest(docs: SopDoc[], generatedAt: string = new Date().toISOString()): string {
	const sorted = [...docs].sort((a, b) => a.name.localeCompare(b.name));
	const lines = [
		"# SOP MANIFEST",
		"",
		"> 本文件由 pi-sop 自动维护（`sop_save` 写入，`/sop init` → 状态面板 → 重建 MANIFEST 可强制刷新）。",
		`> 最后生成: ${generatedAt}`,
		"",
		"| name | description | triggers | last_verified |",
		"|---|---|---|---|",
	];
	for (const doc of sorted) {
		lines.push(
			`| ${cell(doc.name)} | ${cell(doc.description)} | ${cell(doc.triggers)} | ${cell(doc.lastVerified)} |`,
		);
	}
	if (sorted.length === 0) {
		lines.push("| _(empty)_ | | | |");
	}
	lines.push("");
	return lines.join("\n");
}

/** Rebuild `<libDir>/MANIFEST.md` from `sop/*.md`. Returns the SOP count. */
export function rebuildManifest(
	libDir: string,
	generatedAt?: string,
): { count: number; issues: ParseIssue[]; content: string } {
	const { docs, issues } = scanSopDir(libDir);
	const content = renderManifest(docs, generatedAt);
	return { count: docs.length, issues, content };
}

/** Count SOPs without parsing frontmatter (cheap path for notify text). */
export function countSops(libDir: string): number {
	try {
		return readdirSync(join(libDir, "sop"), { withFileTypes: true }).filter(
			(entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."),
		).length;
	} catch {
		return 0;
	}
}

/** Most recent `last_verified` across the library (status panel). */
export function mostRecentVerification(
	docs: SopDoc[],
): { name: string; date: string } | null {
	let best: { name: string; date: string } | null = null;
	for (const doc of docs) {
		if (!doc.lastVerified) continue;
		if (!best || doc.lastVerified > best.date) best = { name: doc.name, date: doc.lastVerified };
	}
	return best;
}
