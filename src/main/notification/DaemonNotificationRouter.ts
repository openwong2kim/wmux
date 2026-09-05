import type { BrowserWindow } from 'electron';
import type { DaemonClient } from '../DaemonClient';
import type { AgentStatus } from '../../shared/types';
import type { HookSignalRouter } from '../hooks/HookSignalRouter';
import { dispatchNotification } from './dispatchNotification';
import {
  clearPty as clearSuppression,
  recentlySettled,
  SETTLE_REDRAW_GUARD_MS,
} from './idleSuppression';
import {
  broadcastMetadataUpdate,
  getLastBroadcastAgentStatus,
  clearLastBroadcastAgentStatus,
} from '../ipc/handlers/metadata.handler';
import { settleHookTurnToIdle, broadcastSettledIdle } from './turnSettle';
import { eventBus } from '../events/EventBus';
import {
  findWorkspaceIdForPty,
  STALE_TRUST_MS,
  ACTIVITY_THROTTLE_MS,
  activityFromSignalPayload,
  buildTurnBoundaryMetadata,
  createLeadingEdgeThrottle,
  readStopMessage,
} from '../pipe/handlers/hooks.rpc';
import type { AgentSignal } from '../../shared/hooks/signal-types';
import type { AgentLastMessage } from '../../shared/events';
import { getWorkspaceMirror, type WorkspaceMirror } from '../workspace/WorkspaceMirror';
import { sendToRenderer } from '../pipe/handlers/_bridge';
import { agentDisplayToSlug } from '../pty/AgentDetector';
import type { ChannelMessage } from '../../shared/channels';

// Mirrors PTYBridge.AGENT_EVENT_SUPPRESSION_MS — same dedup semantics across
// daemon and local modes.
const AGENT_EVENT_SUPPRESSION_MS = 10_000;

/**
 * The OSC 133 markers that mean the pane's shell is back at its OWN prompt:
 * a foreground command ended (D), or a fresh prompt was drawn (A / B). Exactly
 * the `false` branch of `PromptEventLog.isCommandRunning` — the same judgement,
 * from the same marker stream, that the daemon reports as `commandRunning`.
 */
const AT_PROMPT_MARKERS: ReadonlySet<string> = new Set([
  'command_end',
  'prompt_start',
  'prompt_end',
]);

// The F5 rule (which statuses a settle edge must never overwrite) and the
// settle itself live in turnSettle.ts, shared with the interrupt edge in
// PTYBridge so the two cannot drift apart.

interface AgentEventPayload {
  agent: string;
  status: AgentStatus;
  message: string;
  /**
   * M1: which emitter produced this event, stamped by the daemon once hook
   * ingest moved there. Its presence means the daemon ALREADY arbitrated
   * hook-vs-detector against its own ledger, so main must not re-run its own
   * (see arbitratedSource). Absent on events from a pre-M1 daemon.
   */
  source?: 'hook' | 'detector';
  /** Original AgentSignal kind, only on `source:'hook'` events. */
  hookKind?: string;
  /**
   * The daemon's arbitration verdict for this turn (emit-class statuses only):
   *   'emit'     — fan out the notification and the lifecycle tee
   *   'dedup'    — the other source already covered the turn: tee only, no toast
   *   'veto'     — hook-governed pane, detector-sourced: status dot only
   *   'activity' — a per-tool-call ping (PostToolUse): Fleet View activity line
   *                only, never a toast and never a lifecycle tee
   *   'internal' — the daemon's CompletionAlarm rejected the candidate as NOT
   *                a real turn end (subagent stop, leftover background work,
   *                turn-gate miss, already announced, or the window was
   *                rebutted): status dot only, exactly like 'veto'
   * Absent when the daemon could not arbitrate (unknown agent), which means
   * the pre-ledger always-emit behavior.
   */
  decision?: 'emit' | 'dedup' | 'veto' | 'activity' | 'internal';
  /**
   * The validated envelope the daemon ingested, present on hook-sourced events
   * only. Main replays off it the side effects its own `hooks.signal` handler
   * used to run from its copy of the signal — Fleet View activity line, turn
   * boundary metadata, the lifecycle tee's `lastMessage`, and the M2 turn-end
   * probe — so a bridge that reaches the daemon directly loses none of them.
   */
  signal?: AgentSignal;
}

/**
 * Read the daemon's arbitration stamp off a `session:agent` payload.
 *
 * Returns null for a pre-M1 daemon (no `source` field), which keeps the
 * legacy behavior: main runs the hook-authority veto and writes the detector
 * ledger itself. A stamped event means arbitration already happened in the
 * daemon — one process, one ledger — and main is only the presentation layer.
 */
function arbitratedSource(ev: AgentEventPayload): 'hook' | 'detector' | null {
  return ev.source === 'hook' || ev.source === 'detector' ? ev.source : null;
}

/**
 * The daemon's verdict, defaulted to 'emit'. A stamped event with no decision
 * is one the daemon could not arbitrate (unknown agent display name), and the
 * behavior main assumed before any ledger existed was to always emit.
 */
function arbitratedDecision(
  ev: AgentEventPayload,
): 'emit' | 'dedup' | 'veto' | 'activity' | 'internal' {
  return ev.decision === 'dedup'
    || ev.decision === 'veto'
    || ev.decision === 'activity'
    || ev.decision === 'internal'
    ? ev.decision
    : 'emit';
}

/** Lifecycle kinds a `session:agent` event may carry. */
type AgentLifecycleKind = 'agent.stop' | 'agent.subagent_stop' | 'agent.awaiting_input';

/**
 * Kind for the lifecycle tee. A hook-sourced event carries the ORIGINAL signal
 * kind, which is the only way `agent.subagent_stop` survives the trip (the
 * detector's status vocabulary cannot express it); anything else falls back to
 * the status mapping the detector path has always used.
 */
function lifecycleKindFor(ev: AgentEventPayload): AgentLifecycleKind {
  if (
    ev.hookKind === 'agent.stop'
    || ev.hookKind === 'agent.subagent_stop'
    || ev.hookKind === 'agent.awaiting_input'
  ) {
    return ev.hookKind;
  }
  return ev.status === 'awaiting_input' ? 'agent.awaiting_input' : 'agent.stop';
}

/**
 * In daemon mode, PTY data flows through DaemonPTYBridge inside the daemon
 * process — main never sees raw bytes, so the local PTYBridge subscriptions
 * (onEvent, onActive, onActiveToIdle) never fire. Without an explicit bridge
 * here, all notification signal is lost in production (Codex 2nd-round
 * review #1).
 *
 * DaemonNotificationRouter subscribes to DaemonClient's re-emitted events
 * and runs the same handler logic PTYBridge does:
 *   - session:agent → METADATA_UPDATE (sidebar dot) + NOTIFICATION
 *     (unread badge + in-app toast + OS toast)
 *   - session:active → METADATA_UPDATE (agentStatus = 'running')
 *   - session:idle → fallback NOTIFICATION, suppressed if a recent agent
 *     event already covered it
 *   - session:died → METADATA_UPDATE (agentStatus = 'idle')
 *
 * The router does NOT reset AgentDetector emission state on 'active' the way
 * PTYBridge does — AgentDetector lives inside the daemon process and resets
 * itself on each new burst via the bridge wiring, not from main.
 */
// Matches the renderer's workspace.list shape — `name` is required by the
// signature of `findWorkspaceIdForPty` even though we only read id/ptyIds.
interface WorkspaceListEntry {
  id: string;
  name: string;
  activePtyId?: string | null;
  ptyIds?: string[];
}

/**
 * TTL for the workspace.list IPC cache (ms). The workspace tree is reshaped
 * only by user action (create/delete/rename), which is rare — but agent
 * lifecycle events fan in continuously during multi-pane work. A 2s window
 * is long enough to coalesce bursts of events from one turn while remaining
 * short enough that any UI mutation reflects in under a UX heartbeat. The
 * cache is also actively invalidated on `workspace.metadata.changed`
 * EventBus emits, so the TTL is the worst-case staleness for surfaces that
 * don't publish to that event (workspace create/delete go through other
 * paths that we conservatively rely on the TTL to catch).
 */
