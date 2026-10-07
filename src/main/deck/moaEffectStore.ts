// ─── Moa's merge outbox — MergeEffect records ────────────────────────────────
//
// `<wmuxDir>/moa-delegate/effects.json`. One row per decision that allowed a
// merge (`effect:<decisionId>:pr.merge`); kind 'pr.merge' only.
//
//   pending ──claim──▶ inFlight ──finish──▶ done | refused | uncertain
//   uncertain ──reconcile(fresh read)──▶ done | refused | pending | uncertain
//
// The row is journaled inFlight BEFORE the merge runs; a row found inFlight on
// load is uncertain (the merge may or may not have happened). Replay contract:
// claiming a row authorizes nothing by itself — the executor re-reads the PR
// and re-runs the lane predicates (moaMergeLane.ts) and mergeBlock before every
// try, so a stored "approved" is never trusted. Crash reconcile reads the PR:
// MERGED with headRefOid === expectHead is done (the squash commit is evidence,
// never the comparison: a squash commit is a new commit, not the head).
//
// Nothing constructs this at module load.

import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import type { MergeEffectStatus } from '../../shared/moaAsk';
import {
  MERGE_EFFECT_MAX_ATTEMPTS,
  MOA_DECISION_ID_RE,
  MOA_DELEGATE_DIRNAME,
  MOA_EFFECTS_FILENAME,
  mergeEffectId,
  type MergeEffect,
} from '../../shared/moaDecision';
import { isCommitSha, type PrLaneFacts } from '../../shared/prReview';

const STATUSES: ReadonlySet<string> = new Set(['pending', 'inFlight', 'done', 'refused', 'uncertain']);

/** A stored row's shape check (strict: one bad row refuses the file). */
export function isMergeEffectRecord(v: unknown): v is MergeEffect {
  const e = v as MergeEffect;
  return !!e && typeof e === 'object'
    && e.kind === 'pr.merge'
    && typeof e.decisionId === 'string' && MOA_DECISION_ID_RE.test(e.decisionId)
    && e.id === mergeEffectId(e.decisionId)
    && typeof e.repoKey === 'string' && e.repoKey.length > 0 && typeof e.repoPath === 'string' && e.repoPath.length > 0
    && Number.isSafeInteger(e.prNumber) && e.prNumber > 0
    && isCommitSha(e.expectHead)
    && (e.approvedBy === 'owner' || e.approvedBy === 'moa-auto')
    && STATUSES.has(e.status)
    && Number.isSafeInteger(e.attempt) && e.attempt >= 0
    && (e.reason === undefined || typeof e.reason === 'string')
    && (e.startedAt === undefined || Number.isSafeInteger(e.startedAt))
    && (e.mergeCommitOid === undefined || isCommitSha(e.mergeCommitOid))
    && Number.isSafeInteger(e.createdAt) && Number.isSafeInteger(e.updatedAt);
}

/** What a fresh read says about an uncertain (or claimed) merge. */
export type MergeReconcile = { status: MergeEffectStatus; reason?: string; mergeCommitOid?: string };

/**
 * The next state of an effect from a FRESH read of its PR (null: the read
 * failed). Pure. OPEN on the same head goes back to `pending` (a retry still
 * re-runs every predicate), unless the attempts are used up.
 */
export function reconcileMergeEffect(effect: Pick<MergeEffect, 'expectHead' | 'attempt'>, facts: Pick<PrLaneFacts, 'state' | 'headRefOid' | 'mergeCommitOid'> | null): MergeReconcile {
  if (!facts) return { status: 'uncertain', reason: 'read-failed' };
  if (facts.state === 'MERGED') {
    if (facts.headRefOid === effect.expectHead) {
      return { status: 'done', ...(facts.mergeCommitOid ? { mergeCommitOid: facts.mergeCommitOid } : {}) };
    }
    return { status: 'refused', reason: 'merged-other-head' };
  }
  if (facts.state === 'CLOSED') return { status: 'refused', reason: 'closed' };
  if (facts.state !== 'OPEN') return { status: 'uncertain', reason: 'unknown-state' };
  if (facts.headRefOid !== effect.expectHead) return { status: 'refused', reason: 'head-moved' };
  if (effect.attempt >= MERGE_EFFECT_MAX_ATTEMPTS) return { status: 'refused', reason: 'attempts-exhausted' };
  return { status: 'pending' };
}

