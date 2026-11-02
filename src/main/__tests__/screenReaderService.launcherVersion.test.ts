// @wmux-lane unit
// The version a launch's screen-reader flag is checked against: read in the
// background, so a launch never waits on `claude --version`, and the oldest of
// every claude install a pane's shell might run.
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { accessibilitySupportEnabled: false, on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
}));

type ProbeResult = { ok: true; version: string } | { ok: false; detail: string };
const fake = vi.hoisted(() => ({
  installs: [] as string[],
  reads: 0,
  answers: new Map<string, (r: ProbeResult) => void>(),
}));
// A WSL shell on any host, so the WSL rule runs here too.
vi.mock('../../shared/wsl', () => ({ isWslShell: (shell?: string) => /wsl\.exe$/i.test(shell ?? '') }));
vi.mock('../claude/resolveClaudeExecutable', () => ({
  claudeInstalls: async () => {
    fake.reads++;
    return fake.installs;
  },
}));
vi.mock('../factory/claudeProbe', () => ({
  probeClaudeExecutable: (exe: string) => new Promise<ProbeResult>((resolve) => { fake.answers.set(exe, resolve); }),
}));

import { launcherVersionsIn } from '../screenReaderService';

describe('launcherVersionsIn', () => {
  const launcherVersion = (launcher: string) => launcherVersionsIn('/bin/zsh')(launcher, launcher);
  const ok = (version: string): ProbeResult => ({ ok: true, version: `${version} (Claude Code)` });
  /** Answers each probe asked with `by(exe)` until a read gives `want`. Every
   *  ask reads again in the background, as a launch does. */
  async function readUntil(by: (exe: string) => ProbeResult, want: string | null): Promise<void> {
    await vi.waitFor(() => {
      for (const [exe, resolve] of [...fake.answers]) {
        fake.answers.delete(exe);
        resolve(by(exe));
      }
      expect(launcherVersion('claude')).toBe(want);
    }, { timeout: 5_000 });
  }

  it('answers null until every install is read, then the oldest version', async () => {
    fake.installs = ['/home/u/.local/bin/claude', '/home/u/.nvm/versions/node/v20/bin/claude'];
    expect(launcherVersion('claude')).toBeNull();
    const versions: Record<string, string> = { '/home/u/.local/bin/claude': '2.1.316', '/home/u/.nvm/versions/node/v20/bin/claude': '2.1.250' };
    await readUntil((exe) => ok(versions[exe]!), '2.1.250');
  });

  it('knows no version when any install cannot be read, or none is found', async () => {
    fake.installs = ['/a/claude', '/b/claude'];
    await readUntil(() => ok('2.1.316'), '2.1.316');
    await readUntil((exe) => (exe === '/b/claude' ? { ok: false, detail: 'timed out' } : ok('2.1.316')), null);
    await readUntil(() => ok('2.1.316'), '2.1.316');
    fake.installs = [];
    await readUntil(() => ok('2.1.316'), null);
  });

  it('knows no version once an install it read is replaced, until a read of the new one lands', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-sr-version-'));
    const exe = path.join(dir, 'claude');
    fs.writeFileSync(exe, '');
    try {
      fake.installs = [exe];
      await readUntil(() => ok('2.1.316'), '2.1.316');
      // An older claude reinstalled in its place: the read under way may not
      // know yet, and the last one's version is not this install's.
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(exe, later, later);
      expect(launcherVersion('claude')).toBeNull();
      await readUntil(() => ok('2.1.100'), '2.1.100');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts no second read while one runs', () => {
    fake.installs = ['/a/claude'];
    launcherVersion('claude');
    const before = fake.reads;
    launcherVersion('claude');
    launcherVersion('claude');
    expect(fake.reads).toBe(before);
  });

  it('knows no version for gemini, a launcher given by path, a WSL pane or a shell not known, while claude\'s is known', async () => {
    fake.installs = ['/a/claude'];
    await readUntil(() => ok('2.1.316'), '2.1.316');
    expect(launcherVersion('gemini')).toBeNull();
    expect(launcherVersionsIn('/bin/zsh')('claude', '/opt/other/claude')).toBeNull();
    expect(launcherVersionsIn('C:\\Windows\\System32\\wsl.exe')('claude', 'claude')).toBeNull();
    expect(launcherVersionsIn(undefined)('claude', 'claude')).toBeNull();
  });
});
