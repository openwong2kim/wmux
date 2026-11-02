// @wmux-lane unit
// The version a launch's screen-reader flag is checked against: read in the
// background, so a launch never waits on `claude --version`.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { accessibilitySupportEnabled: false, on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
}));

const probe = vi.hoisted(() => ({ answer: null as null | ((r: { ok: true; version: string } | { ok: false; detail: string }) => void), calls: 0 }));
// A WSL shell on any host, so the WSL rule runs here too.
vi.mock('../../shared/wsl', () => ({ isWslShell: (shell?: string) => /wsl\.exe$/i.test(shell ?? '') }));
vi.mock('../claude/resolveClaudeExecutable', () => ({ resolveClaudeExecutable: () => '/fake/claude' }));
vi.mock('../factory/claudeProbe', () => ({
  probeClaudeExecutable: () => {
    probe.calls++;
    return new Promise((resolve) => { probe.answer = resolve; });
  },
}));

import { launcherVersionsIn } from '../screenReaderService';

describe('launcherVersionsIn', () => {
  const launcherVersion = (launcher: string) => launcherVersionsIn('/bin/zsh')(launcher, launcher);

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

  it('knows no version for a launcher given by path, or in a WSL pane', async () => {
    launcherVersion('claude');
    probe.answer?.({ ok: true, version: '2.1.316 (Claude Code)' });
    await Promise.resolve();
    expect(launcherVersion('claude')).toBe('2.1.316');
    const before = probe.calls;
    expect(launcherVersionsIn('/bin/zsh')('claude', '/opt/other/claude')).toBeNull();
    expect(launcherVersionsIn('C:\\Windows\\System32\\wsl.exe')('claude', 'claude')).toBeNull();
    expect(probe.calls).toBe(before);
  });
});
