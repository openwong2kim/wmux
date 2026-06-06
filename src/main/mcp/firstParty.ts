// First-party MCP recognition for the Phase 2.2 permission enforcer.
//
// Why this exists
// ---------------
// wmux ships its own MCP server (`src/mcp/index.ts`, the `wmux` plugin Claude
// Code talks to). In a packaged build the daemon runs the enforcer in
// `enforce` mode (enforcementMode.ts), and the bundled server is recorded in
// the trust DB as `unconfirmed` because it only ever calls `mcp.identify`,
// never `mcp.declarePermissions`. That left every capability-bearing RPC it
// makes (browser.*, pane.*, a2a.*, ...) rejected with no path to recover:
// the approval dialog only fires for plugins that declared a non-empty
// capability set, so the bundled server deadlocked permanently. See
// `plans/first-party-mcp-trust.md`.
//
// It can't go through the normal declare/approve flow either: several tools
// it exposes map to `wmux.internal` methods (surface.list, company.a2a.*)
// which `permissionGrammar` deliberately forbids from ever appearing in a
// declaration (RESERVED_PREFIXES = ['wmux.']). No amount of user approval can
// grant those.
//
// The fix: pair the bundled server's host clientName with a private
// first-party bearer credential before allowing exactly the method set it
// actually calls — nothing more. `clientName` is self-declared (rpc.ts), so a
// clean missing or unconfirmed row cannot grant first-party privileges by
// itself. A method outside the set falls through to normal enforcement, and an
// explicit user `denied` still wins (see PermissionEnforcer.check).

import type { RpcMethod } from '../../shared/rpc';

// Host identities that may own the bundled wmux MCP server once the request
// also carries the private first-party token. The server reports the connecting
// MCP client's `clientInfo.name` (see wireClientIdentityHook in src/mcp/index.ts);
// Claude Code reports `claude-code`. Exact match — `clientName` is already
// trimmed by PipeServer when it builds RpcContext.
export const FIRST_PARTY_CLIENT_NAMES: ReadonlySet<string> = new Set<string>([
  'claude-code',
]);

// The exact RPC methods the bundled MCP server (src/mcp/index.ts and its
// src/mcp/playwright/* helpers) invokes. Kept in lockstep with that surface by
// `firstParty.test.ts`, which parses src/mcp/ for every callRpc/sendRpc method
// literal and fails if any is missing here. Least privilege: methods the
// bundled server does NOT call (e.g. daemon.shutdown, workspace.new,
// company.create) are intentionally absent.
export const FIRST_PARTY_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  // identity / workspace bootstrap
  'mcp.identify',
  'mcp.claimWorkspace',
  'workspace.list',
  'surface.list',
  // panes + metadata
  'pane.list',
  'pane.search',
  'pane.getMetadata',
  'pane.setMetadata',
  'meta.setSkills',
  // terminal IO
  'input.send',
  'input.sendKey',
  'input.readScreen',
  'terminal.readEvents',
  // events
  'events.poll',
  // browser (Playwright + packaged CDP/RPC fallbacks)
  'browser.open',
  'browser.navigate',
  'browser.goBack',
  'browser.close',
  'browser.session.start',
  'browser.session.stop',
  'browser.session.status',
  'browser.session.list',
  'browser.screenshot',
  'browser.evaluate',
  'browser.cdp.info',
  'browser.console.get',
  'browser.network.get',
  'browser.responseBody.get',
  'browser.click.cdp',
  'browser.type.cdp',
  'browser.press.cdp',
  'browser.cookies',
  'browser.resize',
  'browser.emulate',
  // agent-to-agent
  'a2a.resolve.identity',
  'a2a.whoami',
  'a2a.discover',
  'a2a.task.send',
  'a2a.task.query',
  'a2a.task.update',
  'a2a.task.cancel',
  'a2a.broadcast',
  // company mode (all wmux.internal — undeclarable, hence the need for this list)
  'company.a2a.whoami',
  'company.a2a.send',
  'company.a2a.broadcast',
  'company.a2a.inbox',
  'company.a2a.ack',
  'company.a2a.status',
]);

/**
 * True when `clientName` identifies the bundled first-party wmux MCP server.
 * `undefined` / unknown names are NOT first-party — envelope-less callers are
 * already handled by the enforcer's `legacy` grandfather branch.
 */
export function isFirstPartyClient(clientName: string | undefined): boolean {
  return typeof clientName === 'string' && FIRST_PARTY_CLIENT_NAMES.has(clientName);
}
