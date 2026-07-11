/**
 * Verified workspace routing for the wmux MCP terminal tools (issue #163 Part 2).
 *
 * The terminal tools (terminal_read, terminal_read_events, terminal_send,
 * terminal_send_key) carry a `workspaceId` so the main process can assert that
 * the target PTY actually belongs to the caller's workspace
 * (assertWorkspaceOwnsPty). Before this module they resolved that id via the
 * weak resolver, which falls back to the spoofable WMUX_WORKSPACE_ID env hint
 * on a PID-map miss. An external caller could therefore set the hint to a
 * victim workspace, pass that victim's ptyId, and the assert — which only
 * checks "ptyId belongs to workspaceId", both attacker-supplied — would pass.
 *
 * This module resolves terminal routing from VERIFIED identity only:
 *
 *   ┌─ cache hit (verified PID-map result, still valid) ─→ use it
 *   │
 *   ├─ PID-map HIT (our process tree owns a live workspace) ─→ first-party,
 *   │     use that ws; explicit ptyId passes through (main asserts ownership)
 *   │
 *   ├─ PID-map MISS (map populated, our chain absent) ─→ confirmed external:
 *   │     • ptyId omitted  → reuse pinned route, else claim a dedicated ws
 *   │     • explicit ptyId → use pinned ws if pinned (main rejects a foreign
 *   │       ptyId), else FAIL CLOSED (no legitimate target before a claim)
 *   │
 *   └─ TRANSIENT (rpc-down / empty-map, e.g. daemon respawn) ─→ grace retry,
 *         so a real first-party caller booting through a respawn isn't falsely
 *         treated as external. On exhaust: rpc-down → retryable throw;
 *         empty-map → treat as external (a live daemon with zero PTYs cannot
 *         be hosting a first-party caller).
 *
 * INVARIANT: resolveTerminalRoute never returns an empty/undefined
 * workspaceId. An empty workspaceId reaching the main process would make
 * assertWorkspaceOwnsPty treat the call as an internal (CLI/UI) caller and
 * skip the ownership check entirely — the exact bypass this fix closes.
 */

import type { PinnedRoute } from './paneResolver';

export type PidMapLookup =
  | { status: 'hit'; wsId: string; ptyId?: string } // ptyId = the caller's OWN pane anchor (A2A self-send guard); terminal routing ignores it
  | { status: 'miss' } // map non-empty but our process chain isn't in it → confirmed external
  | { status: 'rpc-down' } // a2a.resolve.identity threw → transient (daemon unreachable)
  | { status: 'empty-map' }; // RPC answered but mappings empty → boot/respawn reconcile window

export interface TerminalRoute {
  workspaceId: string;
  ptyId?: string;
}

export interface TerminalRoutingDeps {
  /** Live PID→workspace lookup. Distinguishes hit / miss / transient states. */
  lookupPidMapWorkspace: () => Promise<PidMapLookup>;
  /** Verified cached identity ('' when none / invalidated). Honors workspaceResolved. */
  getCachedVerifiedWorkspaceId: () => string;
  /** Persist a freshly-resolved verified identity into the cache. */
  cacheVerifiedWorkspaceId: (wsId: string) => void;
  /** Route pinned by an earlier external claim, or null. */
  getPinnedRoute: () => PinnedRoute | null;
  /** Claim (and pin) a dedicated workspace + PTY for an external caller. */
  claimPinnedRoute: () => Promise<PinnedRoute>;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Grace attempts for rpc-down. Default 4. */
  rpcDownGraceAttempts?: number;
  /** Grace attempts for empty-map (slightly longer — respawn reconcile). Default 6. */
  emptyMapGraceAttempts?: number;
  /** Delay between grace attempts, ms. Default 750. */
  graceDelayMs?: number;
}

const DEFAULT_RPC_DOWN_ATTEMPTS = 4;
const DEFAULT_EMPTY_MAP_ATTEMPTS = 6;
const DEFAULT_GRACE_DELAY_MS = 750;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the verified workspace (and possibly ptyId) for a terminal RPC.
 * Throws on confirmed-external explicit-ptyId-without-pin and on rpc-down
 * exhaustion. Never returns an empty workspaceId.
 */
export async function resolveTerminalRoute(
  deps: TerminalRoutingDeps,
  explicitPtyId?: string,
): Promise<TerminalRoute> {
  const route = await resolveInner(deps, explicitPtyId);
  if (!route.workspaceId) {
    // Defensive: no branch below should produce this, but an empty workspaceId
    // silently disables the main-side ownership assert, so refuse it loudly.
    throw new Error(
      'resolveTerminalRoute: refusing to route a terminal RPC with no verified workspaceId',
    );
  }
  return route;
}

