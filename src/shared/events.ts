// === wmux Event Bus types ===
//
// Lightweight event surface for external tooling (Claude Code, third-party MCPs)
// that want to react to pane/process lifecycle without polling the full state.
// Events are pull-only via `events.poll(cursor)` — pull cursor is the seq number
// of the last seen event; the bus returns events with `seq > cursor`.
//
// The ring is in-memory only and lives for the lifetime of the main process.
// Daemon restarts clear the ring; clients that drift past the ring window get
// a `resync: true` flag and should reconcile via `pane.list`. Each main-process
// run also gets a `bootId` (UUIDv4) so clients can distinguish "we drifted
// past the window" from "the daemon restarted under us" — the latter
// invalidates the entire seq space, not just the events you missed.
//
// Workspace scoping: each event carries a `workspaceId`; `events.poll` filters
// by the caller's claimed workspace by default so workspaces stay isolated.
//
// === Ordering caveat ===
//
// `seq` is monotonic in **arrival order**, not in **causal order**. Two
// independent producers (PTYBridge emits in-process from main; paneSlice
// publishes through preload IPC) write to the bus on different paths. Within
// one producer the order is preserved, but across producers a same-tick
// `pane.created` (renderer-published) and `process.started` (main-published)
// can land in the bus in either order. Clients must not assume seq order
// implies causal order across producer boundaries.

import type { PaneMetadata, WorkspaceMetadata, TaskState } from './types';

/**
 * Canonical agent slug for the `agent.lifecycle` event payload.
 *
 * Kept in lock-step with two other declaration sites:
 *   - `integrations/shared/signal-types.ts` (bridge envelope, canonical)
 *   - `src/main/pty/AgentDetector.ts` (regex detector)
 *
 * Duplicated here because src/shared is the only directory the daemon's
 * tsconfig.daemon.json includes (rootDir: src), and `integrations/` is
 * outside that root. Importing from main/ would invert the layering
 * (shared depends on main). New agents added to the union MUST be added
 * to all three locations.
 */
export type AgentSlug = 'claude' | 'codex' | 'gemini' | 'aider' | 'opencode' | 'copilot';

export type WmuxEventType =
  | 'pane.created'
  | 'pane.closed'
  | 'pane.focused'
  | 'pane.metadata.changed'
  | 'workspace.metadata.changed'
  | 'process.started'
  | 'process.exited'
  | 'agent.lifecycle'
  | 'notification.received'
  // X8 pane supervision. Tee'd from the daemon's session:restarted /
  // supervision:changed events (DaemonNotificationRouter) so orchestrator
  // clients can observe a supervised pane's restart/stop lifecycle without
  // polling. Like the other daemon-sourced tees they are dropped when the
  // owning workspace can't be resolved (scope-less events would leak across
  // workspace isolation).
  | 'pane.restarted'
  | 'pane.supervision'
  // A2A (agent-to-agent) task lifecycle tee. See A2aTaskEvent below — a
  // dual-party event (from/to) where the base workspaceId always equals `from`.
  | 'a2a.task'
  // A2A channels (per-recipient scoped). A channel post may have N recipients
  // in M workspaces (vs. a2a.task's fixed 2 workspaces). The event is fanned
  // out to every workspace in `recipientWorkspaceIds` plus the sender, with
  // the post-scoping done in `events.poll` (parallel to a2a.task's dual-party
  // filter) — see `src/main/pipe/handlers/events.rpc.ts`.
  | 'channel.message';

export const WMUX_EVENT_TYPES: readonly WmuxEventType[] = [
  'pane.created',
  'pane.closed',
  'pane.focused',
  'pane.metadata.changed',
  'workspace.metadata.changed',
  'process.started',
  'process.exited',
  'agent.lifecycle',
  'notification.received',
  'pane.restarted',
  'pane.supervision',
  'a2a.task',
  'channel.message',
] as const;

export interface WmuxEventBase {
  seq: number;          // monotonic; cursor for poll
  ts: number;           // ms epoch
  workspaceId: string;
  type: WmuxEventType;
}

