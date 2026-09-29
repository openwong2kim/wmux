// Curated statusline-push lane for the Phase 2.2 permission enforcer (#1111).
//
// Why this exists
// ---------------
// The Claude Code statusline script (`integrations/claude/bin/
// wmux-statusline.mjs`, #1639) pushes the live `rate_limits` sample Claude
// Code hands it to the running app over the MAIN pipe, as `usage.rateLimits`.
// It landed after the #1111 close was written and sent no `clientName`, so it
// rode the legacy grandfather. Closing that lane refuses every push under the
// production enforce default, and the usage view silently falls back to HTTP
// polling: shadow mode (the dev default) hides it completely.
//
// It cannot go through the normal declare/approve flow: `usage.rateLimits` is
// `wmux.internal` (methodCapabilityMap.ts) and `permissionGrammar` forbids the
// `wmux.` prefix from ever appearing in a declaration. A source-qualified,
// name-recognised lane is the only path — the same conclusion hookBridge.ts,
// firstParty.ts and internalCli.ts reached.
//
// Why its own lane rather than HOOK_BRIDGE_METHODS
// ------------------------------------------------
// Least privilege, in both directions. Adding `usage.rateLimits` to the hook
// bridge lane would let every hook bridge push usage numbers, and giving the
// statusline the hook-bridge name would let it forge agent lifecycle signals.
// This lane grants exactly `usage.rateLimits`, to exactly this name.
//
// Threat model (same stance as hookBridge.ts)
// -------------------------------------------
// Recognition is by self-asserted `clientName` once local external-wire
// provenance is established, so the name is in NON_IDENTIFYING_CLIENT_NAMES:
// anyone may send it. What it grants is bounded at one method whose handler
// (usage.rpc.ts) writes display state only — no spawn, no fs write — and
// validates strictly, resolving the account main-side from the config dir.
// The worst a token-holding local process can do through it is show a wrong
// percentage, which it could already do before the close.

import type { RpcMethod } from '../../shared/rpc';
import { WMUX_STATUSLINE_CLIENT_NAME } from '../../shared/rpc';

export { WMUX_STATUSLINE_CLIENT_NAME };

// The exact MAIN-PIPE RPC methods the statusline script invokes. A later
// push of another kind must be added here deliberately; until then a
// `wmux-statusline` impersonator can reach nothing else through this path.
export const STATUSLINE_PUSH_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  'usage.rateLimits',
]);

/**
 * True when `clientName` identifies the statusline push. Exact match —
 * `clientName` is already trimmed by RpcRouter when it builds the RpcContext.
 * `undefined` / unknown names fall through to normal enforcement, which after
 * #1111 refuses an envelope-less caller.
 */
export function isStatuslinePushClient(clientName: string | undefined): boolean {
  return clientName === WMUX_STATUSLINE_CLIENT_NAME;
}
