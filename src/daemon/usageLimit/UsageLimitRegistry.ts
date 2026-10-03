// Daemon-owned usage-limit holds, keyed by session (ptyId).
//
// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/app/App.tsx
// usage-limit resume scheduler), MIT License, Copyright (c) 2026 Nick
//
// A pane enters the registry when its agent hits a provider usage limit (the
// Claude Code StopFailure hook, or a Codex limit row on screen). While the hold
// lasts (shared/usageLimit `usageLimitHolds`), every automatic writer — the
// session prompt scheduler, the channel wake worker, main's gated delivery —
// leaves the pane alone. Once the reset passes, a pane explicitly armed with
// `autoResume: true` gets one continue message; nothing is ever sent otherwise.

import type { AgentSlug } from '../../shared/agentIdentity';
import type { DaemonEvent } from '../../shared/rpc';
import type { SessionPromptScheduleResult } from '../../shared/sessionPromptSchedule';
import {
  claudeUsageLimitFromStopFailure,
  formatResetClock,
  formatResetDuration,
  usageLimitHoldEndsAt,
  usageLimitHolds,
  usageLimitResumeDue,
  type PaneUsageLimit,
  type PaneUsageLimitPatch,
  type UsageLimitProvider,
} from '../../shared/usageLimit';

/** Re-check at most every minute: timers drift while the machine sleeps. */
const TICK_MS = 30_000;
/** A hold that ended and was not resumed is forgotten after this long. */
const FORGET_AFTER_HOLD_MS = 24 * 60 * 60 * 1000;
/** Due continues answered `busy` this many ticks in a row (~10 min) are disarmed. */
export const USAGE_LIMIT_MAX_BUSY_RETRIES = 20;

/** The agent a limit was seen on: the continue may only reach this exact process. */
export interface UsageLimitAgentIdentity {
  slug: AgentSlug;
  incarnationId: string;
}

export interface UsageLimitRegistryDeps {
  broadcast: (event: DaemonEvent) => void;
  /** The pane's current verified agent, or null when none is verified. */
  identify: (sessionId: string) => UsageLimitAgentIdentity | null;
  /**
   * Paste and submit the continue message through the scheduled-prompt proof,
   * expecting the agent recorded when the limit was seen. `stillWanted` is
   * asked again right before the paste and right before the Enter.
   */
  deliverContinue: (
    sessionId: string,
    expected: UsageLimitAgentIdentity,
    stillWanted: () => boolean,
  ) => Promise<SessionPromptScheduleResult>;
  now?: () => number;
  log?: (message: string) => void;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void;
}

/** The subset of an AgentSignal the registry reads. */
export interface UsageLimitSignal {
  kind: string;
  payload?: Record<string, unknown>;
}

/** Private per-hold bookkeeping, never broadcast. */
interface HoldMeta {
  /** Bumped for every new hold, so an in-flight continue can tell it was replaced. */
  generation: number;
  identity: UsageLimitAgentIdentity | null;
  busyRetries: number;
}

