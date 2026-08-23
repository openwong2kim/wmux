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
// amount of user approval can grant those — the source-qualified,
// name-recognised wire lane is the only path.
//
// The fix: first require positive local external-wire provenance from
// PipeServer, then recognise the bundled server by the host clientName it
// reports and allow exactly the method set it actually calls — nothing more.
// This is a scoped allowlist, NOT a blanket "first party can do anything"
// bypass: a method outside the set falls through to normal enforcement, and an
// explicit user `denied` still wins (see PermissionEnforcer.check).
//
// Threat model (matches the spec's "declared, not verified" stance, rpc.ts):
// once the source is qualified, recognition is by self-asserted clientName.
// THIS IS BEST-EFFORT ATTRIBUTION, NOT A SECURITY BOUNDARY AGAINST SAME-USER
// CODE. On a single-user OS it is no weaker than any local secret — a same-user
// process that wanted to impersonate the host already holds the daemon auth
// token and could call the pipe directly.
// What the scoped allowlist buys over a blanket bypass is that even an
// impersonator only reaches the curated method set, never daemon.*,
// workspace.new, company mutation, or other reserved surface. Cryptographic
// first-party identity (peer-PID, per-launch nonce) was evaluated and deferred
// to a remote/multi-user transport (issue #113). Full residual-risk writeup +
// the curated-allowlist invariant: docs/api/mcp-plugin-spec.md §2.4.

import type { RpcMethod } from '../../shared/rpc';
import { MAX_PLUGIN_NAME_LEN, NON_IDENTIFYING_CLIENT_NAMES } from '../../shared/rpc';

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
//   - `opencode`           OpenCode              (verified 2026-07-22; clientInfo
//                          name captured live from opencode 1.17.11 initialize —
//                          issue #536)
//
// New names MUST be captured empirically (the agent's actual clientInfo.name),
// not guessed, and the agent must be confirmed to use the wmux tools end-to-end
// before being added. See plans/a2a-pane-identity-mcp-registration-IMPL.md.
export const FIRST_PARTY_CLIENT_NAMES: ReadonlySet<string> = new Set<string>([
  'claude-code',
  'codex-mcp-client',
  'opencode',
]);

// Names that may NEVER be promoted to first-party through config (#636). The
// list and its rationale live in shared/rpc.ts so the CLI (`wmux mcp clients`,
// a separate build) can explain the same refusal. Re-exported here because
// this is the module that enforces it.
//
// The gate is applied in `setConfiguredFirstPartyClients` below, NOT in the
// config reader (firstPartyConfig.ts), so no caller — loader, test helper, or
// future Settings UI — can route around it.
export { NON_IDENTIFYING_CLIENT_NAMES };

// Operator-configured additions, applied once at boot from
// `mcp.firstPartyClients` (firstPartyConfig.ts). Empty until then, so a
// process that never wires this up behaves exactly as before.
let configuredFirstPartyClients: ReadonlySet<string> = new Set<string>();

export interface ConfiguredFirstPartyClientsResult {
  /** Names now recognised in addition to the compiled defaults. */
  accepted: string[];
  /** Names refused, with the reason, so boot can log something actionable. */
  rejected: { name: string; reason: 'non-identifying' }[];
}

/**
 * Install the operator-configured first-party client names. Replaces any
 * previous set (this is a boot-time apply, not an accumulate).
 *
 * This is the single authorisation gate for the config path: every name is
 * checked against `NON_IDENTIFYING_CLIENT_NAMES` here rather than in the
 * reader, so a future Settings UI or test helper cannot bypass the denylist by
 * calling a different loader.
 *
 * Returns what was accepted and what was refused so the caller can surface it.
 * Refusals are not errors — a bad entry must never block boot.
 */
export function setConfiguredFirstPartyClients(
  names: readonly string[],
): ConfiguredFirstPartyClientsResult {
  const accepted: string[] = [];
  const rejected: { name: string; reason: 'non-identifying' }[] = [];
  const next = new Set<string>();
  for (const raw of names) {
    // Clamp to the trust store's bound. PluginTrustStore truncates at
    // MAX_PLUGIN_NAME_LEN before persisting, so that is the longest name an
    // operator can ever SEE — and therefore the longest one they can copy out
    // of `wmux mcp clients` into config. Clamping both this and the lookup
    // below keeps "the name you were shown is the name that matches" true;
    // without it a client reporting a longer name is listed under a truncated
    // one that could never be configured to match. No new impersonation
    // surface: clientName is self-asserted anyway (spec §2.3), so a caller
    // that wanted to match could always just send the exact string.
    const name = typeof raw === 'string' ? clampClientName(raw.trim()) : '';
    if (name.length === 0) continue;
    if (NON_IDENTIFYING_CLIENT_NAMES.has(name.toLowerCase())) {
      rejected.push({ name, reason: 'non-identifying' });
      continue;
    }
    if (next.has(name)) continue;
    next.add(name);
    accepted.push(name);
  }
  configuredFirstPartyClients = next;
  return { accepted, rejected };
}

