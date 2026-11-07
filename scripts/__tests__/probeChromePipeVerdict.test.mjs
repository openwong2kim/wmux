// The pipe probe's verdict on one run (scripts/probe-chrome-pipe-verdict.mjs).
import { describe, expect, it } from 'vitest';
import { probeVerdict } from '../probe-chrome-pipe-verdict.mjs';

/** A run that passed every check, with a start time of `firstAnswerMs`. */
const run = (over = {}) => ({
  firstAnswerMs: 1_000, withinLauncherCeiling: true, target: true, browserSession: true,
  eofExitMs: 120, processesLeft: [], cookieKept: true, secondExitMs: 90, cold: true, ...over,
});
const slow = { firstAnswerMs: 48_400, withinLauncherCeiling: false };
const ci = { coldStartWarn: true, preinstalled: true };

describe('probeVerdict', () => {
  it('passes a run within the ceiling, with or without the flag', () => {
    expect(probeVerdict(run(), ci)).toEqual({ ok: true, warning: null });
    expect(probeVerdict(run(), {})).toEqual({ ok: true, warning: null });
  });

  it('warns, not fails, on a preinstalled browser\'s cold start past the ceiling, when asked to', () => {
    const verdict = probeVerdict(run(slow), ci);
    expect(verdict.ok).toBe(true);
    expect(verdict.warning).toMatch(/48400 ms/);
    expect(verdict.warning).toMatch(/30000 ms/);
  });

  it('fails a start past the ceiling when warm, without the flag, or for a browser it installed itself', () => {
    expect(probeVerdict(run({ ...slow, cold: false }), ci)).toEqual({ ok: false, warning: null });
    expect(probeVerdict(run(slow), { preinstalled: true })).toEqual({ ok: false, warning: null });
    expect(probeVerdict(run(slow), { coldStartWarn: true, preinstalled: false })).toEqual({ ok: false, warning: null });
  });

  it('fails every other check, cold start or not', () => {
    for (const failed of [
      { target: false }, { browserSession: false }, { eofExitMs: null }, { processesLeft: [{ pid: 1 }] },
      { processesLeft: null }, { cookieKept: false }, { secondExitMs: null }, { error: 'Browser.getVersion: no answer in 60000 ms' },
    ]) {
      expect(probeVerdict(run({ ...slow, ...failed }), ci), JSON.stringify(failed)).toEqual({ ok: false, warning: null });
      expect(probeVerdict(run(failed), ci), JSON.stringify(failed)).toEqual({ ok: false, warning: null });
    }
  });
});
