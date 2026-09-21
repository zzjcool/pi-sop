/**
 * pi-sop scaffold: create (or repair) the SOP library skeleton.
 *
 * Design: docs/init-design.md §6
 *
 *   <libDir>/
 *   ├── MANIFEST.md          index table, maintained by sop_save / rebuildable
 *   ├── sop/writing-sops.md  seed SOP: how to write an SOP
 *   └── .gitignore           .DS_Store / *.swp / transient lock files
 *
 * Scaffolding is additive: existing files are never overwritten, so it doubles
 * as the "repair missing skeleton files" path used by the init wizard.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { rebuildManifest, renderSop } from "./sop.ts";
import { commitAll, git, initRepo } from "./sync.ts";

export const MANIFEST_FILE = "MANIFEST.md";
export const SOP_DIR = "sop";
export const SEED_SOP_SLUG = "writing-sops";

export const GITIGNORE_CONTENT = [
	"# OS / editor noise",
	".DS_Store",
	"*.swp",
	"*~",
	"",
	"# pi-sop transient state (lock lives in .git/, this is belt-and-braces)",
	".pi-sop-lock",
	"",
].join("\n");

/** Today as `YYYY-MM-DD`, used for `last_verified` on new SOPs. */
export function today(now: Date = new Date()): string {
	const year = now.getFullYear();
	const month = `${now.getMonth() + 1}`.padStart(2, "0");
	const day = `${now.getDate()}`.padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/** The seed SOP body: format reference + agent-facing instructions. */
export function seedSopBody(): string {
	return [
		"# Writing SOPs",
		"",
		"本库（pi-sop）里的每个文件都是一条可复用的标准作业流程（SOP），",
		"同时会被 pi 当作 skill 自动加载 —— 所以格式必须严格。",
		"",
		"## File layout",
		"",
		"- 一条 SOP = 一个文件：`sop/<name>.md`（平铺，不要子目录）",
		"- `<name>` 用小写字母、数字、连字符（`^[a-z0-9]+(-[a-z0-9]+)*$`，≤64 字符）",
		"- 写完必须更新 `MANIFEST.md`（`sop_save` 工具会自动做；手工编辑时用",
		"  `/sop init` → 状态面板 → 重建 MANIFEST）",
		"",
		"## Frontmatter (required)",
		"",
		"```yaml",
		"---",
		"name: deploy-mysql-replica",
		"description: USE FOR deploying MySQL replicas, setting up replication, GTID config",
		"triggers: mysql replica, 主从, GTID",
		"last_verified: " + today(),
		"---",
		"```",
		"",
		"| 字段 | 说明 |",
		"|---|---|",
		"| `name` | 与文件名一致，小写连字符 |",
		"| `description` | **必需**，决定 pi 何时加载这条 skill。写清「什么时候用」，不要只写「是什么」 |",
		"| `triggers` | 逗号分隔的检索关键词，中英文都写，方便 `/sop <关键词>` 命中 |",
		"| `last_verified` | 最后一次被真实验证的日期（`YYYY-MM-DD`）。内容过期就更新它，别删 |",
		"",
		"## Body",
		"",
		"- 直接写可执行步骤（编号列表），不要写「我做了 X」这种叙事",
		"- 命令要能复制粘贴，含必要的前置条件与验证方式",
		"- 失败分支也写：出错长什么样、怎么回滚",
		"- 只写被验证过的事实；不确定的标注「未验证」",
		"",
		"## Rules",
		"",
		"- 新增 SOP 自由；修改别人的 SOP 会产生一个待 review 的 commit，不要 force-push",
		"- 所有 git 操作 best-effort：离线时只本地提交，下次会话自动补推",
		"",
	].join("\n");
}

export interface ScaffoldResult {
	dir: string;
	created: string[];
	/** Files that already existed and were left untouched. */
	kept: string[];
	/** True when `git init -b main` actually ran. */
	initializedRepo: boolean;
	committed: boolean;
	commitDetail?: string;
}

export interface ScaffoldOptions {
	/** Run `git init -b main` when the dir is not a repo yet. Default true. */
	init?: boolean;
	/** `git add -A && git commit`. Default true. */
	commit?: boolean;
	/** Rebuild MANIFEST from existing `sop/*.md` instead of writing a fresh one. */
	rebuild?: boolean;
	now?: Date;
}

function writeIfMissing(path: string, content: string, created: string[], kept: string[]): void {
	if (existsSync(path)) {
		kept.push(path);
		return;
	}
	writeFileSync(path, content, "utf8");
	created.push(path);
}

/**
 * Create the library skeleton in `dir`.
 *
 * Never destructive: each file is only written when absent, and an existing git
 * repo is left alone (`git init` on an existing repo is a harmless re-init, but
 * we skip it to avoid touching config). `rebuild: true` is the only mode that
 * rewrites MANIFEST.md, and it is opt-in so "repair the skeleton" never
 * clobbers a hand-edited index.
 */
export async function scaffoldLibrary(dir: string, options: ScaffoldOptions = {}): Promise<ScaffoldResult> {
	const { init = true, commit = true, rebuild = false, now = new Date() } = options;
	const created: string[] = [];
	const kept: string[] = [];

	mkdirSync(join(dir, SOP_DIR), { recursive: true });

	let initializedRepo = false;
	if (init && !existsSync(join(dir, ".git"))) {
		const result = await initRepo(dir);
		initializedRepo = result.ok;
	}

	const manifestPath = join(dir, MANIFEST_FILE);
	writeIfMissing(join(dir, ".gitignore"), GITIGNORE_CONTENT, created, kept);
	writeIfMissing(join(dir, SOP_DIR, `${SEED_SOP_SLUG}.md`), renderSop({
		name: SEED_SOP_SLUG,
		description:
			"USE FOR creating or updating SOPs in the pi-sop library — format, frontmatter, MANIFEST conventions",
		triggers: "save sop, 记录流程, write sop",
		lastVerified: today(now),
		body: seedSopBody(),
	}), created, kept);

	if (rebuild || !existsSync(manifestPath)) {
		// The seed SOP is on disk by now, so the manifest already indexes it.
		const { content } = rebuildManifest(dir, now.toISOString());
		const previous = existsSync(manifestPath) ? readExisting(manifestPath) : "";
		if (previous === content) {
			kept.push(manifestPath);
		} else {
			writeFileSync(manifestPath, content, "utf8");
			created.push(previous ? `${manifestPath} (rebuilt)` : manifestPath);
		}
	}

	let committed = false;
	let commitDetail: string | undefined;
	if (commit) {
		// Scope the commit to the files we actually created: a repair run must not
		// sweep up whatever else the user has sitting in their working tree.
		const relative = created
			.map((path) => path.replace(` (rebuilt)`, ""))
			.map((path) => (path.startsWith(dir) ? path.slice(dir.length + 1) : path));
		if (relative.length === 0) {
			committed = false;
		} else {
			const result = await commitAll(dir, "init: scaffold SOP library", relative);
			committed = result.committed;
			commitDetail = result.detail ?? result.reason;
		}
	}

	return { dir, created, kept, initializedRepo, committed, commitDetail };
}

function readExisting(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/** True when the library already has the minimum skeleton. */
export function hasSkeleton(dir: string): { manifest: boolean; sopDir: boolean; seed: boolean } {
	return {
		manifest: existsSync(join(dir, MANIFEST_FILE)),
		sopDir: existsSync(join(dir, SOP_DIR)),
		seed: existsSync(join(dir, SOP_DIR, `${SEED_SOP_SLUG}.md`)),
	};
}

/**
 * Rebuild MANIFEST.md and commit the change. Used by the status panel action
 * and after every `sop_save`.
 */
export async function refreshManifest(
	dir: string,
	commitMessage = "chore: rebuild MANIFEST",
	now: Date = new Date(),
): Promise<{ count: number; changed: boolean; committed: boolean }> {
	const { content, count } = rebuildManifest(dir, now.toISOString());
	const path = join(dir, MANIFEST_FILE);
	const previous = readExisting(path);
	const changed = previous !== content;
	if (changed) writeFileSync(path, content, "utf8");
	const commitResult = changed
		? await commitAll(dir, commitMessage, [MANIFEST_FILE])
		: { committed: false };
	return { count, changed, committed: commitResult.committed };
}

/** Ensure the library is a git repo before writing (used by autoInit). */
export async function ensureRepo(dir: string): Promise<boolean> {
	if (existsSync(join(dir, ".git"))) return true;
	const result = await initRepo(dir);
	return result.ok;
}

/** `git status --porcelain` gate used by the status panel. */
export async function hasLocalChanges(dir: string): Promise<boolean> {
	const result = await git(dir, ["status", "--porcelain"], 5000);
	return result.ok && result.stdout.trim() !== "";
}
