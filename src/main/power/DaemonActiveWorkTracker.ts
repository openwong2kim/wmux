import type { EventEmitter } from 'node:events';
import type { ActiveWorkPowerBlocker, ActiveWorkSessionSnapshot, PromptBoundaryType } from './ActiveWorkPowerBlocker';

export type DaemonActiveWorkClient = Pick<EventEmitter, 'on' | 'removeListener'> & {
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

type PromptPayload = { sessionId: string; event?: { type?: string } };
type SessionPayload = { sessionId: string };
type DaemonEventPayload = { type?: string; sessionId?: string; data?: unknown };

/**
 * Connects daemon lifecycle broadcasts and hydration snapshots to the active
 * work power policy. Keeping this coordinator outside main/index.ts makes the
 * reconnect and hydration races testable without booting Electron.
 */
export class DaemonActiveWorkTracker {
  private detachCurrent: ((clearDaemonState?: boolean) => void) | null = null;

  constructor(
    private readonly blocker: ActiveWorkPowerBlocker,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  async attach(client: DaemonActiveWorkClient): Promise<void> {
    this.detach(false);

    const onPrompt = (payload: PromptPayload) => {
      const type = payload.event?.type;
      if (this.isPromptBoundary(type)) {
        this.blocker.promptBoundary(payload.sessionId, type);
      }
    };
    const onEnded = (payload: SessionPayload) => {
      this.blocker.sessionEnded(payload.sessionId);
    };
    const onCreated = (event: DaemonEventPayload) => {
      if (event.type !== 'session.created' || !event.sessionId) return;
      const data = event.data as { hasExec?: boolean } | null;
      this.blocker.sessionCreated(event.sessionId, data?.hasExec === true);
    };

    client.on('session:prompt', onPrompt);
    client.on('session:died', onEnded);
    client.on('session:destroyed', onEnded);
    client.on('event', onCreated);

    let attached = true;
    const detach = (clearDaemonState = true) => {
      if (!attached) return;
      attached = false;
      client.removeListener('session:prompt', onPrompt);
      client.removeListener('session:died', onEnded);
      client.removeListener('session:destroyed', onEnded);
      client.removeListener('event', onCreated);
      if (clearDaemonState) this.blocker.clearDaemon();
      if (this.detachCurrent === detach) this.detachCurrent = null;
    };
    this.detachCurrent = detach;

    // Subscribe before hydration so no command boundary can slip between the
    // snapshot and listener install. If an event races an RPC response, reject
    // that stale snapshot and retry rather than undoing the newer lifecycle.
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision = this.blocker.revision;
      try {
        const sessions = await client.rpc('daemon.listSessions', {}) as ActiveWorkSessionSnapshot[];
        if (!attached) return;
        if (this.blocker.replaceSessionsIfUnchanged(sessions, revision)) return;
      } catch (err) {
        this.log(`active-work hydration failed: ${String(err)}`);
        return;
      }
    }
    this.log('active-work hydration stayed busy across 3 attempts; live events remain authoritative');
  }

  detach(clearDaemonState = true): void {
    this.detachCurrent?.(clearDaemonState);
  }

  private isPromptBoundary(type: string | undefined): type is PromptBoundaryType {
    return type === 'prompt_start' || type === 'prompt_end' ||
      type === 'command_start' || type === 'command_end';
  }
}
