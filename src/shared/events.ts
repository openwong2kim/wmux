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

import type { PaneMetadata, WorkspaceMetadata } from './types';

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
  | 'agent.lifecycle';

export const WMUX_EVENT_TYPES: readonly WmuxEventType[] = [
  'pane.created',
  'pane.closed',
  'pane.focused',
  'pane.metadata.changed',
  'workspace.metadata.changed',
  'process.started',
  'process.exited',
  'agent.lifecycle',
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

export type WmuxEvent =
  | PaneCreatedEvent
  | PaneClosedEvent
  | PaneFocusedEvent
  | PaneMetadataChangedEvent
  | WorkspaceMetadataChangedEvent
  | ProcessStartedEvent
  | ProcessExitedEvent
  | AgentLifecycleEvent;

export const RING_CAPACITY = 1024;
export const POLL_DEFAULT_MAX = 256;
