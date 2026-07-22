export interface PowerSaveBlockerLike {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
}

export interface ActiveWorkSessionSnapshot {
  id: string;
  state: string;
  commandRunning?: boolean;
  exec?: unknown;
}

export type PromptBoundaryType =
  | 'prompt_start'
  | 'prompt_end'
  | 'command_start'
  | 'command_end';

/**
 * Holds Windows out of Modern Standby only while a foreground terminal
 * command (or a daemon exec unit) is genuinely running. Idle shells do not
 * hold a power request, so normal sleep policy resumes as soon as work ends.
 */
export class ActiveWorkPowerBlocker {
  private readonly activeSessionIds = new Set<string>();
  private blockerId: number | null = null;
  private lifecycleRevision = 0;
  private daemonReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly blocker: PowerSaveBlockerLike,
    private readonly enabled: boolean,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  replaceSessions(sessions: readonly ActiveWorkSessionSnapshot[]): void {
    this.cancelDaemonReconnectGrace();
    this.deleteSource('daemon');
    for (const session of sessions) {
      const live = session.state === 'attached' || session.state === 'detached';
      if (live && (session.commandRunning === true || session.exec != null)) {
        this.activeSessionIds.add(this.key('daemon', session.id));
      }
    }
    this.reconcile();
  }

  get revision(): number {
    return this.lifecycleRevision;
  }

  replaceSessionsIfUnchanged(
    sessions: readonly ActiveWorkSessionSnapshot[],
    expectedRevision: number,
  ): boolean {
    if (this.lifecycleRevision !== expectedRevision) return false;
    this.replaceSessions(sessions);
    return true;
  }

  sessionCreated(sessionId: string, hasExec: boolean): void {
    this.lifecycleRevision++;
    if (hasExec) this.activeSessionIds.add(this.key('daemon', sessionId));
    this.reconcile();
  }

  promptBoundary(sessionId: string, type: PromptBoundaryType): void {
    this.lifecycleRevision++;
    const key = this.key('daemon', sessionId);
    if (type === 'command_start') {
      this.activeSessionIds.add(key);
    } else {
      this.activeSessionIds.delete(key);
    }
    this.reconcile();
  }

  sessionEnded(sessionId: string): void {
    this.lifecycleRevision++;
    this.activeSessionIds.delete(this.key('daemon', sessionId));
    this.reconcile();
  }

  localPromptBoundary(sessionId: string, type: PromptBoundaryType): void {
    this.lifecycleRevision++;
    const key = this.key('local', sessionId);
    if (type === 'command_start') {
      this.activeSessionIds.add(key);
    } else {
      this.activeSessionIds.delete(key);
    }
    this.reconcile();
  }

  localSessionEnded(sessionId: string): void {
    this.lifecycleRevision++;
    this.activeSessionIds.delete(this.key('local', sessionId));
    this.reconcile();
  }

  /** Keep the last daemon state briefly while the respawn controller reconnects. */
  beginDaemonReconnectGrace(graceMs: number): void {
    this.cancelDaemonReconnectGrace();
    if (!this.hasSource('daemon')) return;
    this.daemonReconnectTimer = setTimeout(() => {
      this.daemonReconnectTimer = null;
      this.lifecycleRevision++;
      this.deleteSource('daemon');
      this.reconcile();
      this.log(`daemon reconnect grace expired after ${graceMs}ms`);
    }, graceMs);
  }

  clearDaemon(): void {
    this.lifecycleRevision++;
    this.cancelDaemonReconnectGrace();
    this.deleteSource('daemon');
    this.reconcile();
  }

  clear(): void {
    this.lifecycleRevision++;
    this.cancelDaemonReconnectGrace();
    this.activeSessionIds.clear();
    this.reconcile();
  }

  dispose(): void {
    this.cancelDaemonReconnectGrace();
    this.activeSessionIds.clear();
    if (this.blockerId !== null) {
      try {
        this.blocker.stop(this.blockerId);
      } catch (err) {
        this.log(`failed to stop blocker id=${this.blockerId}: ${String(err)}`);
      }
      this.blockerId = null;
    }
  }

  private reconcile(): void {
    if (!this.enabled) return;
    if (this.activeSessionIds.size > 0 && this.blockerId === null) {
      try {
        this.blockerId = this.blocker.start('prevent-app-suspension');
        this.log(`started prevent-app-suspension id=${this.blockerId} activeSessions=${this.activeSessionIds.size}`);
      } catch (err) {
        this.log(`failed to start prevent-app-suspension: ${String(err)}`);
      }
      return;
    }
    if (this.activeSessionIds.size === 0 && this.blockerId !== null) {
      const id = this.blockerId;
      this.blockerId = null;
      try {
        this.blocker.stop(id);
        this.log(`stopped prevent-app-suspension id=${id}`);
      } catch (err) {
        this.log(`failed to stop prevent-app-suspension id=${id}: ${String(err)}`);
      }
    }
  }

  private key(source: 'daemon' | 'local', sessionId: string): string {
    return `${source}:${sessionId}`;
  }

  private hasSource(source: 'daemon' | 'local'): boolean {
    const prefix = `${source}:`;
    for (const key of this.activeSessionIds) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  private deleteSource(source: 'daemon' | 'local'): void {
    const prefix = `${source}:`;
    for (const key of this.activeSessionIds) {
      if (key.startsWith(prefix)) this.activeSessionIds.delete(key);
    }
  }

  private cancelDaemonReconnectGrace(): void {
    if (this.daemonReconnectTimer === null) return;
    clearTimeout(this.daemonReconnectTimer);
    this.daemonReconnectTimer = null;
  }
}
