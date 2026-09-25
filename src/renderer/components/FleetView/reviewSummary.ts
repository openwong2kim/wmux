// Change counts for Fleet's Ready to review rows, from the counts-only
// diff:summary IPC. One cache entry per task, keyed by the worktree state key
// main returns: a repeat ask with the same key costs one status call and
// returns `unchanged`, so a re-render never recounts, and any change to the
// worktree (a same-minute rerun included) does. At most two reads run at
// once, and entries for tasks that left the queue are pruned.
import type { DiffSummaryResult } from '../../../shared/diffParse';

export interface ReviewChangeSummary {
  files: number;
  additions: number;
  deletions: number;
  /** Files with no line counts (binary, symlink, unreadable). */
  binary: number;
}

const MAX_CONCURRENT = 2;

const cache = new Map<string, { stateKey: string; summary: ReviewChangeSummary }>();
const pending = new Map<string, Promise<ReviewChangeSummary | null>>();
let running = 0;
const waiting: Array<() => void> = [];

function limited<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running += 1;
      fn().then(resolve, reject).finally(() => {
        running -= 1;
        waiting.shift()?.();
      });
    };
    if (running < MAX_CONCURRENT) start();
    else waiting.push(start);
  });
}

type SummaryBridge = (worktreePath: string, knownStateKey?: string) => Promise<DiffSummaryResult | { ok: false; error: string }>;

function bridge(): SummaryBridge | null {
  const fn = (window as unknown as { electronAPI?: { diff?: { summary?: SummaryBridge } } }).electronAPI?.diff?.summary;
  return typeof fn === 'function' ? fn : null;
}

/** The last counts read for a task, if any (shown while a refresh runs). */
export function cachedReviewSummary(taskId: string): ReviewChangeSummary | undefined {
  return cache.get(taskId)?.summary;
}

/** Read (or confirm) a task's counts. Null when the read failed — the row
 *  then says the counts are unavailable rather than showing a wrong total.
 *  Concurrent asks for one task share a single read. */
export function loadReviewSummary(taskId: string, worktreePath: string): Promise<ReviewChangeSummary | null> {
  const inFlight = pending.get(taskId);
  if (inFlight) return inFlight;
  const summaryFn = bridge();
  if (!summaryFn || !worktreePath) return Promise.resolve(null);
  const run = limited(async () => {
    const known = cache.get(taskId);
    let res = await summaryFn(worktreePath, known?.stateKey);
    if (res.ok && res.unchanged) {
      if (known) return known.summary;
      res = await summaryFn(worktreePath);
    }
    if (!res.ok || res.unchanged) return null;
    const summary = { files: res.files, additions: res.additions, deletions: res.deletions, binary: res.binary };
    cache.set(taskId, { stateKey: res.stateKey, summary });
    return summary;
  }).catch(() => null).finally(() => { pending.delete(taskId); });
  pending.set(taskId, run);
  return run;
}

/** Drop cached counts for tasks no longer in the queue. */
export function pruneReviewSummaries(keepTaskIds: ReadonlySet<string>): void {
  for (const id of cache.keys()) if (!keepTaskIds.has(id)) cache.delete(id);
}

/** Test hook: forget everything. */
export function resetReviewSummariesForTests(): void {
  cache.clear();
  pending.clear();
  running = 0;
  waiting.length = 0;
}
