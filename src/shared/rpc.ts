// === JSON-RPC Protocol Types ===

import type { ResumeBinding } from './agentResume';

export interface RpcRequest {
  id: string;
  method: RpcMethod;
  params: Record<string, unknown>;
  token?: string;
  /**
   * v2.10.0+ — declared plugin identity. Carries the MCP `clientInfo.name`
   * (and version) from the MCP server stdio handshake so handlers can attribute
   * each call to a plugin. Optional and additive — pre-v2.10 callers still
   * authenticate by token alone and are treated as `legacy` identities.
   *
   * Substrate stance: this is a declared identity, not a verified one. There is
   * no root-of-trust; any caller can self-name. Permission enforcement (planned
   * in a follow-up PR) treats unknown names as `legacy` and applies user-issued
   * trust state from `~/.wmux/plugin-trust.json` to known names. See
   * `docs/api/mcp-plugin-spec.md` for the threat model.
   */
  clientName?: string;
  clientVersion?: string;
  /**
   * BYOB P4 — commander-brain role claim. Set by the bundled MCP server when
   * it runs in `--commander` mode (per-spawn token minted by the brain
   * adapter, commanderTrust.ts). PRESENCE of this field is the role claim:
   * the router validates it BEFORE trust/permission processing and rejects
   * the whole request on an invalid/stale token — a claimed-but-invalid
   * commander is never demoted to an ordinary external caller (that
   * demotion would reopen exactly the surface the role gate exists to
   * close). A validated token puts `commanderWorkspace` on RpcContext.
   */
  commanderToken?: string;
  /**
   * #922 PR-A — workspace claim token. Minted by main in the
   * `mcp.claimWorkspace` response and bound there to the workspace that call
   * created for this caller (`workspaceClaimTrust.ts`); the MCP server holds
   * it for the life of its claim and stamps it on every later envelope.
   *
   * Unlike `clientName` this is not self-asserted — a caller cannot invent one
   * that resolves, because main issued it. Unlike `commanderToken` it grants
   * no role: it only says WHICH workspace the holder claimed.
   *
   * PR-A carries it and nothing more. NO handler reads it for an
   * authorisation decision yet, so a caller that omits or ignores it behaves
   * exactly as before. PR-B adds the lane that consults it, where a presented
   * token that does not resolve must REFUSE the request rather than demote the
   * caller (the same rule `commanderToken` documents above, and the reason
   * `lookupWorkspaceClaim` returns three states instead of a nullable).
   */
  workspaceToken?: string;
}

/**
 * Stable `clientName` reported by the bundled wmux CLI (`wmux <command>`,
 * src/cli) so the permission enforcer can grant it a curated allowlist
 * (src/main/mcp/internalCli.ts) instead of the envelope-less legacy grandfather.
 * Defined in shared so the CLI (its own build) and the main-process enforcer
 * agree on the exact string without a cross-build import. See the trust-root
 * grandfather-deprecation plan (Stage 2).
 */
export const WMUX_CLI_CLIENT_NAME = 'wmux-cli';

/**
 * `clientName` values that must NEVER be promoted to first-party recognition
 * through `mcp.firstPartyClients` in `~/.wmux/config.json` (issue #636).
 * Compared case-insensitively. Enforced by `setConfiguredFirstPartyClients`
 * (src/main/mcp/firstParty.ts); surfaced by `wmux mcp clients` so an operator
 * sees *why* a name they observed is not configurable.
 *
 * Defined in shared for the same reason as WMUX_CLI_CLIENT_NAME above: the CLI
 * and the main-process enforcer are separate builds and must agree on the exact
 * strings without a cross-build import.
 *
 * Two classes qualify, and an operator hits both in good faith:
 *   - SDK defaults. `mcp` is the Python MCP SDK's `DEFAULT_CLIENT_INFO`
 *     (`mcp/client/session.py`, verified against mcp 1.26.0 on 2026-07-27):
 *     every client that never sets `clientInfo` reports it, so allowlisting it
 *     would recognise all of them at once. (The TypeScript SDK requires
 *     `clientInfo` in the `Client` constructor — no analogous default.)
 *   - wmux's own internal tiers. `wmux-cli` has a deliberately NARROWER
 *     allowlist than first-party and is checked after it, so configuring it
 *     would silently widen the CLI. `unknown` is wmux's placeholder for
 *     envelope-less callers and appears verbatim in real trust DBs.
 */
export const NON_IDENTIFYING_CLIENT_NAMES: ReadonlySet<string> = new Set<string>([
  'mcp',
  'unknown',
  'client',
  'default',
  WMUX_CLI_CLIENT_NAME,
]);

/**
 * Maximum stored length of a plugin `clientName`. `PluginTrustStore` truncates
 * to this before persisting, so it is also the longest name an operator can
 * ever SEE (via `wmux mcp clients` or plugin-trust.json) and therefore the
 * longest one they can copy into `mcp.firstPartyClients`. First-party
 * recognition clamps to the same bound so the name that is displayed is the
 * name that matches — otherwise a longer-than-this client would be listed under
 * a truncated name that could never be configured to match it.
 *
 * Lives here rather than in PluginTrustStore so the recognition path can share
 * the bound without importing the store's filesystem machinery.
 */
export const MAX_PLUGIN_NAME_LEN = 256 as const;

