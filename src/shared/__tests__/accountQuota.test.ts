import { describe, expect, it } from 'vitest';
import { chooseByQuota, envSetsKey, evaluateQuota, heldLaunchNotice, isCompoundLine, isNewSessionLaunch, launchInlineEnvKeys, launchStem, UNKNOWN_RESET_BLOCK_MS } from '../accountQuota';

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
    ['FOO=bar CLAUDE_CONFIG_DIR="/a b" claude -c', 'claude'],
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

describe('explicit account in a launch', () => {
  it('reads the NAME=value prefix in front of the command only', () => {
    expect(launchInlineEnvKeys('CLAUDE_CONFIG_DIR="/acc/b c" claude')).toEqual(['CLAUDE_CONFIG_DIR']);
    expect(launchInlineEnvKeys('claude FOO=bar')).toEqual([]);
  });

  it('matches the env key case-insensitively on Windows only', () => {
    expect(envSetsKey({ codex_home: 'C:\\a' }, 'CODEX_HOME', 'win32')).toBe(true);
    expect(envSetsKey({ codex_home: '/a' }, 'CODEX_HOME', 'darwin')).toBe(false);
    expect(envSetsKey({ CODEX_HOME: '' }, 'CODEX_HOME', 'darwin')).toBe(false);
  });
});

describe('isNewSessionLaunch', () => {
  it.each([
    ['claude', 'claude --model opus "fix the update flow"', true],
    ['claude', 'FOO=bar claude', true],
    ['claude', 'claude --resume abc', false],
    ['claude', 'claude -c', false],
    ['claude', 'claude mcp list', false],
    ['claude', 'claude --version', false],
    ['codex', 'codex -c model=o3 "hi"', true],
    ['codex', 'codex resume --last', false],
    ['codex', 'codex exec "x"', true],
    ['codex', 'codex e "x"', true],
    ['codex', 'codex "resume"', false],
    ['claude', 'claude fix the install script', true],
    ['claude', 'claude --resume="abc"', false],
    ['codex', 'codex login', false],
  ] as const)('%s: %s → %s', (vendor, line, expected) => {
    expect(isNewSessionLaunch(vendor, line)).toBe(expected);
  });
});

it('isCompoundLine sees chaining outside quotes only', () => {
  expect(isCompoundLine('claude && npm test')).toBe(true);
  expect(isCompoundLine('codex; echo done')).toBe(true);
  expect(isCompoundLine('claude | tee log')).toBe(true);
  expect(isCompoundLine('claude "a && b; c | d"')).toBe(false);
});
