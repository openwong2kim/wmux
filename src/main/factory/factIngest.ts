// ─── Fact ingest — existing main-side sources → fact drafts ────────────────
//
// Each source is mapped by a pure function (draft or null) and subscribed
// through an injected port, so every mapping tests with fakes and nothing here
// reaches a singleton unless `defaultFactIngestPorts()` is used.
//
//   EventBus agent.lifecycle awaiting_input (emitted) on a bot's fan-out
//   task pane                                → pane.needs_input (owner workspace)
//   task ledger transitions                  → task.done | task.failed | task.input_required
//                                              (ref.botId = the bot that started the task)
//   PrVerdictStore record                    → verdict.recorded
//   merge executor finish (done / refused)   → merge.done | merge.refused
//   RpcRouter bot role-gate refusal          → bot.refused
//
// Payloads carry ids, states and short capped text only; worker summaries and
// verdict summaries are untrusted text and stay data. The dedupe key of each
// fact is shared/facts.ts factDedupeKey's alone.
//
// EventBus `pr.ci` is NOT a source: ci.failed / ci.green come from the repo
// watch (repoWatch.ts), which stamps `payload.author` that the verifier's
// authorTrusted trigger needs. A pr.ci event carries no author, and a fact
// from it would claim the shared dedupe key first and suppress the watch's
// authored fact for the same head.

import type { WmuxEvent } from '../../shared/events';
import type { Fact, FactDraft } from '../../shared/facts';
import type { LedgerEntry, LedgerStatus } from '../../shared/ledger';
import type { LedgerTransition } from '../../daemon/ledger/TaskLedger';
import type { PrVerdictRecord } from '../../shared/prVerdict';
import type { MergeEffect } from '../../shared/moaDecision';
import type { BotRefusal } from '../../shared/botSurface';
import { taskOriginThread } from '../../shared/room';
import type { FactAppendResult } from './factLog';

const OPEN_TASK: ReadonlySet<LedgerStatus> = new Set<LedgerStatus>(['working', 'input_required', 'review_requested']);
const TEXT_CAP = 500;
const TITLE_CAP = 200;

const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The bot that started a fan-out task, from its ledger row, or null. */
function botOrigin(e: LedgerEntry): string | null {
  const origin = e.dispatch?.origin;
  return origin?.kind === 'bot' && typeof origin.botId === 'string' && origin.botId ? origin.botId : null;
}

/** `payload.threadId` for a task's facts: the thread of the bot wake that
 *  started it (ledger row, written by main), so its cards land there. Empty
 *  when it has none — the cards then go to the task's own thread. */
function originThread(e: LedgerEntry): { threadId?: string } {
  const t = taskOriginThread(e.dispatch?.threadId);
  return t ? { threadId: t } : {};
}

/** agent.lifecycle → draft. `findTask` resolves a fan-out task by
 *  its task workspace (the ledger). Only a task a bot started counts (its
 *  ledger row's dispatch origin, written by main): a human's own fan-out
 *  workers are watched by the human. */
export function factFromBusEvent(ev: WmuxEvent, findTask: (taskWorkspaceId: string) => LedgerEntry | null): FactDraft | null {
  if (ev.type === 'agent.lifecycle') {
    if (ev.kind !== 'agent.awaiting_input' || ev.decision !== 'emit' || !ev.ptyId) return null;
    const task = findTask(ev.workspaceId);
    if (!task || !OPEN_TASK.has(task.status)) return null;
    const botId = botOrigin(task);
    if (!botId) return null;
    return {
      kind: 'pane.needs_input',
      at: ev.ts,
      workspaceId: task.ownerWorkspaceId,
      ref: { ptyId: ev.ptyId, taskId: task.id, botId },
      actor: { kind: 'system' },
      payload: { taskWorkspaceId: ev.workspaceId, agent: ev.agent, source: ev.source, ...originThread(task) },
    };
  }
  return null;
}

/** factoryStop.ts STOPPED_BY_OWNER (not imported: the stop pulls in the
 *  fan-out notifier). */
const STOPPED_BY_OWNER_SUMMARY = 'stopped by owner';

/**
 * A ledger transition → draft. review_requested (the worker's done) and
 * completed → task.done (one per task: the key is the task id; its status
 * tells the room's card apart); failed → task.failed; input_required →
 * task.input_required. A task cancelled before it reported done stopped
 * without a result → task.failed; cancelled after review_requested is the
 * normal close of a delivered task → no fact, unless the owner's stop
 * cancelled it (task.failed, which the room shows as stopped by owner).
 * A task a bot started names that bot in ref.botId: the bot's wake for it
 * comes from the fan-out path (installBotFanoutWake). The trigger engine is
 * handed no task fact (factoryWiring.ts), so a task no bot started wakes no
 * bot.
 */
