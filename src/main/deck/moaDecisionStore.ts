// ─── Moa's delegate decisions — the store (moa_ask tickets) ──────────────────
//
// `<wmuxDir>/moa-delegate/decisions.json`, one record per ticket
// (shared/moaDecision.ts MoaDecision; threat model there). NOT deckDecisionStore.
//
// Idempotency, AnswerReceiptStore's semantics (shared/moaAsk.ts has the table):
// the key is the stamped asker plus the caller's askId (or "q:"+questionHash
// when it gave none), and the body hash is questionHash. Single main writer:
// the in-memory map is the truth and changes synchronously, so two concurrent
// retries see each other; the file follows on one ordered write chain. A new
// ticket is on disk before it is judged (not journaled ⇒ not run). A ticket
// found `inFlight` on load is `uncertain` and is never judged again.
//
// Nothing constructs this at module load: with the ask mode off no file is
// read or written.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { receiptHash } from '../../daemon/approvals/AnswerReceiptStore';
import type { MoaAskBody, MoaAsker, MoaTicketStatus } from '../../shared/moaAsk';
import {
  MOA_DECISION_ID_RE,
  MOA_DECISIONS_FILENAME,
  MOA_DELEGATE_DIRNAME,
  ticketView,
  type MoaDecision,
  type MoaDecisionMode,
  type MoaJudgeResult,
  type MoaOwnerAnswer,
  type MoaReceiptState,
} from '../../shared/moaDecision';
import { MOA_TICKET_ID_RE, parseMoaAskInput } from '../../shared/moaAsk';
import { shadowPacketHash } from './moaShadowJudge';

/** How long a record is kept after it was created. */
export const MOA_DECISION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** An escalation the owner has not answered in the panel by then expires. */
export const MOA_ESCALATION_TTL_MS = 24 * 60 * 60 * 1000;
/** Most live records per asker pane; a full asker's NEW asks are refused. */
export const MOA_DECISIONS_PER_ASKER_MAX = 256;

/**
 * main's hash of a request body: for a question, exactly shadowPacketHash
 * (asker, question, [key, label] pairs), so a moa_ask and a shadow record of
 * the same question hash alike; for a merge, the same 32-hex shape over the
 * asker and the typed target. Context, topic and descriptions are left out.
 */
export function moaQuestionHash(asker: MoaAsker, body: MoaAskBody): string {
  if (body.type === 'question') {
    return shadowPacketHash({
      question: body.question,
      choices: body.options.map((o) => ({ key: o.key, label: o.label })),
      asker: { ptyId: asker.ptyId, workspaceId: asker.workspaceId, agent: asker.agent },
    });
  }
  return receiptHash({
    ptyId: asker.ptyId, workspaceId: asker.workspaceId, agent: asker.agent,
    action: 'merge', prNumber: body.prNumber, expectHead: body.expectHead,
  }).slice(0, 32);
}

/** The idempotency key (sha256 hex). */
export function moaAskKey(asker: MoaAsker, askId: string | undefined, questionHash: string): string {
  return receiptHash([asker.ptyId, asker.workspaceId, askId ?? `q:${questionHash}`]);
}

export type MoaBegin =
  | { kind: 'new'; decision: MoaDecision }
  | { kind: 'replay'; decision: MoaDecision }
  | { kind: 'reused'; decision: MoaDecision }
  | { kind: 'full' };

/** How the machine side settled a ticket. */
export interface MoaSettlement {
  status: Exclude<MoaTicketStatus, 'pending'>;
  judge: MoaJudgeResult | null;
  ruleId: string | null;
  reasonCode: string;
  why: string;
  /** Required when `status` is answered. */
  answer?: MoaDecision['answer'];
}

export type MoaOwnerResolve =
  | { ok: true; decision: MoaDecision }
  | { ok: false; code: 'unknown' | 'not-open' | 'stale' | 'invalid'; message: string };

