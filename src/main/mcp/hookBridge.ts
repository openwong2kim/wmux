// Curated hook-bridge lane for the Phase 2.2 permission enforcer (#1111).
//
// Why this exists
// ---------------
// The agent lifecycle bridges under `integrations/<agent>/bin/` (claude,
// codex, kiro, openclaude, opencode) report turn state to wmux. They prefer
// the DAEMON control pipe (`daemon.hooks.signal`, which has no enforcer), but
// fall back to — and for resume-binding persistence depend on — the MAIN pipe
// method `hooks.signal`.
//
// Until #1111 they sent no `clientName` at all and rode the legacy
// grandfather. Closing that lane refuses every main-pipe lifecycle signal,
// which degrades turn-state reporting silently: shadow mode (the dev default)
// hides it completely, so it would only surface in a packaged build.
//
// They cannot go through the normal declare/approve flow: `hooks.signal` is
// `wmux.internal` (methodCapabilityMap.ts) and `permissionGrammar` forbids the
// `wmux.` prefix from ever appearing in a declaration. No amount of user
// approval can grant it. A source-qualified, name-recognised lane is the only
// path — the same conclusion firstParty.ts and internalCli.ts reached.
//
// Why its own lane rather than FIRST_PARTY_METHODS
// ------------------------------------------------
// Least privilege. FIRST_PARTY_METHODS is ~35 methods including `pane.close`,
// `surface.new`/`surface.close`, `input.send` and `pane.setMetadata`. A notify
// bridge that calls exactly ONE method would receive all of them, and
// `hooks.signal` would simultaneously become reachable by the bundled MCP
// server — widening in both directions to fix a one-method gap. This lane
// grants exactly `hooks.signal`, to exactly this name, and nothing else.
//
// Threat model (same stance as firstParty.ts / internalCli.ts)
// -----------------------------------------------------------
// Recognition is by self-asserted `clientName` once local external-wire
// provenance is established, so the name is in NON_IDENTIFYING_CLIENT_NAMES:
// anyone may send it. What it grants is bounded by design at one method, and
// it grants an attacker nothing new — the daemon control pipe already accepts
// `daemon.hooks.signal` with NO enforcer, so any same-user process holding the
// auth token can already deliver hook signals by that route. This lane
// restores the documented bridge path; it does not open one.

import type { RpcMethod } from '../../shared/rpc';
import { WMUX_HOOK_BRIDGE_CLIENT_NAME } from '../../shared/rpc';

export { WMUX_HOOK_BRIDGE_CLIENT_NAME };

// The exact MAIN-PIPE RPC methods the `integrations/**` bridges invoke.
// Audited across all five bridges (claude, codex, kiro, openclaude, opencode):
// `hooks.signal` is the only one. `daemon.hooks.signal` is intentionally
// EXCLUDED — it targets the DaemonPipeServer, which has no enforcer, so it
// never reaches this tier. Least privilege: a bridge that later needs another
// method must add it here deliberately, and until then a `wmux-hook-bridge`
// impersonator can reach nothing else through this path.
export const HOOK_BRIDGE_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  'hooks.signal',
]);

/**
 * True when `clientName` identifies an agent lifecycle hook bridge. Exact
 * match — `clientName` is already trimmed by RpcRouter when it builds the
 * RpcContext. `undefined` / unknown names are NOT a bridge (they fall through
 * to normal enforcement, which after #1111 refuses an envelope-less caller).
 */
export function isHookBridgeClient(clientName: string | undefined): boolean {
  return clientName === WMUX_HOOK_BRIDGE_CLIENT_NAME;
}