export class UsageLimitRegistry {
  private readonly limits = new Map<string, PaneUsageLimit>();
  private readonly meta = new Map<string, HoldMeta>();
  /** Screen text whose hold was cleared: a redraw of the same row must not hold again. */
  private readonly suppressed = new Map<string, string>();
  private readonly resuming = new Set<string>();
  private generation = 0;
  private ticking = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: UsageLimitRegistryDeps) {
    this.now = deps.now ?? Date.now;
  }

  list(): PaneUsageLimit[] {
    return [...this.limits.values()];
  }

  get(sessionId: string): PaneUsageLimit | undefined {
    return this.limits.get(sessionId);
  }

  /** True while automatic input into this pane must wait. */
  holds(sessionId: string): boolean {
    return usageLimitHolds(this.limits.get(sessionId), this.now());
  }

  /** One line for a refusal: what holds the pane and until when. */
  holdDetail(sessionId: string): string {
    const limit = this.limits.get(sessionId);
    if (!limit) return '';
    const now = this.now();
    const until = limit.resetsAt != null
      ? `until it resets at ${new Date(limit.resetsAt).toISOString()} (in ${formatResetDuration(limit.resetsAt - now)})`
      : `(reset time unknown; held until ${new Date(usageLimitHoldEndsAt(limit)).toISOString()} at most)`;
    return `the pane hit its ${limit.provider} usage limit and is held ${until}`;
  }

  /** Hook signals. A usage-limit StopFailure sets the hold; the operator's next prompt clears it. */
  noteHookSignal(sessionId: string, signal: UsageLimitSignal): void {
    if (signal.kind === 'agent.stop_failure') {
      const hit = claudeUsageLimitFromStopFailure(signal.payload, this.now());
      if (hit) this.set(sessionId, 'claude', 'hook', hit);
      return;
    }
    // A submitted prompt is someone retrying on purpose (or our own continue):
    // if the limit still stands, the next StopFailure puts the hold back.
    if (signal.kind === 'agent.user_prompt_submit') this.noteSubmitted(sessionId);
  }

  /** A limit row the screen detector read. */
  noteScreenLimit(sessionId: string, provider: UsageLimitProvider, hit: { resetsAt?: number; message?: string }): void {
    this.set(sessionId, provider, 'screen', hit);
  }

  /**
   * Input with a submit boundary reached the pane (a human Enter, a chat
   * prompt, our own continue). Someone is retrying on purpose: release the
   * hold. A limit that still stands is printed or reported again, and that
   * fresh sighting is honoured even if it reads the same as the old one.
   */
  noteSubmitted(sessionId: string): void {
    this.suppressed.delete(sessionId);
    this.clear(sessionId, false);
  }

  /** The pane started producing output. Past the hold, that means it is working again. */
  noteActive(sessionId: string): void {
    const limit = this.limits.get(sessionId);
    if (limit && !usageLimitHolds(limit, this.now()) && !this.resuming.has(sessionId)) this.clear(sessionId);
  }

  /** The pane's agent is gone or replaced (exit, restart, interruption): its hold goes with it. */
  drop(sessionId: string): void {
    this.suppressed.delete(sessionId);
    this.clear(sessionId, false);
  }

  /** Renderer edits relayed by main. Returns false for an unknown pane. */
  async update(sessionId: string, patch: PaneUsageLimitPatch): Promise<boolean> {
    const limit = this.limits.get(sessionId);
    if (!limit) return false;
    if (patch.dismiss) {
      this.clear(sessionId);
      return true;
    }
    if (patch.resumeNow) {
      await this.resume(sessionId, false);
      return true;
    }
    const next: PaneUsageLimit = { ...limit };
    if (typeof patch.autoResume === 'boolean') next.autoResume = patch.autoResume;
    // Main fills a reset the hook text did not carry; a known one is not overwritten.
    if (typeof patch.resetsAt === 'number' && Number.isFinite(patch.resetsAt) && next.resetsAt == null) next.resetsAt = patch.resetsAt;
    const meta = this.meta.get(sessionId);
    if (meta && next.autoResume === true) meta.busyRetries = 0;
    this.limits.set(sessionId, next);
    this.changed(sessionId, next);
    return true;
  }

  /** One pass: send due continues, forget long-ended holds. Never overlaps itself. Public for tests. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const id of [...this.limits.keys()]) {
        // Re-read every time: an earlier await may have cleared or replaced it.
        const limit = this.limits.get(id);
        if (!limit) continue;
        const now = this.now();
        if (usageLimitResumeDue(limit, now)) {
          await this.resume(id, true);
        } else if (!(limit.autoResume === true && limit.resetsAt != null) && now >= usageLimitHoldEndsAt(limit) + FORGET_AFTER_HOLD_MS) {
          this.clear(id, false);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  dispose(): void {
    if (this.timer) (this.deps.clearIntervalFn ?? clearInterval)(this.timer);
    this.timer = null;
    this.limits.clear();
    this.meta.clear();
    this.suppressed.clear();
  }

  private set(sessionId: string, provider: UsageLimitProvider, source: PaneUsageLimit['source'], hit: { resetsAt?: number; message?: string }): void {
    const now = this.now();
    // A screen row that was already cleared, redrawn: not a new limit.
    if (source === 'screen' && hit.message && this.suppressed.get(sessionId) === hit.message) return;
    const prev = this.limits.get(sessionId);
    const ongoing = !!prev && prev.provider === provider && usageLimitHolds(prev, now);
    // The same row redrawn (or its wrapped tail re-read) must not move a reset
    // already known: a relative "try again in 2 hours" re-parsed at every
    // redraw would push the hold out forever. Only filling an unknown reset is new.
    if (ongoing && prev && source === 'screen' && (prev.resetsAt != null || hit.resetsAt == null)) return;

    let meta = this.meta.get(sessionId);
    if (!ongoing) {
      const identity = this.deps.identify(sessionId);
      // The detection must belong to the agent actually running there.
      if (identity && identity.slug !== provider) {
        this.deps.log?.(`[usage-limit] ${sessionId} ignored a ${provider} limit on a ${identity.slug} pane`);
        return;
      }
      meta = { generation: ++this.generation, identity, busyRetries: 0 };
      this.meta.set(sessionId, meta);
    }
    const next: PaneUsageLimit = {
      ptyId: sessionId,
      provider,
      // A repeat of an ongoing limit keeps its first sighting and its operator choice.
      detectedAt: ongoing && prev ? prev.detectedAt : now,
      source,
      ...(hit.resetsAt != null ? { resetsAt: hit.resetsAt } : ongoing && prev?.resetsAt != null ? { resetsAt: prev.resetsAt } : {}),
      ...(ongoing && prev?.autoResume !== undefined ? { autoResume: prev.autoResume } : {}),
      ...(hit.message ? { message: hit.message } : ongoing && prev?.message ? { message: prev.message } : {}),
    };
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
    this.limits.set(sessionId, next);
    const reset = next.resetsAt != null ? `resets ${formatResetClock(next.resetsAt, now, 'en-US')}` : 'reset unknown';
    this.deps.log?.(`[usage-limit] ${sessionId} held (${provider}, ${source}, ${reset})`);
    this.changed(sessionId, next);
    this.ensureTimer();
  }

  /** `suppress`: remember the screen text, so its redraw does not hold again. */
  private clear(sessionId: string, suppress = true): void {
    const limit = this.limits.get(sessionId);
    if (!limit) return;
    if (suppress && limit.source === 'screen' && limit.message) this.suppressed.set(sessionId, limit.message);
    this.limits.delete(sessionId);
    this.meta.delete(sessionId);
    this.changed(sessionId, null);
    if (this.limits.size === 0 && this.timer) {
      (this.deps.clearIntervalFn ?? clearInterval)(this.timer);
      this.timer = null;
    }
  }

  /** `armed`: an automatic resume, which must still be opted in when it fires. */
  private async resume(sessionId: string, armed: boolean): Promise<void> {
    if (this.resuming.has(sessionId)) return;
    const meta = this.meta.get(sessionId);
    if (!meta) return;
    const { generation } = meta;
    const stillWanted = (): boolean => {
      const current = this.meta.get(sessionId);
      const limit = this.limits.get(sessionId);
      return !!current && !!limit && current.generation === generation && (!armed || limit.autoResume === true);
    };
    let result: SessionPromptScheduleResult;
    if (!meta.identity) {
      result = 'unavailable'; // never saw which agent hit the limit: nothing to resume into
    } else {
      this.resuming.add(sessionId);
      try {
        result = await this.deps.deliverContinue(sessionId, meta.identity, stillWanted);
      } catch {
        result = 'error';
      } finally {
        this.resuming.delete(sessionId);
      }
    }
    this.deps.log?.(`[usage-limit] ${sessionId} continue: ${result}`);
    // The hold was dismissed or replaced while the send was in flight: its
    // outcome belongs to nobody.
    if (this.meta.get(sessionId)?.generation !== generation) return;
    // A sent continue, or an agent that is gone or replaced, ends the hold.
    if (result === 'sent' || result === 'unavailable' || result === 'session_changed') {
      this.clear(sessionId, false);
      return;
    }
    // 'busy' (a turn or a draft in the way) retries on the next tick, up to a
    // cap; an error, or the cap, disarms so a pane is not retyped into forever.
    if (result === 'busy' && ++meta.busyRetries < USAGE_LIMIT_MAX_BUSY_RETRIES) return;
    const limit = this.limits.get(sessionId);
    if (limit && limit.autoResume !== false) {
      const next = { ...limit, autoResume: false };
      this.limits.set(sessionId, next);
      this.changed(sessionId, next);
    }
  }

  private changed(sessionId: string, limit: PaneUsageLimit | null): void {
    this.deps.broadcast({ type: 'usage.limit.changed', sessionId, data: { limit } });
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = (this.deps.setIntervalFn ?? setInterval)(() => { void this.tick(); }, TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }
}
