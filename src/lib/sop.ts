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

import { PROJECTS_DIR } from "./project.ts";

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
	/**
	 * `global` for `sop/*.md`, otherwise the project key of the containing
	 * directory (`projects/<key>/…` → `<key>`, e.g.
	 * `git.woa.com/csig_tdmq/tdmq-appserver`). Surfaced in MANIFEST and
	 * `/sop <keyword>` so a reader can tell which project a SOP belongs to.
	 */
	scope: string;
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

/** Every SOP that lives outside a project directory belongs to this scope. */
export const GLOBAL_SCOPE = "global";

/** A SOP file and the scope it lives in. */
export interface ScopedFile {
	path: string;
	scope: string;
}

/** A `.md` file present in more than one scope (name collision). */
export interface ScopeConflict {
	name: string;
	/** `{ scope, filePath }` for every occurrence, global first. */
	occurrences: { scope: string; filePath: string }[];
}

/** A valid skill name per the Agent Skills spec (and what pi warns about). */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Direct `*.md` children of `dir`, sorted; `[]` when unreadable. */
function listMarkdown(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/**
/**
 * Every SOP file in the library: global first, then project-scoped.
 *
 * Reads are whole-library on purpose. Loading is deliberately narrow (only the
 * current project's dir + the global dir are registered as skill paths), but
 * search, MANIFEST and the duplicate guard must see every scope.
 */
export function listSopFiles(libDir: string): ScopedFile[] {
	const files: ScopedFile[] = listMarkdown(join(libDir, "sop")).map((name) => ({
		path: join(libDir, "sop", name),
		scope: GLOBAL_SCOPE,
	}));

	const projectsDir = join(libDir, PROJECTS_DIR);
	for (const relative of walkProjectFiles(projectsDir)) {
		// The scope is the containing directory path — that IS the project key,
		// because keys keep their `/` (host/org/repo). A file dumped directly
		// into `projects/` has no key; it is skipped rather than guessed at.
		const slash = relative.lastIndexOf("/");
		if (slash <= 0) continue;
		const scope = relative.slice(0, slash);
		// A valid key is at least `host/repo` (two segments). A repo mistakenly
		// `git clone`d straight into `projects/` would surface as a single-segment
		// scope with its README/docs collected as SOPs — exclude that noise.
		if (!scope.includes("/")) continue;
		files.push({ path: join(projectsDir, relative), scope });
	}
	return files;
}

/** Depth-bounded walk of `projects/`, returning posix relative file paths.
 *
 * Symlinks are NEVER followed (review finding): a link pointing outside the
 * library would pull foreign `.md` files into MANIFEST/search/conflict
 * checks under a fabricated scope, and a cyclic link multiplies entries.
 * The library is pi-sop-managed; everything under `projects/` should be
 * regular files created by `sop_save`.
 */
function walkProjectFiles(root: string, prefix = "", depth = 0): string[] {
	if (depth > 8) return []; // defensive: a pathological tree must not hang us
	const current = prefix ? join(root, prefix) : root;
	let entries;
	try {
		entries = readdirSync(current, { withFileTypes: true });
	} catch {
		return [];
	}
	const found: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		// Symlinks (file or dir): skip entirely — see the doc comment above.
		if (entry.isSymbolicLink()) continue;
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			found.push(...walkProjectFiles(root, relative, depth + 1));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			found.push(relative);
		}
	}
	return found.sort();
}

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

/**
 * Read one SOP file. Returns an issue when the file has no usable
 * frontmatter. `scope` defaults to global so single-file callers stay simple.
 */
export function readSopFile(filePath: string, scope: string = GLOBAL_SCOPE): { doc: SopDoc } | { issue: ParseIssue } {
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
			scope,
			body: splitFrontmatter(content).body,
		},
	};
}

/**
 * Scan the whole library: `<libDir>/sop/*.md` plus every project directory
 * under `<libDir>/projects/`. Never throws; unreadable files become issues.
 *
 * This is the read path (status / MANIFEST / search / duplicate guard) and is
 * intentionally wider than the *load* path in `resources_discover`, which only
 * registers the current project's directory and the global one.
 */