/**
 * Render an untrusted, self-asserted client identity (name or version) for
 * display. Strips C0/DEL control characters and clips to `maxLen`.
 *
 * These strings are chosen by the connecting client (§2.3) and are surfaced in
 * daemon logs, RPC error messages, and `wmux mcp clients` — all of which land
 * in a terminal. A name carrying escape sequences must not be able to move the
 * cursor, recolour the screen, or forge output around itself. Anything that
 * prints a client-supplied identity MUST go through this.
 *
 * Filtered by code point rather than by regex: the equivalent character class
 * is exactly what the `no-control-regex` lint rule forbids.
 */
export function sanitizeClientDisplayName(value: string, maxLen = 64): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
    if (out.length >= maxLen) break;
  }
  return out;
}

/**
 * Per-request context surfaced to RPC handlers — populated by RpcRouter from
 * RpcRequest identity fields plus non-envelope dispatch provenance. Handlers
 * receive this as an optional second argument so legacy handlers `(params) =>
 * ...` keep compiling.
 */
export interface RpcContext {
  /**
   * Trust boundary the request entered through. REQUIRED (no `?`) so any new
   * transport that constructs a context MUST classify it — a forgotten origin
   * is a tsc error, never a silent default. `'remote'` = off-machine (LAN),
   * gated out of every local-only capability (e.g. the a2a execute spawn).
   * Today the only constructor is RpcRouter (named pipe + loopback TCP) →
   * always `'local'`; the LanLink LAN listener (future PR) sets `'remote'`.
   */
  origin: 'local' | 'remote';
  /**
   * Aborts when the client that made this request is no longer there to read
   * the answer (socket closed or errored).
   *
   * Only matters to a handler that WAITS — a normal handler finishes long
   * before anyone hangs up, and writing to a dead socket is already guarded.
   * A waiting handler is different: it holds a connection out of the server's
   * finite budget for its whole wait, so without this a client that times out,
   * is cancelled, or crashes keeps its slot until the handler's own deadline.
   * Enough of those and the server stops accepting, which every other caller
   * sees as "wmux is not running".
   *
   * Optional because the in-process surfaces (renderer bridge, plugin host)
   * have no socket to lose. Absent means "nothing can cancel this".
   */
  signal?: AbortSignal;
  /**
   * True only for the trusted in-process renderer bridge: the human operator
   * surface that may intentionally act across local workspaces. Set by
   * `RpcRouter.dispatch(request, { operator: true })`, never from request JSON.
   *
   * The iframe plugin host is also in-process but is NOT the operator, so it
   * uses the separate `firstParty` dispatch option without this marker. An
   * operator context also carries `firstParty: true` for existing handlers
   * that only need to distinguish trusted in-process dispatch from the wire.
   */
  operator?: true;
  /**
   * True when the request entered through a TRUSTED in-process first-party
   * surface (renderer operator or plugin host), NOT the external local wire
   * (named pipe + loopback TCP). The router derives it from either the explicit
   * `operator` lane or `RpcRouter.dispatch(request, { firstParty: true })`.
   * PipeServer supplies neither, so a wire client can never obtain it (these
   * flags are function arguments, not forgeable request fields). Mutually
   * exclusive with `externalWire`. This qualifies an in-process dispatch
   * source; handlers that specifically need human-operator authority must use
   * `operator`, not this broader marker.
   */
  firstParty?: boolean;
  /**
   * Positive provenance for a request received on wmux's external local wire
   * (named pipe or loopback TCP). Set ONLY by PipeServer through the
   * non-envelope `RpcRouter.dispatch` options, after token authentication and
   * rate limiting. Raw request fields never populate it, and callers must not
   * infer it from `origin === 'local'` or from an absent `firstParty` marker.
   *
   * This qualifies the dispatch source; it is not cryptographic identity
   * against arbitrary same-user processes that already hold the pipe token.
   * Mutually exclusive with `firstParty`.
   */
  externalWire?: true;
  clientName?: string;
  clientVersion?: string;
  /**
   * BYOB P4 — the workspace a VALIDATED commander token is bound to. Set by
   * RpcRouter only after commanderTrust validation succeeds; its presence is
   * the enforcer's signal for the commander allow lane and the handlers'
   * signal for workspace-ownership confinement. Never set from a raw
   * envelope field — validation is the only writer.
   */
  commanderWorkspace?: string;
  /**
   * #922 — the workspace the PLUGIN HOST derived for this caller, not one the
   * caller named. Set by RpcRouter only from the `hostedWorkspace` dispatch
   * option, and only on the in-process `firstParty` lane; a request envelope
   * can never populate it and the external wire never carries it.
   *
   * The iframe plugin surface is the one caller class where neither half of the
   * identity is caller-supplied: `clientName` is stamped from the loaded
   * manifest, and this is the workspace the host is showing. Handlers may
   * therefore treat it as the caller's own workspace — which `browser.rpc.ts`
   * does in its `hosted` lane — where `declared` can only check that some
   * workspaceId is present.
   *
   * Three states, and the difference between the last two is load-bearing:
   *   `string`     the host is showing this workspace; bind the call to it.
   *   `null`       the plugin host dispatched this and had NO workspace to
   *                bind it to. Still a hosted caller — a handler that scopes
   *                on this must refuse, never fall through to a lane that lets
   *                the caller name its own workspace.
   *   `undefined`  not a plugin-host dispatch at all.
   */
  hostedWorkspace?: string | null;
  /**
   * #922 PR-B — the workspace this caller CLAIMED, as resolved server-side from
   * the `workspaceToken` envelope field. Written only by `RpcRouter` from the
   * claim registry (`workspaceClaimTrust.ts`); a request envelope can supply
   * the token but never this field, and a caller cannot invent a token that
   * resolves because main issued it.
   *
   * Three states, mirroring the registry, and the difference between the last
   * two is load-bearing:
   *   `undefined`  no token was presented. The caller never claimed; every
   *                lane behaves for it exactly as before.
   *   `{ bound }`  a live claim. This IS the caller's workspace.
   *   `{ stale }`  a token was presented and did not resolve — revoked, or its
   *                workspace closed. A handler that scopes on this must REFUSE.
   *                Falling through to a lane that accepts a caller-named
   *                workspace would demote a caller whose claim just died into
   *                one free to name any workspace, which is strictly weaker
   *                than never having claimed.
   *
   * Deliberately NOT flattened to `string | undefined`: that collapses `stale`
   * into `unclaimed` and makes the demotion the easy thing to write.
   */
  workspaceClaim?: { kind: 'bound'; workspaceId: string } | { kind: 'stale' };
}

