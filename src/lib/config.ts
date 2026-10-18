/**
 * pi-sop config: `~/.pi/agent/pi-sop.json` + library path resolution.
 *
 * Design: docs/init-design.md §1.1, §1.2
 *
 * Path resolution order (computed on every call, never cached):
 *   1. env PI_SOP_DIR                      (explicit override: tests / multiple libraries)
 *   2. existing config libDir              (written by /sop init; stale paths are bypassed)
 *   3. ~/sop-library                       (convention default; may offer autoClone)
 *
 * The config lives in the agent dir (machine-private) and is deliberately
 * never written inside the SOP library (that repo is shared across machines).
 */

import {
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Directory name pi uses for its global config (`~/.pi`). */
export const CONFIG_DIR_NAME = ".pi";
/** Config file name inside the agent dir. */
export const CONFIG_FILE_NAME = "pi-sop.json";
/** Config schema version. */
export const CONFIG_VERSION = 1;
/**
 * Env var pointing at pi's agent dir (`~/.pi/agent`). Mirrors pi's own
 * `PI_CODING_AGENT_DIR` handling and makes the config testable without
 * touching the real home directory.
 */
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
/** Explicit library override. */
export const LIB_DIR_ENV = "PI_SOP_DIR";

export interface PiSopConfig {
	version: number;
	/** false → extension is silent: no skillPaths, sop_save refuses. */
	enabled: boolean;
	/** Path of the SOP library chosen by /sop init. */
	libDir: string | null;
	/** Machine-independent Git remote used to clone the SOP library on new machines. */
	repo: string | null;
	/** Whether sop_save may silently create a local-only library. */
	autoInit: boolean;
	/**
	 * How SOPs reach the model. See `SkillMode` — this is the knob that decouples
	 * context cost from SOP count.
	 */
	skillMode: SkillMode;
	/** ISO timestamp of the first successful init. */
	initializedAt: string | null;
	/** ISO timestamp of the last successful pull. */
	lastSyncAt: string | null;
}

export const DEFAULT_CONFIG: PiSopConfig = {
	version: CONFIG_VERSION,
	enabled: true,
	libDir: null,
	repo: null,
	autoInit: true,
	skillMode: "auto",
	initializedAt: null,
	lastSyncAt: null,
};

/**
 * How much of the library is exposed as pi skills.
 *
 * - `all`     every SOP becomes a skill (pre-0.7 behaviour). Context cost is
 *             O(number of SOPs) — it grows with the library.
 * - `index`   NO SOP becomes a skill; instead a single generated "index" skill
 *             lists the categories and tells the model to use `sop_search`.
 *             Context cost is O(1) no matter how many SOPs exist.
 * - `auto`    `index` once the library exceeds `INDEX_MODE_THRESHOLD` SOPs,
 *             `all` below it. Keeps a small library convenient while stopping
 *             the growth from ever becoming a problem.
 */
export type SkillMode = "all" | "index" | "auto";

/** SOP count above which `auto` switches to index mode. */
export const INDEX_MODE_THRESHOLD = 12;

export type LibDirSource = "env" | "config" | "default";

export interface ResolvedLibDir {
	dir: string;
	source: LibDirSource;
	/** A configured machine-specific path that does not exist on this machine. */
	stale?: string;
	/** Candidate to clone when the default path is missing and a repo is configured. */
	autoClone?: { repo: string; target: string };
}

/** Expand a leading `~` (and `~/`) to the home directory. */
export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

/** pi's agent dir: `$PI_CODING_AGENT_DIR` if set, else `~/.pi/agent`. */
export function agentDir(): string {
	const envDir = process.env[AGENT_DIR_ENV];
	if (envDir && envDir.trim()) return resolve(expandHome(envDir.trim()));
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Absolute path of `pi-sop.json`. */
export function configPath(): string {
	return join(agentDir(), CONFIG_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/** Unknown or missing `skillMode` degrades to the default, never throws. */
function readSkillMode(value: unknown): SkillMode {
	return value === "all" || value === "index" || value === "auto" ? value : DEFAULT_CONFIG.skillMode;
}

/**
 * Read the config. Never throws: a missing or corrupt file degrades to the
 * defaults so a broken config can never block a session start.
 */
export function readConfig(): PiSopConfig {
	const path = configPath();
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { ...DEFAULT_CONFIG };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ...DEFAULT_CONFIG };
	}
	if (!isRecord(parsed)) return { ...DEFAULT_CONFIG };
	return {
		version: typeof parsed.version === "number" ? parsed.version : CONFIG_VERSION,
		enabled: readBool(parsed.enabled, DEFAULT_CONFIG.enabled),
		libDir: readString(parsed.libDir) ? resolve(expandHome(readString(parsed.libDir) as string)) : null,
		repo: readString(parsed.repo),
		autoInit: readBool(parsed.autoInit, DEFAULT_CONFIG.autoInit),
		skillMode: readSkillMode(parsed.skillMode),
		initializedAt: readString(parsed.initializedAt),
		lastSyncAt: readString(parsed.lastSyncAt),
	};
}

/**
 * Merge `patch` into the on-disk config and write it atomically.
 * Returns the merged config.
 */
export function writeConfig(patch: Partial<PiSopConfig>): PiSopConfig {
	const next: PiSopConfig = { ...readConfig(), ...patch, version: CONFIG_VERSION };
	const path = configPath();
	mkdirSync(agentDir(), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	try {
		renameSync(tmp, path);
	} catch (error) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* ignore */
		}
		throw error;
	}
	return next;
}

/** Convenience helper for `/sop init` success paths. */
export function markInitialized(libDir: string, patch: Partial<PiSopConfig> = {}): PiSopConfig {
	return writeConfig({
		enabled: true,
		libDir,
		initializedAt: new Date().toISOString(),
		...patch,
	});
}

/** Conventional default library location. */
export function defaultLibDir(): string {
	return join(homedir(), "sop-library");
}

function normalizeDir(path: string): string {
	const expanded = expandHome(path.trim());
	return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve the library directory. `explicit` (e.g. `/sop init --link <path>`)
 * short-circuits the three-level lookup.
 */
export function resolveLibDir(explicit?: string | null): ResolvedLibDir {
	if (explicit && explicit.trim()) {
		return { dir: normalizeDir(explicit), source: "config" };
	}
	const fromEnv = process.env[LIB_DIR_ENV];
	if (fromEnv && fromEnv.trim()) {
		return { dir: normalizeDir(fromEnv), source: "env" };
	}
	const config = readConfig();
	let stale: string | undefined;
	if (config.libDir) {
		if (isDirectory(config.libDir)) return { dir: config.libDir, source: "config" };
		stale = config.libDir;
	}

	const target = defaultLibDir();
	if (isDirectory(target)) {
		return { dir: target, source: "default", ...(stale ? { stale } : {}) };
	}
	return {
		dir: target,
		source: "default",
		...(stale ? { stale } : {}),
		...(!pathExists(target) && config.repo ? { autoClone: { repo: config.repo, target } } : {}),
	};
}

/** True when `dir` exists and is a directory. */
export function dirExists(dir: string): boolean {
	return isDirectory(dir);
}