export function scanSopDir(libDir: string): ScanResult {
	const docs: SopDoc[] = [];
	const issues: ParseIssue[] = [];
	for (const file of listSopFiles(libDir)) {
		const result = readSopFile(file.path, file.scope);
		if ("doc" in result) docs.push(result.doc);
		else issues.push(result.issue);
	}
	return { docs, issues };
}

/**
 * Frontmatter `name` values that appear in more than one file.
 *
 * pi's skill loader keeps the first registration and silently drops the rest
 * (`collision` diagnostic only), so a duplicate name means one SOP quietly
 * disappears. `sop_save` refuses such writes up front; this detector covers the
 * files a human added by hand.
 */
export function findSopConflicts(libDir: string): ScopeConflict[] {
	const { docs } = scanSopDir(libDir);
	const byName = new Map<string, { scope: string; filePath: string }[]>();
	for (const doc of docs) {
		const entries = byName.get(doc.name) ?? [];
		// Global first inside each group, so the report reads as "the global one
		// wins" (registration order is project-then-global).
		entries.push({ scope: doc.scope, filePath: doc.filePath });
		byName.set(doc.name, entries);
	}
	const conflicts: ScopeConflict[] = [];
	for (const [name, occurrences] of byName) {
		if (occurrences.length < 2) continue;
		conflicts.push({ name, occurrences });
	}
	return conflicts.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every SOP file whose frontmatter `name` equals `name` (usually 0 or 1).
 * More than one means the library already has a collision — which is exactly
 * what `sop_save`'s guard and the session_start warning need to know.
 */
export function findNameConflicts(libDir: string, name: string): SopDoc[] {
	return scanSopDir(libDir).docs.filter((doc) => doc.name === name);
}

/** Escape a value for a Markdown table cell. */
function cell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/**
 * The description part to show in MANIFEST: for a bilingual
 * `English | 中文` description only the English segment is shown, otherwise a
 * long bilingual string would blow up the table width.
 */
export function descriptionHead(description: string): string {
	const [head] = description.split("|");
	// Fall back to the whole value when the head segment is empty (`| 中文`).
	return (head?.trim() || description.trim()).replace(/\r?\n/g, " ");
}

/** Render MANIFEST.md from the scanned SOPs (deterministic ordering). */
export function renderManifest(docs: SopDoc[], generatedAt: string = new Date().toISOString()): string {
	const sorted = [...docs].sort((a, b) => a.name.localeCompare(b.name));
	const lines = [
		"# SOP MANIFEST",
		"",
		"> 本文件由 pi-sop 自动维护（`sop_save` 写入，`/sop init` → 状态面板 → 重建 MANIFEST 可强制刷新）。",
		"> `scope` 列：`global` 或项目键（`git.woa.com/org/repo`），项目键对应 `projects/<键>/` 目录。",
		`> 最后生成: ${generatedAt}`,
		"",
		"| name | scope | description | triggers | last_verified |",
		"|---|---|---|---|---|",
	];
	for (const doc of sorted) {
		lines.push(
			`| ${cell(doc.name)} | ${cell(doc.scope)} | ${cell(descriptionHead(doc.description))} | ${cell(doc.triggers)} | ${cell(doc.lastVerified)} |`,
		);
	}
	if (sorted.length === 0) {
		lines.push("| _(empty)_ | | | | |");
	}
	lines.push("");
	return lines.join("\n");
}

/** Rebuild `<libDir>/MANIFEST.md` from the whole library. Returns the count. */
export function rebuildManifest(
	libDir: string,
	generatedAt?: string,
): { count: number; issues: ParseIssue[]; content: string } {
	const { docs, issues } = scanSopDir(libDir);
	const content = renderManifest(docs, generatedAt);
	return { count: docs.length, issues, content };
}

/** Count SOPs across all scopes (cheap path for notify text). */
export function countSops(libDir: string): number {
	return listSopFiles(libDir).length;
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