/**
 * #922 — is this context a plugin-host dispatch? Keyed on the PRESENCE of
 * `hostedWorkspace` (its `null` state still means "hosted, unbound"), exactly
 * like the browser `hosted` lane. `firstParty` alone cannot answer this: the
 * renderer bridge and the plugin host both dispatch first-party, but only the
 * former is the operator. Handlers that widen scope for "the operator" must
 * use `firstParty && !isHostedCaller(ctx)`, never bare `firstParty`.
 */
export function isHostedCaller(ctx?: RpcContext): boolean {
  return ctx !== undefined && ctx.hostedWorkspace !== undefined;
}

/**
 * #922 — the hosted caller's server-derived workspace binding, or undefined
 * when the host had no workspace to bind (`null`) or the context is not a
 * hosted dispatch at all. Callers scoping on this must fail closed on
 * undefined for a hosted context — never fall through to a caller-named
 * workspace (see `RpcContext.hostedWorkspace`).
 */
export function hostedBindingOf(ctx?: RpcContext): string | undefined {
  return typeof ctx?.hostedWorkspace === 'string' && ctx.hostedWorkspace.length > 0
    ? ctx.hostedWorkspace
    : undefined;
}

export type RpcResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string; rejection?: RpcRejection };

// Structured rejection surfaced by the Phase 2.2 permission enforcer.
//
// Defined here as a standalone exported type so the enforcer module (pure,
// non-wire-format) can share a vocabulary with the eventual RpcResponse
// extension that carries it. Pre-commit 2 wires this into RpcResponse;
// callers that switch on `r.ok` keep narrowing as before, and ones that
// want machine-readable rejection detail branch on `rejection.reason`.
//
// `pendingApproval.promptId` is minted by ApprovalQueue (Pre-commit 5) so
// the client can correlate a rejection with the user-facing prompt and
// retry once the prompt resolves — see plan D4 for the OAuth
// `authorization_pending` precedent.
export type RpcRejection =
  | {
      reason: 'capability-not-declared';
      method: RpcMethod;
      capability: string;
    }
  | {
      reason: 'path-not-allowed';
      method: RpcMethod;
      capability: string;
      path: string;
      declared: string[];
    }
  | {
      reason: 'paths-partially-allowed';
      method: RpcMethod;
      capability: string;
      allowed: string[];
      rejected: { path: string; declared: string[] }[];
    }
  | {
      reason: 'identity-status';
      method: RpcMethod;
      capability: string;
      status: 'denied' | 'unconfirmed';
      pendingApproval?: { promptId: string };
    };

