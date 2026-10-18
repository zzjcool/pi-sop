/**
 * "Index mode": the whole SOP library collapses into ONE skill entry.
 *
 * Why this exists
 * ---------------
 * pi has no grouping, pagination or truncation for skills: every visible skill
 * costs its `<name> + <description> + <location>` in the system prompt on every
 * request. Registering the library directory as a skill path therefore gives
 * context cost O(number of SOPs) — a library that keeps growing eventually
 * crowds out the actual work.
 *
 * Index mode makes the cost O(1): no SOP appears individually, and a single
 * synthetic entry says "there are N SOPs; call sop_search". The entry's
 * `location` is `MANIFEST.md`, which pi-sop already maintains as a pure function
 * of the SOP set — so the index needs no extra file, no extra write, and cannot
 * drift out of date.
 *
 * Why a synthetic entry rather than a generated SKILL.md
 * -----------------------------------------------------
 * pi's `before_agent_start` exposes a mutable `systemPromptOptions.skills`
 * array that is rendered into the prompt after handlers run, so the entry can be
 * injected in memory. Writing a generated SKILL.md into the library would put a
 * derived file under version control, where it would conflict on every
 * multi-machine save — the exact failure the deterministic MANIFEST was written
 * to avoid.
 */

import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";

import type { SopDoc } from "./sop.ts";
import { GLOBAL_SCOPE, isModelHidden } from "./sop.ts";

/**
 * The single entry that replaces per-SOP skills in index mode.
 *
 * Structurally identical to pi's exported `Skill`; the fields are spelled out so
 * a change in pi's shape becomes a type error here instead of a silent
 * omission in the prompt.
 */
export interface SyntheticSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: ReturnType<typeof createSyntheticSourceInfo>;
	disableModelInvocation: boolean;
}

/** Name of the single entry that replaces the per-SOP skills in index mode. */
export const INDEX_SKILL_NAME = "sop-library";

/**
 * Top-level categories derived from the SOP names/triggers.
 *
 * Deliberately mechanical: a hand-maintained category list would rot the moment
 * someone adds a SOP, and the model can always call `sop_search` for detail. The
 * point of this summary is to tell the model *what kinds of things exist* so it
 * knows to search at all.
 */
const CATEGORY_RULES: { label: string; match: RegExp }[] = [
	{ label: "pi 扩展/插件开发", match: /^pi-(plugin|extension|tui|async)|pi-tui/ },
	{ label: "pi 自身运维", match: /^pi-(sop|config|subagents|legion)/ },
	{ label: "网络/隧道/代理", match: /tunnel|proxy|dns|router|sing-box|sb-tun|cloudflare|netbird|warp/ },
	{ label: "主机与进程运维", match: /host|leak|process|worktree|disk|systemd/ },
	{ label: "第三方工具逆向/提取", match: /codebuddy|cursor|api-extraction|protocol/ },
	{ label: "工程方法论", match: /parallel|interface|durable|compaction|discipline|pitfalls/ },
	{ label: "项目上下文", match: /project-context|qa-hunting/ },
];

/** Bucket a SOP into the first matching category (or "其它"). */
function categorize(doc: SopDoc): string {
	const haystack = `${doc.name} ${doc.triggers}`.toLowerCase();
	for (const rule of CATEGORY_RULES) {
		if (rule.match.test(haystack)) return rule.label;
	}
	return "其它";
}

/**
 * Build the single skill entry that stands in for the whole library.
 *
 * The description states the count, the scopes present, and the instruction to
 * call `sop_search`. That instruction is load-bearing: a controlled experiment
 * on the deployed extension showed the model will invent its own plan instead of
 * searching when nothing in the prompt tells it a library exists.
 */
export function buildIndexSkill(docs: SopDoc[], libDir: string): SyntheticSkill {
	const readable = docs.filter((doc) => !isModelHidden(doc));
	const hidden = docs.length - readable.length;

	const byCategory = new Map<string, number>();
	for (const doc of readable) {
		const label = categorize(doc);
		byCategory.set(label, (byCategory.get(label) ?? 0) + 1);
	}
	const categories = [...byCategory.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([label, count]) => `${label}(${count})`)
		.join("、");

	const projectScopes = new Set(
		readable.filter((doc) => doc.scope !== GLOBAL_SCOPE).map((doc) => doc.scope),
	);
	const parts = [
		`USE FOR 任何可能已被记录成标准流程的任务 —— 共享 SOP 库共 ${docs.length} 条`,
		`（全局 ${readable.filter((d) => d.scope === GLOBAL_SCOPE).length} 条`,
		projectScopes.size > 0 ? `，另覆盖 ${projectScopes.size} 个项目` : "",
		hidden > 0 ? `，${hidden} 条默认隐藏` : "",
		"）",
		`。分类：${categories}`,
		`。任务像是一个部署/排障/项目约定/踩过的坑时，先调用 sop_search（中文或英文关键词均可）检索，再用 read 打开命中的 filePath 获取完整步骤；不要凭印象重写已有流程。`,
		`索引：${libDir}/MANIFEST.md`,
	];

	return {
		name: INDEX_SKILL_NAME,
		description: parts.join(""),
		// Pointing at MANIFEST gives the model a readable fallback when it wants
		// the full table instead of a keyword search.
		filePath: `${libDir}/MANIFEST.md`,
		baseDir: libDir,
		// Built through pi's own helper so the entry carries the same provenance
		// shape as a loaded skill (`scope: "temporary"` = injected by an extension).
		sourceInfo: createSyntheticSourceInfo(`${libDir}/MANIFEST.md`, {
			source: "pi-sop",
			scope: "temporary",
			baseDir: libDir,
		}),
		disableModelInvocation: false,
	};
}
