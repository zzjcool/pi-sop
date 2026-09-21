import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * pi-sop — SOP library for pi coding agents.
 *
 * git-synced, machine-shared, agent-discoverable.
 *
 * Design:
 *   - session_start:  best-effort `git pull --rebase` on the SOP library
 *   - resources_discover: register `<lib>/sop/` as skill paths so agents
 *     load SOPs by task relevance (SKILL.md convention, one SOP per file)
 *   - sop_save tool: write SOP + update MANIFEST + commit & push
 *   - /sop command: grep the library for humans
 *
 * TODO: implement. See README.md for the full design.
 */

export default function (pi: ExtensionAPI) {
  const sopLibDir = process.env.PI_SOP_DIR ?? `${process.env.HOME}/sop-library`;

  // TODO: session_start → git pull --rebase (best-effort, offline-safe)
  // pi.on("session_start", async (_event, ctx) => { ... });

  // TODO: resources_discover → skillPaths: [join(sopLibDir, "sop")]
  // pi.on("resources_discover", async () => ({ skillPaths: [...] }));

  // TODO: sop_save tool (name, content, triggers) → write + MANIFEST + git
  // pi.registerTool({ name: "sop_save", ... });

  // TODO: /sop command → grep SOP library
  // pi.registerCommand("sop", { ... });

  void pi;
  void sopLibDir;
}
