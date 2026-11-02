// ─── The act outbox — one row per approved act request ─────────────────────
//
// `<wmuxDir>/factory/act-effects.json` ({version:1, effects}). The merge
// executor keeps its own outbox (deck/moaEffectStore.ts), which refuses a
// row of a kind it does not know; acts live here so that an older build
// still reads its merges.
//
//   pending ──claim──▶ inFlight ──finish──▶ done | refused | uncertain
//                         └──release (nothing was written)──▶ pending
//   uncertain ──settle (a read of GitHub)──▶ done | refused | pending
//   pending, never started ──settle (its approval aged out)──▶ refused
//   pending or uncertain, claimed, stalled ──settle (a read found nothing)──▶ refused
//
// A row is journaled inFlight, on disk, before its write is sent; a row found
// inFlight on load is uncertain (the write may or may not have landed) and is
// settled by a read before anything is sent again. Claiming authorizes
// nothing: the executor asks the approval store on every try. A row whose
// action this build does not know is kept and never run; a malformed row
// refuses the file (the outbox is not dropped).
//
// A release published through the API takes two writes: a draft (which makes
// no tag), then publishing it. The draft's id is journaled on the row as soon
// as GitHub names it (noteDraft), so a later try publishes that draft rather
// than making a second one. A release row refused with a draft is journaled
// with that draft open (draftOpen) in the same write as the refusal, until
// what becomes of the draft is decided and journaled (decideDraft): a quit,
// or a read GitHub did not answer, in between leaves it open, and the next
// sweep decides it. A row an earlier build refused has no flag: its draft
// was decided then.
//
// A claimed row whose reads keep failing (a read before the write, or the
// reconcile read) counts them (noteReadUnanswered). Past ACT_STALL_MAX_MS
// from its first try and ACT_STALL_MIN_TRIES such reads (actStalledTooLong),
// no write is sent for it again: a read that finds nothing refuses it, one
// that finds the act settles it, and while reads still cannot say the owner
// is told it may have gone through (approvals.ts onActStalled).

import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import { ACT_ACTIONS, APPROVAL_ID_RE, type ActAction } from '../../shared/botApproval';

export const ACT_EFFECTS_FILENAME = 'act-effects.json';

/** Tries one row gets (a write that was not sent gives its try back). */
export const ACT_MAX_ATTEMPTS = 3;

export type ActEffectStatus = 'pending' | 'inFlight' | 'done' | 'refused' | 'uncertain';

export interface ActEffect {
  /** `act:<requestId>`. */
  id: string;
  requestId: string;
  action: ActAction;
  repoKey: string;
  /** The request's payloadHash when it was enqueued. */
  payloadHash: string;
  status: ActEffectStatus;
  attempt: number;
  reason?: string;
  /** The first claim: a reconcile reads GitHub's answers from just before it. */
  firstStartedAt?: number;
  startedAt?: number;
  result?: { url: string; id?: number; number?: number };
  /** A release's draft on GitHub, made by an earlier write of this row. */
  draftId?: number;
  /** A refused release row's draft is still to be deleted or kept. */
  draftOpen?: true;
  /** Its draft's reads GitHub did not answer: since the first, and how many
   *  (DRAFT_OPEN_MAX_MS and DRAFT_OPEN_MIN_TRIES bound them). */
  draftUnansweredAt?: number;
  draftUnansweredTries?: number;
  /** Reads of a claimed row GitHub did not answer (ACT_STALL_MIN_TRIES), and
   *  the last one's error, clipped. */
  readUnansweredTries?: number;
  lastReadError?: string;
  createdAt: number;
  updatedAt: number;
}

const STATUSES: ReadonlySet<string> = new Set(['pending', 'inFlight', 'done', 'refused', 'uncertain']);

export function actEffectId(requestId: string): string {
  return `act:${requestId}`;
}