const WORKSPACE_LIST_CACHE_TTL_MS = 2_000;

export class DaemonNotificationRouter {
  private cleanups: Array<() => void> = [];
  private lastAgentEventAt = new Map<string, number>();
  /**
   * Per-PTY last-known agent display name. Populated on every
   * `session:agent` event so the `session:prompt` (OSC 133) handler can
   * attach an agent slug to the EventBus tee. Without this cache, OSC 133
   * events emitted in daemon mode would always carry `agent: null` even
   * when AgentDetector has already gated a Claude Code / Codex CLI / ...
   * session — losing parity with the local-mode PTYBridge case 133 path
   * which reads `agentDetector.getLastAgent()` directly.
   *
   * Cleared on `session:died` / `session:destroyed` (alongside
   * `lastAgentEventAt`) so stale agent labels never leak across PTY reuse.
   */
  private lastAgentNameByPty = new Map<string, string>();
  private workspaceCache: { value: WorkspaceListEntry[]; ts: number } | null = null;
  /**
   * Fleet View activity rate limit for the hook-activity replay. Same window as
   * the local handler's (ACTIVITY_THROTTLE_MS) so a pane's activity line is
   * throttled identically whichever path serves it. Cleared wholesale in stop().
   */
  private activityThrottle = createLeadingEdgeThrottle(ACTIVITY_THROTTLE_MS);

  constructor(
    private daemonClient: DaemonClient,
    private getWindow: () => BrowserWindow | null,
    // Optional. When supplied, daemon-sourced detector lifecycle events go
    // through the same `recordDetector` dedup ledger as the local PTYBridge
    // path so hook+detector pairs collapse to one emit / one dedup. Without
    // it we still emit (decision:'emit'), which is the legacy fallback.
    private getHookRouter?: () => HookSignalRouter | null,
    // Optional clock override. Used by tests so cache-TTL behavior can be
    // exercised deterministically without faking globals.
    private now: () => number = Date.now,
    // Main-side WorkspaceMirror (renderer-pushed workspace tree). Consulted
    // before the cached round-trip so a resolvable ptyId never touches the
    // renderer. Injected (default the singleton) for testability.
    private getMirror: () => Pick<WorkspaceMirror, 'peek'> = getWorkspaceMirror,
    // M1: fired once per hook-sourced claude `agent.stop` that the daemon
    // arbitrated, carrying the workspace that owns the pane. Same callback
    // main passes to registerHooksRpc — after M1 the signal may never reach
    // that handler, so this is the daemon-path twin of its M2 usage probe.
    private onClaudeTurnEnd?: (workspaceId: string) => void,
  ) {}

  /**
   * Pull the current workspace list from the renderer so we can resolve the
   * daemon `sessionId` (= ptyId) to its owning workspace for `events.poll`
   * scoping. Best-effort — returns null on any IPC failure, in which case
   * the caller skips the EventBus tee (a stray-workspaced lifecycle event
   * would route to the wrong subscriber, so dropping is safer).
   *
   * The result is cached for `WORKSPACE_LIST_CACHE_TTL_MS`. Without this,
   * every detector-sourced `agent.lifecycle` emit triggered a fresh
   * round-trip — for a 5-pane × 10-turn session that was 50 unnecessary
   * IPC hops worth of pure latency. The cache is also wiped on
   * `workspace.metadata.changed` EventBus emits so user-visible workspace
   * mutations don't have to wait out the full TTL.
   */
  private async resolveWorkspaceIdForPty(ptyId: string): Promise<string | null> {
    // Mirror first: the renderer pushes its full workspace tree to main on every
    // structural/status change, so a ptyId that still belongs to an open pane
    // resolves here with no renderer round-trip. A ptyId→workspace mapping is
    // topology-stable (independent of which surface is focused), so a mirror
    // that is merely fresh (< STALE_TRUST_MS) is authoritative for it. A miss
    // (empty/stale mirror, or a ptyId absent from the snapshot — e.g. a pane
    // that just closed) falls through to the cached round-trip below.
    const mirrored = this.getMirror().peek();
    if (mirrored && mirrored.ageMs < STALE_TRUST_MS) {
      const workspaceId = findWorkspaceIdForPty(ptyId, mirrored.entries);
      if (workspaceId) return workspaceId;
    }
    const cached = this.workspaceCache;
    if (cached && this.now() - cached.ts < WORKSPACE_LIST_CACHE_TTL_MS) {
      return findWorkspaceIdForPty(ptyId, cached.value);
    }
    try {
      const result = (await sendToRenderer(this.getWindow, 'workspace.list')) as unknown;
      if (!Array.isArray(result)) return null;
      const list = result as WorkspaceListEntry[];
      this.workspaceCache = { value: list, ts: this.now() };
      return findWorkspaceIdForPty(ptyId, list);
    } catch (err) {
      console.warn('[DaemonNotificationRouter] workspace.list resolve failed:', err);
      return null;
    }
  }

  /**
   * Drop the cached workspace.list result. Called from the
   * `workspace.metadata.changed` subscription registered in `start()`, and
   * exposed for tests that exercise invalidation without involving the
   * EventBus.
   */
  invalidateWorkspaceCache(): void {
    this.workspaceCache = null;
  }

  /**
   * Mirror of PTYBridge's detector-source `agent.lifecycle` emit for the
   * daemon-backed PTY path. Skips silently when:
   *   - the agent display name has no canonical slug (unknown agent)
   *   - workspaceId can't be resolved (renderer transient unavailable,
   *     or PTY closed mid-flight) — better to drop than route wrong
   *
   * Ordering matters: `recordDetector` is called SYNCHRONOUSLY first so
   * the ledger write happens at the same moment the local-mode
   * PTYBridge.onEvent path would have written it (codex round-2/3
   * cross-model catch). If we awaited workspace.list first, daemon-mode
   * dedup would race a hook arriving in the 50-200ms IPC window — local
   * vs daemon mode would then produce different decision distributions
   * for the same user scenario. With sync recordDetector + async
   * workspace.list, ledger timing is parity; only the EventBus emit is
   * delayed (and gated on workspace resolution, since an event with the
   * wrong scope would route to the wrong subscriber).
   *
   * No throw path — daemon notification flow is best-effort and a tee
   * failure must never break the toast/sidebar update.
   *
   * `arbitrated` (M1) carries the daemon's own `source` + verdict when it
   * stamped one. For those events the ledger is NOT written here: the daemon
   * already ran `recordHook`/`recordDetector` against its ledger, so a second
   * write in main would dedup the NEXT signal of the same kind against a
   * decision that was already made.
   */
  private async emitDetectorLifecycle(
    ptyId: string,
    agentName: string,
    kind: AgentLifecycleKind = 'agent.stop',
    arbitrated: {
      source: 'hook' | 'detector';
      decision: 'emit' | 'dedup';
      /** Transcript tail for a turn-end wake; hook-sourced `agent.stop` only. */
      lastMessage?: AgentLastMessage | null;
      /** The ingested envelope, for side effects keyed on the original kind. */
      signal?: AgentSignal | null;
    } | null = null,
  ): Promise<void> {
    try {
      const slug = agentDisplayToSlug(agentName);
      if (!slug) return;
      // Sync ledger write first — parity with PTYBridge local-mode timing.
      // recordDetector is cheap (in-memory Map ops); it must precede the
      // ~50-200ms workspace.list round-trip to match local-mode semantics.
      const hookRouter = this.getHookRouter?.() ?? null;
      const decision = arbitrated
        ? arbitrated.decision
        : hookRouter
          ? hookRouter.recordDetector(slug, kind, ptyId)
          : 'emit';
      // Now do the workspace lookup. If it fails or returns null we drop
      // the event entirely (event without scope = wrong subscriber routing)
      // but the ledger write already happened — a subsequent hook for the
      // same turn will still see the dedup record.
      const workspaceId = await this.resolveWorkspaceIdForPty(ptyId);
      if (!workspaceId) return;
      eventBus.emit({
        type: 'agent.lifecycle',
        workspaceId,
        ptyId,
        kind,
        source: arbitrated?.source ?? 'detector',
        agent: slug,
        decision,
        // Attach the pane's closing words to a turn-end wake. Without this the
        // orchestrator receives "pane stopped" and nothing else, so its only way
        // to tell "finished" from "blocked on a question" is to read the
        // rendered terminal — where an agent's printed proposal is
        // indistinguishable from text pending in its input box.
        ...(arbitrated?.lastMessage ? { lastMessage: arbitrated.lastMessage } : {}),
      });
      // M1 replay — M2 usage probe. A claude turn just ended in this workspace,
      // so the usage number for its bound account may have moved. Fires on BOTH
      // emit and dedup (the turn genuinely ended regardless of which source won
      // the toast), matching the local handler's gate exactly.
      const endedSignal = arbitrated?.signal;
      if (endedSignal && endedSignal.kind === 'agent.stop' && endedSignal.agent === 'claude') {
        this.onClaudeTurnEnd?.(workspaceId);
      }
    } catch (err) {
      console.warn('[DaemonNotificationRouter] emitDetectorLifecycle error:', err);
    }
  }