export interface PaneCreatedEvent extends WmuxEventBase {
  type: 'pane.created';
  paneId: string;
  parentBranchId?: string;
}

export interface PaneClosedEvent extends WmuxEventBase {
  type: 'pane.closed';
  paneId: string;
}

export interface PaneFocusedEvent extends WmuxEventBase {
  type: 'pane.focused';
  paneId: string;
  previousPaneId?: string;
}

export interface PaneMetadataChangedEvent extends WmuxEventBase {
  type: 'pane.metadata.changed';
  paneId: string;
  metadata: PaneMetadata;
  /**
   * Monotonic version assigned by MetadataStore (v2.9.0+). Present when
   * emitted by the main-process MetadataStore; absent when emitted from
   * legacy renderer paths (publisher.ts) that pre-date the store.
   * Subscribers SHOULD ignore events with `version` ≤ a previously seen
   * value for the same `paneId` (idempotence — see PROTOCOL.md §1.3,
   * race #2).
   */
  version?: number;
}

/**
 * Fires when WorkspaceMetadata mutates (cwd, gitBranch, listeningPorts,
 * status, progress, agentName, agentStatus, lastNotification). The full
 * post-mutation metadata snapshot is included so clients don't need to
 * re-query. `patch` carries the keys that the caller actually wrote, so
 * dashboards can distinguish "user set status" from "shell hook updated cwd".
 */
export interface WorkspaceMetadataChangedEvent extends WmuxEventBase {
  type: 'workspace.metadata.changed';
  metadata: WorkspaceMetadata;
  patch: Partial<WorkspaceMetadata>;
}

export interface ProcessStartedEvent extends WmuxEventBase {
  type: 'process.started';
  ptyId: string;
  pid?: number;
  shell: string;
}

export interface ProcessExitedEvent extends WmuxEventBase {
  type: 'process.exited';
  ptyId: string;
  exitCode: number | null;
  signal?: string;
}

/**
 * Fires when an inner agent (Claude Code, etc.) finishes a turn, surfaces a
 * y/N approval prompt, or a generic shell command completes under OSC 133
 * shell integration. Three sources stream so callers can compare and pick:
 *
 *   - `source:'hook'`      — Claude Code hook bridge. Deterministic, sub-200ms.
 *                             Carries `agent` (the hook plugin knows who fired).
 *   - `source:'detector'`  — Regex-based AgentDetector. Heuristic, ~1-2s lag.
 *                             Carries `agent` (regex gates identify the agent).
 *   - `source:'osc133'`    — Shell integration OSC 133 D marker. Latency-zero,
 *                             shell-agnostic (any CLI: npm, pytest, make...).
 *                             `agent` may be `null` when no agent context is
 *                             known; `exitCode` is set when the marker carried
 *                             one (`OSC 133;D;<n>`).
 *
 * The dedup ledger inside HookSignalRouter decides whether a fan-out
 * notification fires (`decision`); the event itself is emitted regardless so
 * external consumers (orchestrator clients) see all three signals for
 * forensic / replay purposes. OSC 133 events are not dedup-gated — they
 * represent shell command lifecycle, not agent turn boundaries — and always
 * carry `decision:'emit'`.
 *
 * Intentionally omitted: `agent.activity` (per-tool-call) and
 * `agent.session_start`. activity events can fire 5-30 times per turn per
 * pane; including them would overrun the 1024 ring on any multi-pane
 * workflow. Consumers who need activity granularity should subscribe to
 * SIGNAL_HEALTH_UPDATE in-renderer instead.
 *
 * Carries `ptyId` only, not `paneId`. Resolving paneId from ptyId requires
 * a renderer-side workspace.list round-trip; orchestrators that know which
 * ptyId they spawned can filter directly. If a caller needs paneId they
 * can pull it from `pane.list` once and cache.
 */