function wellFormed(v: unknown): v is ActEffect {
  const e = v as ActEffect;
  return !!e && typeof e === 'object'
    && typeof e.requestId === 'string' && APPROVAL_ID_RE.test(e.requestId) && e.id === actEffectId(e.requestId)
    && typeof e.action === 'string' && typeof e.repoKey === 'string' && typeof e.payloadHash === 'string'
    && STATUSES.has(e.status) && Number.isSafeInteger(e.attempt) && e.attempt >= 0
    && (e.reason === undefined || typeof e.reason === 'string')
    && (e.result === undefined || (typeof e.result === 'object' && e.result !== null && typeof e.result.url === 'string'))
    && (e.draftId === undefined || (Number.isSafeInteger(e.draftId) && e.draftId > 0))
    && (e.draftOpen === undefined || e.draftOpen === true)
    && (e.draftUnansweredAt === undefined || Number.isSafeInteger(e.draftUnansweredAt))
    && (e.draftUnansweredTries === undefined || (Number.isSafeInteger(e.draftUnansweredTries) && e.draftUnansweredTries > 0))
    && (e.readUnansweredTries === undefined || (Number.isSafeInteger(e.readUnansweredTries) && e.readUnansweredTries > 0))
    && (e.lastReadError === undefined || typeof e.lastReadError === 'string')
    && Number.isSafeInteger(e.createdAt) && Number.isSafeInteger(e.updatedAt);
}

/** Whether this build runs a row's action. */
export function runnableAct(e: Pick<ActEffect, 'action'>): boolean {
  return ACT_ACTIONS.has(e.action);
}

/** Whether a row was claimed at least once (a write may have reached
 *  GitHub): any row past pending, a pending one an earlier try left, and one
 *  whose release draft is on GitHub (whatever its tries). */
export function actRowClaimed(e: Pick<ActEffect, 'status' | 'attempt' | 'draftId'>): boolean {
  return e.status !== 'pending' || e.attempt > 0 || e.draftId !== undefined;
}

/** How long, from the first read GitHub did not answer, and for how many
 *  such reads at least, a draft stays open; past both, it is decided as kept
 *  and not checked, and the owner is told. Both: a long time off counts no
 *  tries, and a start's first sweep (before the network is up) only one. */
export const DRAFT_OPEN_MAX_MS = 24 * 60 * 60_000;
export const DRAFT_OPEN_MIN_TRIES = 12;

/** Whether a draft GitHub has not answered for is past both bounds. Pure. */
export function draftUnansweredTooLong(e: Pick<ActEffect, 'draftUnansweredAt' | 'draftUnansweredTries'>, now: number): boolean {
  return e.draftUnansweredAt !== undefined && now - e.draftUnansweredAt >= DRAFT_OPEN_MAX_MS
    && (e.draftUnansweredTries ?? 0) >= DRAFT_OPEN_MIN_TRIES;
}

/** How long from a claimed row's first try, and for how many reads GitHub
 *  did not answer at least, it is tried; past both, no write is sent for it
 *  again. Both, as for a draft: a long time off counts no reads. */
export const ACT_STALL_MAX_MS = 24 * 60 * 60_000;
export const ACT_STALL_MIN_TRIES = 12;
const READ_ERROR_MAX = 200;

/** Whether a claimed row's reads have failed past both bounds. Pure. */
export function actStalledTooLong(e: Pick<ActEffect, 'status' | 'attempt' | 'draftId' | 'firstStartedAt' | 'createdAt' | 'readUnansweredTries'>, now: number): boolean {
  return actRowClaimed(e) && now - (e.firstStartedAt ?? e.createdAt) >= ACT_STALL_MAX_MS
    && (e.readUnansweredTries ?? 0) >= ACT_STALL_MIN_TRIES;
}

/** Whether a refused release row's draft is still to be deleted or kept. Pure. */
export function draftUndecided(e: Pick<ActEffect, 'status' | 'draftOpen'>): boolean {
  return e.status === 'refused' && e.draftOpen === true;
}

