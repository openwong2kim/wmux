import type { BrowserWindow } from 'electron';
import type { DaemonClient } from '../DaemonClient';
import type { AgentStatus } from '../../shared/types';
import { IPC } from '../../shared/constants';
import { sendNotification } from './sendNotification';
import { recentlySuppressed, clearPty as clearSuppression } from './idleSuppression';
import { broadcastMetadataUpdate } from '../ipc/handlers/metadata.handler';
import { toastManager } from '../pipe/handlers/notify.rpc';

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
export class DaemonNotificationRouter {
  private cleanups: Array<() => void> = [];
  private lastAgentEventAt = new Map<string, number>();

  constructor(
    private daemonClient: DaemonClient,
    private getWindow: () => BrowserWindow | null,
  ) {}

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
        if (ev.status === 'waiting' || ev.status === 'complete') {
          this.lastAgentEventAt.set(payload.sessionId, Date.now());
          const title = `${ev.agent}: ${ev.message}`;
          const body = ev.status === 'waiting' ? 'Ready for input' : 'Task finished';
          sendNotification(win, payload.sessionId, { type: 'agent', title, body });
          toastManager.show(title, body);
        }
      } catch (err) {
        console.warn('[DaemonNotificationRouter] session:agent error:', err);
      }
    };

    const onActive = (payload: { sessionId: string }) => {
      try {
        // Intentionally omit `agentName`: the daemon's AgentDetector owns
        // the last-agent name, and we can't reach into it from main. If we
        // emitted `agentName: ''` here, the renderer's Object.assign would
        // clobber the legitimate name set by the previous session:agent
        // event, making the sidebar label flicker to blank on every burst.
        // Leaving the field out preserves the prior name; the next
        // session:agent event will refresh it.
        broadcastMetadataUpdate(this.getWindow(), {
          ptyId: payload.sessionId,
          agentStatus: 'running',
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
        toastManager.show(notification.title, notification.body);
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
        clearSuppression(payload.sessionId);
      } catch (err) {
        console.warn('[DaemonNotificationRouter] session end error:', err);
      }
    };

    this.daemonClient.on('session:agent', onAgent);
    this.daemonClient.on('session:active', onActive);
    this.daemonClient.on('session:idle', onIdle);
    this.daemonClient.on('session:critical', onCritical);
    this.daemonClient.on('session:died', onSessionEnd);
    this.daemonClient.on('session:destroyed', onSessionEnd);

    this.cleanups.push(
      () => this.daemonClient.off('session:agent', onAgent),
      () => this.daemonClient.off('session:active', onActive),
      () => this.daemonClient.off('session:idle', onIdle),
      () => this.daemonClient.off('session:critical', onCritical),
      () => this.daemonClient.off('session:died', onSessionEnd),
      () => this.daemonClient.off('session:destroyed', onSessionEnd),
    );
  }

  stop(): void {
    for (const fn of this.cleanups) {
      try { fn(); } catch (err) { console.warn('[DaemonNotificationRouter] cleanup error:', err); }
    }
    this.cleanups.length = 0;
    this.lastAgentEventAt.clear();
  }
}