export interface AgentLifecycleEvent extends WmuxEventBase {
  type: 'agent.lifecycle';
  ptyId: string;
  /**
   * 'agent.stop'           — turn finished, ready for next user input.
   * 'agent.subagent_stop'  — nested subagent (e.g. /team coordinator) returned.
   * 'agent.awaiting_input' — agent paused mid-turn for a y/N / approval prompt
   *                          and is blocked until the user responds. Emitted
   *                          by AgentDetector when a confirmation regex matches
   *                          on a previously-gated agent. Distinct from
   *                          'agent.stop' (which signals turn completion);
   *                          orchestrators that auto-approve trusted operations
   *                          can react to this kind to feed input back without
   *                          waiting for the turn to end.
   *
   * Other AgentSignalKind values are NOT emitted here — see the doc comment
   * above for rationale.
   */
  kind: 'agent.stop' | 'agent.subagent_stop' | 'agent.awaiting_input';
  source: 'hook' | 'detector' | 'osc133';
  /**
   * Canonical agent slug. `null` only when `source:'osc133'` and no agent
   * context is known for the PTY (e.g. plain shell command in a non-agent
   * pane). Hook and detector sources always carry a non-null agent.
   */
  agent: AgentSlug | null;
  /**
   * 'emit' = HookSignalRouter decided to fan out a notification.
   * 'dedup' = a same-pane same-kind signal already emitted within the
   * dedup window, so no notification fired. The lifecycle event itself
   * is published either way for observability; consumers that only want
   * "first-of-kind" signals filter on `decision === 'emit'`. OSC 133
   * events are always 'emit' (no dedup applies to shell command lifecycle).
   */
  decision: 'emit' | 'dedup';
  /**
   * Process exit code reported by the OSC 133 D marker, when present.
   * Only set for `source:'osc133'`; absent or `null` for hook/detector
   * sources (which signal agent-turn boundaries, not process exits).
   * `null` when the shell emitted `OSC 133;D` without an exit code suffix.
   */
  exitCode?: number | null;
}

/**
 * Fires when a terminal program emits a desktop-notification escape sequence
 * (OSC 9, OSC 777 `notify`, or kitty OSC 99). Parsed once in the process
 * that owns the PTY (daemon by default, main in local mode); both modes emit
 * the identical shape. Normative parsing/sanitization rules are frozen in
 * docs/internal/fable-window-schema-freeze.md §1.
 *
 * NOT dedup-gated: every sequence the program emits becomes an event.
 * Rate-limiting/suppression is a surface (toast/ring) policy, not a bus
 * policy. Like `agent.lifecycle`, the event is dropped when the owning
 * workspace can't be resolved (scope-less events would leak across
 * workspace isolation).
 */
export interface NotificationReceivedEvent extends WmuxEventBase {
  type: 'notification.received';
  ptyId: string;
  /** Which escape sequence produced this notification. */
  source: 'osc9' | 'osc777' | 'osc99';
  /** Sanitized title (≤256 chars), null when no separate title was carried. */
  title: string | null;
  /** Sanitized body (≤4096 chars). Always non-empty. */
  body: string;
}

/**
 * X8 — a supervised pane's process died and the daemon's PaneSupervisor
 * re-created it under the same id with a fresh PTY. Restarts are QUIET on the
 * UI surfaces (in-pane marker + badge, never a toast); this bus event is the
 * machine-readable equivalent for external observers. `restartCount` is the
 * cumulative count for this daemon lifetime (resets on daemon restart, like
 * the supervisor's volatile runtime). `exitCode` is the dead process's code,
 * or `null` for an external kill / signal-only exit.
 */
export interface PaneRestartedEvent extends WmuxEventBase {
  type: 'pane.restarted';
  ptyId: string;
  restartCount: number;
  exitCode: number | null;
}

/**
 * X8 — a supervised pane's sticky status flipped. `'stopped'` with
 * `reason:'guard-trip'` is the runaway-guard firing (auto-restart disabled);
 * `'armed'`/`'stopped'` with `reason:'rearm'`/`'manual-stop'` are the user's
 * own pane-menu actions. The renderer-facing surface only ever raises a toast
 * on `guard-trip`; this event is emitted for every flip for observability.
 */
export interface PaneSupervisionEvent extends WmuxEventBase {
  type: 'pane.supervision';
  ptyId: string;
  status: 'armed' | 'stopped';
  reason: 'guard-trip' | 'rearm' | 'manual-stop';
}

