// Internal first-party CLI recognition for the permission enforcer.
//
// Why this exists
// ---------------
// `wmux <command>` (src/cli) is the one steady-state, envelope-less, MUTATING
// caller on the main pipe: it builds bare `{ id, method, params, token }`
// requests and historically rode the legacy grandfather in the enforcer
// (`if (!clientName) return allow`). To let the grandfather be CLOSED later
// (trust-root plan Stage 3) WITHOUT breaking the CLI, the CLI now reports a
// stable `clientName` (`WMUX_CLI_CLIENT_NAME`) and the enforcer grants it
// EXACTLY the curated method set it invokes — a SEPARATE, narrower allowlist
// than the bundled-MCP `FIRST_PARTY_METHODS` (this deliberately does NOT widen
// that set).
//
// Threat model (identical to firstParty.ts): recognition is by self-asserted
// `clientName` — best-effort same-user attribution, NOT a security boundary
// against same-user code (a same-user process already holds the auth token and
// can hit the pipe directly). What the scoped allowlist buys over the blanket
// grandfather is that even an impersonator using this name reaches ONLY the
// CLI's curated surface — never `daemon.*`, `company.*` mutation,
// `workspace.new`'s neighbours it doesn't use, etc.
//
// Kept in lockstep with the real CLI surface by internalCli.test.ts, which
// parses src/cli/** for every `sendRequest`/`sendRequestToPipe` method literal
// and fails if a main-pipe method is missing here (so a new CLI command that
// calls a new RPC can't silently break under enforce mode once the grandfather
// closes).

import type { RpcMethod } from '../../shared/rpc';
import { WMUX_CLI_CLIENT_NAME } from '../../shared/rpc';

export { WMUX_CLI_CLIENT_NAME };

// The exact MAIN-PIPE RPC methods `wmux <command>` (src/cli/**) invokes via
// `sendRequest`. Daemon-control-pipe methods (`daemon.*`) are intentionally
// EXCLUDED — they target the DaemonPipeServer, which has no enforcer, so they
// never reach this tier. Least privilege: methods the CLI does not call are
// absent, so a `wmux-cli` impersonator can never reach them through this path.
export const WMUX_CLI_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  // identity / capabilities (capability:null bootstrap; allowed before this
  // tier anyway, listed so the source-lockstep test stays exhaustive)
  'system.identify',
  'system.capabilities',
  // workspace lifecycle/read (the CLI's `wmux workspace ...` verbs)
  'workspace.list',
  'workspace.current',
  'workspace.focus',
  'workspace.new',
  'workspace.close',
  // surface + pane (`wmux surface ...` / `wmux pane ...`)
  'surface.list',
  'surface.new',
  'surface.focus',
  'surface.close',
  'pane.list',
  'pane.split',
  'pane.focus',
  // terminal IO (`wmux input ...`)
  'input.send',
  'input.sendKey',
  'input.readScreen',
  // metadata (`wmux` status/progress reporting)
  'meta.setStatus',
  'meta.setProgress',
  // notification (`wmux notify`)
  'notify',
  // a2a identity resolution (`wmux` resolves its own pane identity)
  'a2a.resolve.identity',
  // browser control (`wmux browser ...`)
  'browser.open',
  'browser.navigate',
  'browser.close',
  'browser.session.start',
  'browser.session.stop',
  'browser.session.status',
  'browser.session.list',
]);

/**
 * True when `clientName` identifies the bundled first-party wmux CLI. Exact
 * match — `clientName` is already trimmed by RpcRouter when it builds the
 * RpcContext. `undefined` / unknown names are NOT the CLI (they fall through to
 * the legacy grandfather / normal enforcement).
 */
export function isInternalCliClient(clientName: string | undefined): boolean {
  return clientName === WMUX_CLI_CLIENT_NAME;
}
