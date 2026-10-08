// Receipts for `POST /api/approvals/:id/answer`, keyed by the client's own
// `clientAnswerId`, so a phone that lost the response (a tunnel, a killed app,
// an offline queue replaying) can retry without answering twice.
//
//   same id, same body, still running  → 202 {state:'pending', replayed:true}
//   same id, same body, finished       → the stored final response, again
//   same id, another body              → 409 answer-id-reused
//   in flight when the daemon stopped  → 409 answer-uncertain (never re-run)
//
// Only final outcomes are kept. A refusal the caller can retry past (401, 403,
// 425, 503, …) is released, so the retry is checked again rather than replayed.
// The answer text is never stored — only a hash of the whole body.

import crypto from 'node:crypto';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSON } from '../util/atomicWrite';

/** How long a receipt is kept. */
export const ANSWER_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Most live receipts per owner; a full owner's NEW ids are refused, old ones are kept. */
export const ANSWER_RECEIPTS_PER_OWNER_MAX = 512;

export type AnswerReceiptState = 'inFlight' | 'done' | 'partial' | 'refused' | 'uncertain';

/** The HTTP answer a receipt replays. */
export interface AnswerReceiptResponse {
  status: number;
  body: Record<string, unknown>;
}

interface Row {
  owner: string;
  approvalId: string;
  bodyHash: string;
  state: AnswerReceiptState;
  result?: AnswerReceiptResponse;
  createdAt: number;
}

export type AnswerReceiptBegin =
  | { kind: 'new' }
  | { kind: 'in-flight' }
  | { kind: 'replay'; response: AnswerReceiptResponse; state: AnswerReceiptState }
  | { kind: 'reused' }
  | { kind: 'uncertain' }
  | { kind: 'full' };

export interface AnswerReceiptView {
  approvalId: string;
  state: AnswerReceiptState;
  result?: AnswerReceiptResponse;
  createdAt: number;
}

const STATES: ReadonlySet<string> = new Set(['inFlight', 'done', 'partial', 'refused', 'uncertain']);