export class MoaEffectStore {
  private readonly file: string;
  private rows = new Map<string, MergeEffect>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(wmuxDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(wmuxDir, MOA_DELEGATE_DIRNAME, MOA_EFFECTS_FILENAME);
    const saved = atomicReadJSONSync<{ version?: unknown; effects?: unknown }>(this.file);
    if (saved === null) {
      // Unreadable is not empty: starting blank would overwrite the file and
      // drop its uncertain rows. Refuse, like an invalid row.
      if (fs.existsSync(this.file)) throw new Error('Unreadable moa effect storage');
      return;
    }
    if (saved.version !== 1 || !Array.isArray(saved.effects)) throw new Error('Invalid moa effect storage');
    for (const e of saved.effects) {
      if (!isMergeEffectRecord(e)) throw new Error('Invalid moa effect entry');
      this.rows.set(e.id, e.status === 'inFlight' ? { ...e, status: 'uncertain', reason: 'restart-mid-merge' } : e);
    }
  }

  /** Add the effect for a decision, or return the one it already has. */
  async enqueue(input: Pick<MergeEffect, 'decisionId' | 'repoKey' | 'repoPath' | 'prNumber' | 'expectHead' | 'approvedBy'>): Promise<MergeEffect> {
    const id = mergeEffectId(input.decisionId);
    const existing = this.rows.get(id);
    if (existing) return existing;
    const at = this.now();
    const effect: MergeEffect = { id, kind: 'pr.merge', ...input, status: 'pending', attempt: 0, createdAt: at, updatedAt: at };
    if (!isMergeEffectRecord(effect)) throw new Error('invalid merge effect');
    this.rows.set(id, effect);
    try {
      await this.save();
    } catch (err) {
      if (this.rows.get(id) === effect) this.rows.delete(id);
      throw err;
    }
    return effect;
  }

  /**
   * Journal an attempt: pending → inFlight, attempt + 1, on disk before the
   * caller runs anything. Null when the row is not pending or out of attempts
   * (an uncertain row must be reconciled first). The caller must still
   * re-evaluate the lane on a fresh read before merging.
   */
  async claim(id: string): Promise<MergeEffect | null> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'pending' || row.attempt >= MERGE_EFFECT_MAX_ATTEMPTS) return null;
    const at = this.now();
    const next: MergeEffect = { ...row, status: 'inFlight', attempt: row.attempt + 1, startedAt: at, updatedAt: at };
    delete next.reason;
    this.rows.set(id, next);
    try {
      await this.save();
    } catch {
      if (this.rows.get(id) === next) this.rows.set(id, row);
      return null;
    }
    return next;
  }

  /** Record how a claimed attempt ended. A failed write leaves it uncertain. */
  async finish(id: string, status: 'done' | 'refused' | 'uncertain', reason?: string, mergeCommitOid?: string): Promise<MergeEffect | null> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'inFlight') return null;
    return this.put(row, { status, ...(reason ? { reason } : {}), ...(mergeCommitOid ? { mergeCommitOid } : {}) });
  }

  /** Apply reconcileMergeEffect's verdict to an uncertain row. */
  async reconcile(id: string, facts: Pick<PrLaneFacts, 'state' | 'headRefOid' | 'mergeCommitOid'> | null): Promise<MergeEffect | null> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'uncertain') return null;
    return this.put(row, reconcileMergeEffect(row, facts));
  }

  get(id: string): MergeEffect | null {
    return this.rows.get(id) ?? null;
  }

  list(): MergeEffect[] {
    return [...this.rows.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  private async put(row: MergeEffect, r: MergeReconcile): Promise<MergeEffect> {
    const next: MergeEffect = { ...row, status: r.status, updatedAt: this.now() };
    delete next.reason;
    if (r.reason) next.reason = r.reason;
    if (r.mergeCommitOid) next.mergeCommitOid = r.mergeCommitOid;
    this.rows.set(row.id, next);
    try {
      await this.save();
    } catch {
      // A done that is not on disk is not done: say uncertain, reconcile later.
      const fallback: MergeEffect = { ...row, status: 'uncertain', reason: 'write-failed', updatedAt: this.now() };
      if (this.rows.get(row.id) === next) this.rows.set(row.id, fallback);
      return fallback;
    }
    return next;
  }

  private save(): Promise<void> {
    const run = this.writes.then(() =>
      atomicWriteJSON(this.file, { version: 1, effects: [...this.rows.values()] }));
    this.writes = run.catch(() => undefined);
    return run;
  }
}
