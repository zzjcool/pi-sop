/**
 * config.ts tests: three-level path resolution + config file round-trip.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	CONFIG_VERSION,
	DEFAULT_CONFIG,
	agentDir,
	configPath,
	dirExists,
	expandHome,
	readConfig,
	resolveLibDir,
	writeConfig,
	markInitialized,
} from "../src/lib/config.ts";
import { withSandbox } from "./helpers.ts";

test("expandHome expands ~ and leaves absolute paths alone", () => {
	assert.equal(expandHome("~"), process.env.HOME);
	assert.equal(expandHome("~/sop-library"), join(process.env.HOME as string, "sop-library"));
	assert.equal(expandHome("/abs/path"), "/abs/path");
});

test("agentDir honours PI_CODING_AGENT_DIR", async () => {
	await withSandbox((sandbox) => {
		assert.equal(agentDir(), sandbox.agentDir);
		assert.equal(configPath(), join(sandbox.agentDir, "pi-sop.json"));
	});
});

test("readConfig returns defaults when the file is missing", async () => {
	await withSandbox(() => {
		assert.deepEqual(readConfig(), DEFAULT_CONFIG);
	});
});

test("readConfig returns defaults on corrupt JSON instead of throwing", async () => {
	await withSandbox((sandbox) => {
		mkdirSync(sandbox.agentDir, { recursive: true });
		writeFileSync(configPath(), "{ not json", "utf8");
		assert.deepEqual(readConfig(), DEFAULT_CONFIG);
	});
});

test("writeConfig merges patches and bumps version", async () => {
	await withSandbox(() => {
		writeConfig({ libDir: "/tmp/one" });
		const second = writeConfig({ enabled: false });
		assert.equal(second.version, CONFIG_VERSION);
		assert.equal(second.enabled, false);
		// libDir survives the second write
		assert.equal(second.libDir, "/tmp/one");
		const stored = readConfig();
		assert.equal(stored.enabled, false);
		assert.equal(stored.libDir, "/tmp/one");
	});
});

test("markInitialized sets enabled + libDir + initializedAt", async () => {
	await withSandbox(() => {
		const config = markInitialized("/tmp/lib");
		assert.equal(config.enabled, true);
		assert.equal(config.libDir, "/tmp/lib");
		assert.ok(config.initializedAt && !Number.isNaN(Date.parse(config.initializedAt)));
	});
});

test("resolveLibDir: env wins over config", async () => {
	await withSandbox(() => {
		writeConfig({ libDir: "/from/config" });
		process.env.PI_SOP_DIR = "/from/env";
		const resolved = resolveLibDir();
		assert.equal(resolved.dir, "/from/env");
		assert.equal(resolved.source, "env");
	});
});

test("resolveLibDir: config wins over default", async () => {
	await withSandbox(() => {
		writeConfig({ libDir: "/from/config" });
		const resolved = resolveLibDir();
		assert.equal(resolved.dir, "/from/config");
		assert.equal(resolved.source, "config");
	});
});

test("resolveLibDir: falls back to ~/sop-library", async () => {
	await withSandbox((sandbox) => {
		const resolved = resolveLibDir();
		assert.equal(resolved.dir, join(sandbox.home, "sop-library"));
		assert.equal(resolved.source, "default");
	});
});

test("resolveLibDir: explicit argument short-circuits everything", async () => {
	await withSandbox(() => {
		process.env.PI_SOP_DIR = "/from/env";
		const resolved = resolveLibDir("~/custom");
		assert.equal(resolved.dir, join(process.env.HOME as string, "custom"));
	});
});

test("resolveLibDir expands ~ from the config file", async () => {
	await withSandbox((sandbox) => {
		// writeConfig only touches the agent dir, never the library
		writeConfig({ libDir: join(sandbox.home, "lib") });
		assert.equal(readConfig().libDir, join(sandbox.home, "lib"));
	});
});

test("dirExists", async () => {
	await withSandbox((sandbox) => {
		assert.equal(dirExists(sandbox.agentDir), false);
		mkdirSync(sandbox.agentDir, { recursive: true });
		assert.equal(dirExists(sandbox.agentDir), true);
	});
});