// === RPC Method definitions ===
export type RpcMethod =
  | 'workspace.list'
  | 'workspace.new'
  | 'workspace.focus'
  | 'workspace.close'
  | 'workspace.current'
  | 'surface.list'
  | 'surface.new'
  | 'surface.focus'
  | 'surface.close'
  | 'pane.list'
  | 'pane.focus'
  | 'pane.split'
  | 'pane.close'
  // #977 — take a pane out of the layout / put it back. Both are needed:
  // refusing a position operation with "call pane.unstash" and then not
  // shipping pane.unstash is a contract that contradicts itself.
  | 'pane.stash'
  | 'pane.unstash'
  | 'pane.setMetadata'
  | 'pane.getMetadata'
  | 'pane.clearMetadata'
  | 'pane.search'
  | 'events.poll'
  | 'input.send'
  | 'input.sendKey'
  | 'input.readScreen'
  | 'terminal.readEvents'
  | 'mcp.claimWorkspace'
  | 'mcp.identify'
  | 'mcp.declarePermissions'
  | 'notify'
  | 'meta.setStatus'
  | 'meta.setProgress'
  | 'ui.decoratePane'
  | 'system.identify'
  | 'system.capabilities'
  // Performance diagnostics (P0-5c) — aggregate reveal-mechanism counters
  // for `wmux doctor --performance`. Read-only, no terminal content.
  | 'perf.status'
  | 'deck.resolvePaneRoute'
  | 'deck.resolveCommanderWorkspace'
  | 'deck.completeWork'
  | 'deck.requestDecision'
  | 'deck.resolveDecision'
  | 'browser.tabs'
  | 'browser.open'
  | 'browser.navigate'
  | 'browser.goBack'
  | 'browser.close'
  | 'browser.session.start'
  | 'browser.session.stop'
  | 'browser.session.status'
  | 'browser.session.list'
  | 'browser.type.humanlike'
  | 'browser.cdp.target'
  | 'browser.cdp.info'
  | 'browser.screenshot'
  | 'browser.evaluate'
  | 'browser.console.get'
  | 'browser.lifecycle.get'
  | 'browser.network.get'
  | 'browser.responseBody.get'
  | 'browser.type.cdp'
  | 'browser.click.cdp'
  | 'browser.hover.cdp'
  | 'browser.drag.cdp'
  | 'browser.press.cdp'
  | 'browser.cookies'
  | 'browser.resize'
  | 'browser.emulate'
  | 'browser.actionCache.list'
  | 'browser.actionCache.get'
  | 'browser.actionCache.put'
  | 'browser.actionCache.stats'
  | 'browser.actionCache.forget'
  | 'browser.actionCache.promote'
  | 'browser.actionCache.demote'
  | 'browser.actionCache.promoted'
  | 'browser.lease.acquire'
  | 'browser.lease.renew'
  | 'browser.lease.release'
  | 'daemon.createSession'
  | 'daemon.destroySession'
  | 'daemon.attachSession'
  | 'daemon.detachSession'
  | 'daemon.resizeSession'
  | 'daemon.listSessions'
  | 'daemon.readPromptEvents'
  | 'daemon.ping'
  | 'daemon.shutdown'
  | 'daemon.compact'
  | 'daemon.superviseRearm'
  | 'daemon.superviseStop'
  | 'daemon.setResumeBinding'
  | 'daemon.inbox.poll'
  | 'lanlink.status'
  | 'lanlink.configure'
  | 'lanlink.pair.begin'
  | 'lanlink.pair.status'
  | 'lanlink.pair.cancel'
  | 'lanlink.pair.join'
  | 'lanlink.send'
  | 'lanlink.peers.list'
  | 'lanlink.peers.remove'
  | 'a2a.resolve.identity'
  | 'a2a.whoami'
  | 'a2a.discover'
  | 'a2a.task.send'
  | 'a2a.task.query'
  | 'a2a.task.update'
  | 'a2a.task.cancel'
  | 'a2a.broadcast'
  | 'meta.setSkills'
  | 'company.create'
  | 'company.destroy'
  | 'company.status'
  | 'company.addDept'
  | 'company.removeDept'
  | 'company.addMember'
  | 'company.removeMember'
  | 'company.broadcast'
  | 'company.sendDept'
  | 'company.sendMember'
  | 'company.message'
  | 'company.save'
  | 'company.restore'
  | 'company.templates'
  | 'company.worktreeSetup'
  | 'company.mergeDept'
  | 'company.a2a.whoami'
  | 'company.a2a.send'
  | 'company.a2a.broadcast'
  | 'company.a2a.inbox'
  | 'company.a2a.ack'
  | 'company.a2a.status'
  | 'company.provision'
  | 'company.provisionAll'
  | 'company.provisionCeo'
  | 'hooks.signal'
  | 'a2a.channel.list'
  | 'a2a.channel.get'
  | 'a2a.channel.getMessages'
  | 'a2a.channel.getMembers'
  | 'a2a.channel.create'
  | 'a2a.channel.archive'
  | 'a2a.channel.join'
  | 'a2a.channel.leave'
  | 'a2a.channel.post'
  | 'a2a.channel.invite'
  | 'a2a.channel.kick'
  | 'a2a.channel.ack'
  | 'a2a.channel.nudgeRecorded'
  | 'a2a.channel.unread'
  | 'a2a.channel.purgeMembership'
  // operator-join (설계 §2.1/§2.2) — 사람이 에이전트가 만든 비공개 채널에 스스로
  // 들어가는 신뢰 경로 + 그 발견 목록. archive/kick/purge와 동일한 humans-only
  // 등급: 파이프 라우터(a2a.channel.rpc.ts)에 등록되지 않고 렌더러 전용
  // channels:mutate-local IPC로만 도달한다. 이 union 등재는 RpcMethod 완전성
  // (METHOD_CAPABILITY 매핑) 목적이며, first-party 그랜트(FIRST_PARTY_METHODS)에는
  // 의도적으로 제외된다(설계 §2.3 / Codex #7).
  | 'a2a.channel.operatorJoin'
  | 'a2a.channel.operatorList'
  // Channel trash lifecycle — soft delete, undo, and permanent deletion.
  // Same humans-only grade as archive/kick/operator*: registered on the
  // renderer-only channels:mutate-local IPC and deliberately absent from the
  // pipe router, so no agent/MCP caller can hide or destroy a channel.
  | 'a2a.channel.trash'
  | 'a2a.channel.restore'
  | 'a2a.channel.destroy'
  | 'a2a.principal.upsert'
  | 'a2a.principal.remove'
  | 'a2a.principal.markStaleWorkspace'
  // WorkTask mission channels (J0 — §4). Mission start/close bind a worktree
  // mission (WorkTask) to a private channel; list enumerates the caller's
  // missions. Identity rides the same senderPtyId→verifiedWorkspaceId stamp as
  // a2a.channel.* mutations (fail-closed on unresolvable identity).
  | 'task.mission.start'
  | 'task.mission.close'
  | 'task.mission.list'
  // J1 §5 — 물질화 필드(branch/worktreePath/paneGroupId) 단조 커밋. FanOutService
  // 내부 경로가 호출한다(owner OR CEO authz는 데몬 WorkTaskService에서 강제).
  | 'task.mission.update'
  // Fan-out on the pipe surface (pipe/handlers/fanout.rpc.ts). One prompt → N
  // isolated worktree tasks. Unlike the renderer-only `fanout:start` IPC, the
  // caller supplies NO repoPath, NO agentCmd and NO memberId: the repo is the
  // git toplevel of the caller's own workspace cwd and the agent command is
  // fixed. Identity rides the same senderPtyId→verifiedWorkspaceId stamp as
  // `task.mission.*`, the spawn is approval-gated, and the call is
  // accept-then-poll (re-send the key to read the state).
  | 'task.fanout.start'
  // Task ledger (pipe/handlers/ledger.rpc.ts) — the status log behind
  // src/shared/ledger.ts. Reads are scoped to the caller's own rows (owner or
  // task workspace); updates are authorized by the ledger's canActorSet.
  | 'ledger.list'
  | 'ledger.update';