export function factFromLedgerTransition(t: LedgerTransition): FactDraft | null {
  if (t.from === t.to) return null;
  let kind: 'task.done' | 'task.failed' | 'task.input_required';
  if (t.to === 'review_requested' || t.to === 'completed') kind = 'task.done';
  else if (t.to === 'failed') kind = 'task.failed';
  else if (t.to === 'cancelled' && t.from !== 'review_requested' && t.from !== 'completed') kind = 'task.failed';
  else if (t.to === 'cancelled' && t.from === 'review_requested' && t.by.kind === 'system' && (t.summary ?? t.entry.summary) === STOPPED_BY_OWNER_SUMMARY) kind = 'task.failed';
  else if (t.to === 'input_required') kind = 'task.input_required';
  else return null;
  const e = t.entry;
  const botId = botOrigin(e);
  return {
    kind,
    at: e.updatedAt,
    workspaceId: e.ownerWorkspaceId,
    ref: { taskId: e.id, ...(botId ? { botId } : {}) },
    actor: { kind: 'system' },
    payload: {
      taskWorkspaceId: e.taskWorkspaceId,
      title: cap(e.title, TITLE_CAP),
      status: t.to,
      from: t.from,
      by: t.by.kind,
      ...(t.summary ?? e.summary ? { summary: cap(String(t.summary ?? e.summary), TEXT_CAP) } : {}),
      ...(e.gate ? { gateExit: e.gate.exitCode, ...(e.gate.headSha ? { gateHeadSha: e.gate.headSha } : {}) } : {}),
      ...originThread(e),
    },
  };
}

export function factFromVerdict(r: PrVerdictRecord): FactDraft | null {
  const botId = r.principal.botId;
  return {
    kind: 'verdict.recorded',
    at: r.at,
    workspaceId: r.principal.workspaceId,
    repoKey: r.repoKey,
    ref: {
      pr: r.prNumber,
      headSha: r.headSha,
      ...(botId ? { botId } : {}),
      ...(r.evidence ? { taskId: r.evidence.taskId } : {}),
    },
    actor: botId ? { kind: 'bot', id: botId } : { kind: 'system' },
    payload: {
      verdict: r.verdict,
      summary: cap(r.summary, TEXT_CAP),
      agent: r.principal.agent,
      ...(r.evidence ? { gateHeadSha: r.evidence.gateHeadSha } : {}),
    },
  };
}

/** Only a finished effect is a fact: done → merge.done, refused →
 *  merge.refused. pending / inFlight / uncertain are not outcomes. */
export function factFromMergeEffect(e: MergeEffect): FactDraft | null {
  if (e.status !== 'done' && e.status !== 'refused') return null;
  return {
    kind: e.status === 'done' ? 'merge.done' : 'merge.refused',
    at: e.updatedAt,
    repoKey: e.repoKey,
    ref: { pr: e.prNumber, headSha: e.expectHead },
    actor: { kind: 'system' },
    payload: {
      effectId: e.id,
      approvedBy: e.approvedBy,
      ...(e.reason ? { reason: cap(e.reason, TEXT_CAP) } : {}),
      ...(e.mergeCommitOid ? { mergeCommitOid: e.mergeCommitOid } : {}),
    },
  };
}

export function factFromBotRefusal(r: BotRefusal): FactDraft {
  return {
    kind: 'bot.refused',
    at: r.at,
    workspaceId: r.bot.workspaceId,
    ref: { botId: r.bot.botId, method: r.method },
    actor: { kind: 'bot', id: r.bot.botId },
    payload: { role: r.bot.role, reason: r.reason },
  };
}

type Subscribe<T> = (fn: (v: T) => void) => () => void;

/** The part of the Moa delegate service the merge executor's effects reach
 *  (its `emit` port → `emitEffect` → subscribers). */
export interface MergeEffectSource {
  subscribe(listener: { decision(ev: unknown): void; effect(ev: { effect: MergeEffect }): void }): () => void;
}

/**
 * Follow the merge effects of whichever delegate service is registered. The
 * service is created and replaced when the owner changes the ask mode;
 * `onServiceChange` fires synchronously on each change, before the new
 * service starts, so its first outcomes are not missed.
 */
export function watchMergeEffects(
  getService: () => MergeEffectSource | null,
  onServiceChange: (listener: () => void) => () => void,
): Subscribe<MergeEffect> {
  return (fn) => {
    let attached: MergeEffectSource | null = null;
    let off: (() => void) | null = null;
    const sync = (): void => {
      const next = getService();
      if (next === attached) return;
      off?.();
      off = null;
      attached = next;
      if (next) off = next.subscribe({ decision: () => undefined, effect: ({ effect }) => fn(effect) });
    };
    const offChange = onServiceChange(sync);
    sync();
    return () => {
      offChange();
      off?.();
      off = null;
      attached = null;
    };
  };
}

