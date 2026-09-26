import { summarizeSamples } from './perf-scenarios.mjs';
import { compareResults, GATES } from './perf-compare.mjs';

// Sample `frames` rAF deltas (ms) inside the renderer — the same cadence probe
// measureInputLatency uses, but WITHOUT any keystroke: it measures the compositor
// cadence while whatever workload is currently running streams. Returns raw
// deltas so the caller can summarize + detect throttling.
export async function sampleRafDeltas(page, frames = 60) {
  return page.evaluate((n) => new Promise((resolve) => {
    const deltas = []; let last = null; let i = 0;
    const tick = (ts) => {
      if (last !== null) deltas.push(ts - last);
      last = ts;
      if (++i < n) requestAnimationFrame(tick); else resolve(deltas);
    };
    requestAnimationFrame(tick);
  }), frames);
}


/** Confirm a failing 60-frame sample once under the same active flood. */
export async function sampleFrameBudget(page, n, baseline, log = console.log) {
  const gate = GATES.find((candidate) => candidate.key === `frameBudgetP95Ms_N${n}`);
  const samples = [];
  const take = async () => {
    const stats = summarizeSamples(await sampleRafDeltas(page));
    samples.push(stats);
    log(`[frameBudget N${n}] sample=${samples.length} p50=${stats.p50}ms p95=${stats.p95}ms`);
    return stats;
  };
  const first = await take();
  const result = (stats) => ({ scenarios: { frameBudget: { [`N${n}`]: { frameDeltaMs: stats } } } });
  const verdict = (stats) => gate && baseline
    ? compareResults(result(stats), baseline, [gate])[0].status
    : 'NEW';
  if (verdict(first) !== 'FAIL') return { stats: first, samples };
  await take();
  // Preserve the first measurement for history and baseline comparison. The
  // comparator judges the confirmation against the baseline it was given.
  return { stats: first, samples };
}
