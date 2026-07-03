import { buildSafeChildEnv } from '../../shared/envFilter';
import { applyProfileEnv } from '../../shared/workspaceProfile';
import { ENV_KEYS } from '../../shared/constants';

/**
 * Resolve the environment for a NEW child PTY, in the single canonical order
 * shared by both spawn paths (local PTYManager and the daemon-mode handler in
 * pty.handler). Extracted as a pure function so the security-critical merge
 * order has direct regression coverage and the two callsites can't drift.
 *
 *   1. buildSafeChildEnv(baseEnv) — strip the control process's own inherited
 *      secrets / build-tooling vars from the child baseline.
 *   2. applyProfileEnv(...)       — overlay the workspace profile AFTER the
 *      denylist, so a configured profile key is applied verbatim and not
 *      re-stripped; reserved WMUX_* keys are skipped. NOTE: this is the spawn
 *      MECHANISM — it applies whatever the profile contains. WHICH keys a
 *      profile may contain is decided one layer up by the editor's policy
 *      (shared/workspaceProfile: reserved + secret-named keys are dropped on
 *      save), not here.
 *   3. identity                   — forced LAST, so a profile can never spoof
 *      WMUX_WORKSPACE_ID / WMUX_SURFACE_ID / WMUX_SOCKET_PATH. The caller
 *      decides which identity vars apply (local mode also sets the socket
 *      path; daemon mode does not).
 *
 * The result is a fresh object the caller may further mutate (e.g. shell-
 * integration injection layered on top).
 */
export function resolveSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  profileEnv: Record<string, string> | undefined,
  identity: Record<string, string>,
  fallbackLocale?: string,
): Record<string, string> {
  const env = buildSafeChildEnv(baseEnv);
  // Capture the instance-isolation suffix from the SPAWNING process's own env
  // BEFORE the blanket WMUX_* strip below, and re-apply it last (like identity).
  // It is NOT an ownership claim — it only selects which instance a child joins —
  // so unlike WORKSPACE_ID/SURFACE_ID/SOCKET_PATH it must SURVIVE: without it an
  // isolated (dev / dogfood) pane's agent/MCP/CLI computes an empty suffix and
  // connects to the PRODUCTION control pipe, where it can drive the user's real
  // workspaces. Sourced ONLY from baseEnv (main/daemon's own env), never from
  // profileEnv — so it isolates without being a spoofable identity.
  const dataSuffix = baseEnv[ENV_KEYS.DATA_SUFFIX];
  // Drop the ENTIRE reserved WMUX_* namespace from the baseline before we
  // overlay or force anything. buildSafeChildEnv only strips WMUX_AUTH*, so a
  // wmux launched from inside a wmux pane (e.g. `npm start` while dogfooding)
  // would otherwise inherit the PARENT pane's WMUX_WORKSPACE_ID / SURFACE_ID /
  // SOCKET_PATH from its own process.env — a stale identity the caller never
  // forced (daemon mode never sets SOCKET_PATH; some create paths run before a
  // surfaceId exists). Clearing it here means a child's identity is ONLY ever
  // what we force below, making the "identity can't be spoofed" guarantee
  // unconditional rather than profile-only. Safe to clear all WMUX_*: the
  // shell-hook var is injected by the caller AFTER this, and identity is
  // re-applied immediately below.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('WMUX_')) delete env[key];
  }
  applyProfileEnv(env, profileEnv);
  for (const [k, v] of Object.entries(identity)) {
    if (typeof v === 'string') env[k] = v;
  }
  // Re-apply the captured suffix AFTER identity (same "forced last, unspoofable"
  // discipline). A profile can never set it (applyProfileEnv skips WMUX_*); only
  // the spawning process's real suffix survives. baseEnv here is always the live
  // process.env (never a persisted blob), so a simple presence check is enough —
  // the daemon recovery path scrubs a stale blob suffix separately.
  if (typeof dataSuffix === 'string' && dataSuffix) env[ENV_KEYS.DATA_SUFFIX] = dataSuffix;
  // 로케일 폴백 (issue #321): 셸이 UTF-8 로케일을 하나도 못 받으면 C/POSIX로 떨어져
  // zsh ZLE가 한글·CJK 멀티바이트 입력을 조합하지 못하고 `<0085>` 식으로 깨진다.
  // macOS를 Dock/Finder로 실행하면 `LANG`이 상속되지 않는 게 대표적 트리거. 사용자가
  // 프로필/rc로 이미 로케일을 지정했으면(아래 셋 중 하나라도) 절대 덮어쓰지 않는다.
  if (fallbackLocale && !env.LANG && !env.LC_ALL && !env.LC_CTYPE) {
    env.LANG = fallbackLocale;
  }
  return env;
}
