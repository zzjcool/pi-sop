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

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import { PROJECTS_DIR } from "./project.ts";

export interface SopFrontmatter {
	name: string;
	description: string;
	triggers: string;
	lastVerified: string;
}

/**
 * Frontmatter keys pi-sop owns. Anything else in the frontmatter is preserved
 * verbatim in `SopDoc.extra` so a `sop_save` round-trip never destroys a key it
 * does not understand — pi's own `disable-model-invocation`, a future pi field,
 * or a human's note. Dropping them silently would be the same class of bug as
 * the YAML quoting loss: the file looks saved, the behaviour is gone.
 */
const OWNED_KEYS = new Set(["name", "description", "triggers", "last_verified"]);

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
	/**
	 * Frontmatter keys pi-sop does not own, kept so a rewrite cannot destroy them.
	 * Values are already unquoted by pi's parser. `disable-model-invocation` from
	 * pi lives here: dropping it would silently re-expose a hidden SOP.
	 */
	extra: Record<string, string>;
}

/** True when the SOP is hidden from pi's skill list (pi's own field). */
export function isModelHidden(doc: SopDoc): boolean {
	return doc.extra["disable-model-invocation"] === "true";
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
 * Frontmatter scalars, read with PI'S OWN parser.
 *
 * v0.4.0 and earlier used a hand-rolled line splitter here. That let pi-sop
 * read files pi itself rejects: an unquoted `description: ... foo: bar ...` is
 * invalid YAML ("Nested mappings are not allowed in compact mappings"), so pi
 * dropped the skill **silently** (root-level `.md` skills get no diagnostic)
 * while MANIFEST/status/search still listed it as healthy.
 *
 * Using pi's exported `parseFrontmatter` closes that gap by construction: the
 * reader and the loader are the same code. `yaml` is not an available module on
 * the installed package path, so this is also the only dependency-free way to
 * get a真 YAML grammar.
 *
 * Leniency applies only when the file is ALREADY unloadable: a broken file must
 * still be readable so it can be repaired (`sop_save` / re-render), and
 * `frontmatterIssue` is the function that decides loadability — never this one.
 */
function parseScalars(yaml: string): Map<string, string> {
	try {
		const { frontmatter } = parseFrontmatter(`---\n${yaml}\n---\n`);
		const values = new Map<string, string>();
		for (const [rawKey, rawValue] of Object.entries(frontmatter ?? {})) {
			if (rawValue === null || rawValue === undefined) continue;
			const value = Array.isArray(rawValue)
				? rawValue.map((entry) => String(entry).trim()).filter(Boolean).join(", ")
				: String(rawValue);
			values.set(rawKey.trim().toLowerCase(), value);
		}
		return values;
	} catch {
		return parseScalarsLenient(yaml);
	}
}

/**
 * Last-resort reader for frontmatter that is not valid YAML.
 *
 * Only used to recover the values of a file pi would skip, so the library can
 * be repaired. Never treat a value obtained here as proof of loadability.
 */
function parseScalarsLenient(yaml: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const rawLine of yaml.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim().toLowerCase();
		let value = line.slice(colon + 1).trim();
		if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
		if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
			value = value.slice(1, -1);
		}
		if (!values.has(key)) values.set(key, value.trim());
	}
	return values;
}

/**
 * Serialize one frontmatter value so pi's parser reads it back verbatim.
 *
 * Strategy is verify-then-quote rather than a rule table: emit the raw value,
 * ask pi's parser what it thinks, and fall back to a JSON string literal (valid
 * YAML double-quoted scalar) when the result is not an exact match. A rule
 * table cannot be trusted here — YAML's plain-scalar restrictions are
 * positional (`: ` breaks mid-value, `#` only after a space, `[` only at the
 * start, ...), and getting one case wrong means a silently unloadable SOP.
 *
 * Booleans are the exception and are handled BEFORE the round-trip test. pi's
 * `disable-model-invocation` is compared with `=== true` (pi's
 * `core/skills.js`), so a quoted `"true"` parses back as the string "true" and
 * the skill silently stops being hidden. Emitting the bare token is the only
 * form pi accepts, so those two literals bypass quoting.
 */
function encodeScalar(value: string): string {
	// Bare boolean tokens: pi requires the YAML boolean, not a string.
	if (value === "true" || value === "false") {
		return value;
	}
	const trial = `---\nkey: ${value}\n---\n`;
	try {
		const { frontmatter } = parseFrontmatter(trial);
		// `=== value` compares against the raw text, so a plain numeric/boolean
		// token that pi coerces (e.g. `123` -> 123) falls through to quoting —
		// which is what we want for a *string* value.
		if (frontmatter.key === value) return value;
	} catch {
		// fall through to the quoted form
	}
	// JSON strings are valid YAML double-quoted scalars (\\, \", \n, \t all
	// mean the same thing), so this is always parseable and always exact.
	return JSON.stringify(value);
}

