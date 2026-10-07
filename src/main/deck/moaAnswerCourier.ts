// ─── Moa's delegate — the answer's way back to the asker ─────────────────────
//
// A worker whose moa_ask ticket escalated ends its turn (the deny hook and the
// tool reply tell it to). When the owner answers the card later, or Moa
// settles a ticket the worker stopped polling, nothing would tell the worker:
// the store changes and the pane sits idle. The courier pastes one short line
// into the asker's pane as a new turn, through main's gated submit (the
// delivery send_message and hand-offs use: approval gate, typing guard,
// bracketed paste, Enter).
//
//   schedule  record `waiting` on the decision, then try. A pane that is
//             mid-turn, on a prompt, or being typed in is retried later; a
//             closed pane fails the delivery. `sending` is recorded before the
//             paste, `delivered` after it.
//   seen      the asker read the final answer itself (moa_ask_status): a
//             delivery still waiting is dropped, so it never reads it twice.
//             A read that lands while the paste is under way stops it right
//             before the paste (and the Enter): `wanted` goes false.
//   stop      the delegate went off or the service was replaced: pending
//             timers are cleared and no try starts or pastes after it.
//
// Exactly once: every move goes through MoaDecisionStore.setDelivery with the
// state it expects, and a `sending` row found on load is never sent again.

import type { MoaAsker } from '../../shared/moaAsk';
import type { MoaAnswerDelivery, MoaDecision } from '../../shared/moaDecision';

/** How the asker's pane looks right now. */
export type AskerPaneState = 'idle' | 'busy' | 'gone' | 'unknown';

/** What one paste attempt did. `retry` false fails the delivery. */
export type CourierSendResult = { ok: true } | { ok: false; retry: boolean; reason: string };

export interface MoaAnswerCourierPorts {
  get: (decisionId: string) => MoaDecision | null;
  setDelivery: (decisionId: string, delivery: MoaAnswerDelivery, from: MoaAnswerDelivery['state'] | null) => Promise<MoaDecision | null>;
  paneState: (asker: MoaAsker) => AskerPaneState;
  /** One gated paste. `wanted` is asked right before the paste and the
   *  Enter; false refuses (nothing submitted). */
  send: (asker: MoaAsker, text: string, wanted: () => boolean) => Promise<CourierSendResult>;
  /** A delivery moved (the panel re-reads). */
  onChange?: (d: MoaDecision) => void;
  now?: () => number;
  /** Schedule `fn`; returns its cancel. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  log?: (line: string) => void;
  /** Between tries while the pane is busy (default 5 s). */
  retryMs?: number;
  /** Give up after this long (default 2 h). */
  maxWaitMs?: number;
}

export const COURIER_RETRY_MS = 5_000;
export const COURIER_MAX_WAIT_MS = 2 * 60 * 60 * 1000;
/** Characters of an agent-written option label quoted back. */
const LABEL_MAX = 160;

