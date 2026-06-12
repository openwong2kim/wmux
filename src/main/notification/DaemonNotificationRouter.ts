import type { BrowserWindow } from 'electron';
import type { DaemonClient } from '../DaemonClient';
import type { AgentStatus } from '../../shared/types';
import type { HookSignalRouter } from '../hooks/HookSignalRouter';
import { IPC } from '../../shared/constants';
import { sendNotification } from './sendNotification';
import { recentlySuppressed, clearPty as clearSuppression } from './idleSuppression';
import { broadcastMetadataUpdate } from '../ipc/handlers/metadata.handler';
import { toastManager } from '../pipe/handlers/notify.rpc';
import { eventBus } from '../events/EventBus';
import { findWorkspaceIdForPty } from '../pipe/handlers/hooks.rpc';
import { sendToRenderer } from '../pipe/handlers/_bridge';
import { agentDisplayToSlug } from '../pty/AgentDetector';

// Mirrors PTYBridge.AGENT_EVENT_SUPPRESSION_MS — same dedup semantics across
// daemon and local modes.
const AGENT_EVENT_SUPPRESSION_MS = 10_000;

interface AgentEventPayload {
  agent: string;
  status: AgentStatus;
  message: string;
}

interface CriticalEventPayload {
  action: string;
  riskLevel: 'review' | 'critical';
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
 *   - session:critical → APPROVAL_REQUEST IPC
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
   */
  private async emitDetectorLifecycle(
    ptyId: string,
    agentName: string,
    kind: 'agent.stop' | 'agent.awaiting_input' = 'agent.stop',
  ): Promise<void> {
    try {
      const slug = agentDisplayToSlug(agentName);
      if (!slug) return;
      // Sync ledger write first — parity with PTYBridge local-mode timing.
      // recordDetector is cheap (in-memory Map ops); it must precede the
      // ~50-200ms workspace.list round-trip to match local-mode semantics.
      const hookRouter = this.getHookRouter?.() ?? null;
      const decision = hookRouter
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
        source: 'detector',
        agent: slug,
        decision,
      });
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

  start(): void {
    const onAgent = (payload: { sessionId: string; event: unknown }) => {
      try {
        const win = this.getWindow();
        const ev = payload.event as AgentEventPayload;
        if (!ev || typeof ev !== 'object') return;
        broadcastMetadataUpdate(win, {
          ptyId: payload.sessionId,
          agentStatus: ev.status,
          agentName: ev.agent,
        });
        // Cache the agent display name for any subsequent OSC 133
        // command_end on this PTY. Daemon mode has no direct equivalent
        // of `agentDetector.getLastAgent()` because the detector lives in
        // the daemon process — the freshest signal main sees is each
        // session:agent payload.
        if (ev.agent) {
          this.lastAgentNameByPty.set(payload.sessionId, ev.agent);
        }
        if (ev.status === 'waiting' || ev.status === 'complete' || ev.status === 'awaiting_input') {
          this.lastAgentEventAt.set(payload.sessionId, Date.now());
          const title = `${ev.agent}: ${ev.message}`;
          const body = ev.status === 'awaiting_input'
            ? 'Awaiting input'
            : ev.status === 'waiting' ? 'Ready for input' : 'Task finished';
          sendNotification(win, payload.sessionId, { type: 'agent', title, body });
          toastManager.show(title, body, { ptyId: payload.sessionId });

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
          const kind = ev.status === 'awaiting_input' ? 'agent.awaiting_input' : 'agent.stop';
          void this.emitDetectorLifecycle(payload.sessionId, ev.agent, kind);
        }
      } catch (err) {
        console.warn('[DaemonNotificationRouter] session:agent error:', err);
      }
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
        sendNotification(win, payload.sessionId, {
          type: 'info',
          title: title ?? 'Terminal',
          body: ev.body,
        });
        toastManager.show(title ?? 'Terminal', ev.body, { ptyId: payload.sessionId });
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
        // daemon이 active 이벤트에 gate로 확정한 agentName을 실어 보낸다(있으면).
        // 이게 있어야 idle prompt 패턴이 안 잡히는 에이전트(Claude Code v2.1.x:
        // 입력대기 hint가 "❯"만 남음)도 running 상태에서 agentName이 채워진다.
        // 없으면 필드를 생략해 이전 이름을 보존한다 — 빈 문자열로 덮으면 renderer의
        // Object.assign이 정당한 이름을 지워 사이드바 라벨이 매 버스트마다 깜빡인다.
        broadcastMetadataUpdate(this.getWindow(), {
          ptyId: payload.sessionId,
          agentStatus: 'running',
          ...(payload.agentName ? { agentName: payload.agentName } : {}),
        });
      } catch (err) {
        console.warn('[DaemonNotificationRouter] session:active error:', err);
      }
    };

    const onIdle = (payload: { sessionId: string }) => {
      const now = Date.now();
      const lastAgentAt = this.lastAgentEventAt.get(payload.sessionId) ?? 0;
      if (now - lastAgentAt < AGENT_EVENT_SUPPRESSION_MS) return;
      // Same resize/typing suppression as local mode (see idleSuppression.ts).
      if (recentlySuppressed(payload.sessionId, now)) return;
      try {
        const win = this.getWindow();
        // Clear stale 'running' alongside the fallback toast, mirroring
        // PTYBridge.onActiveToIdle behavior.
        broadcastMetadataUpdate(win, {
          ptyId: payload.sessionId,
          agentStatus: 'idle',
          agentName: '',
        });
        const notification = {
          type: 'agent' as const,
          title: 'Task may have finished',
          body: 'Terminal output stopped after active period',
        };
        sendNotification(win, payload.sessionId, notification);
        toastManager.show(notification.title, notification.body, { ptyId: payload.sessionId });
      } catch (err) {
        console.warn('[DaemonNotificationRouter] session:idle error:', err);
      }
    };

    const onCritical = (payload: { sessionId: string; event: unknown }) => {
      try {
        const win = this.getWindow();
        if (!win || win.isDestroyed()) return;
        const ev = payload.event as CriticalEventPayload;
        if (!ev || typeof ev !== 'object') return;
        win.webContents.send(IPC.APPROVAL_REQUEST, payload.sessionId, {
          action: ev.action,
          riskLevel: ev.riskLevel,
        });
      } catch (err) {
        console.warn('[DaemonNotificationRouter] session:critical error:', err);
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
        });
        this.lastAgentEventAt.delete(payload.sessionId);
        this.lastAgentNameByPty.delete(payload.sessionId);
        clearSuppression(payload.sessionId);
      } catch (err) {
        console.warn('[DaemonNotificationRouter] session end error:', err);
      }
    };

    this.daemonClient.on('session:agent', onAgent);
    this.daemonClient.on('session:active', onActive);
    this.daemonClient.on('session:idle', onIdle);
    this.daemonClient.on('session:critical', onCritical);
    this.daemonClient.on('session:prompt', onPrompt);
    this.daemonClient.on('session:notification', onNotification);
    this.daemonClient.on('session:died', onSessionEnd);
    this.daemonClient.on('session:destroyed', onSessionEnd);

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
      () => this.daemonClient.off('session:critical', onCritical),
      () => this.daemonClient.off('session:prompt', onPrompt),
      () => this.daemonClient.off('session:notification', onNotification),
      () => this.daemonClient.off('session:died', onSessionEnd),
      () => this.daemonClient.off('session:destroyed', onSessionEnd),
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
    this.workspaceCache = null;
  }
}