/** sha256 hex of a canonical rendering — the key and the body hash share it. */
export function receiptHash(parts: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * Single-daemon writer. The in-memory map is the truth and changes
 * synchronously, so two concurrent retries of one id see each other; the file
 * follows on one ordered write chain.
 */
export class AnswerReceiptStore {
  private readonly file: string;
  private rows = new Map<string, Row>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    directory: string,
    private readonly now: () => number = Date.now,
    private readonly perOwnerMax = ANSWER_RECEIPTS_PER_OWNER_MAX,
    // The phone's Moa wake keeps its own file (phone-moa-wake-receipts.json)
    // with the same rules, so its ids never meet an approval answer's.
    fileName = 'phone-answer-receipts.json',
  ) {
    this.file = path.join(directory, fileName);
    const saved = atomicReadJSONSync<{ version?: unknown; entries?: unknown }>(this.file);
    if (saved === null) return;
    if (saved.version !== 1 || !saved.entries || typeof saved.entries !== 'object' || Array.isArray(saved.entries)) {
      throw new Error('Invalid answer receipt storage');
    }
    for (const [key, value] of Object.entries(saved.entries as Record<string, unknown>)) {
      const row = value as Row;
      if (!/^[a-f0-9]{64}$/.test(key) || !row || typeof row !== 'object'
        || typeof row.owner !== 'string' || typeof row.approvalId !== 'string'
        || typeof row.bodyHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.bodyHash)
        || !STATES.has(row.state) || !Number.isSafeInteger(row.createdAt)) {
        throw new Error('Invalid answer receipt entry');
      }
      // An answer that was running when the daemon stopped may or may not have
      // reached the agent. Say so; never run it again.
      this.rows.set(key, row.state === 'inFlight' ? { ...row, state: 'uncertain' } : row);
    }
  }

  /**
   * Claim `(owner, clientAnswerId)` for one approval and body, or report what
   * the id already stands for. `new` means the caller must run the answer and
   * then `finish` or `release` it.
   */
  async begin(owner: string, clientAnswerId: string, approvalId: string, bodyHash: string): Promise<AnswerReceiptBegin> {
    const seen = this.peek(owner, clientAnswerId, approvalId, bodyHash);
    if (seen) return seen;
    const key = receiptHash([owner, clientAnswerId]);
    let owned = 0;
    for (const row of this.rows.values()) if (row.owner === owner) owned++;
    if (owned >= this.perOwnerMax) return { kind: 'full' };
    const row: Row = { owner, approvalId, bodyHash, state: 'inFlight', createdAt: this.now() };
    this.rows.set(key, row);
    try {
      await this.save();
    } catch (err) {
      // Not journaled ⇒ not run: a retry starts over.
      if (this.rows.get(key) === row) this.rows.delete(key);
      throw err;
    }
    return { kind: 'new' };
  }

  /**
   * What `(owner, clientAnswerId)` already stands for, or null when it is
   * unused. Synchronous and side-effect free apart from pruning, so a route
   * can replay a receipt before it looks for the approval — which may have
   * left the registry's history long before the receipt expires.
   */
  peek(owner: string, clientAnswerId: string, approvalId: string, bodyHash: string): Exclude<AnswerReceiptBegin, { kind: 'new' | 'full' }> | null {
    this.prune();
    const existing = this.rows.get(receiptHash([owner, clientAnswerId]));
    if (!existing) return null;
    if (existing.approvalId !== approvalId || existing.bodyHash !== bodyHash) return { kind: 'reused' };
    if (existing.state === 'inFlight') return { kind: 'in-flight' };
    if (existing.state === 'uncertain' || !existing.result) return { kind: 'uncertain' };
    return { kind: 'replay', response: existing.result, state: existing.state };
  }

  /**
   * Record the final response for a claimed id (`uncertain`: an answer that
   * may or may not have landed). A failed write leaves it `uncertain`, never `done`.
   */
  async finish(
    owner: string,
    clientAnswerId: string,
    state: Exclude<AnswerReceiptState, 'inFlight'>,
    result: AnswerReceiptResponse,
  ): Promise<void> {
    const key = receiptHash([owner, clientAnswerId]);
    const row = this.rows.get(key);
    if (!row || row.state !== 'inFlight') return;
    const next: Row = { ...row, state, result };
    this.rows.set(key, next);
    try {
      await this.save();
    } catch {
      // The answer happened; only its receipt did not reach disk, where it is
      // still in flight (a restart reads that as uncertain). Say the same now,
      // rather than a final result the disk does not hold.
      if (this.rows.get(key) === next) this.rows.set(key, { ...row, state: 'uncertain' });
    }
  }

  /**
   * Replace the response of a FINISHED (`done`) id with a final outcome
   * learned later — an accepted Moa wake whose brain then never took the
   * message. In-flight, refused and uncertain rows are left alone. A failed
   * write keeps the old response, which is what the disk still holds.
   */
  async revise(
    owner: string,
    clientAnswerId: string,
    state: Exclude<AnswerReceiptState, 'inFlight'>,
    result: AnswerReceiptResponse,
  ): Promise<boolean> {
    const key = receiptHash([owner, clientAnswerId]);
    const row = this.rows.get(key);
    if (!row || row.state !== 'done') return false;
    const next: Row = { ...row, state, result };
    this.rows.set(key, next);
    try {
      await this.save();
      return true;
    } catch {
      if (this.rows.get(key) === next) this.rows.set(key, row);
      return false;
    }
  }

  /** Forget a claimed id whose refusal the caller may retry past. */
  async release(owner: string, clientAnswerId: string): Promise<void> {
    const key = receiptHash([owner, clientAnswerId]);
    const row = this.rows.get(key);
    if (!row || row.state !== 'inFlight') return;
    this.rows.delete(key);
    await this.save().catch(() => undefined);
  }

  /** The owner's own receipt for this id, or null. */
  lookup(owner: string, clientAnswerId: string): AnswerReceiptView | null {
    const row = this.rows.get(receiptHash([owner, clientAnswerId]));
    if (!row || row.createdAt <= this.now() - ANSWER_RECEIPT_RETENTION_MS) return null;
    return {
      approvalId: row.approvalId,
      state: row.state,
      ...(row.result ? { result: row.result } : {}),
      createdAt: row.createdAt,
    };
  }

  private prune(): void {
    const cutoff = this.now() - ANSWER_RECEIPT_RETENTION_MS;
    for (const [key, row] of this.rows) {
      // Nothing runs for a day (the native answer is bounded by a timeout),
      // so an old in-flight row is one a lost write stranded: drop it too.
      if (row.createdAt <= cutoff) this.rows.delete(key);
    }
  }

  private save(): Promise<void> {
    const run = this.writes.then(() =>
      atomicWriteJSON(this.file, { version: 1, entries: Object.fromEntries(this.rows) }));
    this.writes = run.catch(() => undefined);
    return run;
  }
}
