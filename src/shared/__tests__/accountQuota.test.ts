import { describe, expect, it } from 'vitest';
import { chooseByQuota, evaluateQuota, heldLaunchNotice, launchStem, UNKNOWN_RESET_BLOCK_MS } from '../accountQuota';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const LATER = NOW + 3 * 3600_000;

describe('evaluateQuota', () => {
  it('treats no reading as usable and unknown', () => {
    expect(evaluateQuota(null, NOW)).toEqual({ usable: true, remaining: null, availableAtMs: null });
  });

  it('uses the lowest window and blocks a spent one until reset', () => {
    expect(evaluateQuota({ windows: [{ remaining: 0.7, resetAtMs: LATER }, { remaining: 0.3, resetAtMs: LATER }], capturedAtMs: NOW }, NOW))
      .toEqual({ usable: true, remaining: 0.3, availableAtMs: null });
    expect(evaluateQuota({ windows: [{ remaining: 0.01, resetAtMs: LATER }], capturedAtMs: NOW }, NOW))
      .toEqual({ usable: false, remaining: 0.01, availableAtMs: LATER });
  });

  it('counts a window whose reset passed as refilled', () => {
    expect(evaluateQuota({ windows: [{ remaining: 0, resetAtMs: NOW - 1 }], capturedAtMs: NOW - 10 }, NOW).usable).toBe(true);
  });

  it('blocks a spent window with no reset time from the capture time', () => {
    expect(evaluateQuota({ windows: [{ remaining: 0, resetAtMs: null }], capturedAtMs: NOW }, NOW).availableAtMs)
      .toBe(NOW + UNKNOWN_RESET_BLOCK_MS);
  });
});

describe('chooseByQuota', () => {
  const ok = (remaining: number | null) => ({ usable: true, remaining, availableAtMs: null });
  const out = (at: number) => ({ usable: false, remaining: 0, availableAtMs: at });

  it('keeps the current account while it has quota', () => {
    expect(chooseByQuota([{ id: 'a', current: true, verdict: ok(0.1) }, { id: 'b', current: false, verdict: ok(0.9) }]))
      .toEqual({ kind: 'keep', id: 'a' });
  });

  it('switches to the most quota, measured before unknown', () => {
    expect(chooseByQuota([
      { id: 'a', current: true, verdict: out(LATER) },
      { id: 'b', current: false, verdict: ok(null) },
      { id: 'c', current: false, verdict: ok(0.4) },
    ])).toEqual({ kind: 'switch', id: 'c' });
  });

  it('holds with the earliest reset when every account is out', () => {
    expect(chooseByQuota([
      { id: 'a', current: true, verdict: out(LATER) },
      { id: 'b', current: false, verdict: out(NOW + 60_000) },
    ])).toEqual({ kind: 'hold', availableAtMs: NOW + 60_000 });
  });

  it('keeps when there is nothing to choose from', () => {
    expect(chooseByQuota([])).toEqual({ kind: 'keep', id: null });
  });
});

describe('launchStem', () => {
  it.each([
    ['claude --model opus', 'claude'],
    ['"C:\\Program Files\\nodejs\\codex.cmd" exec', 'codex'],
    ['agy -i "x"', 'agy'],
    ['echo claude', 'echo'],
    [undefined, ''],
  ])('%s → %s', (line, stem) => {
    expect(launchStem(line)).toBe(stem);
  });
});

it('heldLaunchNotice names the provider and stays a single echo', () => {
  const line = heldLaunchNotice('codex', null);
  expect(line.startsWith('echo "wmux: codex was not started')).toBe(true);
  expect(line).not.toMatch(/[|&;<>]/);
});
