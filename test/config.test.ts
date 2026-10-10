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
		writeConfig({ libDir: "/tmp/one", repo: "git@example.com:you/sop-library.git" });
		const second = writeConfig({ enabled: false });
		assert.equal(second.version, CONFIG_VERSION);
		assert.equal(second.enabled, false);
		// Existing fields survive the second write.
		assert.equal(second.libDir, "/tmp/one");
		assert.equal(second.repo, "git@example.com:you/sop-library.git");
		const stored = readConfig();
		assert.equal(stored.enabled, false);
		assert.equal(stored.libDir, "/tmp/one");
		assert.equal(stored.repo, "git@example.com:you/sop-library.git");
	});
});

test("readConfig defaults repo to null for an older v1 config", async () => {
	await withSandbox(() => {
		mkdirSync(agentDir(), { recursive: true });
		writeFileSync(configPath(), JSON.stringify({ version: 1, enabled: true, libDir: "/old/lib" }), "utf8");
		assert.equal(readConfig().repo, null);
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

test("resolveLibDir: an existing config directory wins over default", async () => {
	await withSandbox((sandbox) => {
		const configured = join(sandbox.root, "configured-lib");
		mkdirSync(configured);
		writeConfig({ libDir: configured });
		const resolved = resolveLibDir();
		assert.equal(resolved.dir, configured);
		assert.equal(resolved.source, "config");
		assert.equal(resolved.stale, undefined);
	});
});

test("resolveLibDir: a dead libDir falls through to the missing default and offers autoClone", async () => {
	await withSandbox((sandbox) => {
		const stale = join(sandbox.root, "from-another-machine");
		const repo = "git@example.com:you/sop-library.git";
		writeConfig({ libDir: stale, repo });
		const resolved = resolveLibDir();
		const target = join(sandbox.home, "sop-library");
		assert.equal(resolved.dir, target);
		assert.equal(resolved.source, "default");
		assert.equal(resolved.stale, stale);
		assert.deepEqual(resolved.autoClone, { repo, target });
	});
});

test("resolveLibDir: an existing default beats a dead configured path", async () => {
	await withSandbox((sandbox) => {
		const stale = join(sandbox.root, "from-another-machine");
		const target = join(sandbox.home, "sop-library");
		mkdirSync(target, { recursive: true });
		writeConfig({ libDir: stale, repo: "git@example.com:you/sop-library.git" });
		const resolved = resolveLibDir();
		assert.equal(resolved.dir, target);
		assert.equal(resolved.source, "default");
		assert.equal(resolved.stale, stale);
		assert.equal(resolved.autoClone, undefined);
	});
});

test("resolveLibDir: a missing default offers autoClone when repo is configured", async () => {
	await withSandbox((sandbox) => {
		const repo = "git@example.com:you/sop-library.git";
		writeConfig({ repo });
		assert.deepEqual(resolveLibDir().autoClone, {
			repo,
			target: join(sandbox.home, "sop-library"),
		});
	});
});

test("resolveLibDir: an existing non-directory default target is never offered for autoClone", async () => {
	await withSandbox((sandbox) => {
		mkdirSync(sandbox.home, { recursive: true });
		const target = join(sandbox.home, "sop-library");
		writeFileSync(target, "keep this file", "utf8");
		writeConfig({ repo: "git@example.com:you/sop-library.git" });
		const resolved = resolveLibDir();
		assert.equal(resolved.dir, target);
		assert.equal(resolved.autoClone, undefined);
	});
});

test("resolveLibDir: env override is always used and never offers autoClone", async () => {
	await withSandbox(() => {
		writeConfig({ repo: "git@example.com:you/sop-library.git" });
		process.env.PI_SOP_DIR = "/missing/explicit-library";
		const resolved = resolveLibDir();
		assert.equal(resolved.dir, "/missing/explicit-library");
		assert.equal(resolved.source, "env");
		assert.equal(resolved.autoClone, undefined);
		assert.equal(resolved.stale, undefined);
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
