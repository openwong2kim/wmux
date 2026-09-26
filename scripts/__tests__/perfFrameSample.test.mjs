import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleFrameBudget } from '../perf-frame-sample.mjs';
import { compareResults, GATES } from '../perf-compare.mjs';

const gate = GATES.find((g) => g.key === 'frameBudgetP95Ms_N8');
function verdict(measured, against = baseline) {
  const current = { scenarios: { frameBudget: { N8: {
    frameDeltaMs: measured.stats, frameDeltaSamples: measured.samples,
  } } } };
  return compareResults(current, against, [gate])[0];
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

const baseline = { scenarios: { frameBudget: { N8: { frameDeltaMs: { p95: 15.7 } } } } };
// N8 distribution from #1480: most frames take 46.9ms; the tail takes 62.6ms.
const badSample = (frame) => frame % 60 < 54 ? 46.9 : 62.6;
describe('frame-budget failure confirmation', () => {
  it('passes one bad N8 sample followed by a good sample and logs both', async () => {
    const log = vi.fn();
    const measured = await sampleFrameBudget(pageWithCadence((frame) => frame < 60 ? badSample(frame) : 15.7), 8, baseline, log);
    expect(measured.samples).toHaveLength(2);
    expect(measured.samples[0]).toMatchObject({ p50: 46.9, p95: 62.6, count: 59 });
    expect(measured.stats).toBe(measured.samples[0]);
    expect(verdict(measured)).toMatchObject({ status: 'PASS', current: 62.6, improved: false });
    expect(verdict(measured).note).toContain('confirmation');
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toContain('p95=62.6ms');
    expect(log.mock.calls[1][0]).toContain('p95=15.7ms');
  });

  it('fails two bad N8 samples without lengthening or smoothing either window', async () => {
    const measured = await sampleFrameBudget(pageWithCadence(badSample), 8, baseline, vi.fn());
    expect(measured.samples).toHaveLength(2);
    expect(measured.samples.every((sample) => sample.p50 === 46.9 && sample.p95 === 62.6 && sample.count === 59)).toBe(true);
    expect(verdict(measured).status).toBe('FAIL');
  });
  it('judges the confirmation against the supplied baseline and refuses incomplete samples', async () => {
    const measured = await sampleFrameBudget(pageWithCadence((frame) => frame < 60 ? badSample(frame) : 31.3), 8, baseline, vi.fn());
    expect(measured.stats.p95).toBe(62.6);
    expect(verdict(measured).status).toBe('PASS');
    const strict = { scenarios: { frameBudget: { N8: { frameDeltaMs: { p95: 10 } } } } };
    expect(verdict(measured, strict).status).toBe('FAIL');
    measured.samples[1].count = 2;
    expect(verdict(measured).status).toBe('FAIL');
  });

});
