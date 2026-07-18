// ─── AO-style review-feedback routing, slice 2 (owner decision 2026-07-18) ───
//
// Sibling of PrCiRouter: where that one routes a RED CI back to the owning
// workspace, this one routes NEW PR REVIEW FEEDBACK (conversation comments,
// review verdicts, inline review comments — everything GhPrService.prDetail
// already normalizes into one stream) the same way. A reviewer leaves a
// comment → the owning workspace's brain wakes and (in auto) may drive the
// pane to address it.
//
// WATERMARK, not edge: comments are an append-only stream, so we remember the
// max `createdAt` seen per pane and fire once per batch of strictly-newer
// comments. The FIRST observation of a PR arms the watermark silently — an
// existing review history must not wake the brain the moment a pane checks
// out an old PR branch.
//
// COST: rides entirely on existing caches. `listPrs` has a 30 s TTL per repo
// and `prDetail` is keyed by the PR's `updatedAt` (unchanged → no gh call), so
// the only new steady-state cost is one throttled cache read per pane per
// CHECK_INTERVAL. The per-pane throttle is written SYNCHRONOUSLY before any
// await, so overlapping poll ticks can't double-fetch.
//
// Pure of Electron: provider (gh), resolver and emit sink are injected —
// production wiring lives in metadata.handler next to PrCiRouter's.

import type { PrStatus } from '../../shared/types';
import type { PrListResult, PrDetailResult } from '../github/PrProvider';
import type { WorkspaceResolver } from './PrCiRouter';

/** How often one pane may hit the (cached) provider. The metadata poll ticks
 *  every 5 s; review feedback is human-latency, so once a minute is plenty. */
const CHECK_INTERVAL_MS = 60_000;

/** Snippet cap for the wake prompt — pointer + flavor, never the full body. */
const SNIPPET_CAP = 140;

/** The provider slice this router needs (GhPrService satisfies it). */
export interface ReviewProvider {
  listPrs(repoPath: string, force?: boolean): Promise<PrListResult>;
  prDetail(repoPath: string, number: number, updatedAt: string): Promise<PrDetailResult>;
}

export interface PrReviewEmit {
  workspaceId: string;
  ptyId: string;
  prNumber: number;
  url: string;
  /** How many strictly-new comments this batch carries. */
  count: number;
  /** Author + sanitized snippet of the LATEST comment in the batch. */
  author: string;
  snippet: string;
}

/** Merge-conflict edge (slice 3) — fired once when a pane's PR becomes
 *  CONFLICTING (including first observation), re-armed when it leaves. */
export interface PrConflictEmit {
  workspaceId: string;
  ptyId: string;
  prNumber: number;
  url: string;
}

/** Display-safe snippet: control chars and newlines stripped, hard cap. The
 *  coalescer prompt already fences pane-derived text as untrusted data; this
 *  strip keeps a comment from smuggling escapes into the terminal render. */
export function sanitizeSnippet(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_CAP ? `${flat.slice(0, SNIPPET_CAP)}…` : flat;
}

interface PaneState {
  /** Which PR the watermark belongs to — a branch switch resets it. */
  prNumber: number;
  /** Max comment `createdAt` already seen (ISO string compare). Null = not yet
   *  armed; the first successful read arms silently without firing. */
  watermark: string | null;
  /** Last provider check (throttle), ms epoch. */
  lastCheck: number;
  /** Whether we already fired for this PR being CONFLICTING (edge memory —
   *  re-armed when mergeable leaves CONFLICTING; reset with the PR). */
  conflictFired: boolean;
}

export class PrReviewRouter {
  private panes = new Map<string, PaneState>();

  constructor(
    private readonly provider: ReviewProvider,
    private readonly resolveWorkspaceId: WorkspaceResolver,
    private readonly emit: (e: PrReviewEmit) => void,
    private readonly now: () => number = Date.now,
    /** Optional merge-conflict sink (slice 3). Absent → conflicts ignored. */
    private readonly emitConflict?: (e: PrConflictEmit) => void,
  ) {}

  /**
   * Observe one pane's poll result. No PR (or no cwd context) drops the pane's
   * state so a future PR starts fresh. Throttled per pane; never throws.
   */
  async note(ptyId: string, cwd: string, pr: PrStatus | null): Promise<void> {
    if (!pr || typeof pr.number !== 'number') {
      this.panes.delete(ptyId);
      return;
    }
    let st = this.panes.get(ptyId);
    if (!st || st.prNumber !== pr.number) {
      // NEGATIVE_INFINITY, not 0: the first check must always pass the
      // throttle regardless of the clock's epoch (a fake clock starts at 0).
      st = { prNumber: pr.number, watermark: null, lastCheck: Number.NEGATIVE_INFINITY, conflictFired: false };
      this.panes.set(ptyId, st);
    }
    const now = this.now();
    if (now - st.lastCheck < CHECK_INTERVAL_MS) return;
    st.lastCheck = now; // sync write BEFORE any await — overlap guard

    try {
      const list = await this.provider.listPrs(cwd);
      if (!list.ok) return;
      const summary = list.prs.find((p) => p.number === pr.number);
      if (!summary) return; // PR closed/merged out of the open list — nothing to route

      // Slice 3 — merge-conflict edge, riding the SAME throttled read. Fires
      // once per CONFLICTING episode (including first observation — an already-
      // conflicted PR you check out is actionable, matching PrCiRouter's rule),
      // re-arms when mergeable leaves CONFLICTING. `conflictFired` flips back
      // only on success so a transient resolve failure retries next interval.
      if (this.emitConflict) {
        if (summary.mergeable !== 'CONFLICTING') {
          st.conflictFired = false;
        } else if (!st.conflictFired) {
          const ws = await this.resolveWorkspaceId(ptyId);
          if (ws) {
            this.emitConflict({ workspaceId: ws, ptyId, prNumber: pr.number, url: pr.url });
            st.conflictFired = true;
          }
        }
      }
      const detail = await this.provider.prDetail(cwd, pr.number, summary.updatedAt);
      if (!detail.ok) return;
      const comments = detail.detail.comments;
      let maxCreated = '';
      for (const c of comments) if (c.createdAt > maxCreated) maxCreated = c.createdAt;
      if (st.watermark === null) {
        // First sighting: arm past the existing history, fire nothing. An
        // EMPTY history arms at '' (CodeRabbit, PR #496) — leaving it null
        // would make the first future comment another silent "first sighting".
        st.watermark = maxCreated;
        return;
      }
      const fresh = comments.filter((c) => c.createdAt > (st!.watermark as string));
      if (fresh.length === 0) return;
      const latest = fresh[fresh.length - 1];
      const workspaceId = await this.resolveWorkspaceId(ptyId);
      if (!workspaceId) return; // unresolved → drop; watermark NOT advanced → next interval retries
      this.emit({
        workspaceId,
        ptyId,
        prNumber: pr.number,
        url: pr.url,
        count: fresh.length,
        author: latest.author,
        snippet: sanitizeSnippet(latest.body),
      });
      // Advance ONLY after a successful emit (CodeRabbit, PR #496) — a resolve
      // failure or emit throw above leaves the watermark put, so the same
      // batch re-fires on the next interval instead of being lost.
      st.watermark = maxCreated;
    } catch {
      /* provider/resolver failure must never break the metadata poll. The
         watermark was NOT advanced on this path, so the batch re-fires on the
         next interval instead of being lost. */
    }
  }

  /** Drop a pane's memory when it closes (poll prune parity). */
  forget(ptyId: string): void {
    this.panes.delete(ptyId);
  }
}
