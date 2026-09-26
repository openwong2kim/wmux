import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleRafDeltas } from '../perf-frame-sample.mjs';
import { summarizeSamples } from '../perf-scenarios.mjs';
import { compareResults, GATES } from '../perf-compare.mjs';

const gate = GATES.find((g) => g.key === 'frameBudgetP95Ms_N8');
function verdict(p95) {
  const result = (value) => ({ scenarios: { frameBudget: { N8: { frameDeltaMs: { p95: value } } } } });
  return compareResults(result(p95), result(15.7), [gate])[0].status;
}
function pageWithCadence(deltaAt) {
  let frame = 0;
  let time = 0;
  vi.stubGlobal('requestAnimationFrame', (callback) => {
    time += deltaAt(frame++);
    callback(time);
  });
  return { evaluate: (fn, arg) => fn(arg) };
}
afterEach(() => vi.unstubAllGlobals());

describe('frame-budget measurement window', () => {
  it('keeps a brief three-frame hiccup from determining p95', async () => {
    const cadence = (frame) => frame >= 20 && frame < 23 ? 62.6 : 15.7;
    const short = summarizeSamples(await sampleRafDeltas(pageWithCadence(cadence), 60));
    expect(verdict(short.p95)).toBe('FAIL');
    const measured = summarizeSamples(await sampleRafDeltas(pageWithCadence(cadence)));
    expect(verdict(measured.p95)).toBe('PASS');
    expect(measured.max).toBe(62.6); // The hiccup remains visible in the result.
  });

  it('still fails sustained missed-frame cadence', async () => {
    const measured = summarizeSamples(await sampleRafDeltas(pageWithCadence(() => 62.6)));
    expect(measured.p95).toBe(62.6);
    expect(verdict(measured.p95)).toBe('FAIL');
  });
});
