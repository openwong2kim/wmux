import type { AgentStatus } from '../../shared/types';
import type { TranscriptPage, TranscriptStatus } from '../../shared/transcript/turnEvents';
import type { ChatTurn } from '../chat/chatBridge';

/** The bridge surface the settle reads and writes (DaemonPTYBridge). */
export interface OpenCodeIdleBridge {
  getAgentStatus(): AgentStatus;
  isTurnOpen(): boolean;
  hasHookReports(): boolean;
  /** When the current episode's evidence began: its submit, or its opening edge. */
  getTurnEvidenceStartedAt(): number;
  noteAgentStatus(status: 'complete' | 'awaiting_input'): void;
  noteTranscriptTurnEnd(at: number): void;
}

export interface OpenCodePluginRead { status: TranscriptStatus; page: TranscriptPage; turn?: ChatTurn }

/** Status-only event: main treats `internal` as a trace, never a toast. */
export interface OpenCodeSettleEvent {
  agent: 'OpenCode';
  status: 'complete' | 'awaiting_input';
  message: string;
  source: 'detector';
  decision: 'internal';
}

export interface OpenCodeIdleSettlerDeps {
  bridge(id: string): OpenCodeIdleBridge | undefined;
  /** The pane's canonical agent slug (process, hook, then screen tier). */
  agentSlug(id: string): string | undefined;
  /** `null`: no plugin to reach here (back off); `undefined`: a transient miss. */
  read(id: string): Promise<OpenCodePluginRead | null | undefined>;
  /** Changes whenever a plugin send leaves for this pane (TerminalChatService.sendCount). */
  sendCount(id: string): number;
  emit(id: string, data: OpenCodeSettleEvent): void;
  now?: () => number;
}

/** How long an unreachable plugin is not asked again. */
export const OPENCODE_UNREACHABLE_BACKOFF_MS = 30_000;
/** The running probe retries once when the plugin has not gone busy yet. */
export const OPENCODE_RUNNING_PROBE_RETRY_MS = 1_000;

/**
 * #1621 — settles an OpenCode pane whose turn ended with no lifecycle
 * `agent.stop` (the lifecycle plugin is missing, or its signal was lost).
 * Without it the end of the turn is only byte silence, an unmarked idle, and
 * the desktop keeps the pane `running` for its whole activity window.
 *
 * The terminal chat plugin mints a turn (id + start) only on a read that sees
 * the session busy, so `onActive` reads once while the pane runs. On the idle
 * edge the read settles the pane only when the plugin's turn belongs to the
 * bridge's current episode: it started no earlier than the episode, is not the
 * turn settled last, and has ended (`complete`) or stopped on a question
 * (`awaiting_input`). A boot, a resumed or switched session, or a reattached
 * pane has no such turn, so nothing settles there.
 */
export class OpenCodeIdleSettler {
  private readonly settled = new Map<string, string>();
  private readonly unreachableUntil = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<OpenCodePluginRead | null | undefined>>();
  private readonly now: () => number;

  constructor(private readonly deps: OpenCodeIdleSettlerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Cheap gate: an OpenCode pane with an open episode that no hook governs. */
  private eligible(id: string): OpenCodeIdleBridge | undefined {
    const bridge = this.deps.bridge(id);
    if (!bridge || this.deps.agentSlug(id) !== 'opencode') return undefined;
    if (!bridge.isTurnOpen() || bridge.hasHookReports()) return undefined;
    if ((this.unreachableUntil.get(id) ?? 0) > this.now()) return undefined;
    return bridge;
  }

  /** One read per pane at a time; an unreachable plugin backs off. */
  private read(id: string): Promise<OpenCodePluginRead | null | undefined> {
    const pending = this.inflight.get(id);
    if (pending) return pending;
    const next = this.deps.read(id).then(result => {
      if (result === null) this.unreachableUntil.set(id, this.now() + OPENCODE_UNREACHABLE_BACKOFF_MS);
      else if (result) this.unreachableUntil.delete(id);
      return result;
    }).finally(() => { this.inflight.delete(id); });
    this.inflight.set(id, next);
    return next;
  }

  /** The pane went running: let the plugin observe the busy session and mint its turn. */
  async onActive(id: string, wait: (ms: number) => Promise<void> = ms => new Promise(r => { setTimeout(r, ms).unref?.(); })): Promise<void> {
    if (!this.eligible(id)) return;
    const first = await this.read(id);
    // Retry once when the plugin had not gone busy yet, or the read missed transiently.
    if (first === null || first && (!first.status.available || first.turn?.state === 'running')) return;
    await wait(OPENCODE_RUNNING_PROBE_RETRY_MS);
    const bridge = this.eligible(id);
    if (bridge && bridge.getAgentStatus() === 'running') await this.read(id);
  }

  /** Byte silence on the pane. Returns the status it settled to, if any. */
  async onIdle(id: string): Promise<OpenCodeSettleEvent['status'] | undefined> {
    const bridge = this.eligible(id);
    if (!bridge || bridge.getAgentStatus() !== 'idle') return undefined;
    const evidenceAt = bridge.getTurnEvidenceStartedAt();
    const sends = this.deps.sendCount(id);
    const result = await this.read(id);
    const status = result?.status;
    const turn = result?.turn;
    if (!result || !status?.available || !turn?.startedAt) return undefined;
    const phase = status.agentStatus;
    // `complete` is an ended turn; `awaiting_input` is a turn stopped on the
    // agent's own question (its turn stays open). Running or the admission
    // fence (an accepted send not busy yet) reads `running`.
    const ended = phase === 'complete' && turn.state === 'idle';
    if (!ended && phase !== 'awaiting_input') return undefined;
    // The plugin's turn must be this episode's: minted after the episode began.
    if (turn.startedAt < evidenceAt) return undefined;
    const key = `${result.page.cursor.historyEpoch ?? ''}|${status.agentSessionId ?? ''}|${turn.id}|${phase}`;
    if (this.settled.get(id) === key) return undefined;
    // Anything that moved during the read: a new submit, a phone send, a hook
    // or another settle, or the episode closing.
    if (bridge.getTurnEvidenceStartedAt() !== evidenceAt || this.deps.sendCount(id) !== sends
      || bridge.getAgentStatus() !== 'idle' || !bridge.isTurnOpen() || bridge.hasHookReports()) return undefined;
    const settledStatus = ended ? 'complete' : 'awaiting_input';
    // Emit before touching the bridge (no await in between, so nothing can
    // relight the pane): a failed emit leaves the pane idle and retryable.
    this.deps.emit(id, {
      agent: 'OpenCode',
      status: settledStatus,
      message: ended ? 'Turn ended' : 'Waiting for input',
      source: 'detector',
      decision: 'internal',
    });
    bridge.noteAgentStatus(settledStatus);
    // The plugin confirmed the end: close the episode for good, so the next
    // submit starts a new turn instead of resuming this one.
    if (ended) bridge.noteTranscriptTurnEnd(this.now());
    this.settled.set(id, key);
    return settledStatus;
  }

  drop(id: string): void {
    this.settled.delete(id);
    this.unreachableUntil.delete(id);
  }
}
