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
// it exposes map to `wmux.internal` methods (surface.list, surface.new/close
// [issue #285], company.a2a.*) which `permissionGrammar` deliberately forbids
// from ever appearing in a declaration (RESERVED_PREFIXES = ['wmux.']). No
// amount of user approval can grant those — name-recognition is the only path.
//
// The fix: recognise the bundled server by the host clientName it reports and
// allow exactly the method set it actually calls — nothing more. This is a
// scoped allowlist, NOT a blanket "first party can do anything" bypass: a
// method outside the set falls through to normal enforcement, and an explicit
// user `denied` still wins (see PermissionEnforcer.check).
//
// Threat model (matches the spec's "declared, not verified" stance, rpc.ts):
// recognition is by self-asserted clientName. THIS IS BEST-EFFORT ATTRIBUTION,
// NOT A SECURITY BOUNDARY AGAINST SAME-USER CODE. On a single-user OS it is no
// weaker than any local secret — a same-user process that wanted to impersonate
// the host already holds the daemon auth token and could call the pipe directly.
// What the scoped allowlist buys over a blanket bypass is that even an
// impersonator only reaches the curated method set, never daemon.*,
// workspace.new, company mutation, or other reserved surface. Cryptographic
// first-party identity (peer-PID, per-launch nonce) was evaluated and deferred
// to a remote/multi-user transport (issue #113). Full residual-risk writeup +
// the curated-allowlist invariant: docs/api/mcp-plugin-spec.md §2.4.

import type { RpcMethod } from '../../shared/rpc';

// Host identities that own the bundled wmux MCP server. The server reports the
// connecting MCP client's `clientInfo.name` (see wireClientIdentityHook in
// src/mcp/index.ts); Claude Code reports `claude-code`. A Set so additional
// first-party hosts can be added without touching the enforcer. Exact match —
// `clientName` is already trimmed by PipeServer when it builds RpcContext.
//
// Each entry is the bundled wmux MCP server running under a DIFFERENT agent
// host (the bundle code is identical; only the connecting client's reported
// name differs). Adding a host grants it the SAME scoped allowlist
// (FIRST_PARTY_METHODS) — never a blanket bypass, and an explicit user `denied`
// still wins. Threat model is unchanged: best-effort same-user attribution, not
// a security boundary (a same-user impersonator already holds the auth token).
//
//   - `claude-code`        Claude Code           (verified)
//   - `codex-mcp-client`   OpenAI Codex CLI      (verified 2026-06-15; clientInfo
//                          name captured live — `codex mcp add` → initialize)
//
// New names MUST be captured empirically (the agent's actual clientInfo.name),
// not guessed, and the agent must be confirmed to use the wmux tools end-to-end
// before being added. See plans/a2a-pane-identity-mcp-registration-IMPL.md.
export const FIRST_PARTY_CLIENT_NAMES: ReadonlySet<string> = new Set<string>([
  'claude-code',
  'codex-mcp-client',
]);

// The exact RPC methods the bundled MCP server (src/mcp/index.ts and its
// src/mcp/playwright/* helpers) invokes. Kept in lockstep with that surface by
// `firstParty.test.ts`, which parses src/mcp/ for every callRpc/sendRpc method
// literal and fails if any is missing here. Least privilege: methods the
// bundled server does NOT call (e.g. daemon.shutdown, workspace.new,
// company.create) are intentionally absent, so a clientName impersonator can
// never reach them through the first-party path.
export const FIRST_PARTY_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  // identity / workspace bootstrap
  'mcp.identify',
  'mcp.claimWorkspace',
  'workspace.list',
  'surface.list',
  // surface lifecycle (issue #285) — reserved wmux.internal, so these ALSO
  // appear in ALLOWED_RESERVED_FIRST_PARTY (firstParty.test.ts). Granted to the
  // bundled supervisor per the security review in
  // plans/issue-285-pane-lifecycle-mcp-tools.md §6 (same-user ceiling; already
  // reachable via the CLI tier + the still-open legacy grandfather).
  'surface.new',
  'surface.close',
  // panes + metadata
  'pane.list',
  'pane.search',
  'pane.getMetadata',
  'pane.setMetadata',
  'meta.setSkills',
  // pane lifecycle (issue #285) — pane.create / pane.read, NOT reserved.
  'pane.split',
  'pane.close',
  'pane.focus',
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
  // a2a channels — nine standard channel_* MCP tools
  'a2a.channel.list',
  'a2a.channel.get',
  'a2a.channel.getMessages',
  'a2a.channel.getMembers',
  'a2a.channel.create',
  'a2a.channel.archive',
  'a2a.channel.join',
  'a2a.channel.leave',
  'a2a.channel.post',
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