  /**
   * OSC 133 mirror of PTYBridge's case 133 path for daemon-backed PTYs.
   * Fires on every `command_end` PromptEvent forwarded from the daemon.
   * Unlike `emitDetectorLifecycle`, this path:
   *   - never goes through `HookSignalRouter.recordDetector` (OSC 133 is
   *     shell command lifecycle, not agent-turn boundaries — dedup against
   *     hook signals would conflate two different semantic levels)
   *   - resolves agent slug from `lastAgentNameByPty` (best-effort);
   *     emits `agent: null` when no agent context is gated, matching the
   *     local-mode behavior
   *   - sets `exitCode` from the parsed marker (`null` when the shell
   *     omitted the suffix on `OSC 133;D`)
   */
  private async emitOsc133Lifecycle(ptyId: string, exitCode: number | null): Promise<void> {
    // Snapshot the agent slug BEFORE awaiting workspace.list. The shell may
    // emit `OSC 133;D` then redraw the prompt and trigger a `session:agent`
    // update in the same burst; if we resolved the slug after the await,
    // the cache could already reflect a future turn's agent, mis-attributing
    // this command_end. This matches PTYBridge's local-mode case 133 path,
    // which reads `agentDetector.getLastAgent()` synchronously before any
    // EventBus emit (Codex round-2 P2).
    const lastAgentName = this.lastAgentNameByPty.get(ptyId) ?? '';
    const agentSlug = agentDisplayToSlug(lastAgentName) ?? null;
    try {
      const workspaceId = await this.resolveWorkspaceIdForPty(ptyId);
      if (!workspaceId) return;
      eventBus.emit({
        type: 'agent.lifecycle',
        workspaceId,
        ptyId,
        kind: 'agent.stop',
        source: 'osc133',
        agent: agentSlug,
        decision: 'emit',
        exitCode,
      });
    } catch (err) {
      console.warn('[DaemonNotificationRouter] emitOsc133Lifecycle error:', err);
    }
  }

  /**
   * Tee a daemon-parsed terminal notification (OSC 9/777/99) onto the
   * EventBus as `notification.received`. Same workspace-resolution-or-drop
   * contract as the lifecycle tees above: an event without a workspace
   * scope would route to the wrong subscriber, so dropping is safer.
   */
  private async emitNotificationReceived(
    ptyId: string,
    notification: { source: 'osc9' | 'osc777' | 'osc99'; title: string | null; body: string },
  ): Promise<void> {
    try {
      const workspaceId = await this.resolveWorkspaceIdForPty(ptyId);
      if (!workspaceId) return;
      eventBus.emit({
        type: 'notification.received',
        workspaceId,
        ptyId,
        source: notification.source,
        title: notification.title,
        body: notification.body,
      });
    } catch (err) {
      console.warn('[DaemonNotificationRouter] emitNotificationReceived error:', err);
    }
  }

  /**
   * X8 — tee a supervised-pane restart onto the EventBus as `pane.restarted`.
   * Same workspace-resolution-or-drop contract as the lifecycle tees above:
   * a scope-less event would route to the wrong `events.poll` subscriber.
   * Best-effort — a tee failure must never disturb the renderer-facing
   * PTY_RESTARTED relay or the badge sync (those run on pty.handler's own
   * subscription, independent of this one).
   */
  private async emitPaneRestarted(
    ptyId: string,
    restartCount: number,
    exitCode: number | null,
  ): Promise<void> {
    try {
      const workspaceId = await this.resolveWorkspaceIdForPty(ptyId);
      if (!workspaceId) return;
      eventBus.emit({
        type: 'pane.restarted',
        workspaceId,
        ptyId,
        restartCount,
        exitCode,
      });
    } catch (err) {
      console.warn('[DaemonNotificationRouter] emitPaneRestarted error:', err);
    }
  }

  /**
   * X8 — tee a supervision sticky-status flip onto the EventBus as
   * `pane.supervision`. Emitted for every flip (guard-trip / rearm /
   * manual-stop) for observability; the toast surface (guard-trip only) is
   * raised separately by pty.handler. Workspace-resolution-or-drop, like the
   * tees above.
   */
  private async emitPaneSupervision(
    ptyId: string,
    status: 'armed' | 'stopped',
    reason: 'guard-trip' | 'rearm' | 'manual-stop',
  ): Promise<void> {
    try {
      const workspaceId = await this.resolveWorkspaceIdForPty(ptyId);
      if (!workspaceId) return;
      eventBus.emit({
        type: 'pane.supervision',
        workspaceId,
        ptyId,
        status,
        reason,
      });
    } catch (err) {
      console.warn('[DaemonNotificationRouter] emitPaneSupervision error:', err);
    }
  }

  /**
   * A2A channels (a2a-channels U4) — tee a daemon-broadcast `channel.message`
   * onto the main-process EventBus as a WmuxEvent `channel.message`.
   *
   * Unlike the per-PTY tees above, this event is NOT scoped via
   * `resolveWorkspaceIdForPty` — the sender's workspace is the `workspaceId`
   * field on the event itself (the daemon froze it at the critical-section
   * entry in ChannelService.post, plan KTD3), and the recipient set is
   * `recipientWorkspaceIds`. The per-recipient fan-out is the job of
   * `events.poll` (events.rpc.ts), which reads those two fields directly
   * and drops the event for any caller not in scope. Teeing here with a
   * `workspaceId: sender` so a consumer that ignores channel.message stays
   * scoped to the sender (the base-scoping invariant in events.ts).
   *
   * No workspace-resolution-or-drop contract applies because the
   * workspaceId is ALREADY authoritative on the event. We do, however,
   * still skip a malformed payload — a missing `channelId` / `seq` /
   * `senderWorkspaceId` / `message` would crash the bus-projection
   * downstream, and the per-recipient filter in events.rpc.ts already
   * tolerates empty `recipientWorkspaceIds` (it just routes to the sender
   * only).
   */
  private emitChannelMessage(event: {
    channelId?: string;
    seq?: number;
    sender?: { workspaceId?: string; memberId?: string; memberName?: string };
    recipients?: Array<{ workspaceId?: string; memberId?: string; status?: string }>;
    message?: ChannelMessage;
    workspaceId?: string;
  }): void {
    try {
      // Guard the minimum shape. Anything less is a daemon-side bug; log
      // and skip rather than crash the bus.
      if (
        typeof event.channelId !== 'string' ||
        event.channelId.length === 0 ||
        typeof event.seq !== 'number' ||
        typeof event.workspaceId !== 'string' ||
        event.workspaceId.length === 0 ||
        !event.message ||
        !Array.isArray(event.recipients)
      ) {
        console.warn('[DaemonNotificationRouter] channel.message payload missing required fields; dropping', event);
        return;
      }
      // Project the ChannelService-side shape (sender / recipients) onto
      // the WmuxEvent counterpart (senderWorkspaceId / recipientWorkspaceIds).
      // The daemon side carries the full sender ref for trace logging; the
      // bus only needs the workspaceId, matching the field already named in
      // the WmuxEvent interface.
      const recipientWorkspaceIds = event.recipients
        .map((r) => r.workspaceId)
        .filter((w): w is string => typeof w === 'string' && w.length > 0);
      // Always include the sender's workspaceId — it's the base-scope anchor
      // and a post is implicitly addressed to its own sender (membership is a
      // precondition). Without this, a single-member channel would have an
      // empty recipient list and the sender wouldn't see their own post.
      if (!recipientWorkspaceIds.includes(event.workspaceId)) {
        recipientWorkspaceIds.push(event.workspaceId);
      }
      eventBus.emit({
        type: 'channel.message',
        channelId: event.channelId,
        seq: event.seq,
        senderWorkspaceId: event.workspaceId,
        recipientWorkspaceIds,
        message: event.message,
        workspaceId: event.workspaceId,
      });
    } catch (err) {
      console.warn('[DaemonNotificationRouter] emitChannelMessage error:', err);
    }
  }

