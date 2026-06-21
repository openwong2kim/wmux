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
}

/**
 * Per-request context surfaced to RPC handlers — populated by PipeServer
 * from RpcRequest fields. Handlers receive this as an optional second
 * argument so legacy handlers `(params) => ...` keep compiling.
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
  clientName?: string;
  clientVersion?: string;
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
  | 'browser.network.get'
  | 'browser.responseBody.get'
  | 'browser.type.cdp'
  | 'browser.click.cdp'
  | 'browser.press.cdp'
  | 'browser.cookies'
  | 'browser.resize'
  | 'browser.emulate'
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
  | 'hooks.signal';

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
  'browser.network.get',
  'browser.responseBody.get',
  'browser.type.cdp',
  'browser.click.cdp',
  'browser.press.cdp',
  'browser.cookies',
  'browser.resize',
  'browser.emulate',
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
    | 'lanlink.remote.received';
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
  cwd: string;
  cmd: string;
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
