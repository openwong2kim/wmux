// ─── Moa's merge executor — runs the MergeEffect outbox (moaEffectStore.ts) ──
//
//   run(id):  authorize → claim (journal inFlight first) → FRESH lane read
//             (MergeLaneFactsReader, never the TTL cache) → evaluateMergeLane
//             (every predicate for 'moa-auto'; OWNER_APPROVED_PREDICATES for an
//             owner's approval) → GhPrReviewService.merge() unchanged (it reads
//             the head again, applies mergeBlock and passes
//             --match-head-commit) → finish.
//   reconcileAll():  every `uncertain` row is read fresh and settled by
//             reconcileMergeEffect (MERGED with headRefOid === expectHead →
//             done); a row that comes back `pending` runs again from the top.
//
// Nothing stored authorizes a merge. `authorize` is asked on every try: the
// decision behind the effect must read answered/go NOW (a forged outbox row has
// no such decision), and a 'moa-auto' effect must still be auto-eligible (book
// attribute, the owner's toggle, the kill switch). A failure after the claim
// that may or may not have reached GitHub ends `uncertain`, never `done`.

import type { MergeEffect } from '../../shared/moaDecision';
import type { PrLaneFacts, PrWriteResult } from '../../shared/prReview';
import { reconcileMergeEffect, type MoaEffectStore } from './moaEffectStore';
import {
  LANE_PREDICATES,
  OWNER_APPROVED_PREDICATES,
  evaluateMergeLane,
  type MergeLaneContext,
  type MergeLaneFactsReader,
} from './moaMergeLane';

export interface MoaMergeExecutorPorts {
  effects: MoaEffectStore;
  facts: MergeLaneFactsReader;
  /** The squash merge itself (GhPrReviewService.merge with expectHead). */
  merge: (effect: MergeEffect) => Promise<PrWriteResult>;
  /** trustedAuthors and askerBranches for this effect, read by main now. */
  laneContext: (effect: MergeEffect) => Promise<Omit<MergeLaneContext, 'expectHead'>>;
  /** Null when the effect may run now, else the refusal reason. */
  authorize: (effect: MergeEffect) => string | null;
  emit?: (effect: MergeEffect) => void;
  log?: (line: string) => void;
}

export class MoaMergeExecutor {
  private readonly running = new Map<string, Promise<MergeEffect | null>>();

  constructor(private readonly ports: MoaMergeExecutorPorts) {}

  /** Run one pending effect. Concurrent calls for one id share the run. */
  run(id: string): Promise<MergeEffect | null> {
    const live = this.running.get(id);
    if (live) return live;
    const p = this.runOnce(id).finally(() => this.running.delete(id));
    this.running.set(id, p);
    return p;
  }

  /** Settle every uncertain row from a fresh read, then run what is pending
   *  (startup and the periodic tick). Never re-runs a row without a read. */
  async reconcileAll(): Promise<void> {
    for (const row of this.ports.effects.list()) {
      if (row.status !== 'uncertain') continue;
      const facts = await this.read(row);
      const next = await this.ports.effects.reconcile(row.id, facts);
      if (next) this.emit(next);
    }
    for (const row of this.ports.effects.list()) {
      if (row.status === 'pending') await this.run(row.id);
    }
  }

  private async runOnce(id: string): Promise<MergeEffect | null> {
    const { effects } = this.ports;
    const claimed = await effects.claim(id);
    if (!claimed) return effects.get(id);
    this.emit(claimed);
    const end = async (status: 'done' | 'refused' | 'uncertain', reason?: string, oid?: string): Promise<MergeEffect | null> => {
      const row = await effects.finish(id, status, reason, oid);
      if (row) {
        this.emit(row);
        this.ports.log?.(`[moa-merge] ${row.repoKey}#${row.prNumber} ${row.status}${row.reason ? ` (${row.reason})` : ''}`);
      }
      return row;
    };
    try {
      const denied = this.ports.authorize(claimed);
      if (denied) return await end('refused', denied);
      const facts = await this.read(claimed);
      if (!facts) return await end('uncertain', 'read-failed');
      if (facts.number !== claimed.prNumber) return await end('refused', 'pr-mismatch');
      // Not open (or another head) is settled from the read, never merged.
      const pre = reconcileMergeEffect({ expectHead: claimed.expectHead, attempt: 0 }, facts);
      if (pre.status !== 'pending') return await end(pre.status === 'done' ? 'done' : pre.status === 'refused' ? 'refused' : 'uncertain', pre.reason, pre.mergeCommitOid);
      const ctx = await this.ports.laneContext(claimed);
      const verdict = evaluateMergeLane(
        facts,
        { ...ctx, expectHead: claimed.expectHead },
        claimed.approvedBy === 'moa-auto' ? LANE_PREDICATES : OWNER_APPROVED_PREDICATES,
      );
      if (!verdict.ok) {
        const f = verdict.failures[0];
        return await end('refused', f ? `${f.predicate}:${f.reason}` : 'lane');
      }
      const r = await this.ports.merge(claimed);
      if (r.ok) {
        const after = await this.read(claimed);
        const oid = after && after.state === 'MERGED' && after.headRefOid === claimed.expectHead ? after.mergeCommitOid ?? undefined : undefined;
        return await end('done', undefined, oid);
      }
      if (r.code === 'moved') return await end('refused', 'head-moved');
      if (r.code === 'blocked') return await end('refused', `blocked-${r.reason}`);
      if (r.code === 'invalid') return await end('refused', 'invalid');
      // A rate limit or a gh error may have happened after GitHub merged.
      return await end('uncertain', `merge-${r.code}`);
    } catch (err) {
      this.ports.log?.(`[moa-merge] ${id} failed: ${String(err)}`);
      return end('uncertain', 'executor-error');
    }
  }

  private async read(e: MergeEffect): Promise<PrLaneFacts | null> {
    try {
      return await this.ports.facts.readFresh(e.repoPath, e.repoKey, e.prNumber);
    } catch {
      return null;
    }
  }

  private emit(e: MergeEffect): void {
    try { this.ports.emit?.(e); } catch { /* a listener never breaks the outbox */ }
  }
}
