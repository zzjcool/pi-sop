/**
 * Remote helpers for the init wizard.
 *
 * Design: docs/init-design.md §3.2 branch 1
 *
 * Before cloning we probe with `git ls-remote` (bounded to 5s) so the user gets
 * an actionable reason ("SSH key missing" / "repo does not exist") instead of a
 * raw git dump. The probe is best-effort: an inconclusive failure (e.g. no
 * network) still lets the wizard be re-run, and the clone itself is the
 * authority.
 */

import { firstLine, lsRemote, type GitResult } from "./sync.ts";

/** How many times the wizard will re-prompt for an unreachable remote. */
export const MAX_REMOTE_RETRIES = 3;

export interface RemoteCheck {
	ok: boolean;
	result: GitResult;
}

/** `git ls-remote` pre-flight. Never throws. */
export async function checkRemote(url: string): Promise<RemoteCheck> {
	if (!looksLikeRemote(url)) {
		return {
			ok: false,
			result: {
				ok: false,
				code: null,
				stdout: "",
				stderr: "地址看起来不是 git 远端（应为 git@host:path 或 https://…）",
				timedOut: false,
				command: "",
			},
		};
	}
	const result = await lsRemote(url);
	return { ok: result.ok, result };
}

/** Cheap syntactic gate so obvious typos never hit the network. */
export function looksLikeRemote(url: string): boolean {
	const trimmed = url.trim();
	if (!trimmed || /\s/.test(trimmed)) return false;
	return (
		/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || // https://, ssh://, git://, file://
		/^[^\s@]+@[^\s@]+:.+/.test(trimmed) || // scp-like: git@github.com:you/repo.git
		/^\/.+/.test(trimmed) // local absolute path (file remote)
	);
}

/**
 * Turn git's stderr into the design's three-way hint (SSH key / credentials /
 * missing repo), because "Permission denied (publickey)" alone is not useful
 * for a first-time user.
 */
export function summarizeRemoteError(url: string, result: GitResult): string {
	const blob = `${result.stderr}\n${result.stdout}`;
	const isHttps = /^https?:\/\//i.test(url.trim());
	if (result.timedOut) {
		return "连接超时（网络不可达或需要代理）";
	}
	if (/Permission denied \(publickey\)|Load key|no such identity|Could not read from remote/i.test(blob)) {
		// SSH without a usable key: https is the only alternative the wizard offers.
		return isHttps
			? "认证失败（https 凭证无效或已过期）"
			: "SSH key 未配置或未被远端接受（可改用 https 地址）";
	}
	if (/Authentication failed|could not read Username|terminal prompts disabled|Invalid username or password/i.test(blob)) {
		return isHttps
			? "https 需要凭证（配置 token，或改用 SSH 地址）"
			: "认证失败（检查该账号是否已授权）";
	}
	if (/Repository not found|does not appear to be a git repository|not found/i.test(blob)) {
		return "仓库不存在，或当前账号没有访问权限";
	}
	if (/Could not resolve host|Name or service not known|nodename nor servname/i.test(blob)) {
		return "无法解析主机名（检查地址拼写与网络）";
	}
	const line = firstLine(blob);
	return line || "远端不可用";
}

/** Full message: reason + the raw error, for the error dialogs. */
export function formatRemoteError(result: GitResult): string {
	return [firstLine(result.stderr) || firstLine(result.stdout), result.command].filter(Boolean).join(" — ");
}