const oneLine = (s: string, max: number): string => {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The line the asker reads, or null when there is nothing to tell it. */
export function answerLine(d: MoaDecision): string | null {
  const head = `[wmux] Moa ticket ${d.ticketId}:`;
  const who = d.resolvedBy === 'owner' ? 'the owner' : d.resolvedBy === 'moa-auto' ? `Moa (rule ${d.ruleId ?? '?'})` : null;
  if (d.status === 'refused' && d.resolvedBy === 'owner') {
    return `${head} the owner closed this as not needed. Do not wait for an answer to it.`;
  }
  if (d.status !== 'answered' || !d.answer || !who) return null;
  if ('choiceKey' in d.answer) {
    const key = d.answer.choiceKey;
    const opt = d.body.type === 'question' ? d.body.options.find((o) => o.key === key) : undefined;
    const label = opt ? ` "${oneLine(opt.label, LABEL_MAX)}"` : '';
    return `${head} ${who} chose${label} (option ${key}). Continue your task with this answer.`;
  }
  if (d.body.type !== 'merge') return null;
  const pr = `PR #${d.body.prNumber} at ${d.body.expectHead.slice(0, 7)}`;
  return d.answer.actionVerdict === 'go'
    ? `${head} ${who} approved merging ${pr}. wmux merges it through the merge lane; do not run gh pr merge. moa_ask_status reports the result.`
    : `${head} ${who} declined merging ${pr}. Do not merge it.`;
}

export class MoaAnswerCourier {
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly log: (line: string) => void;
  private readonly retryMs: number;
  private readonly maxWaitMs: number;
  /** Decisions with a try running now: one at a time per decision. */
  private readonly trying = new Set<string>();
  /** When each delivery was first queued (for maxWaitMs). */
  private readonly queuedAt = new Map<string, number>();
  /** Read by the asker while its paste was under way. */
  private readonly seenWhileSending = new Set<string>();
  /** Cancels of the timers still pending. */
  private readonly timers = new Set<() => void>();
  private stopped = false;

  constructor(private readonly ports: MoaAnswerCourierPorts) {
    this.now = ports.now ?? Date.now;
    this.setTimer = ports.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return () => clearTimeout(t);
    });
    this.log = ports.log ?? ((l) => console.log(l));
    this.retryMs = ports.retryMs ?? COURIER_RETRY_MS;
    this.maxWaitMs = ports.maxWaitMs ?? COURIER_MAX_WAIT_MS;
  }

  /**
   * Queue the answer for the asker. A decision with nothing to tell, or whose
   * delivery already moved past `waiting`, is left alone. `delayMs` holds the
   * first try (an auto answer the asker may still be polling for).
   */
  async schedule(d: MoaDecision, delayMs = 0): Promise<void> {
    if (this.stopped || !answerLine(d)) return;
    const state = d.delivery?.state ?? null;
    if (state !== null && state !== 'waiting') return;
    if (state === null) {
      const rec = await this.move(d.id, { state: 'waiting', agent: d.asker.agent, at: this.now() }, null);
      if (!rec) return;
    }
    if (!this.queuedAt.has(d.id)) this.queuedAt.set(d.id, this.now());
    if (delayMs > 0) this.after(d.id, delayMs);
    else await this.attempt(d.id);
  }

  /** The asker read the final answer itself: drop a delivery still waiting. */
  async seen(decisionId: string): Promise<void> {
    const d = this.ports.get(decisionId);
    if (!d || !answerLine(d)) return;
    const state = d.delivery?.state ?? null;
    if (state === 'sending') {
      // The paste is under way: its guard refuses it before the paste (or
      // the Enter), and the try records it as read by the poll.
      this.seenWhileSending.add(decisionId);
      return;
    }
    if (state !== null && state !== 'waiting') return;
    await this.move(decisionId, { state: 'seen', agent: d.asker.agent, at: this.now() }, state);
    this.queuedAt.delete(decisionId);
  }

  /** One try. Re-reads the decision: a `seen` or a finished delivery stops it. */
  async attempt(decisionId: string): Promise<void> {
    if (this.stopped || this.trying.has(decisionId)) return;
    this.trying.add(decisionId);
    try {
      const d = this.ports.get(decisionId);
      const text = d ? answerLine(d) : null;
      if (!d || !text || d.delivery?.state !== 'waiting') {
        this.queuedAt.delete(decisionId);
        return;
      }
      const agent = d.asker.agent;
      if (this.now() - (this.queuedAt.get(decisionId) ?? this.now()) > this.maxWaitMs) {
        await this.finish(decisionId, { state: 'failed', agent, at: this.now(), reason: 'timeout' }, 'waiting');
        return;
      }
      const pane = this.ports.paneState(d.asker);
      if (pane === 'gone') {
        await this.finish(decisionId, { state: 'failed', agent, at: this.now(), reason: 'pane-gone' }, 'waiting');
        return;
      }
      if (pane !== 'idle') {
        this.later(decisionId);
        return;
      }
      if (!(await this.move(decisionId, { state: 'sending', agent, at: this.now() }, 'waiting'))) return;
      this.seenWhileSending.delete(decisionId);
      const wanted = () => !this.stopped && !this.seenWhileSending.has(decisionId);
      let r: CourierSendResult;
      try {
        r = await this.ports.send(d.asker, text, wanted);
      } catch (err) {
        r = { ok: false, retry: false, reason: `send-error: ${String(err)}`.slice(0, 120) };
      }
      const readByPoll = this.seenWhileSending.delete(decisionId);
      if (!r.ok && this.stopped && !readByPoll) {
        // Stopped mid-try (the delegate went off): nothing was submitted, so
        // it waits for whichever service picks the queue up next.
        await this.move(decisionId, { state: 'waiting', agent, at: this.now(), reason: 'stopped' }, 'sending');
      } else if (!r.ok && readByPoll) {
        // The asker read it itself while the paste waited: nothing was
        // submitted, and the answer counts as delivered by its poll.
        await this.finish(decisionId, { state: 'seen', agent, at: this.now(), reason: 'read-by-poll' }, 'sending');
      } else if (r.ok) {
        await this.finish(decisionId, { state: 'delivered', agent, at: this.now() }, 'sending');
      } else if (r.retry) {
        // Refused before anything was submitted (someone typing, a prompt
        // opened): back to waiting, and try again.
        if (await this.move(decisionId, { state: 'waiting', agent, at: this.now(), reason: r.reason }, 'sending')) this.later(decisionId);
      } else {
        await this.finish(decisionId, { state: 'failed', agent, at: this.now(), reason: r.reason }, 'sending');
      }
    } finally {
      this.trying.delete(decisionId);
    }
  }

  /** Clear every pending try; nothing starts or pastes after this. A try
   *  already past its paste finishes recording what happened. */
  stop(): void {
    this.stopped = true;
    for (const cancel of this.timers) cancel();
    this.timers.clear();
    this.queuedAt.clear();
  }

  private later(decisionId: string): void {
    this.after(decisionId, this.retryMs);
  }

  private after(decisionId: string, ms: number): void {
    if (this.stopped) return;
    const cancel = this.setTimer(() => {
      this.timers.delete(cancel);
      void this.attempt(decisionId);
    }, ms);
    this.timers.add(cancel);
  }

  private async finish(decisionId: string, delivery: MoaAnswerDelivery, from: MoaAnswerDelivery['state']): Promise<void> {
    this.queuedAt.delete(decisionId);
    await this.move(decisionId, delivery, from);
  }

  private async move(decisionId: string, delivery: MoaAnswerDelivery, from: MoaAnswerDelivery['state'] | null): Promise<MoaDecision | null> {
    let next: MoaDecision | null = null;
    try {
      next = await this.ports.setDelivery(decisionId, delivery, from);
    } catch (err) {
      this.log(`[moa-ask] ${decisionId} delivery not recorded: ${String(err)}`);
      return null;
    }
    if (next) {
      try { this.ports.onChange?.(next); } catch { /* a listener never breaks the courier */ }
    }
    return next;
  }
}