// All available methods as array (for system.capabilities)
export const ALL_RPC_METHODS = [
  'workspace.list',
  'workspace.new',
  'workspace.focus',
  'workspace.close',
  'workspace.current',
  'surface.list',
  'surface.new',
  'surface.focus',
  'surface.close',
  'pane.list',
  'pane.focus',
  'pane.split',
  'pane.close',
  'pane.stash',
  'pane.unstash',
  'pane.setMetadata',
  'pane.getMetadata',
  'pane.clearMetadata',
  'pane.search',
  'events.poll',
  'input.send',
  'input.sendKey',
  'input.readScreen',
  'terminal.readEvents',
  'mcp.claimWorkspace',
  'mcp.identify',
  'mcp.declarePermissions',
  'notify',
  'meta.setStatus',
  'meta.setProgress',
  'ui.decoratePane',
  'system.identify',
  'system.capabilities',
  'perf.status',
  'deck.resolvePaneRoute',
  'deck.resolveCommanderWorkspace',
  'deck.completeWork',
  'deck.requestDecision',
  'deck.resolveDecision',
  'browser.tabs',
  'browser.open',
  'browser.navigate',
  'browser.goBack',
  'browser.close',
  'browser.session.start',
  'browser.session.stop',
  'browser.session.status',
  'browser.session.list',
  'browser.type.humanlike',
  'browser.cdp.target',
  'browser.cdp.info',
  'browser.screenshot',
  'browser.evaluate',
  'browser.console.get',
  'browser.lifecycle.get',
  'browser.network.get',
  'browser.responseBody.get',
  'browser.type.cdp',
  'browser.click.cdp',
  'browser.hover.cdp',
  'browser.drag.cdp',
  'browser.press.cdp',
  'browser.cookies',
  'browser.resize',
  'browser.emulate',
  'browser.actionCache.list',
  'browser.actionCache.get',
  'browser.actionCache.put',
  'browser.actionCache.stats',
  'browser.actionCache.forget',
  'browser.actionCache.promote',
  'browser.actionCache.demote',
  'browser.actionCache.promoted',
  'browser.lease.acquire',
  'browser.lease.renew',
  'browser.lease.release',
  'daemon.createSession',
  'daemon.destroySession',
  'daemon.attachSession',
  'daemon.detachSession',
  'daemon.resizeSession',
  'daemon.listSessions',
  'daemon.readPromptEvents',
  'daemon.ping',
  'daemon.shutdown',
  'daemon.compact',
  'daemon.superviseRearm',
  'daemon.superviseStop',
  'daemon.setResumeBinding',
  'daemon.inbox.poll',
  'lanlink.status',
  'lanlink.configure',
  'lanlink.pair.begin',
  'lanlink.pair.status',
  'lanlink.pair.cancel',
  'lanlink.pair.join',
  'lanlink.send',
  'lanlink.peers.list',
  'lanlink.peers.remove',
  'a2a.resolve.identity',
  'a2a.whoami',
  'a2a.discover',
  'a2a.task.send',
  'a2a.task.query',
  'a2a.task.update',
  'a2a.task.cancel',
  'a2a.broadcast',
  'meta.setSkills',
  'company.create',
  'company.destroy',
  'company.status',
  'company.addDept',
  'company.removeDept',
  'company.addMember',
  'company.removeMember',
  'company.broadcast',
  'company.sendDept',
  'company.sendMember',
  'company.message',
  'company.save',
  'company.restore',
  'company.templates',
  'company.worktreeSetup',
  'company.mergeDept',
  'company.a2a.whoami',
  'company.a2a.send',
  'company.a2a.broadcast',
  'company.a2a.inbox',
  'company.a2a.ack',
  'company.a2a.status',
  'company.provision',
  'company.provisionAll',
  'company.provisionCeo',
  'hooks.signal',
  'a2a.channel.list',
  'a2a.channel.get',
  'a2a.channel.getMessages',
  'a2a.channel.getMembers',
  'a2a.channel.create',
  'a2a.channel.archive',
  'a2a.channel.join',
  'a2a.channel.leave',
  'a2a.channel.post',
  'a2a.channel.invite',
  'a2a.channel.kick',
  'a2a.channel.ack',
  'a2a.channel.nudgeRecorded',
  'a2a.channel.unread',
  'a2a.channel.purgeMembership',
  // operator-join (설계 §2.1/§2.2) — humans-only, 파이프 미등록. RpcMethod 완전성.
  'a2a.channel.operatorJoin',
  'a2a.channel.operatorList',
  // Channel trash lifecycle — humans-only, pipe-unregistered. RpcMethod completeness.
  'a2a.channel.trash',
  'a2a.channel.restore',
  'a2a.channel.destroy',
  'a2a.principal.upsert',
  'a2a.principal.remove',
  'a2a.principal.markStaleWorkspace',
  'task.mission.start',
  'task.mission.close',
  'task.mission.list',
  'task.mission.update',
  'task.fanout.start',
  'ledger.list',
  'ledger.update',
] as const satisfies readonly RpcMethod[];