  /**
   * A1 — tee a daemon-broadcast `channel.catalog` onto the main EventBus. Like
   * emitChannelMessage, the scope is the event's own fields (actorWorkspaceId +
   * recipientWorkspaceIds), re-imposed per-recipient by `events.poll` — no
   * resolveWorkspaceIdForPty needed. A malformed payload is dropped, not thrown.
   */
  private emitChannelCatalog(event: {
    channelId?: string;
    actorWorkspaceId?: string;
    recipientWorkspaceIds?: unknown;
    reason?: unknown;
  }): void {
    try {
      if (
        typeof event.channelId !== 'string' ||
        event.channelId.length === 0 ||
        typeof event.actorWorkspaceId !== 'string' ||
        event.actorWorkspaceId.length === 0 ||
        !Array.isArray(event.recipientWorkspaceIds)
      ) {
        console.warn(
          '[DaemonNotificationRouter] channel.catalog payload missing required fields; dropping',
          event,
        );
        return;
      }
      const recipientWorkspaceIds = (event.recipientWorkspaceIds as unknown[]).filter(
        (w): w is string => typeof w === 'string' && w.length > 0,
      );
      // The actor is always in scope (it performed the change and must see the
      // result), mirroring emitChannelMessage's sender-always-included rule.
      if (!recipientWorkspaceIds.includes(event.actorWorkspaceId)) {
        recipientWorkspaceIds.push(event.actorWorkspaceId);
      }
      const reason =
        event.reason === 'created' || event.reason === 'archived' || event.reason === 'membership' ||
        event.reason === 'cursor'
          ? event.reason
          : 'membership';
      eventBus.emit({
        type: 'channel.catalog',
        channelId: event.channelId,
        actorWorkspaceId: event.actorWorkspaceId,
        recipientWorkspaceIds,
        reason,
        workspaceId: event.actorWorkspaceId,
      });
    } catch (err) {
      console.warn('[DaemonNotificationRouter] emitChannelCatalog error:', err);
    }
  }

  /**
   * Channels v2 wake worker — the mention-nudge budget for one (channel,
   * member) episode is exhausted; the worker stopped re-nudging and the
   * episode is HANDED TO HUMANS. This is the promise the wake worker's
   * `channel.nudgeExhausted` broadcast makes, and this handler is where it
   * is kept: an in-app toast + OS notification for the operator, plus an
   * EventBus tee so orchestrator clients (`wmux_events_poll`) can observe
   * stranded mentions. A malformed payload is dropped, not thrown.
   */
  private emitChannelNudgeExhausted(event: {
    channelId?: string;
    channelName?: unknown;
    workspaceId?: unknown;
    memberId?: unknown;
    unread?: unknown;
    mentionUnread?: unknown;
  }): void {
    try {
      if (
        typeof event.channelId !== 'string' ||
        event.channelId.length === 0 ||
        typeof event.workspaceId !== 'string' ||
        event.workspaceId.length === 0 ||
        typeof event.memberId !== 'string' ||
        event.memberId.length === 0
      ) {
        console.warn(
          '[DaemonNotificationRouter] channel.nudgeExhausted payload missing required fields; dropping',
          event,
        );
        return;
      }
      const channelName =
        typeof event.channelName === 'string' && event.channelName.length > 0
          ? event.channelName
          : event.channelId;
      const unread = typeof event.unread === 'number' ? event.unread : 0;
      const mentionUnread = typeof event.mentionUnread === 'number' ? event.mentionUnread : 0;
      const title = `#${channelName}: ${event.memberId} is not responding`;
      const body = `${mentionUnread} mention${mentionUnread === 1 ? '' : 's'} unanswered after repeated nudges — needs a human`;
      const win = this.getWindow();
      // workspaceId rides in the payload so the renderer routes/records the
      // notification against the affected member's workspace AND the OS
      // toast click (renderer-decided osToast action, or the no-window
      // fallback inside dispatchNotification) jumps there — same contract
      // as notify.rpc.
      dispatchNotification(
        win,
        null,
        { type: 'agent', title, body, workspaceId: event.workspaceId, category: 'system' },
        { workspaceId: event.workspaceId },
      );
      eventBus.emit({
        type: 'channel.nudgeExhausted',
        channelId: event.channelId,
        channelName,
        memberId: event.memberId,
        unread,
        mentionUnread,
        workspaceId: event.workspaceId,
      });
    } catch (err) {
      console.warn('[DaemonNotificationRouter] emitChannelNudgeExhausted error:', err);
    }
  }

