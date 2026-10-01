// settleLatency (scripts/lib/hookHarmlessness.mjs), #1685.
//
// The harmlessness gate re-measures a case once when added latency is its only
// violation, and fails it only if it is over the cap both times. These pin that
// rule without spawning a hook: the verdicts are plain data, and `remeasure` is
// a stub that counts its calls.
import { describe, expect, it } from 'vitest';
import { settleLatency } from '../lib/hookHarmlessness.mjs';

const clean = { strict: [], latency: [] };
const slow = (ms) => ({ strict: [], latency: [`claude:Stop: +${ms}ms over control (cap 1500)`] });

function stub(...verdicts) {
  const calls = { count: 0 };
  const remeasure = async () => verdicts[calls.count++];
  return { calls, remeasure };
}

describe('settleLatency', () => {
  it('passes a clean case without re-measuring', async () => {
    const { calls, remeasure } = stub(clean);
    expect(await settleLatency(clean, remeasure)).toEqual({ violations: [], second: null });
    expect(calls.count).toBe(0);
  });

  it('fails a strict violation on first sight, without re-measuring', async () => {
    const { calls, remeasure } = stub(clean);
    const first = { strict: ['claude:PreToolUse: decision=ask'], latency: [] };
    expect(await settleLatency(first, remeasure)).toEqual({
      violations: ['claude:PreToolUse: decision=ask'],
      second: null,
    });
    expect(calls.count).toBe(0);
  });

  it('does not re-measure latency that comes with a strict violation', async () => {
    const { calls, remeasure } = stub(clean);
    const first = { strict: ['claude:Stop: stdout="x"'], latency: slow(1514).latency };
    const { violations, second } = await settleLatency(first, remeasure);
    expect(violations).toEqual([...first.strict, ...first.latency]);
    expect(second).toBeNull();
    expect(calls.count).toBe(0);
  });

  it('passes a single latency outlier that is within the cap on re-measure', async () => {
    const { calls, remeasure } = stub(clean);
    const { violations, second } = await settleLatency(slow(1514), remeasure);
    expect(violations).toEqual([]);
    expect(second).toBe(clean);
    expect(calls.count).toBe(1);
  });

  it('fails a hook that is over the cap both times, reporting both measurements', async () => {
    const { calls, remeasure } = stub(slow(1800));
    const { violations } = await settleLatency(slow(1700), remeasure);
    expect(violations).toEqual([
      'claude:Stop: +1700ms over control (cap 1500)',
      'claude:Stop: +1800ms over control (cap 1500) (re-measured)',
    ]);
    expect(calls.count).toBe(1);
  });

  it('fails a strict violation that only shows up on the re-measure', async () => {
    const { calls, remeasure } = stub({ strict: ['claude:Stop: exit=2'], latency: [] });
    const { violations } = await settleLatency(slow(1514), remeasure);
    expect(violations).toEqual([
      'claude:Stop: +1514ms over control (cap 1500)',
      'claude:Stop: exit=2 (re-measured)',
    ]);
    expect(calls.count).toBe(1);
  });
});