async function resolveInner(
  deps: TerminalRoutingDeps,
  explicitPtyId?: string,
): Promise<TerminalRoute> {
  // 1. Verified cache fast-path. getCachedVerifiedWorkspaceId returns '' once
  //    invalidateWorkspaceId() has cleared workspaceResolved, so a stale (re-
  //    minted) workspace falls through to a fresh PID-map lookup and self-heals.
  const cached = deps.getCachedVerifiedWorkspaceId();
  if (cached) {
    return { workspaceId: cached, ptyId: explicitPtyId };
  }

  const sleep = deps.sleep ?? defaultSleep;
  const rpcDownAttempts = deps.rpcDownGraceAttempts ?? DEFAULT_RPC_DOWN_ATTEMPTS;
  const emptyMapAttempts = deps.emptyMapGraceAttempts ?? DEFAULT_EMPTY_MAP_ATTEMPTS;
  const delayMs = deps.graceDelayMs ?? DEFAULT_GRACE_DELAY_MS;

  let rpcDownSeen = 0;
  let emptyMapSeen = 0;

  // 2. Grace loop. `hit` and `miss` are terminal (decided immediately — a miss
  //    must not stall a confirmed-external caller). Only transient states retry.
  for (;;) {
    const lookup = await deps.lookupPidMapWorkspace();

    if (lookup.status === 'hit') {
      // First-party: cache so subsequent calls take the fast-path, then route.
      // A fresh hit always beats an existing pin — this bounds the blast radius
      // of any false claim (below) to a single self-healing call.
      deps.cacheVerifiedWorkspaceId(lookup.wsId);
      return { workspaceId: lookup.wsId, ptyId: explicitPtyId };
    }

    if (lookup.status === 'miss') {
      return resolveExternal(deps, explicitPtyId);
    }

    if (lookup.status === 'rpc-down') {
      rpcDownSeen += 1;
      if (rpcDownSeen >= rpcDownAttempts) {
        throw new Error(
          'wmux main process is not reachable (it may be starting or restarting). ' +
            'Retry the terminal operation in a few seconds.',
        );
      }
      await sleep(delayMs);
      continue;
    }

    // empty-map: a live daemon reporting zero PTYs. During a respawn reconcile
    // window this can briefly be true for a first-party caller, so retry; on
    // exhaust treat as external (a daemon with no PTYs can't host first-party).
    emptyMapSeen += 1;
    if (emptyMapSeen >= emptyMapAttempts) {
      return resolveExternal(deps, explicitPtyId);
    }
    await sleep(delayMs);
  }
}

/**
 * Confirmed-external routing. ptyId omitted → reuse/claim a pinned dedicated
 * route. Explicit ptyId → only valid against an existing pin (a foreign ptyId
 * is then rejected by the main-side assert); without a pin there is no
 * legitimate target, so fail closed rather than claim (claiming would spawn an
 * empty "MCP" workspace the explicit ptyId can never belong to).
 */
async function resolveExternal(
  deps: TerminalRoutingDeps,
  explicitPtyId?: string,
): Promise<TerminalRoute> {
  const pin = deps.getPinnedRoute();

  if (explicitPtyId) {
    if (pin) {
      return { workspaceId: pin.workspaceId, ptyId: explicitPtyId };
    }
    throw new Error(
      'External MCP callers cannot target an explicit ptyId before claiming a ' +
        'dedicated terminal. Omit ptyId to claim and use your own terminal.',
    );
  }

  const route = pin ?? (await deps.claimPinnedRoute());
  return { workspaceId: route.workspaceId, ptyId: route.ptyId };
}

/**
 * Commander-brain routing (P3b, codex P1). The commander's MCP subprocess is
 * spawned by the wmux MAIN process — it has no pane ancestry, so the pid-map
 * resolves it as confirmed-external and the rules above confine it to a
 * claimed "MCP" workspace. But the commander's whole job is driving the
 * EXISTING fleet, so main injects a per-spawn token (WMUX_COMMANDER_TOKEN)
 * into ONLY this subprocess's env, and `deck.resolvePaneRoute` resolves any
 * pane's true owning workspaceId for a live token.
 *
 * Returns null when there is no token / no explicit ptyId / the RPC rejects
 * (stale token after an app restart, unknown pane) — the caller then falls
 * through to the ordinary routing rules, so a broken token degrades to the
 * plain external behavior instead of erroring every terminal tool.
 */
export async function resolveCommanderRoute(args: {
  token: string | undefined;
  explicitPtyId: string | undefined;
  sendRpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}): Promise<TerminalRoute | null> {
  const { token, explicitPtyId, sendRpc } = args;
  if (!token || !explicitPtyId) return null;
  try {
    const result = await sendRpc('deck.resolvePaneRoute', { token, ptyId: explicitPtyId });
    const workspaceId =
      result && typeof result === 'object' && 'workspaceId' in result
        ? (result as Record<string, unknown>)['workspaceId']
        : undefined;
    if (typeof workspaceId === 'string' && workspaceId.length > 0) {
      return { workspaceId, ptyId: explicitPtyId };
    }
  } catch {
    /* not a live commander / pane unowned — fall back to normal routing */
  }
  return null;
}
