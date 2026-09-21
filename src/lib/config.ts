/**
 * pi-sop config: `~/.pi/agent/pi-sop.json` + library path resolution.
 *
 * Design: docs/init-design.md §1.1, §1.2
 *
 * Path resolution order (computed on every call, never cached):
 *   1. env PI_SOP_DIR                      (explicit override: tests / multiple libraries)
 *   2. config libDir                       (written by /sop init)
 *   3. ~/sop-library                       (convention default)
 *
 * The config lives in the agent dir (machine-private) and is deliberately
 * never written inside the SOP library (that repo is shared across machines).
 */

import {
	existsSync,
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
	/** Whether sop_save may silently create a local-only library. */
	autoInit: boolean;
	/** ISO timestamp of the first successful init. */
	initializedAt: string | null;
	/** ISO timestamp of the last successful pull. */
	lastSyncAt: string | null;
}

export const DEFAULT_CONFIG: PiSopConfig = {
	version: CONFIG_VERSION,
	enabled: true,
	libDir: null,
	autoInit: true,
	initializedAt: null,
	lastSyncAt: null,
};

export type LibDirSource = "env" | "config" | "default";

export interface ResolvedLibDir {
	dir: string;
	source: LibDirSource;
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

/** True when the config file exists on disk. */
export function configExists(): boolean {
	return existsSync(configPath());
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
		autoInit: readBool(parsed.autoInit, DEFAULT_CONFIG.autoInit),
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
	const configured = readConfig().libDir;
	if (configured) {
		return { dir: configured, source: "config" };
	}
	return { dir: defaultLibDir(), source: "default" };
}

/**
 * Throw a friendly error unless `path` is an absolute, existing directory
 * (used by the wizard before scaffolding).
 */
export function assertUsableParentDir(path: string): void {
	if (!isAbsolute(path)) {
		throw new Error(`库路径必须是绝对路径：${path}`);
	}
}

/** True when `dir` exists and is a directory. */
export function dirExists(dir: string): boolean {
	return isDirectory(dir);
}