// === RPC Parameter Types ===

export interface BrowserSessionStartParams {
  profile?: string;
}

export interface BrowserTypeHumanlikeParams {
  text: string;
  selector?: string;
}

// === Daemon RPC Types ===

export interface DaemonEvent {
  type:
    | 'session.created'
    | 'session.destroyed'
    | 'session.died'
    // X8 pane supervision. 'session.restarted' fires after the supervisor
    // re-created the SAME session id with a fresh PTY — main must forward it
    // to the renderer so the existing PTY_RECONNECT machinery re-attaches
    // (a restart is NOT covered by the daemon:connected reattach trigger).
    //   session.restarted   → { restartCount, exitCode, consecutiveFailures }
    // 'supervision.changed' fires on any sticky-status flip (runaway-guard
    // trip → 'stopped', manual rearm/stop). Toast only on guard trips.
    //   supervision.changed → { status: 'armed'|'stopped',
    //                           reason: 'guard-trip'|'rearm'|'manual-stop',
    //                           restartCount, consecutiveFailures }
    | 'session.restarted'
    | 'supervision.changed'
    | 'session.output'
    | 'agent.event'
    | 'agent.critical'
    | 'activity.idle'
    | 'activity.active'
    | 'prompt.event'
    | 'notification.event'
    | 'cwd.changed'
    | 'title.changed'
    // X1 workspace-context sidebar (schema-freeze §2). Per-session live
    // context detected where the PTY lives:
    //   context.git   → { branch: string | null, isWorktree: boolean }
    //   context.ports → { ports: Array<{ port: number, pid: number }> }
    | 'context.git'
    | 'context.ports'
    // LanLink PR-2 inbound durable inbox. FIRE-AND-FORGET NUDGE ONLY — the
    // broadcast says "a remote message landed, re-pull"; it is NOT a delivery
    // guarantee. Durability + exactly-once come from the disk inbox +
    // daemon.inbox.poll cursor-pull (a message that arrives while main is dead
    // survives on disk and replays on reconnect). `data` is
    // LanLinkRemoteReceivedData ({ seq }); `sessionId` is the
    // LANLINK_SENTINEL_SESSION_ID — no PTY session backs a remote message.
    //   lanlink.remote.received → { seq: number }
    | 'lanlink.remote.received'
    // A2A channels (a2a-channels U4) — daemon broadcasts every successful
    // post as `channel.message`. `sessionId` is not meaningful here (no
    // session owns the event) so the field is set to '' (the rest of the
    // dispatch path tolerates it; the consumer in DaemonNotificationRouter
    // reads only `data`). `data` carries the full ChannelMessageEvent
    // envelope (channelId, seq, sender, recipients, message,
    // workspaceId). Main tees this onto the in-process EventBus as a
    // WmuxEvent `channel.message`, which `events.poll` then scopes per-
    // recipient (see events.rpc.ts). Naming matches the WmuxEvent
    // counterpart 1:1; do not invent a new shape here.
    | 'channel.message'
    // A2A channels (a2a-channels A1) — daemon broadcasts catalog/membership
    // lifecycle (create/archive/join/leave/kick/invite). `sessionId` is '' and
    // `data` carries the ChannelCatalogEvent; main tees it onto the in-process
    // EventBus as a WmuxEvent `channel.catalog`, scoped per-recipient by
    // `events.poll` exactly like channel.message.
    | 'channel.catalog'
    // Channels v2 wake worker — a (channel, member) mention episode ran out
    // of nudge budget; the worker stops and HUMANS must look. `sessionId` is
    // '' and `data` carries the flat payload (channelId, channelName,
    // workspaceId = affected member ws, memberId, unread, mentionUnread).
    // Main surfaces it directly (toast + OS notification) AND tees it onto
    // the EventBus as WmuxEvent `channel.nudgeExhausted` for orchestrators.
    | 'channel.nudgeExhausted'
    // Transcript projection (from #655's daemon half) — a subscribed pane's
    // transcript grew. UNICAST, not broadcast: `data` is TranscriptAppendData
    // and carries the pane's conversation content, so the daemon writes it only
    // to the sockets that called `daemon.transcript.subscribe` (see
    // DaemonPipeServer.sendTo). `data.reset` means the file rotated or a new
    // session started and the consumer must REPLACE its rows, not append them.
    | 'transcript.appended';
  sessionId: string;
  data: unknown;
}

