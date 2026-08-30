/**
 * Default-pane resolution for the wmux MCP server.
 *
 * Terminal tools (terminal_send, terminal_read, terminal_send_key,
 * terminal_read_events) accept an optional ptyId. When it's omitted, the
 * main process falls back to the currently-focused pane. That fallback is
 * fine for callers running INSIDE a wmux PTY (Claude Code in a wmux pane),
 * but wrong for external callers (Claude Code in cmd.exe / Windows
 * Terminal / VS Code terminal) — there the user almost always has live
 * work in the focused pane and keystrokes would hijack it.
 *
 * This module holds a process-lifetime "pinned route" (ptyId + owning
 * workspaceId) that external callers claim on first use via the
 * mcp.claimWorkspace RPC. The pin survives for the MCP server process
 * only; when the external Claude Code exits, the subprocess dies and the
 * pin disappears. The claimed workspace and its pane are left intact so
 * the user can inspect output afterwards.
 *
 * The workspaceId is pinned ALONGSIDE the ptyId (issue #163 Part 2): the
 * terminal RPCs carry workspaceId so the main process can assert PTY
 * ownership, and that id must come from the claim response — never from
 * the spoofable WMUX_WORKSPACE_ID env hint. A pin without a workspaceId
 * would force callers back onto the hint, reopening the bypass, so a
 * claim response missing either id fails closed.
 */

import type { RpcMethod } from '../shared/rpc';
import { getConnectionScope } from './connectionScope';

export interface PinnedRoute {
  readonly ptyId: string;
  readonly workspaceId: string;
}

export interface ClaimDeps {
  /** JSON-RPC sender (wmux-client.sendRpc, usually). */
  sendRpc: (method: RpcMethod, params?: Record<string, unknown>) => Promise<unknown>;
  /**
   * #922 PR-A — hand the minted workspace claim token to whatever stamps
   * outbound envelopes (wmux-client.setWorkspaceToken, usually). Injected
   * rather than imported so this module keeps its one-way dependency on the
   * sender and stays testable without the socket layer.
   *
   * Optional: a main process that mints no token (an older build, or an
   * in-process caller, which is not issued one) simply never calls it, and the
   * claim succeeds exactly as before.
   */
  onWorkspaceToken?: (token: string) => void;
}

let pinned: PinnedRoute | null = null;
let claimInFlight: Promise<PinnedRoute> | null = null;

// Broker mode: the pin is per CONNECTION, not per process — two external
// callers hosted by one broker must not share a claimed workspace. The
// scope carries the slots; single-child mode falls back to module state.
interface PinSlots {
  get(): PinnedRoute | null;
  set(v: PinnedRoute | null): void;
  getInFlight(): Promise<PinnedRoute> | null;
  setInFlight(v: Promise<PinnedRoute> | null): void;
}

function slots(): PinSlots {
  const scope = getConnectionScope();
  if (scope) {
    return {
      get: () => scope.pinnedRoute,
      set: (v) => { scope.pinnedRoute = v; },
      getInFlight: () => scope.pinnedClaimInFlight,
      setInFlight: (v) => { scope.pinnedClaimInFlight = v; },
    };
  }
  return {
    get: () => pinned,
    set: (v) => { pinned = v; },
    getInFlight: () => claimInFlight,
    setInFlight: (v) => { claimInFlight = v; },
  };
}

/** The route claimed earlier in this process/connection, or null before the first claim. */
export function getPinnedRoute(): PinnedRoute | null {
  return slots().get();
}

/**
 * Drop the route claimed by the current process/connection.
 *
 * A claim is normally process-lived, but the user can delete its workspace
 * while the MCP server stays alive. Once an RPC proves that route is stale,
 * clearing the pin lets the next terminal call claim a fresh workspace rather
 * than retrying the dead PTY forever. `slots()` keeps broker callers isolated:
 * invalidating one connection never disturbs another connection's route.
 *
 * When `expectedRoute` is supplied, object identity acts as the claim
 * generation: a late response for an older claim cannot clear a newer one.
 * Omitting it retains the unconditional form used by explicit resets.
 */
export function clearPinnedRoute(expectedRoute?: PinnedRoute | null): void {
  const s = slots();
  if (expectedRoute !== undefined && s.get() !== expectedRoute) return;
  s.set(null);
}

/**
 * Claim a dedicated workspace + PTY for an external caller and pin both ids
 * for the rest of this process's lifetime.
 *
 * Concurrent first calls de-dupe through claimInFlight so we don't race
 * and spawn multiple claim workspaces. Failures throw (fail-closed) and do
 * NOT pin, so a later call retries instead of being permanently disabled.
 */
export async function claimPinnedRoute(deps: ClaimDeps): Promise<PinnedRoute> {
  const s = slots();
  const existing = s.get();
  if (existing) return existing;
  const inFlight = s.getInFlight();
  if (inFlight) return inFlight;

  const claim = (async () => {
    try {
      const result = await deps.sendRpc('mcp.claimWorkspace', { name: 'MCP' });
      const ptyId = (result as { ptyId?: string } | null)?.ptyId;
      const workspaceId = (result as { workspaceId?: string } | null)?.workspaceId;
      if (typeof ptyId !== 'string' || ptyId.length === 0) {
        throw new Error('mcp.claimWorkspace returned no ptyId');
      }
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
        // Pinning the ptyId without its owner would leave terminal RPCs with
        // no trustworthy workspaceId to assert against — fail closed instead.
        throw new Error('mcp.claimWorkspace returned no workspaceId');
      }
      // #922 PR-A — the claim token, when main issued one. Deliberately NOT
      // part of `PinnedRoute`: the route is the terminal target, the token is
      // envelope identity, and the two are read by different layers. It is
      // handed over BEFORE the route is published so no RPC can be routed by
      // this claim while the envelope still lacks its token.
      //
      // Its absence is never fatal. Unlike ptyId/workspaceId above — which
      // fail closed because a pin without them reopens the #163 bypass —
      // nothing in PR-A depends on the token, so a main process that does not
      // mint one leaves the caller exactly where it was.
      // Trimmed at the source, not just downstream: a blank token would be
      // handed over as if it were a real one, and presenting a blank reads to
      // the substrate as a token that does not resolve — "stale", which PR-B
      // must refuse — rather than as the "never claimed" it actually is.
      const rawToken = (result as { workspaceToken?: unknown } | null)?.workspaceToken;
      const workspaceToken = typeof rawToken === 'string' ? rawToken.trim() : '';
      if (workspaceToken.length > 0) {
        deps.onWorkspaceToken?.(workspaceToken);
      }
      const route = { ptyId, workspaceId };
      s.set(route);
      return route;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[mcp] claimWorkspace failed:', message);
      throw new Error(`Unable to claim a dedicated MCP terminal workspace: ${message}`);
    }
  })();
  s.setInFlight(claim);

  try {
    return await claim;
  } finally {
    s.setInFlight(null);
  }
}

/** Test-only: clear module state so each test starts with an empty pin. */
export function __resetPaneResolverForTesting(): void {
  pinned = null;
  claimInFlight = null;
}