  start(): void {
    const onAgent = (payload: { sessionId: string; event: unknown }) => {
      try {
        const win = this.getWindow();
        const ev = payload.event as AgentEventPayload;
        if (!ev || typeof ev !== 'object') return;

        // M1 replay — the metadata-only hook kinds (`decision:'activity'`).
        // None of them are emit-class: no toast, no lifecycle tee, no dedup
        // ledger, only the metadata funnel the renderer already consumes. Main's
        // own handler did this off its copy of the signal; once the bridge
        // reaches the daemon directly this is the only path left, so it replays
        // off the envelope the daemon ships. Handled BEFORE the status broadcast
        // below and returning early so a tool-heavy turn produces ONE throttled
        // IPC message per window rather than an unthrottled agentStatus
        // broadcast per tool call — that flood is exactly what
        // ACTIVITY_THROTTLE_MS exists to prevent.
        //
        // Several kinds land here and they are NOT interchangeable, so dispatch
        // on the kind rather than letting the activity summarizer stand in for
        // all of them.
        if (arbitratedSource(ev) && arbitratedDecision(ev) === 'activity') {
          // hookKind is the daemon's own label; the envelope's kind is the
          // fallback for an event that ships one but not the other.
          const metadataKind = ev.hookKind ?? ev.signal?.kind;
          if (metadataKind === 'agent.session_start') {
            // A CLEAR, not an activity line — exact parity with main's local
            // session_start handling: a fresh session on this ptyId must inherit
            // neither the previous session's tool label nor its unanswered
            // question. Two properties the activity path cannot provide:
            //   - NEVER throttled. A dropped clear leaves a dead session's label
            //     on a live pane, and a session start is rare enough that it can
            //     never contribute to the flood the throttle guards against.
            //   - clears pendingQuestion, which no summarized string expresses.
            // It also does not STAMP the window: the throttle keeps running off
            // the previous session's last tool call, so a new session's first
            // activity line can wait out the remainder of that window. The gap
            // shows an EMPTY line (this clear just ran), never a stale one, so
            // the cost is a sub-3s delay on the first label and the benefit is
            // one fewer moving part in the shared throttle.
            broadcastMetadataUpdate(win, {
              ptyId: payload.sessionId,
              activity: '',
              pendingQuestion: '',
            });
          } else if (metadataKind === 'agent.user_prompt_submit') {
            // The TURN START, and the whole point of the hook: the pane goes
            // 'running' the instant a prompt is submitted, instead of once the
            // byte-rate heuristic has seen enough output to guess. Like the
            // session_start clear above and unlike the activity line below, it
            // is NEVER throttled — UserPromptSubmit fires once per turn, so it
            // can never contribute to the flood the throttle guards against,
            // and a dropped one would leave the pane looking idle for a whole
            // turn. It also does not stamp the throttle window.
            const promptSlug = agentDisplayToSlug(ev.agent);
            // Remember WHO is running here. The process-death edge below has to
            // check the dying process against this pane's agent, and a turn
            // start may be the only event a pane produces before it dies.
            if (ev.agent) this.lastAgentNameByPty.set(payload.sessionId, ev.agent);
            // From here the hook owns this pane's running dot — onActive stops
            // promoting it on output bursts and onIdle stops clearing it on
            // silence. Recorded on main's router even though a daemon-served
            // pane never touches its authority map: this latch is a separate,
            // narrower claim. See HookSignalRouter.governsRunningState.
            this.getHookRouter?.()?.noteHookTurnStart(payload.sessionId, this.now(), promptSlug ?? null);
            broadcastMetadataUpdate(win, {
              ptyId: payload.sessionId,
              agentStatus: 'running',
              // The renderer's half of the same latch: tagged with the hook
              // kind so `surfaceTurnOpenAt` opens on THIS broadcast and not on
              // a byte-rate 'running', which is a guess and could never be
              // trusted to hold a pane at running with no decay.
              hookKind: 'agent.user_prompt_submit',
              // Same rule as the daemon-mode running broadcast in `onActive`:
              // an empty name is omitted rather than written, because a blank
              // overwrite erases a legitimate label the renderer already has.
              ...(ev.agent ? { agentName: ev.agent, agentSlug: promptSlug ?? null } : {}),
            });
          } else if (ev.signal && this.activityThrottle.allow(payload.sessionId)) {
            // agent.activity, or a kind this build does not know yet: the
            // throttled Fleet View line. Unknown kinds are safe here — the
            // branch can only ever write the activity metadata field.
            broadcastMetadataUpdate(win, {
              ptyId: payload.sessionId,
              activity: activityFromSignalPayload(ev.signal.payload),
            });
          }
          return;
        }

        // #935 — daemon-mode twin of the PTYBridge status gate. Claude's
        // bypass-mode footer is on screen for the whole turn, so an ungated
        // broadcast wrote a false 'waiting' onto the roster row and into
        // "N need you". Identity still rides every event; only the lifecycle
        // status is withheld.
        //
        // The two arms mirror the notification veto's own split below, and for
        // the same reason — an arbitrated event already carries the daemon's
        // judgement, so main must not re-run its own authority on top of it:
        //
        //   arbitrated  → trust the stamp. Withhold on 'veto' (the daemon
        //                 applied exactly this rule) and nothing else. Note
        //                 M1 makes this the ONLY live arm: `hooks.rpc` returns
        //                 at the daemon relay, above its `touchAuthority`
        //                 call, so main's router never gains authority over a
        //                 daemon-served pane.
        //   otherwise   → the pre-M1 fallback, where main's own authority is
        //                 the only thing that knows.
        //
        // `awaiting_input` is excluded on BOTH arms. The daemon already
        // refuses to stamp 'veto' on it (HookIngest), but that guarantee lives
        // in another process: an older daemon paired with this main would
        // otherwise hide a real approval prompt for the full authority TTL,
        // which is worse than the bug this fixes. Cheap to enforce locally.
        const statusSlug = agentDisplayToSlug(ev.agent);
        const statusRouter = this.getHookRouter?.() ?? null;
        // A pane is a shell: the agent that reported a turn start may already be
        // gone and a different one launched in its place. Main's authority map
        // is never touched for a daemon-served pane, so this is the daemon-mode
        // arm of that invalidation — without it the new agent's dot would be
        // muted by the old one's latch. Same-agent events are a no-op.
        statusRouter?.noteAgentOnPane(payload.sessionId, statusSlug);
        const withholdStatus = ev.status !== 'awaiting_input' && (
          arbitratedSource(ev)
            ? arbitratedDecision(ev) === 'veto'
            : statusRouter?.governsDetectorStatus(payload.sessionId, statusSlug, ev.status) === true
        );
        broadcastMetadataUpdate(win, {
          ptyId: payload.sessionId,
          ...(withholdStatus ? {} : { agentStatus: ev.status }),
          agentName: ev.agent,
          // P2: carry the slug (daemon-mode path — the packaged production path)
          // so the renderer builds the pane auto-name `(<agent>)` suffix. ev.agent
          // is the display name; mirrors the PTYBridge local-mode broadcast.
          agentSlug: statusSlug ?? null,
        });
        // #935 direction 3: recorded at the broadcastMetadataUpdate funnel —
        // withheld statuses never reach `agentStatus` in that payload, so
        // they never land in the tracker either.
        // Cache the agent display name for any subsequent OSC 133
        // command_end on this PTY. Daemon mode has no direct equivalent
        // of `agentDetector.getLastAgent()` because the detector lives in
        // the daemon process — the freshest signal main sees is each
        // session:agent payload.
        if (ev.agent) {
          this.lastAgentNameByPty.set(payload.sessionId, ev.agent);
        }
        // 'error' joins the emit-class statuses: it is what the daemon ships
        // for `agent.stop_failure`, a turn that ended on an API error. It is as
        // much a turn boundary as 'complete' — the operator is owed the toast
        // and the idle-clear suppression window — it simply finished nothing.
        if (
          ev.status === 'waiting' || ev.status === 'complete'
          || ev.status === 'awaiting_input' || ev.status === 'error'
        ) {
          this.lastAgentEventAt.set(payload.sessionId, Date.now());

          // Hook-authority veto — daemon-mode twin of PTYBridge.onEvent.
          // While this pane's hook bridge is alive for the SAME agent, the
          // hook Stop signal is canonical: the detector's footer heuristics
          // fire mid-turn (Claude's status footer is always visible) and
          // would pre-poison the dedup ledger so the real Stop lands as
          // 'dedup' → silent completion. The metadata broadcast above rides
          // the SAME rule now (#935) — it withholds the lifecycle status and
          // carries identity only, so the roster stops showing a working pane
          // as waiting.
          //
          // codex review catch (round 2): this must NOT cover
          // 'awaiting_input'. Claude's hooks.json wires PreToolUse ONLY for
          // the AskUserQuestion tool — the far more common approval
          // prompts ("Do you want to proceed?", "Allow tool use for X",
          // Claude's default permission-mode Y/N gate) have NO hook at
          // all; AgentDetector's regex patterns are the ONLY signal source
          // for those. Vetoing 'awaiting_input' here would leave an agent
          // blocked on a real approval prompt completely silent for the
          // full authority TTL (up to 30 minutes) — worse than any bug
          // this PR set out to fix.
          //
          // M1: SKIP the veto entirely for a daemon-ARBITRATED event. The
          // daemon stamps `source` once it owns hook ingest, meaning it already
          // weighed hook against detector for this turn and forwarded only the
          // winner. Re-running the veto here would suppress the very signal the
          // hook produced (the pane is hook-governed BECAUSE of it), turning
          // every hook completion silent.
          const slug = agentDisplayToSlug(ev.agent);
          const hookRouter = this.getHookRouter?.() ?? null;
          const arbitrated = arbitratedSource(ev);
          const decision = arbitratedDecision(ev);
          if (arbitrated) {
            // 'veto' is the daemon having applied the rule this block used to
            // apply locally: a detector event on a hook-governed pane.
            // 'internal' is the daemon's CompletionAlarm rejecting the
            // candidate as not-a-real-turn-end (subagent stop, leftover
            // background work, turn-gate miss, already announced, or a
            // rebutted window). Nothing else fires either way. They differ
            // only in the status dot: 'veto' means the hook owns the
            // lifecycle, so the broadcast above withheld the status (#935);
            // 'internal' is the alarm's own judgement and leaves it live.
            if (decision === 'veto' || decision === 'internal') return;
          } else if (
            ev.status !== 'awaiting_input'
            && slug
            && hookRouter?.isGovernedFor(payload.sessionId, slug)
          ) {
            return;
          }

          const kind = lifecycleKindFor(ev);

          // M1 replay — turn-boundary metadata (activity clear + pendingQuestion
          // + completion status) and the transcript tail. Hook-sourced events
          // only: `ev.signal` rides exclusively on those, and a detector event
          // never produced these side effects in main either. The tail is read
          // ONCE here and reused for the lifecycle tee below, mirroring the
          // local handler's single read. See buildTurnBoundaryMetadata.
          const hookSignal = arbitrated ? ev.signal ?? null : null;
          const stopMessage = hookSignal ? readStopMessage(hookSignal) : null;
          const boundary = hookSignal
            ? buildTurnBoundaryMetadata(hookSignal.kind, stopMessage)
            : null;
          if (boundary) {
            broadcastMetadataUpdate(win, { ptyId: payload.sessionId, ...boundary });
          }

          const title = `${ev.agent}: ${ev.message}`;
          const body = ev.status === 'awaiting_input'
            ? 'Awaiting input'
            // A turn the API killed finished nothing. Its title already says
            // so ("Turn failed (API error)", from the daemon's eventShapeFor);
            // 'Task finished' underneath it would take the claim straight back.
            : ev.status === 'error' ? 'The turn ended on an API error'
              : ev.status === 'waiting' ? 'Ready for input' : 'Task finished';
          // 'dedup' means the other source already fanned out this turn, so the
          // tee below still records it but no second toast fires — the same
          // rule main's own hooks.signal handler applies to its dedup verdict.
          if (!(arbitrated && decision === 'dedup')) {
            dispatchNotification(
              win,
              payload.sessionId,
              // Daemon-mode twin of PTYBridge's detector path: text-only signal,
              // so anything that isn't an approval prompt is 'agent-turn' (#516).
              // A hook-sourced event knows more — only the hook can tell a
              // subagent turn from a main-agent one — so it keeps the 'subagent'
              // category main's own hook handler assigns, which is what the
              // renderer's per-category mute reads.
              {
                type: 'agent',
                title,
                body,
                category: kind === 'agent.subagent_stop'
                  ? 'subagent'
                  : ev.status === 'awaiting_input' ? 'approval' : 'agent-turn',
              },
              { ptyId: payload.sessionId },
            );
          }

          // Tee to EventBus for external observers (orchestrator clients via
          // `wmux_events_poll`). The local-mode mirror of this lives in
          // PTYBridge.onEvent; codex round-2 catch was that without this
          // branch, daemon-backed panes (the default production path) emit
          // ZERO detector-sourced `agent.lifecycle` events even though the
          // detector inside the daemon is fully alive. Workspace resolution
          // and ledger update fire-and-forget — we don't await before
          // returning from the IPC handler, so the toast/sendNotification
          // path above is never blocked on a renderer round-trip.
          //
          // `awaiting_input` maps to its own lifecycle kind so orchestrators
          // can distinguish "turn ended, next instruction please" from
          // "agent paused mid-turn for a y/N answer". Parity with the
          // local-mode PTYBridge.onEvent path added in the same patch.
          // M1: `arbitrated` carries the daemon's source + verdict through to
          // the tee, so the event reads `source:'hook'`/`decision:'dedup'` and
          // main's ledger is left alone.
          //
          // `agent.stop_failure` is skipped: `lifecycleKindFor` would fall
          // through to 'agent.stop' for it (its hookKind is not one of the
          // three the published `AgentLifecycleEvent.kind` union names), and a
          // failed turn announced to orchestrators as a normal stop is worse
          // than no event. Widening that union is a separate change. Same
          // boundary the local `hooks.signal` path draws.
          if (ev.hookKind === 'agent.stop_failure') return;
          void this.emitDetectorLifecycle(
            payload.sessionId,
            ev.agent,
            kind,
            arbitrated
              ? {
                source: arbitrated,
                decision: decision === 'dedup' ? 'dedup' : 'emit',
                lastMessage: stopMessage,
                signal: hookSignal,
              }
              : null,
          );
        }
      } catch (err) {
        console.warn('[DaemonNotificationRouter] session:agent error:', err);
      }
    };

    /**
     * Release the pane's hook turn latch on the OSC 133 back-at-prompt edge and
     * settle its dot, on the same METADATA_UPDATE funnel the process-death edge
     * uses.
     *
     * Only a LATCHED pane is touched: the latch is the claim this edge exists to
     * withdraw, and a pane that never had one is still the byte heuristic's to
     * write. The latch is released FIRST, exactly as the death edge does it, so
     * the broadcast is not vetoed by the gate it exists to escape — and it is
     * released even when the broadcast is withheld, because a shell at a prompt
     * is proof the turn is over either way.
     */
    const settleAtShellPrompt = (ptyId: string) => {
      settleHookTurnToIdle(
        ptyId,
        this.getHookRouter?.() ?? null,
        this.getWindow(),
        this.now(),
      );
    };

    // OSC 133 D markers from daemon mode. Mirror of PTYBridge.OscParser
    // case 133 — the daemon already parsed the payload and forwarded a
    // PromptEvent; we only need to dispatch `command_end` to the
    // EventBus tee (PromptEventLog inside the daemon is the canonical
    // byte-offset log; this is the parallel projection for
    // workspaceId-scoped poll consumers).
    const onPrompt = (payload: { sessionId: string; event: unknown }) => {
      try {
        const ev = payload.event as { type?: string; exitCode?: number } | null;
        if (!ev || typeof ev !== 'object') return;
        // THE PROMPT-SPEED SETTLE. Shell integration is tier-1 authoritative in
        // `isPaneAgentBusy`, above process truth: a shell that has printed its
        // prompt again cannot be mid-turn, because whatever owned the PTY —
        // the agent the operator exited, or one that died on a network error
        // and so never sent a turn end — is gone. And unlike the process-death
        // edge below it needs no attribution: this marker names the pane's own
        // PTY, where `AgentProcessTracker` frequently cannot name the process
        // at all (live dogfood: `agentAliveByPtyId` empty for a whole session,
        // so a hook-latched pane sat lit for minutes after `claude` exited).
        if (ev.type && AT_PROMPT_MARKERS.has(ev.type)) settleAtShellPrompt(payload.sessionId);
        if (ev.type !== 'command_end') return;
        const exitCode = typeof ev.exitCode === 'number' ? ev.exitCode : null;
        void this.emitOsc133Lifecycle(payload.sessionId, exitCode);
      } catch (err) {
        console.warn('[DaemonNotificationRouter] session:prompt error:', err);
      }
    };

    // Terminal desktop notifications (OSC 9/777/99) parsed in the daemon.
    // Surface parity with the local-mode PTYBridge OSC switch (in-app
    // notification + toast), plus the EventBus `notification.received` tee
    // that both modes share. Smarter surface policy (attention ring,
    // focus-aware suppression) layers on top of the EventBus event later.
    const onNotification = (payload: { sessionId: string; event: unknown }) => {
      try {
        const ev = payload.event as { source?: string; title?: string | null; body?: string } | null;
        if (!ev || typeof ev !== 'object') return;
        if (ev.source !== 'osc9' && ev.source !== 'osc777' && ev.source !== 'osc99') return;
        if (typeof ev.body !== 'string' || ev.body.length === 0) return;
        const title = typeof ev.title === 'string' && ev.title.length > 0 ? ev.title : null;
        const win = this.getWindow();
        dispatchNotification(
          win,
          payload.sessionId,
          { type: 'info', title: title ?? 'Terminal', body: ev.body, category: 'terminal' },
          { ptyId: payload.sessionId },
        );
        // X1 — fold the latest notification text into the sidebar metadata
        // (schema-freeze §2 lastNotificationText). The renderer merges it
        // into WorkspaceMetadata and renders the one-line summary.
        broadcastMetadataUpdate(win, {
          ptyId: payload.sessionId,
          lastNotificationText: {
            ts: Date.now(),
            title,
            body: ev.body,
            source: ev.source,
          },
        });
        void this.emitNotificationReceived(payload.sessionId, {
          source: ev.source,
          title,
          body: ev.body,
        });
      } catch (err) {
        console.warn('[DaemonNotificationRouter] session:notification error:', err);
      }
    };

    const onActive = (payload: { sessionId: string; agentName?: string }) => {
      try {
        // Daemon-mode twin of the PTYBridge.onActive gate: a pane whose bridge
        // reports turn starts has a better answer than this burst does, and an
        // unconditional 'running' here is what overwrote a correct
        // 'complete'/'awaiting_input' on every mid-turn redraw.
        if (this.getHookRouter?.()?.governsRunningState(payload.sessionId, this.now())) return;
        // Settle-redraw guard, twin of PTYBridge's: the repaint that follows a
        // settle (an interrupt's "Interrupted …", a shell redrawing its prompt)
        // must not re-light the pane it just cleared.
        if (recentlySettled(payload.sessionId, SETTLE_REDRAW_GUARD_MS, this.now())) return;
        // daemon이 active 이벤트에 gate로 확정한 agentName을 실어 보낸다(있으면).
        // 이게 있어야 idle prompt 패턴이 안 잡히는 에이전트(Claude Code v2.1.x:
        // 입력대기 hint가 "❯"만 남음)도 running 상태에서 agentName이 채워진다.
        // 없으면 필드를 생략해 이전 이름을 보존한다 — 빈 문자열로 덮으면 renderer의
        // Object.assign이 정당한 이름을 지워 사이드바 라벨이 매 버스트마다 깜빡인다.
        broadcastMetadataUpdate(this.getWindow(), {
          ptyId: payload.sessionId,
          agentStatus: 'running',
          // P2: include the slug alongside the gated name (daemon-mode running
          // broadcast) so the auto-name suffix fills as soon as the name does.
          ...(payload.agentName
            ? { agentName: payload.agentName, agentSlug: agentDisplayToSlug(payload.agentName) ?? null }
            : {}),
        });
        // #935 direction 3: recorded at the broadcastMetadataUpdate funnel.
      } catch (err) {
        console.warn('[DaemonNotificationRouter] session:active error:', err);
      }
    };

    const onIdle = (payload: { sessionId: string }) => {
      const now = Date.now();
      // Daemon-mode twin of the PTYBridge.onActiveToIdle gate: byte silence on
      // a hook-governed pane is not a turn end (quiet reasoning, a long tool
      // call), so the clear would only make the dot flicker. The hook's Stop
      // settles it; the process-death edge covers an agent that never sent one.
      if (this.getHookRouter?.()?.governsRunningState(payload.sessionId, now)) return;
      const lastAgentAt = this.lastAgentEventAt.get(payload.sessionId) ?? 0;
      // #935 direction 3: the suppression window defers to a recent precise
      // status ONLY while that status is still what is actually showing.
      // `onActive` broadcasts 'running' unconditionally — no deference of its
      // own — so a burst inside this window overwrites a correct
      // 'complete'/'waiting' with 'running', and this pane would then wedge
      // at 'running' forever if the clear below kept deferring to a status
      // that 'running' already clobbered. Once the live status IS 'running',
      // there is nothing left to defer to, so the window no longer applies.
      // #935 direction 3: recorded at the broadcastMetadataUpdate funnel
      // (metadata.handler.ts) — shared with PTYBridge, so a status this
      // router only replayed (line ~852 below) still counts as precise.
      const stillPrecise = getLastBroadcastAgentStatus(payload.sessionId) !== 'running';
      if (stillPrecise && now - lastAgentAt < AGENT_EVENT_SUPPRESSION_MS) return;
      // Accepted cost of #935 direction 3, do not "fix" — see PTYBridge.ts's
      // identical comment at its onActiveToIdle equivalent: a turn that is
      // genuinely still running and goes byte-quiet inside this window now
      // clears to 'idle' with no deferral until the next burst. Deferring
      // again here would reopen the wedge this direction closes.
      // No resize/typing gate here: this handler's only job is the status
      // clear, and dropping it wedges the pane at `running` permanently
      // (ActivityMonitor has already consumed the transition, and a quiet pane
      // never produces another burst to re-fire it). See idleSuppression.ts
      // and issue #733. The precise-status deference above still applies.
      try {
        const win = this.getWindow();
        // Daemon-mode twin of PTYBridge.onActiveToIdle: keep the stale-'running'
        // → 'idle' clear (sidebar dot self-heal) but DROP the byte-silence
        // toast — it's the "Task may have finished" false-positive (fires
        // mid-turn and on plain shells). Precise completions still come from the
        // Stop/awaiting_input hook + detector paths. See
        // plans/agent-status-dot-quiet-notifications-2026-07-12.md.
        broadcastMetadataUpdate(win, {
          ptyId: payload.sessionId,
          agentStatus: 'idle',
          agentName: '',
        });
      } catch (err) {
        console.warn('[DaemonNotificationRouter] session:idle error:', err);
      }
    };

    /**
     * The agent process inside a still-live pane died (AgentProcessTracker's
     * alive->dead edge). This is the second and last settle path for a pane
     * whose status the hook owns: the first is the Stop hook, and an agent
     * killed mid-turn never sends one. Byte silence no longer clears such a
     * pane, so without this the dot would stay lit for the authority TTL.
     *
     * It is also, unguarded, a way to LOSE state: an exit is only ever a reason
     * to clear a pane that is currently claiming to be working, and only when
     * the process that died is the one this pane was running. Three guards, in
     * the order they can disqualify the edge most cheaply:
     *
     *   1. ATTRIBUTION. `slug: null` is the tracker admitting it could not name
     *      the process it was watching (arm failure, backoff, a pick with no
     *      slug). An unattributed death is not evidence about THIS pane.
     *   2. IDENTITY. A named death must match the agent the pane is running, or
     *      it belongs to some other process the tracker followed into this
     *      session — a sidecar, a leftover child, a previous launch.
     *   3. LIVE STATUS. Only a pane showing 'running' (or holding an open turn
     *      latch) has anything to settle. `complete` / `awaiting_input` /
     *      `waiting` / `error` are results the operator has not read yet, and
     *      the agent exiting afterwards does not un-finish the turn. This
     *      reuses the same `getLastBroadcastAgentStatus` record #935 added for
     *      onIdle's deference.
     *
     * `agentName` is deliberately NOT cleared: it is per-PTY identity ("this
     * pane is a Claude Code pane"), not a liveness claim, and blanking it drops
     * the roster row's label — and with it the pane's place in the roster —
     * for a pane that is still very much there.
     *
     * The order matters — the hook's claim is released FIRST, so the clear
     * below is not vetoed by the very gate it exists to escape.
     */
    const onAgentProcessExit = (payload: { sessionId: string; slug?: string | null }) => {
      try {
        if (!payload.slug) return;
        const paneName = this.lastAgentNameByPty.get(payload.sessionId);
        const paneSlug = paneName ? agentDisplayToSlug(paneName) : undefined;
        // An unknown pane agent cannot contradict the tracker: the payload is
        // then the only attribution anyone has.
        if (paneSlug && paneSlug !== payload.slug) return;
        const router = this.getHookRouter?.() ?? null;
        const latchOpen = router?.governsRunningState(payload.sessionId, this.now()) === true;
        if (!latchOpen && getLastBroadcastAgentStatus(payload.sessionId) !== 'running') return;
        router?.releaseHookTurnStart(payload.sessionId);
        broadcastSettledIdle(payload.sessionId, this.getWindow(), this.now());
      } catch (err) {
        console.warn('[DaemonNotificationRouter] agent process exit error:', err);
      }
    };

    // session:died (natural PTY exit) and session:destroyed (pty:dispose)
    // both clear agentStatus. Only listening to session:died left a stale
    // sidebar dot when the user closed a terminal intentionally (Codex P2).
    const onSessionEnd = (payload: { sessionId: string }) => {
      try {
        broadcastMetadataUpdate(this.getWindow(), {
          ptyId: payload.sessionId,
          agentStatus: 'idle',
          agentName: '',
          // The session is over — nothing is waiting on an answer. Same reason
          // agentStatus is cleared here: a dead pane must not keep advertising
          // a pending question on `pane_list`.
          pendingQuestion: '',
        });
        this.lastAgentEventAt.delete(payload.sessionId);
        this.lastAgentNameByPty.delete(payload.sessionId);
        clearLastBroadcastAgentStatus(payload.sessionId);
        clearSuppression(payload.sessionId);
        // Release the dedup ledger AND the hook authority for this pane.
        // Daemon-backed panes never pass through PTYBridge.cleanupInstance
        // (the local-mode caller of dropPty), so without this a disposed
        // pane's hook authority would linger for the 30min TTL and veto
        // detector notifications on a reused session id.
        this.getHookRouter?.()?.dropPty(payload.sessionId);
      } catch (err) {
        console.warn('[DaemonNotificationRouter] session end error:', err);
      }
    };

    // X8 — supervised-pane lifecycle tees. DaemonClient re-emits the daemon's
    // session.restarted / supervision.changed broadcasts as these convenience
    // events; we project them onto the EventBus (workspace-scoped) for
    // `events.poll` consumers. The renderer-facing surfaces (PTY_RESTARTED
    // relay, badge sync, guard-trip toast) live in pty.handler on its own
    // subscriptions, so this tee is purely additive.
    const onRestarted = (payload: {
      sessionId: string;
      restartCount: number;
      consecutiveFailures: number;
      exitCode: number | null;
    }) => {
      void this.emitPaneRestarted(payload.sessionId, payload.restartCount, payload.exitCode);
    };
    const onSupervisionChanged = (payload: {
      sessionId: string;
      status: 'armed' | 'stopped';
      reason: 'guard-trip' | 'rearm' | 'manual-stop';
      restartCount: number;
      consecutiveFailures: number;
    }) => {
      void this.emitPaneSupervision(payload.sessionId, payload.status, payload.reason);
    };

    // A2A channels (a2a-channels U4) — daemon → main EventBus tee. See
    // emitChannelMessage for the projection contract.
    const onChannelMessage = (payload: { data: unknown }) => {
      try {
        const ev = payload.data as Parameters<typeof this.emitChannelMessage>[0] | null;
        if (!ev || typeof ev !== 'object') return;
        this.emitChannelMessage(ev);
      } catch (err) {
        console.warn('[DaemonNotificationRouter] channel:message error:', err);
      }
    };

    // A1 — catalog/membership lifecycle tee. Same bridge contract as
    // onChannelMessage; see emitChannelCatalog for the projection.
    const onChannelCatalog = (payload: { data: unknown }) => {
      try {
        const ev = payload.data as Parameters<typeof this.emitChannelCatalog>[0] | null;
        if (!ev || typeof ev !== 'object') return;
        this.emitChannelCatalog(ev);
      } catch (err) {
        console.warn('[DaemonNotificationRouter] channel:catalog error:', err);
      }
    };

    // Channels v2 — wake-worker nudge exhaustion: the human handoff. See
    // emitChannelNudgeExhausted for the surfaces (toast + OS notification +
    // EventBus tee).
    const onChannelNudgeExhausted = (payload: { data: unknown }) => {
      try {
        const ev = payload.data as Parameters<typeof this.emitChannelNudgeExhausted>[0] | null;
        if (!ev || typeof ev !== 'object') return;
        this.emitChannelNudgeExhausted(ev);
      } catch (err) {
        console.warn('[DaemonNotificationRouter] channel:nudgeExhausted error:', err);
      }
    };

    this.daemonClient.on('session:agent', onAgent);
    this.daemonClient.on('session:active', onActive);
    this.daemonClient.on('session:idle', onIdle);
    this.daemonClient.on('session:prompt', onPrompt);
    this.daemonClient.on('session:notification', onNotification);
    this.daemonClient.on('session:died', onSessionEnd);
    this.daemonClient.on('session:destroyed', onSessionEnd);
    this.daemonClient.on('session:agentProcessExit', onAgentProcessExit);
    this.daemonClient.on('session:restarted', onRestarted);
    this.daemonClient.on('supervision:changed', onSupervisionChanged);
    // A2A channels (a2a-channels U4) — project daemon-broadcast channel
    // messages onto the main-process EventBus so `events.poll` consumers
    // (renderer's channelsSlice in U6 + orchestrator clients) see them.
    // The projection does NOT await workspace resolution: the sender's
    // workspaceId is already authoritative on the event (frozen at
    // ChannelService.post critical-section entry, plan KTD3), so the
    // projection is sync. Per-recipient scope is `events.poll`'s job
    // (events.rpc.ts), NOT this tee's.
    this.daemonClient.on('channel:message', onChannelMessage);
    this.daemonClient.on('channel:catalog', onChannelCatalog);
    this.daemonClient.on('channel:nudgeExhausted', onChannelNudgeExhausted);

    // Invalidate the workspace.list cache whenever a workspace's metadata
    // mutates. Workspace creation/deletion does not currently publish to
    // this event, so the TTL is the worst-case staleness for those paths
    // (UI flow rarely overlaps a sub-2s race with notification routing).
    const unsubscribeMeta = eventBus.subscribe((event) => {
      if (event.type === 'workspace.metadata.changed') {
        this.invalidateWorkspaceCache();
      }
    });

    this.cleanups.push(
      () => this.daemonClient.off('session:agent', onAgent),
      () => this.daemonClient.off('session:active', onActive),
      () => this.daemonClient.off('session:idle', onIdle),
      () => this.daemonClient.off('session:prompt', onPrompt),
      () => this.daemonClient.off('session:notification', onNotification),
      () => this.daemonClient.off('session:died', onSessionEnd),
      () => this.daemonClient.off('session:destroyed', onSessionEnd),
      () => this.daemonClient.off('session:agentProcessExit', onAgentProcessExit),
      () => this.daemonClient.off('session:restarted', onRestarted),
      () => this.daemonClient.off('supervision:changed', onSupervisionChanged),
      () => this.daemonClient.off('channel:message', onChannelMessage),
      () => this.daemonClient.off('channel:catalog', onChannelCatalog),
      () => this.daemonClient.off('channel:nudgeExhausted', onChannelNudgeExhausted),
      unsubscribeMeta,
    );
  }

  stop(): void {
    for (const fn of this.cleanups) {
      try { fn(); } catch (err) { console.warn('[DaemonNotificationRouter] cleanup error:', err); }
    }
    this.cleanups.length = 0;
    this.lastAgentEventAt.clear();
    this.lastAgentNameByPty.clear();
    // #935 direction 3: no `lastBroadcastAgentStatus.clear()` here — that
    // tracker moved to metadata.handler.ts as a shared, module-level map fed
    // by both this router and PTYBridge's local-mode broadcasts. Wiping it
    // wholesale on this router's stop() would erase unrelated local-mode
    // PTYs' tracked status. Per-PTY cleanup already runs on session end (see
    // `clearLastBroadcastAgentStatus` above); there is nothing of this
    // router's own left to clear here.
    this.activityThrottle.clear();
    this.workspaceCache = null;
  }
}