// NOTE: 'session.destroyed' is broadcast when the renderer/MCP explicitly
// closes a session (pty:dispose → DaemonSessionManager.destroySession),
// while 'session.died' is broadcast when the underlying PTY exits on its
// own. Both must clear agentStatus on the main side; only one is reliably
// observed depending on the caller path.

export interface DaemonCreateSessionParams {
  id: string;
  /** Absent means the home directory. */
  cwd?: string;
  /**
   * Absent means the daemon's configured default shell. Omit it to get the
   * default; do not send `''`, which only works by accident.
   */
  cmd?: string;
  /**
   * The fully-resolved child environment. Main builds this (resolveSpawnEnv:
   * buildSafeChildEnv + workspace-profile overlay + forced WMUX identity) and
   * the daemon replays it verbatim — NOT re-filtered daemon-side, so any key
   * main placed here is applied as-is and recovery reproduces the create-time
   * env. Trusted-env contract: the caller is responsible for filtering. The
   * daemon's one unconditional guard is that it strips its own WMUX_AUTH*
   * namespace from any supplied env, so its RPC token can never reach a child.
   */
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  agent?: { role: string; teamId: string; displayName: string };
  /**
   * X8 exec-style unit: run `command` as the pane's ROOT process via a
   * non-interactive wrapper shell (systemd ExecStart semantics) instead of
   * typing it into an interactive shell. Process = unit: session.died then
   * carries the command's own exit code, and a recovery replay re-launches
   * the command itself. The wrapper binary is the daemon's choice; the
   * trust-approved bytes are exactly `command`.
   */
  exec?: { command: string };
  /** X8: arm the daemon-side PaneSupervisor for this session. */
  supervision?: DaemonSupervisionPolicy;
}

/**
 * X8 pane-supervision restart policy ('never' never reaches the daemon —
 * an unsupervised pane simply carries no policy). Persisted on the session
 * meta; restart counters stay volatile in the supervisor.
 */
export interface DaemonSupervisionPolicy {
  restart: 'on-failure' | 'always';
  limit: { burst: number; healthyUptimeSec: number };
  /**
   * Unattended reboot-survival: when true, a supervised replay (recovery /
   * restart) re-applies the pane's CAPTURED permission mode (from its
   * resumeBinding) so an unattended agent resumes without stalling at a prompt.
   * This is the EFFECTIVE, consent-gated decision — main computes it at creation
   * as `leaf.restorePermissionMode && the project's explicit unattended consent`
   * (see ProjectTrustRecord.unattended) and persists it. The daemon honors this
   * bit verbatim at replay and reads no trust file (Minimal design 2026-07-01:
   * trust is re-checked at CREATION, consistent with X6/X8 replay). Absent/false
   * → the D6 fail-safe (no bypass flag added). Only meaningful with `restart`.
   */
  restorePermissionMode?: boolean;
}

/**
 * X8: volatile per-session supervision state, exposed for surfaces
 * (sidebar badge, `wmux list --json`, supervision.changed event data).
 * Lives in the daemon's PaneSupervisor; resets on daemon restart except
 * `status`, which is persisted on the session meta.
 */
export interface SupervisionRuntime {
  status: 'armed' | 'stopped';
  /** Restarts performed this daemon lifetime. */
  restartCount: number;
  /** Consecutive short-lived runs (died before healthyUptimeSec) — the runaway-guard counter. */
  consecutiveFailures: number;
  lastExit?: { exitCode: number | null; signal?: number; at: string };
  /** Epoch ms of the pending backoff restart, when one is scheduled. */
  nextRestartAt?: number;
}

export interface DaemonSessionIdParams {
  id: string;
}

/**
 * X6 ③: persist a resume binding on a session (daemon-side, saveImmediate).
 * `id` is the daemon session id (== ptyId); `resumeBinding.sessionId` is the
 * claude conversation id captured from the hook (transcript basename).
 */
export interface DaemonSetResumeBindingParams {
  id: string;
  resumeBinding: ResumeBinding;
}

export interface DaemonResizeParams {
  id: string;
  cols: number;
  rows: number;
}

// === Pane Metadata RPC types (M0-f) ===
//
// Wire-format spec for the metadata RPC surface. Lifted out of the handler
// internals so external clients can build against a documented, stable
// shape. All additions are backwards-compatible with v2.8.x clients:
//   - PaneSetMetadataParams.mergeMode / .expectedVersion are optional
//   - .merge:boolean still works and maps to mergeMode merge|replace
//   - PaneSetMetadataResult.version is an ADDITIVE field; v2.8.x readers
//     that destructure { ok, paneId, metadata } continue to compile
//   - PaneGetMetadataResult.version is additive (same rationale)
//   - PaneMetadataCapabilities surfaces in system.capabilities as an
//     object; v2.8.x boolean checks (`if (caps.features.paneMetadata)`)
//     still pass because the object is truthy

import type { PaneMetadata } from './types';

/**
 * Merge semantics for pane.setMetadata writes — see PROTOCOL.md §1.3
 * (race spec #2 — optimistic concurrency).
 *
 *   - 'merge':         patch-style; deep-merges custom one level (default)
 *   - 'replace':       full overwrite — only patch fields survive
 *   - 'replaceShared': overwrites top-level shared fields (label/role/status)
 *                      but preserves base.custom verbatim
 */
export type MetadataMergeMode = 'merge' | 'replace' | 'replaceShared';

