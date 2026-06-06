import { buildSafeChildEnv } from '../../shared/envFilter';
import { applyProfileEnv } from '../../shared/workspaceProfile';

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
): Record<string, string> {
  const env = buildSafeChildEnv(baseEnv);
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
  return env;
}