function clampClientName(name: string): string {
  return name.length <= MAX_PLUGIN_NAME_LEN
    ? name
    : name.slice(0, MAX_PLUGIN_NAME_LEN);
}

/** The operator-configured additions currently in effect (for diagnostics). */
export function getConfiguredFirstPartyClients(): ReadonlySet<string> {
  return configuredFirstPartyClients;
}

/** Test hook — drops all configured additions back to compiled-defaults-only. */
export function __resetConfiguredFirstPartyClientsForTests(): void {
  configuredFirstPartyClients = new Set<string>();
}

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
  // #977 — the bundled server must be able to undo a stash it is told to undo:
  // every PANE_STASHED refusal names pane.unstash as the remedy, and a remedy
  // the caller is not allowed to invoke is not a remedy.
  'pane.stash',
  'pane.unstash',
  // terminal IO
  'input.send',
  'input.sendKey',
  'input.readScreen',
  'terminal.readEvents',
  // command deck (P3b) — commander-brain pane routing. The method carries its
  // own auth (per-spawn token, commanderTrust.ts): listing it here only lets
  // the bundled server ATTEMPT the call; without a live token it fails closed.
  'deck.resolvePaneRoute',
  // commander-brain self-identity (token→home workspace) for A2A sender
  // resolution — same per-spawn-token auth, fails closed without a live token.
  'deck.resolveCommanderWorkspace',
  // commander-only final-response barrier for the currently active human work.
  'deck.completeWork',
  // commander-brain decision gate (deck_ask_decision tool). Same per-spawn-token
  // auth; a non-commander caller has no token and fails closed.
  'deck.requestDecision',
  // commander-brain self-resolve of a STALE decision (deck_resolve_decision tool,
  // WP3). Same per-spawn-token auth; the handler server-enforces auto-mode +
  // staleness + substance, so a non-commander or premature caller fails closed.
  'deck.resolveDecision',
  // events
  'events.poll',
  // browser (Playwright + packaged CDP/RPC fallbacks)
  'browser.tabs',
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
  'browser.lease.acquire',
  'browser.lease.renew',
  'browser.lease.release',
  // agent-to-agent
  'a2a.resolve.identity',
  'a2a.whoami',
  'a2a.discover',
  'a2a.task.send',
  'a2a.task.query',
  'a2a.task.update',
  'a2a.task.cancel',
  'a2a.broadcast',
  // a2a channels — standard channel_* MCP tools
  'a2a.channel.list',
  'a2a.channel.get',
  'a2a.channel.getMessages',
  'a2a.channel.getMembers',
  'a2a.channel.create',
  // NOTE: a2a.channel.archive is NOT here (nor is kick, nor operatorJoin /
  // operatorList). All are humans-only — routed via the renderer-only
  // channels:mutate-local IPC, never the MCP/pipe surface — so a first-party
  // agent is not granted them. operatorJoin/operatorList are deliberately
  // excluded here (operator-join design §2.3 / Codex #7): registering them in
  // RpcMethod + METHOD_CAPABILITY for completeness must NOT leak an agent-
  // reachable operator path. firstParty.test.ts (which parses src/mcp/ for the
  // methods the bundled server actually calls) never requires them, since the
  // bundled MCP server does not call operatorJoin/operatorList.
  'a2a.channel.join',
  'a2a.channel.leave',
  'a2a.channel.post',
  'a2a.channel.invite',
  // Channels v2 durable inbox — the consume signal (ack) + the cheap unread
  // poll. Both agent-reachable by design: ack is what stops the wake worker's
  // re-nudges, so denying it to agents would re-ping them forever.
  'a2a.channel.ack',
  'a2a.channel.unread',
  // WorkTask mission channels (J0) — the mutating tools the bundled server
  // exposes (channel_mission_start / channel_mission_close), plus the
  // owner-scoped read behind channel_mission_list.
  'task.mission.start',
  'task.mission.close',
  'task.mission.list',
  // Fan-out (J1) on the wire — the fanout_start tool. Every dangerous input is
  // server-derived in the handler and the spawn is approval-gated, so the grant
  // is to ATTEMPT the call; an unverifiable caller still fails closed.
  'task.fanout.start',
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
 *
 * Matches the compiled defaults plus any operator-configured additions
 * (`setConfiguredFirstPartyClients`). Exact match either way — `clientName` is
 * already trimmed by PipeServer when it builds RpcContext.
 */
export function isFirstPartyClient(clientName: string | undefined): boolean {
  if (typeof clientName !== 'string') return false;
  if (FIRST_PARTY_CLIENT_NAMES.has(clientName)) return true;
  if (configuredFirstPartyClients.size === 0) return false;
  // Clamped on both sides — see setConfiguredFirstPartyClients. The compiled
  // defaults above stay an exact match; they are all well under the bound.
  return configuredFirstPartyClients.has(clampClientName(clientName));
}