export class ActEffectStore {
  private rows = new Map<string, ActEffect>();

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    if (!fs.existsSync(file)) return;
    const raw = atomicReadJSONSync<{ version?: unknown; effects?: unknown }>(file);
    if (!raw || raw.version !== 1 || !Array.isArray(raw.effects)) throw new Error('Unreadable act effect storage');
    for (const e of raw.effects) {
      if (!wellFormed(e)) throw new Error('Invalid act effect entry');
      this.rows.set(e.id, e.status === 'inFlight' ? { ...e, status: 'uncertain', reason: 'restart-mid-write' } : e);
    }
  }

  private save(): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      atomicWriteJSONSync(this.file, { version: 1, effects: [...this.rows.values()] });
      return true;
    } catch (err) {
      console.warn(`[factory] act effects not written: ${String(err)}`);
      return false;
    }
  }

  /** Put a row; undone in memory when it did not reach the file. */
  private put(next: ActEffect): boolean {
    const prev = this.rows.get(next.id);
    this.rows.set(next.id, next);
    if (this.save()) return true;
    if (prev) this.rows.set(next.id, prev);
    else this.rows.delete(next.id);
    return false;
  }

  get(id: string): ActEffect | null {
    return this.rows.get(id) ?? null;
  }

  list(): ActEffect[] {
    return [...this.rows.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** The row of a request, added pending when it has none (whatever its
   *  status otherwise: one row per request). Null when it could not be stored. */
  enqueue(input: { requestId: string; action: ActAction; repoKey: string; payloadHash: string }): ActEffect | null {
    const id = actEffectId(input.requestId);
    const existing = this.rows.get(id);
    if (existing) return existing;
    const at = this.now();
    const row: ActEffect = { id, ...input, status: 'pending', attempt: 0, createdAt: at, updatedAt: at };
    return this.put(row) ? row : null;
  }

  /** pending → inFlight, attempt + 1, on disk before the write. Null when the
   *  row is not pending, has used its tries, or the journal failed. */
  claim(id: string): ActEffect | null {
    const row = this.rows.get(id);
    if (!row || row.status !== 'pending' || row.attempt >= ACT_MAX_ATTEMPTS || !runnableAct(row)) return null;
    const at = this.now();
    const next: ActEffect = { ...row, status: 'inFlight', attempt: row.attempt + 1, startedAt: at, firstStartedAt: row.firstStartedAt ?? at, updatedAt: at };
    delete next.reason;
    return this.put(next) ? next : null;
  }

  /** Journal the draft a row's write made (or found), while the row is
   *  claimed or being settled. Null when the row is not one of those or the
   *  file was not written (the row is then uncertain in memory). */
  noteDraft(id: string, draftId: number): ActEffect | null {
    const row = this.rows.get(id);
    if (!row || !Number.isSafeInteger(draftId) || draftId <= 0) return null;
    if (row.status !== 'inFlight' && row.status !== 'uncertain' && row.status !== 'pending') return null;
    if (row.draftId === draftId) return row;
    const next: ActEffect = { ...row, draftId, updatedAt: this.now() };
    if (this.put(next)) return next;
    // A claimed row whose draft is not on disk: settled by a read (the draft
    // scan finds it), never written again blind.
    if (row.status === 'inFlight') this.unjournaled(row);
    return null;
  }

  /** inFlight → pending: nothing was written (the approval was taken back,
   *  GitHub's rate limit refused it before it was sent); the try is given back.
   *  A release's draft made by an earlier write keeps the row claimed
   *  (actRowClaimed), not its count of tries. */
  release(id: string, reason: string): ActEffect | null {
    const row = this.rows.get(id);
    if (!row || row.status !== 'inFlight') return null;
    const next: ActEffect = { ...row, status: 'pending', attempt: Math.max(0, row.attempt - 1), reason, updatedAt: this.now() };
    return this.put(next) ? next : this.unjournaled(row);
  }

  /** How a claimed try ended. A done that is not on disk is uncertain. */
  finish(id: string, status: 'done' | 'refused' | 'uncertain', reason?: string, result?: ActEffect['result']): ActEffect | null {
    const row = this.rows.get(id);
    if (!row || row.status !== 'inFlight') return null;
    return this.end(row, status, reason, result);
  }

  /** A refused row's draft decided: no longer open, and the reason told
   *  more when the draft stays on GitHub (`reason`). Null when its draft is
   *  not open or the file was not written (it stays open). */
  decideDraft(id: string, reason?: string): ActEffect | null {
    const row = this.rows.get(id);
    if (!row || !draftUndecided(row)) return null;
    const next: ActEffect = { ...row, ...(reason ? { reason } : {}), updatedAt: this.now() };
    delete next.draftOpen;
    delete next.draftUnansweredAt;
    delete next.draftUnansweredTries;
    return this.put(next) ? next : null;
  }

  /** A read of a row's draft GitHub did not answer, at `at`, counted. The
   *  row as counted; null when it has no draft. Not journaled: the row as it
   *  was (it stays open). */
  noteDraftUnanswered(id: string, at: number): ActEffect | null {
    const row = this.rows.get(id);
    if (!row || row.draftId === undefined) return null;
    const next: ActEffect = {
      ...row,
      draftUnansweredAt: row.draftUnansweredAt ?? at,
      draftUnansweredTries: (row.draftUnansweredTries ?? 0) + 1,
    };
    return this.put(next) ? next : row;
  }

  /** A read of a claimed row GitHub did not answer, counted with its error
   *  (not a move of the row: updatedAt is kept, as noteDraftUnanswered).
   *  The row as counted (as it was for a row not claimed, pending or
   *  uncertain); null when there is no row. Not journaled: the row as it was. */
  noteReadUnanswered(id: string, error: string): ActEffect | null {
    const row = this.rows.get(id);
    if (!row || !actRowClaimed(row) || (row.status !== 'pending' && row.status !== 'uncertain')) return row ?? null;
    const next: ActEffect = {
      ...row,
      readUnansweredTries: (row.readUnansweredTries ?? 0) + 1,
      lastReadError: error.replace(/\s+/g, ' ').trim().slice(0, READ_ERROR_MAX),
    };
    return this.put(next) ? next : row;
  }

  /** What a read of GitHub says about a row that may have run (uncertain, or
   *  pending after an earlier try): done, refused, or pending again (attempts
   *  left) when nothing was found. Also a pending row no try of which
   *  started, refused as its approval aged out (`approval-stale`). */
  settle(id: string, status: 'done' | 'refused' | 'pending', reason?: string, result?: ActEffect['result']): ActEffect | null {
    const row = this.rows.get(id);
    if (!row || (row.status !== 'uncertain' && row.status !== 'pending')) return null;
    if (status === 'pending' && row.attempt >= ACT_MAX_ATTEMPTS) return this.end(row, 'refused', 'attempts-exhausted');
    return this.end(row, status, reason, result);
  }

  private end(row: ActEffect, status: ActEffectStatus, reason?: string, result?: ActEffect['result']): ActEffect {
    const next: ActEffect = { ...row, status, updatedAt: this.now() };
    delete next.reason;
    if (reason) next.reason = reason;
    if (result) next.result = result;
    // A refused release row's draft is open in the same write as the refusal,
    // unless the refusal already says what became of it: published as the
    // release (its result), or deleted on GitHub (draft-gone).
    if (status === 'refused' && row.action === 'release' && row.draftId !== undefined
      && result?.id !== row.draftId && !(reason ?? '').split(/,\s*/).includes('draft-gone')) {
      next.draftOpen = true;
    }
    return this.put(next) ? next : this.unjournaled(row);
  }

  /** A move that did not reach the file: uncertain in memory, settled by a
   *  read before anything is sent again. */
  private unjournaled(row: ActEffect): ActEffect {
    const fallback: ActEffect = { ...row, status: 'uncertain', reason: 'write-failed', updatedAt: this.now() };
    this.rows.set(row.id, fallback);
    return fallback;
  }

  /** Drop the row of a request that ended (it expired, or aged out). A row
   *  that was claimed and has not ended stays until a read settles it, and a
   *  refused one whose draft is undecided until the sweep decides it. */
  remove(id: string): void {
    const row = this.rows.get(id);
    if (!row || (actRowClaimed(row) && row.status !== 'done' && row.status !== 'refused') || draftUndecided(row)) return;
    this.drop(id);
  }

  /** Drop a row whatever its status (its request is gone). False when the
   *  file was not written: the row stays. */
  drop(id: string): boolean {
    const row = this.rows.get(id);
    if (!row) return true;
    this.rows.delete(id);
    if (this.save()) return true;
    this.rows.set(id, row);
    return false;
  }
}
