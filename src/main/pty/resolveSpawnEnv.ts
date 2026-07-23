import { buildGatedAutomationEnv, buildInteractiveShellEnv } from '../../shared/envFilter';
import { ENV_KEYS } from '../../shared/constants';
import type { EnvPolicy } from '../../shared/spawnKind';

/**
 * Resolve the environment for a NEW child PTY, in the single canonical order
 * shared by both spawn paths (local PTYManager and the daemon-mode handler in
 * pty.handler). Extracted as a pure function so the security-critical merge
 * order has direct regression coverage and the two callsites can't drift.
 *
 *   1. baseline — determined by `policy` (execution-context policy):
 *        'gated' (default, fail-closed) → buildGatedAutomationEnv: strip
 *          internal + credentials. Agent/automation panes. Same as legacy behavior
 *          (backward compatible).
 *        'passthrough'                  → buildInteractiveShellEnv: strip internal
 *          only, credentials pass through. User-opened shell (same as other terminals).
 *   1.5 accountEnv (multi-account) — overlay the workspace's bound-account env
 *      (CLAUDE_CONFIG_DIR / CODEX_HOME), resolved in MAIN from the workspace
 *      binding, AFTER the denylist and BEFORE the profile. Applied before the
 *      profile deliberately so a MANUAL profile CLAUDE_CONFIG_DIR always WINS
 *      over an account binding (the existing contributor workflow must keep
 *      working; UI warns on conflict). Empty when the workspace binds no
 *      account for this vendor. Same skip-WMUX_* discipline as the profile.
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
 * `policy` defaults to 'gated', so existing callers/tests that omit the argument
 * behave as before (fail-closed). WMUX_* namespace clear + forced identity apply
 * regardless of policy, so even passthrough cannot spoof inherited WMUX identity.
 *
 * The result is a fresh object the caller may further mutate (e.g. shell-
 * integration injection layered on top).
 */
/**
 * Overlay `src` onto `target` in place, skipping reserved WMUX_* keys and
 * non-string values (mirrors applyProfileEnv). On win32, env vars are
 * case-insensitive, so before writing a key we delete any existing
 * different-cased alias — otherwise `CLAUDE_CONFIG_DIR` and `claude_config_dir`
 * would both survive and the OS would pick one nondeterministically, breaking
 * the account-vs-profile precedence contract.
 */
function applyOverlay(target: Record<string, string>, src: Record<string, string> | undefined): void {
  if (!src) return;
  const win = process.platform === 'win32';
  for (const [key, value] of Object.entries(src)) {
    if (typeof value !== 'string') continue;
    if (key.toUpperCase().startsWith('WMUX_')) continue;
    if (win) {
      const lower = key.toLowerCase();
      for (const existing of Object.keys(target)) {
        if (existing !== key && existing.toLowerCase() === lower) delete target[existing];
      }
    }
    target[key] = value;
  }
}

export function resolveSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  profileEnv: Record<string, string> | undefined,
  identity: Record<string, string>,
  fallbackLocale?: string,
  policy: EnvPolicy = 'gated',
  accountEnv?: Record<string, string>,
): Record<string, string> {
  const env = policy === 'passthrough'
    ? buildInteractiveShellEnv(baseEnv)
    : buildGatedAutomationEnv(baseEnv);
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
  // 1.5: account overlay BEFORE the profile so a manual profile CLAUDE_CONFIG_DIR
  // wins. On Windows env vars are case-INSENSITIVE, so a bound `CLAUDE_CONFIG_DIR`
  // and a profile's `claude_config_dir` would otherwise survive as two keys and
  // the OS would keep an arbitrary one — silently defeating the manual-override
  // precedence (Codex review P1). applyOverlay drops existing case-variants on
  // win32 before writing each key, so the last overlay (profile) truly wins.
  applyOverlay(env, accountEnv);
  applyOverlay(env, profileEnv);
  for (const [k, v] of Object.entries(identity)) {
    if (typeof v === 'string') env[k] = v;
  }
  // Re-apply the captured suffix AFTER identity (same "forced last, unspoofable"
  // discipline). A profile can never set it (applyProfileEnv skips WMUX_*); only
  // the spawning process's real suffix survives. baseEnv here is always the live
  // process.env (never a persisted blob), so a simple presence check is enough —
  // the daemon recovery path scrubs a stale blob suffix separately.
  if (typeof dataSuffix === 'string' && dataSuffix) env[ENV_KEYS.DATA_SUFFIX] = dataSuffix;
  // Locale fallback (issue #321): without any UTF-8 locale the shell falls back to
  // C/POSIX and zsh ZLE cannot compose Korean/CJK multibyte input, showing garbage
  // like `<0085>`. Launching macOS from Dock/Finder without inheriting `LANG` is the
  // common trigger. Never overwrite if the user already set locale via profile/rc
  // (any of the three vars below).
  if (fallbackLocale && !env.LANG && !env.LC_ALL && !env.LC_CTYPE) {
    env.LANG = fallbackLocale;
  }
  return env;
}