/**
 * Why pi cannot load this document as a skill, or `null` when it can.
 *
 * Mirrors pi's loader contract for root `.md` skills: the frontmatter must
 * parse as YAML and carry a non-empty `description`. Anything else means the
 * SOP exists on disk but is invisible to the agent.
 */
export function frontmatterIssue(content: string): string | null {
	const { yaml } = splitFrontmatter(content);
	if (yaml === null) return "缺少 frontmatter（不会被 pi 识别为 skill）";
	let frontmatter: Record<string, unknown>;
	try {
		({ frontmatter } = parseFrontmatter(content));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `frontmatter 不是合法 YAML，pi 会静默跳过这条 skill：${message.split("\n")[0]}`;
	}
	if (!frontmatter || Object.keys(frontmatter).length === 0) {
		return "frontmatter 为空（不会被 pi 识别为 skill）";
	}
	const description = frontmatter.description;
	if (typeof description !== "string" || description.trim() === "") {
		return "缺少 description（不会被 pi 识别为 skill）";
	}
	return null;
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

/**
 * Serialize an SOP document (frontmatter + body).
 *
 * Every value passes through `encodeScalar`, which is verified against pi's own
 * parser instead of guessed. A description is free prose written by an agent, so
 * it routinely contains `GitHub: org/repo`, `pi: make run`, or a `#` — all of
 * which break the unquoted `key: value` form and made pi drop the skill
 * silently. Those values now come out double-quoted.
 *
 * Key order is fixed: name, description, triggers, last_verified.
 */
export function renderSop(doc: {
	name: string;
	description: string;
	triggers: string;
	lastVerified: string;
	body: string;
	/** Unknown frontmatter keys to re-emit after the owned ones. */
	extra?: Record<string, string>;
}): string {
	const body = doc.body.trim();
	const lines = [
		`name: ${encodeScalar(doc.name)}`,
		`description: ${encodeScalar(doc.description)}`,
		`triggers: ${encodeScalar(doc.triggers)}`,
		`last_verified: ${encodeScalar(doc.lastVerified)}`,
	];
	// Unknown keys last, so the owned four keep a stable position (diffs and
	// human readers both benefit). A key pi-sop happens to own is skipped
	// rather than duplicated — `extra` is by definition the non-owned set.
	for (const [key, value] of Object.entries(doc.extra ?? {})) {
		if (OWNED_KEYS.has(key)) continue;
		lines.push(`${key}: ${encodeScalar(value)}`);
	}
	return ["---", lines.join("\n"), "---", "", body, ""].join("\n");
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
	// Report whatever makes pi skip this file — invalid YAML first, because that
	// is the failure mode that used to be invisible here.
	const problem = frontmatterIssue(content);
	if (problem) {
		return { issue: { filePath, message: problem } };
	}
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
			extra: parseExtraKeys(content),
		},
	};
}

/**
 * Frontmatter keys that pi-sop does not own, as unquoted strings.
 *
 * Read through a second pass of the raw frontmatter rather than pi's object,
 * because pi's parser yields booleans/numbers for unquoted scalars and the
 * rewrite path needs the value in a form `encodeScalar` can re-emit faithfully.
 */
function parseExtraKeys(content: string): Record<string, string> {
	const { yaml } = splitFrontmatter(content);
	const extra: Record<string, string> = {};
	if (!yaml) return extra;
	for (const [key, value] of parseScalars(yaml)) {
		if (OWNED_KEYS.has(key)) continue;
		extra[key] = value;
	}
	return extra;
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

/**
 * Render MANIFEST.md from the scanned SOPs (deterministic ordering — and
 * deterministic BYTES: no timestamp, no machine-local input).
 *
 * The manifest must be a pure function of the SOP file set: identical files
 * on two machines must render identical bytes, otherwise every cross-machine
 * save round-trips a timestamp conflict (review finding: "timestamp ping-pong"
 * — v0.2's `最后生成` line made MANIFEST collide on every multi-machine
 * pull). `generatedAt` is kept as a parameter for callers that still want a
 * dated footer, but `sop_save` and the sync resolver pass nothing.
 */
export function renderManifest(docs: SopDoc[], generatedAt?: string): string {
	const sorted = [...docs].sort((a, b) => a.name.localeCompare(b.name));
	const lines = [
		"# SOP MANIFEST",
		"",
		"> 本文件由 pi-sop 自动维护（`sop_save` 写入，`/sop init` → 状态面板 → 重建 MANIFEST 可强制刷新）。",
		"> `scope` 列：`global` 或项目键（`git.woa.com/org/repo`），项目键对应 `projects/<键>/` 目录。",
	];
	if (generatedAt) lines.push(`> 最后生成: ${generatedAt}`);
	lines.push(
		"",
		"| name | scope | description | triggers | last_verified |",
		"|---|---|---|---|---|",
	);
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
