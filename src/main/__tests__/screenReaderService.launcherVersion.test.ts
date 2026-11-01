// @wmux-lane unit
// The version a launch's screen-reader flag is checked against: read in the
// background, so a launch never waits on `claude --version`.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { accessibilitySupportEnabled: false, on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
}));

const probe = vi.hoisted(() => ({ answer: null as null | ((r: { ok: true; version: string } | { ok: false; detail: string }) => void), calls: 0 }));
vi.mock('../claude/resolveClaudeExecutable', () => ({ resolveClaudeExecutable: () => '/fake/claude' }));
vi.mock('../factory/claudeProbe', () => ({
  probeClaudeExecutable: () => {
    probe.calls++;
    return new Promise((resolve) => { probe.answer = resolve; });
  },
}));

import { launcherVersion } from '../screenReaderService';

describe('launcherVersion', () => {
  it('answers null until claude --version answers, then its x.y.z, and only for claude', async () => {
    expect(launcherVersion('claude')).toBeNull();
    expect(probe.calls).toBe(1);
    probe.answer?.({ ok: true, version: '2.1.316 (Claude Code)' });
    await Promise.resolve();
    expect(launcherVersion('claude')).toBe('2.1.316');
    probe.answer?.({ ok: false, detail: 'gone' });
    await Promise.resolve();
    expect(launcherVersion('claude')).toBeNull();
    const before = probe.calls;
    expect(launcherVersion('gemini')).toBeNull();
    expect(probe.calls).toBe(before);
  });
});
