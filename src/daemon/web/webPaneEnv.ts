import { ENV_KEYS } from '../../shared/constants';
import { buildSafeChildEnv } from '../../shared/envFilter';

/**
 * Drop the whole reserved `WMUX_*` namespace from an environment.
 *
 * Mirrors what `createSession` does to its own `process.env` fallback: a daemon
 * that was itself launched from a wmux pane inherited that pane's
 * WMUX_WORKSPACE_ID / WMUX_SURFACE_ID / WMUX_SOCKET_PATH, and a child must not
 * be told it belongs to a workspace it does not. Applied here because the
 * lifecycle create path SUPPLIES an env (to stamp the pane's identity), and a
 * supplied env is replayed verbatim by contract.
 */
export function stripWmuxNamespace(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('WMUX_')) out[k] = v;
  }
  return out;
}

/**
 * The environment a pane created over the web API is spawned with.
 *
 * Lives in its own module purely so it can be tested: the daemon entrypoint
 * that used to hold this inline cannot be imported without booting a daemon.
 *
 * Two things are stamped back on after the namespace is stripped:
 *
 *   - `WMUX_MEMBER_ID`, ALWAYS, set to the pane's own session id. This is the
 *     pane's channel identity and the main-process create path
 *     (`pty.handler`'s forced identity) sets exactly the same thing. Without
 *     it `wmux channel join` inside a phone-created pane fails with "no member
 *     id", while the other channel commands fall back to the shared literal
 *     `agent` — which is precisely the member collision the per-pane stamp
 *     exists to prevent. `createSession` only adds `WMUX_PTY_ID`, so nothing
 *     else in the daemon supplies this.
 *
 *   - `WMUX_WORKSPACE_ID` (and the human-readable name when one is known) when
 *     the request named a workspace. Absent workspace ⇒ a headless pane, which
 *     is a valid outcome; the member id is stamped either way.
 */
export function buildWebPaneEnv(params: {
  /** The new session's id. Becomes the channel member id verbatim. */
  id: string;
  /** The daemon's own environment, pre-filter. */
  parentEnv: NodeJS.ProcessEnv;
  workspaceId?: string;
  /** Copied from a live sibling pane; the daemon has no workspace registry. */
  workspaceName?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    ...stripWmuxNamespace(buildSafeChildEnv(params.parentEnv)),
    [ENV_KEYS.MEMBER_ID]: params.id,
  };
  if (params.workspaceId) {
    env[ENV_KEYS.WORKSPACE_ID] = params.workspaceId;
    if (params.workspaceName) env[ENV_KEYS.WORKSPACE_NAME] = params.workspaceName;
  }
  return env;
}
