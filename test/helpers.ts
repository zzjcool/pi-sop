/**
 * Shared test helpers: throwaway HOME / agent dir per test file.
 *
 * Every test that touches config redirects `PI_CODING_AGENT_DIR` into a temp
 * dir, so the real `~/.pi/agent/pi-sop.json` is never read or written.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Sandbox {
	root: string;
	agentDir: string;
	home: string;
	cleanup(): void;
}

/** Create an isolated HOME + agent dir and point the env vars at them. */
export function createSandbox(prefix = "pi-sop-test-"): Sandbox {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	const previous = {
		home: process.env.HOME,
		agentDir: process.env.PI_CODING_AGENT_DIR,
		libDir: process.env.PI_SOP_DIR,
	};
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_SOP_DIR;
	return {
		root,
		home,
		agentDir,
		cleanup() {
			if (previous.home === undefined) delete process.env.HOME;
			else process.env.HOME = previous.home;
			if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
			if (previous.libDir === undefined) delete process.env.PI_SOP_DIR;
			else process.env.PI_SOP_DIR = previous.libDir;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** Run `fn` and return its value, cleaning the sandbox up afterwards. */
export async function withSandbox<T>(fn: (sandbox: Sandbox) => Promise<T> | T): Promise<T> {
	const sandbox = createSandbox();
	try {
		return await fn(sandbox);
	} finally {
		sandbox.cleanup();
	}
}