const HEX64 = /^[a-f0-9]{64}$/;
const HEX32 = /^[a-f0-9]{32}$/;
const STATUSES: ReadonlySet<string> = new Set(['pending', 'answered', 'escalated', 'refused']);
const RECEIPTS: ReadonlySet<string> = new Set(['inFlight', 'done', 'refused', 'uncertain']);
const MODES: ReadonlySet<string> = new Set(['shadow', 'suggest', 'auto']);
const RESOLVED_BY: ReadonlySet<string> = new Set(['owner', 'moa-auto', 'expired', 'refused']);

/** A stored record's shape check (strict: one bad row refuses the file). */
export function isMoaDecisionRecord(v: unknown): v is MoaDecision {
  const d = v as MoaDecision;
  return !!d && typeof d === 'object'
    && typeof d.id === 'string' && MOA_DECISION_ID_RE.test(d.id)
    && typeof d.ticketId === 'string' && MOA_TICKET_ID_RE.test(d.ticketId)
    && !!d.asker && typeof d.asker.ptyId === 'string' && typeof d.asker.workspaceId === 'string' && typeof d.asker.agent === 'string'
    && typeof d.askKey === 'string' && HEX64.test(d.askKey)
    && typeof d.questionHash === 'string' && HEX32.test(d.questionHash)
    && (d.kind === 'question' || d.kind === 'merge') && !!d.body && typeof d.body === 'object' && d.body.type === d.kind && isValidBody(d.body)
    && MODES.has(d.mode) && STATUSES.has(d.status) && RECEIPTS.has(d.receipt)
    && (d.resolvedBy === null || RESOLVED_BY.has(d.resolvedBy))
    && (d.ruleId === null || typeof d.ruleId === 'string')
    && typeof d.reasonCode === 'string' && typeof d.why === 'string'
    && Number.isSafeInteger(d.createdAt) && (d.resolvedAt === null || Number.isSafeInteger(d.resolvedAt));
}

/** A stored body is one parseMoaAskInput would have produced. */
function isValidBody(body: MoaAskBody): boolean {
  const ctx = body.context !== undefined ? { context: body.context } : {};
  const wire = body.type === 'question'
    ? { question: body.question, options: body.options, ...(body.topic !== undefined ? { kind: body.topic } : {}), ...ctx }
    : body.type === 'merge'
      ? { action: { type: 'merge', prNumber: body.prNumber, expectHead: body.expectHead }, ...ctx }
      : null;
  const parsed = wire ? parseMoaAskInput(wire) : null;
  return !!parsed?.ok && parsed.value.body.type === body.type;
}

/** The owner may answer a ticket the asker currently reads as escalated. */
function ownerCanResolve(d: MoaDecision): boolean {
  return d.resolvedBy === null && ticketView(d).status === 'escalated';
}