export interface PaneSetMetadataParams {
  /** Omit to target active leaf in caller's workspace (resolved via pane.resolveActiveLeaf). */
  paneId?: string;
  /** External MCP callers should pass this so writes stay scoped to their workspace. */
  workspaceId?: string;
  label?: string;
  role?: string;
  status?: string;
  custom?: Record<string, string>;
  /**
   * Legacy boolean — kept for v2.8.x client compatibility.
   * true → merge, false → replace. Equivalent to `mergeMode: 'merge'` / `'replace'`.
   * When both `merge` and `mergeMode` are present, `mergeMode` wins.
   */
  merge?: boolean;
  /** v2.9.0+ — explicit merge semantics. Overrides legacy `merge` when present. */
  mergeMode?: MetadataMergeMode;
  /**
   * v2.9.0+ — optimistic concurrency guard. If the pane's current version
   * differs, the server returns VERSION_CONFLICT and does not mutate.
   * Omit for unconditional writes (legacy v2.8.x behavior).
   */
  expectedVersion?: number;
}

export interface PaneSetMetadataResult {
  ok: true;
  paneId: string;
  metadata: PaneMetadata;
  /** v2.9.0+ — post-commit monotonic version. */
  version: number;
}

export interface PaneGetMetadataParams {
  paneId?: string;
  workspaceId?: string;
}

export interface PaneGetMetadataResult {
  paneId: string;
  metadata: PaneMetadata;
  /** v2.9.0+ — current monotonic version for this pane. */
  version: number;
}

export interface PaneClearMetadataParams {
  paneId?: string;
  workspaceId?: string;
}

export interface PaneClearMetadataResult {
  ok: true;
  paneId: string;
  /** v2.9.0+ — version after the clear (bumped monotonically). */
  version: number;
}

/**
 * Surface form of features.paneMetadata in system.capabilities (M0-f).
 * Truthy in boolean context — v2.8.x clients that wrote
 * `if (caps.features.paneMetadata)` continue to work because a non-null
 * object is truthy. v2.9.0+ clients can inspect `optimisticConcurrency`
 * and `mergeModes` to feature-detect the M0 surface.
 */
export interface PaneMetadataCapabilities {
  optimisticConcurrency: true;
  mergeModes: readonly MetadataMergeMode[];
}

/**
 * JSON-RPC error code returned when `pane.setMetadata.expectedVersion`
 * does not match the pane's current version. Exported for clients that
 * want to type-narrow on the error code; the current RpcRouter envelope
 * only surfaces an error message string (with `currentVersion=N` embedded
 * for retry), so this code is informational until the envelope grows
 * structured error data.
 */
export const RPC_VERSION_CONFLICT = -32001 as const;

// === MCP Plugin Identity RPC types (Phase 2.1, v2.10+) ===
//
// Two record-only RPCs that wire per-client identity through the substrate.
// Enforcement is intentionally absent in this revision — handlers persist
// declared state to `~/.wmux/plugin-trust.json` and return the recorded
// identity. A follow-up PR will introduce permission checks at the three
// remaining enforcement points (method dispatch, metadata path write,
// event subscription).

/**
 * Trust state for a plugin entry in `~/.wmux/plugin-trust.json`.
 *
 *   - 'unconfirmed' — recorded by `mcp.identify` or `mcp.declarePermissions`,
 *                     not yet shown to the user (no prompt UI in this PR)
 *   - 'trusted'     — user approved the declared capability set (future PR)
 *   - 'denied'      — user rejected the plugin (future PR)
 *   - 'legacy'      — observed via RPC traffic without a clientName envelope
 *                     (pre-v2.10 callers, or non-MCP RPC clients)
 */
export type PluginTrustStatus = 'unconfirmed' | 'trusted' | 'denied' | 'legacy';

export interface PluginIdentityRecord {
  name: string;
  version?: string;
  declaredCapabilities?: string[];
  rationale?: string;
  status: PluginTrustStatus;
  firstSeen: number;
  lastSeen: number;
}

export interface McpIdentifyParams {
  name: string;
  version?: string;
}

export interface McpIdentifyResult {
  ok: true;
  identity: PluginIdentityRecord;
}

export interface McpDeclarePermissionsParams {
  permissions: string[];
  rationale?: string;
}

/**
 * Per-entry rejection surfaced through `McpDeclarePermissionsResult` when
 * the declaration is rejected. Plugins can map `index` back to the entry
 * they sent, see the original (possibly non-string) value, and render the
 * reason inline next to it. `index = -1` is reserved for the top-level
 * "permissions is not an array" error which has no per-entry context.
 */
export interface PermissionRejection {
  index: number;
  permission: unknown;
  reason: string;
}

/**
 * Result of `mcp.declarePermissions`. The union shape lets plugins receive
 * structured per-entry feedback on rejection without the wire envelope
 * having to grow JSON-RPC error-data support. Acceptance carries the
 * identity record and the echoed capability list; rejection carries one
 * `PermissionRejection` per malformed entry. Whole-declaration rejection
 * is preserved — `accepted` only appears when every entry parsed.
 */
export type McpDeclarePermissionsResult =
  | {
      ok: true;
      identity: PluginIdentityRecord;
      /**
       * Parsed permission echoes — useful for clients verifying that wmux
       * accepted the grammar they sent. Order matches `params.permissions`.
       */
      accepted: string[];
    }
  | {
      ok: false;
      errors: PermissionRejection[];
    };