/**
 * A2A (agent-to-agent) task lifecycle, tee'd from the renderer task store onto
 * the bus so receivers can be notified WITHOUT a terminal paste and senders get
 * a delivery/status receipt. Involves TWO workspaces — `from` (sender) and `to`
 * (receiver). SCOPING INVARIANT: the base `workspaceId` is ALWAYS set === `from`,
 * so any consumer that ignores a2a.task still scopes to the sender and NEVER a
 * third party. `events.poll` adds `to` as a second matchable key for a2a.task
 * ONLY (see events.rpc.ts dual-party filter). `messagePreview` is omitted by
 * default — the event is a pointer; the party fetches the body via a2a_task_query.
 */
export interface A2aTaskEvent extends WmuxEventBase {
  type: 'a2a.task';
  taskId: string;
  /** Sender workspaceId. REQUIRED non-empty. ALSO equals the base workspaceId. */
  from: string;
  /** Receiver workspaceId. REQUIRED non-empty. */
  to: string;
  kind: 'created' | 'updated' | 'cancelled';
  state: TaskState;
  /**
   * Optional preview (≤200 chars). Omitted by default (pointer-only).
   *
   * SANITIZATION CAVEAT: this field is LENGTH-bounded only — it is NOT
   * content-sanitized for control/escape sequences. It is safe on the bus
   * today because it reaches ONLY the two scoped parties (the dual-party
   * `from`/`to` filter in events.rpc.ts) and is omitted by default. But any UI
   * that ever surfaces it (a toast, a Fleet View row, etc.) MUST sanitize it
   * first — do NOT render it raw.
   */
  messagePreview?: string;
}

import type { ChannelMessage } from './channels';

/**
 * A2A channels: a message was posted in a channel. The base `workspaceId` is
 * always set `=== senderWorkspaceId` so a consumer that ignores channel.message
 * still scopes to the sender and never leaks to a third party; `events.poll`
 * then adds every `recipientWorkspaceId` as an additional matchable key for
 * this type only (see events.rpc.ts per-recipient filter). Unlike `a2a.task`
 * (which is fixed 2 workspaces), channels may have N recipients in M
 * workspaces — so this is a generalization, not a parallel of, the dual-party
 * pattern.
 *
 * `recipients` is the per-recipient delivery snapshot frozen at critical-
 * section entry inside `ChannelService.post` (plan KTD3). Each entry carries
 * `workspaceId` so the renderer can filter to its own delivery row.
 *
 * SANITIZATION CAVEAT: `message.text` and `message.memberName` flow through
 * `LocalPtyDelivery.defaultChannelMessage` / `defaultChannelNudge` (which
 * delegate to `sanitizeA2aName` and an inline strip) before they ever reach a
 * terminal. The event itself, however, is NOT pre-sanitized — any UI that
 * renders `message.text` directly (a panel that doesn't route through the
 * delivery formatter) MUST sanitize first.
 */
export interface ChannelMessageEvent extends WmuxEventBase {
  type: 'channel.message';
  channelId: string;
  /** Per-channel monotonic seq (see plan KTD2). */
  seq: number;
  /** Sender's workspaceId. Also equals the base `workspaceId`. */
  senderWorkspaceId: string;
  /** Every workspaceId the post targeted. Used by `events.poll` to fan out
   *  the event to all member workspaces (parallel to a2a.task's `to` key). */
  recipientWorkspaceIds: string[];
  /** The full posted message (sender, text, seq, postedAt, recipientSnapshot). */
  message: ChannelMessage;
}

export type WmuxEvent =
  | PaneCreatedEvent
  | PaneClosedEvent
  | PaneFocusedEvent
  | PaneMetadataChangedEvent
  | WorkspaceMetadataChangedEvent
  | ProcessStartedEvent
  | ProcessExitedEvent
  | AgentLifecycleEvent
  | NotificationReceivedEvent
  | PaneRestartedEvent
  | PaneSupervisionEvent
  | A2aTaskEvent
  | ChannelMessageEvent;

export const RING_CAPACITY = 1024;
export const POLL_DEFAULT_MAX = 256;