export class MoaDecisionStore {
  private readonly file: string;
  /** askKey → record. */
  private rows = new Map<string, MoaDecision>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    wmuxDir: string,
    private readonly now: () => number = Date.now,
    private readonly perAskerMax = MOA_DECISIONS_PER_ASKER_MAX,
  ) {
    this.file = path.join(wmuxDir, MOA_DELEGATE_DIRNAME, MOA_DECISIONS_FILENAME);
    const saved = atomicReadJSONSync<{ version?: unknown; decisions?: unknown }>(this.file);
    if (saved === null) return;
    if (saved.version !== 1 || !Array.isArray(saved.decisions)) throw new Error('Invalid moa decision storage');
    for (const d of saved.decisions) {
      if (!isMoaDecisionRecord(d)) throw new Error('Invalid moa decision entry');
      // Judged when main stopped: it may or may not have finished. Never again.
      this.rows.set(d.askKey, d.receipt === 'inFlight' ? { ...d, receipt: 'uncertain' } : d);
    }
  }

  /**
   * Claim a ticket for this asker and body, or report what the key already
   * stands for. `new`: the record is on disk with receipt inFlight and the
   * caller must judge it, then `settle` it. Rejects when the write fails
   * (nothing is kept).
   */
  async begin(input: { asker: MoaAsker; askId?: string; body: MoaAskBody; mode: MoaDecisionMode; repo?: { key: string; path: string } }): Promise<MoaBegin> {
    const questionHash = moaQuestionHash(input.asker, input.body);
    const seen = this.peek(input.asker, input.askId, questionHash);
    if (seen) return seen;
    let owned = 0;
    for (const row of this.rows.values()) if (row.asker.ptyId === input.asker.ptyId) owned++;
    if (owned >= this.perAskerMax) return { kind: 'full' };
    const askKey = moaAskKey(input.asker, input.askId, questionHash);
    const decision: MoaDecision = {
      id: `moa-d-${randomUUID()}`,
      ticketId: `moa-t-${randomUUID()}`,
      asker: { ...input.asker },
      askKey,
      ...(input.askId ? { askId: input.askId } : {}),
      questionHash,
      kind: input.body.type,
      body: input.body,
      ...(input.repo ? { repo: { ...input.repo } } : {}),
      mode: input.mode,
      status: 'pending',
      judge: null,
      ruleId: null,
      reasonCode: 'judging',
      why: '',
      resolvedBy: null,
      createdAt: this.now(),
      resolvedAt: null,
      receipt: 'inFlight',
    };
    this.rows.set(askKey, decision);
    try {
      await this.save();
    } catch (err) {
      if (this.rows.get(askKey) === decision) this.rows.delete(askKey);
      throw err;
    }
    return { kind: 'new', decision };
  }

  /** What this asker's key already stands for, or null when it is unused. */
  peek(asker: MoaAsker, askId: string | undefined, questionHash: string): Exclude<MoaBegin, { kind: 'new' | 'full' }> | null {
    this.prune();
    const existing = this.rows.get(moaAskKey(asker, askId, questionHash));
    if (!existing) return null;
    if (existing.questionHash !== questionHash) return { kind: 'reused', decision: existing };
    return { kind: 'replay', decision: existing };
  }

  /**
   * Record the machine side's result for an inFlight ticket. A no-op (null)
   * for any other. A failed write leaves it `uncertain` in memory, which the
   * asker reads as escalated — never as a result the disk does not hold.
   */
  async settle(id: string, s: MoaSettlement): Promise<MoaDecision | null> {
    const key = this.keyOf(id);
    const row = key ? this.rows.get(key) : undefined;
    if (!key || !row || row.receipt !== 'inFlight') return null;
    if (s.status === 'answered' && !s.answer) throw new Error('an answered settlement needs an answer');
    const at = this.now();
    const receipt: MoaReceiptState = s.status === 'refused' ? 'refused' : 'done';
    const next: MoaDecision = {
      ...row,
      status: s.status,
      judge: s.judge,
      ruleId: s.ruleId,
      reasonCode: s.reasonCode,
      why: s.why,
      ...(s.status === 'answered' && s.answer ? { answer: s.answer } : {}),
      resolvedBy: s.status === 'answered' ? 'moa-auto' : s.status === 'refused' ? 'refused' : null,
      resolvedAt: s.status === 'escalated' ? null : at,
      receipt,
    };
    this.rows.set(key, next);
    try {
      await this.save();
    } catch {
      if (this.rows.get(key) === next) this.rows.set(key, { ...row, receipt: 'uncertain' });
      return this.rows.get(key) ?? null;
    }
    return next;
  }

  /**
   * The owner's answer from the panel (renderer IPC only). Allowed while the
   * asker reads the ticket as escalated and nobody resolved it. A merge answer
   * must name the head the decision is about (`stale` otherwise).
   */
  async resolveByOwner(id: string, answer: MoaOwnerAnswer): Promise<MoaOwnerResolve> {
    const key = this.keyOf(id);
    const row = key ? this.rows.get(key) : undefined;
    if (!key || !row) return { ok: false, code: 'unknown', message: 'no such decision' };
    if (!ownerCanResolve(row)) return { ok: false, code: 'not-open', message: 'this decision is already settled' };
    let patch: Pick<MoaDecision, 'status' | 'reasonCode' | 'why'> & { answer?: MoaDecision['answer'] };
    if (answer.type === 'dismiss') {
      patch = { status: 'refused', reasonCode: 'dismissed', why: 'the owner closed it as not needed' };
    } else if (answer.type === 'choice') {
      if (row.body.type !== 'question' || !row.body.options.some((o) => o.key === answer.choiceKey)) {
        return { ok: false, code: 'invalid', message: 'not one of the offered choices' };
      }
      patch = { status: 'answered', reasonCode: 'owner-answered', why: '', answer: { choiceKey: answer.choiceKey } };
    } else {
      if (row.body.type !== 'merge') return { ok: false, code: 'invalid', message: 'not a merge decision' };
      if (answer.expectHead !== row.body.expectHead) return { ok: false, code: 'stale', message: 'the card shows another head' };
      patch = {
        status: 'answered',
        reasonCode: answer.approve ? 'owner-approved' : 'owner-declined',
        why: '',
        answer: { actionVerdict: answer.approve ? 'go' : 'no-go' },
      };
    }
    const next: MoaDecision = {
      ...row,
      ...patch,
      ruleId: null,
      resolvedBy: 'owner',
      resolvedAt: this.now(),
      // The machine side is over: a restart-uncertain ticket is settled now.
      receipt: row.receipt === 'inFlight' || row.receipt === 'uncertain' ? 'done' : row.receipt,
    };
    this.rows.set(key, next);
    try {
      await this.save();
    } catch (err) {
      if (this.rows.get(key) === next) this.rows.set(key, row);
      throw err;
    }
    return { ok: true, decision: next };
  }

  /** Mark escalations the owner left unanswered past the TTL as expired. */
  async expire(): Promise<MoaDecision[]> {
    const cutoff = this.now() - MOA_ESCALATION_TTL_MS;
    const expired: MoaDecision[] = [];
    const before: Array<[string, MoaDecision, MoaDecision]> = [];
    for (const [key, row] of this.rows) {
      if (row.resolvedBy !== null || row.receipt === 'inFlight' || row.createdAt > cutoff || ticketView(row).status !== 'escalated') continue;
      const next: MoaDecision = { ...row, resolvedBy: 'expired', resolvedAt: this.now() };
      this.rows.set(key, next);
      expired.push(next);
      before.push([key, row, next]);
    }
    if (expired.length === 0) return expired;
    try {
      await this.save();
    } catch (err) {
      // Not on disk ⇒ not expired: the owner can still answer them.
      for (const [key, row, next] of before) if (this.rows.get(key) === next) this.rows.set(key, row);
      throw err;
    }
    return expired;
  }

  /** The asker's own ticket; another asker's id reads as unknown (null). */
  getForAsker(asker: MoaAsker, ticketId: string): MoaDecision | null {
    for (const row of this.rows.values()) {
      if (row.ticketId !== ticketId) continue;
      return row.asker.ptyId === asker.ptyId && row.asker.workspaceId === asker.workspaceId ? row : null;
    }
    return null;
  }

  get(id: string): MoaDecision | null {
    const key = this.keyOf(id);
    return key ? this.rows.get(key) ?? null : null;
  }

  /** Newest first. */
  list(): MoaDecision[] {
    this.prune();
    return [...this.rows.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  private keyOf(id: string): string | null {
    for (const [key, row] of this.rows) if (row.id === id) return key;
    return null;
  }

  private prune(): void {
    const cutoff = this.now() - MOA_DECISION_RETENTION_MS;
    for (const [key, row] of this.rows) if (row.createdAt <= cutoff) this.rows.delete(key);
  }

  private save(): Promise<void> {
    const run = this.writes.then(() =>
      atomicWriteJSON(this.file, { version: 1, decisions: [...this.rows.values()] }));
    this.writes = run.catch(() => undefined);
    return run;
  }
}
