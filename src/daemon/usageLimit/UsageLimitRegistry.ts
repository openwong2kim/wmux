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

export interface UsageLimitRegistryDeps {
  broadcast: (event: DaemonEvent) => void;
  /** Paste and submit the continue message (the scheduled-prompt proof, hold bypassed). */
  deliverContinue: (sessionId: string) => Promise<SessionPromptScheduleResult>;
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

export class UsageLimitRegistry {
  private readonly limits = new Map<string, PaneUsageLimit>();
  private readonly resuming = new Set<string>();
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
    if (signal.kind === 'agent.user_prompt_submit') this.clear(sessionId);
  }

  /** A limit row the screen detector read. */
  noteScreenLimit(sessionId: string, provider: UsageLimitProvider, hit: { resetsAt?: number; message?: string }): void {
    this.set(sessionId, provider, 'screen', hit);
  }

  /** The pane started producing output. Past the hold, that means it is working again. */
  noteActive(sessionId: string): void {
    const limit = this.limits.get(sessionId);
    if (limit && !usageLimitHolds(limit, this.now()) && !this.resuming.has(sessionId)) this.clear(sessionId);
  }

  drop(sessionId: string): void {
    this.resuming.delete(sessionId);
    this.clear(sessionId);
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
      await this.resume(sessionId);
      return true;
    }
    const next: PaneUsageLimit = { ...limit };
    if (typeof patch.autoResume === 'boolean') next.autoResume = patch.autoResume;
    // Main fills a reset the hook text did not carry; a known one is not overwritten.
    if (typeof patch.resetsAt === 'number' && Number.isFinite(patch.resetsAt) && next.resetsAt == null) next.resetsAt = patch.resetsAt;
    this.limits.set(sessionId, next);
    this.changed(sessionId, next);
    return true;
  }

  /** One pass: send due continues, forget long-ended holds. Public for tests. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const [id, limit] of [...this.limits]) {
      if (usageLimitResumeDue(limit, now)) {
        await this.resume(id);
      } else if (limit.autoResume !== true && now >= usageLimitHoldEndsAt(limit) + FORGET_AFTER_HOLD_MS) {
        this.clear(id);
      }
    }
  }

  dispose(): void {
    if (this.timer) (this.deps.clearIntervalFn ?? clearInterval)(this.timer);
    this.timer = null;
    this.limits.clear();
  }

  private set(sessionId: string, provider: UsageLimitProvider, source: PaneUsageLimit['source'], hit: { resetsAt?: number; message?: string }): void {
    const prev = this.limits.get(sessionId);
    const next: PaneUsageLimit = {
      ptyId: sessionId,
      provider,
      // A repeat of the same limit keeps its first sighting and its operator choice.
      detectedAt: prev && prev.provider === provider ? prev.detectedAt : this.now(),
      source,
      ...(hit.resetsAt != null ? { resetsAt: hit.resetsAt } : prev?.resetsAt != null ? { resetsAt: prev.resetsAt } : {}),
      ...(prev?.autoResume !== undefined ? { autoResume: prev.autoResume } : {}),
      ...(hit.message ? { message: hit.message } : prev?.message ? { message: prev.message } : {}),
    };
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
    this.limits.set(sessionId, next);
    const reset = next.resetsAt != null ? `resets ${formatResetClock(next.resetsAt, this.now(), 'en-US')}` : 'reset unknown';
    this.deps.log?.(`[usage-limit] ${sessionId} held (${provider}, ${source}, ${reset})`);
    this.changed(sessionId, next);
    this.ensureTimer();
  }

  private clear(sessionId: string): void {
    if (!this.limits.delete(sessionId)) return;
    this.changed(sessionId, null);
    if (this.limits.size === 0 && this.timer) {
      (this.deps.clearIntervalFn ?? clearInterval)(this.timer);
      this.timer = null;
    }
  }

  private async resume(sessionId: string): Promise<void> {
    if (this.resuming.has(sessionId)) return;
    this.resuming.add(sessionId);
    let result: SessionPromptScheduleResult;
    try {
      result = await this.deps.deliverContinue(sessionId);
    } catch {
      result = 'error';
    } finally {
      this.resuming.delete(sessionId);
    }
    this.deps.log?.(`[usage-limit] ${sessionId} continue: ${result}`);
    // 'busy' (a turn or a draft is in the way) retries on the next tick. A sent
    // continue, or an agent that is gone, ends the hold. An error disarms it so
    // a broken pane is not retyped into every tick.
    if (result === 'sent' || result === 'unavailable' || result === 'session_changed') {
      this.clear(sessionId);
    } else if (result === 'error') {
      const limit = this.limits.get(sessionId);
      if (limit) {
        const next = { ...limit, autoResume: false };
        this.limits.set(sessionId, next);
        this.changed(sessionId, next);
      }
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