/** Drafts kept while the log cannot write (facts.jsonl not writable), and
 *  how often they are offered again. */
export const FACT_INGEST_RETRY_MAX = 500;
export const FACT_INGEST_RETRY_MS = 5_000;

export interface FactIngestPorts {
  subscribeBus?: Subscribe<WmuxEvent>;
  findTaskByWorkspace?: (taskWorkspaceId: string) => LedgerEntry | null;
  onLedgerTransition?: Subscribe<LedgerTransition>;
  onVerdictRecorded?: Subscribe<PrVerdictRecord>;
  onMergeEffect?: Subscribe<MergeEffect>;
  log?: (line: string) => void;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

export interface FactIngest {
  /** RpcRouter.onBotRefused is subscribed by the module at register time;
   *  it forwards here. */
  noteBotRefused(r: BotRefusal): void;
  dispose(): void;
}

/**
 * A sink with `appendResult` (the fact log) says why a draft was refused: a
 * draft the log could not write is kept (FACT_INGEST_RETRY_MAX, oldest
 * dropped first) and offered again before the next draft and every
 * FACT_INGEST_RETRY_MS, so a fact is not lost while the file is unwritable.
 */
export function startFactIngest(sink: { append(draft: FactDraft): Fact | null; appendResult?(draft: FactDraft): FactAppendResult }, ports: FactIngestPorts): FactIngest {
  const log = ports.log ?? ((line: string) => console.warn(line));
  const setTimer = ports.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return { cancel: () => clearTimeout(t) };
  });
  const offs: Array<() => void> = [];
  let disposed = false;
  const unwritten: FactDraft[] = [];
  let timer: { cancel(): void } | null = null;
  /** false when the log could not write it (it is kept to retry). */
  const write = (what: string, draft: FactDraft): boolean => {
    if (!sink.appendResult) {
      sink.append(draft);
      return true;
    }
    const r = sink.appendResult(draft);
    if (r.ok || r.code === 'duplicate') return true;
    if (r.code !== 'write_failed') {
      log(`[facts] ingest ${what}: ${draft.kind} refused (${r.code})`);
      return true;
    }
    return false;
  };
  const arm = (): void => {
    if (timer || disposed || unwritten.length === 0) return;
    timer = setTimer(() => {
      timer = null;
      flush();
    }, FACT_INGEST_RETRY_MS);
  };
  /** Offer the kept drafts again, oldest first; stop at the first that still
   *  cannot be written. */
  const flush = (): boolean => {
    while (unwritten.length > 0 && !disposed) {
      let ok = false;
      try {
        ok = write('retry', unwritten[0]);
      } catch (err) {
        log(`[facts] ingest retry failed: ${String(err)}`);
      }
      if (!ok) break;
      unwritten.shift();
    }
    arm();
    return unwritten.length === 0;
  };
  const keep = (what: string, draft: FactDraft): void => {
    if (unwritten.length === 0) log(`[facts] ingest ${what}: the fact log cannot write; facts are kept and written once it can`);
    unwritten.push(draft);
    if (unwritten.length > FACT_INGEST_RETRY_MAX) {
      unwritten.shift();
      log(`[facts] ingest: more than ${FACT_INGEST_RETRY_MAX} facts wait for the log; the oldest was dropped`);
    }
    arm();
  };
  const put = (what: string, make: () => FactDraft | null): void => {
    if (disposed) return;
    try {
      const draft = make();
      if (!draft) return;
      // In order: the new draft waits behind the ones kept before it.
      if (!flush() || !write(what, draft)) keep(what, draft);
    } catch (err) {
      log(`[facts] ingest ${what} failed: ${String(err)}`);
    }
  };
  const attach = <T>(what: string, sub: Subscribe<T> | undefined, map: (v: T) => FactDraft | null): void => {
    if (!sub) return;
    try {
      offs.push(sub((v) => put(what, () => map(v))));
    } catch (err) {
      log(`[facts] ingest ${what} not attached: ${String(err)}`);
    }
  };
  const findTask = ports.findTaskByWorkspace ?? (() => null);
  attach('event', ports.subscribeBus, (ev) => factFromBusEvent(ev, findTask));
  attach('ledger', ports.onLedgerTransition, factFromLedgerTransition);
  attach('verdict', ports.onVerdictRecorded, factFromVerdict);
  attach('merge', ports.onMergeEffect, factFromMergeEffect);
  return {
    noteBotRefused: (r) => put('bot refusal', () => factFromBotRefusal(r)),
    dispose() {
      if (disposed) return;
      disposed = true;
      timer?.cancel();
      timer = null;
      for (const off of offs.splice(0)) {
        try { off(); } catch { /* best-effort */ }
      }
    },
  };
}
