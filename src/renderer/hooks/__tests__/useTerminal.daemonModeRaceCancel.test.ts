import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Rendered scrollback snapshots are the UI recovery source for repainting
// TUIs. When daemon replay arrives during snapshot restore, useTerminal must
// drop the old replay bytes and keep only live bytes after the flush marker.
//
// useTerminal is a 700-line React hook with xterm dependencies that are
// awkward to bootstrap in vitest, so we verify the race cancel at the
// source level. The integration assertion (daemon connects mid-load →
// terminal shows daemon flush only) is part of the manual Windows
// checklist in docs/upgrade-v2.9.1.md.
describe('daemon-mode snapshot restore (source-level)', () => {
  const hookPath = path.join(__dirname, '..', 'useTerminal.ts');
  const src = fs.readFileSync(hookPath, 'utf-8');

  it('imports isDaemonModeActive from the renderer daemon module', () => {
    expect(src).toMatch(
      /import\s*{\s*isDaemonModeActive\s*}\s*from\s*['"]\.\.\/daemon\/daemonMode['"]/,
    );
  });

  it('writes loaded snapshots even when daemon mode is active', () => {
    const loadIdx = src.indexOf('scrollback.load(scrollbackFile)');
    expect(loadIdx).toBeGreaterThan(0);
    const body = src.slice(loadIdx, loadIdx + 4000);
    expect(body).toMatch(/const\s+restored\s*=\s*content/);
    expect(body).toMatch(/terminal\.write\(\s*restored\s*\)/);
  });

  it('splits replay bytes from live bytes while scrollback is loading', () => {
    const loadIdx = src.indexOf('scrollback.load(scrollbackFile)');
    const body = src.slice(loadIdx, loadIdx + 4000);
    expect(body).toMatch(/pendingReplayData/);
    expect(body).toMatch(/pendingLiveData/);
    expect(body).toMatch(/daemonFlushComplete/);
  });

  it('drops old daemon replay when a rendered snapshot exists', () => {
    const loadIdx = src.indexOf('scrollback.load(scrollbackFile)');
    const body = src.slice(loadIdx, loadIdx + 5000);
    expect(body).toMatch(/restoreBeatsDaemonReplay/);
    expect(body).toMatch(/dropDaemonReplayUntilFlush\s*=\s*!daemonFlushComplete/);
    expect(body).toMatch(/scrollbackLoaded\s*=\s*true/);
    expect(body).toMatch(/const\s+replayData\s*=\s*restoreBeatsDaemonReplay\s*\?\s*\[\]\s*:\s*pendingReplayData/);
  });

  it('keeps the legacy late-daemon reset fallback for non-daemon restores', () => {
    // Module-scope flag declared at the top of the effect.
    expect(src).toMatch(/let\s+didRestoreTxt\s*=\s*false/);
    expect(src).toMatch(/let\s+removeDaemonConnectedForRestore/);
    const loadIdx = src.indexOf('scrollback.load(scrollbackFile)');
    const body = src.slice(loadIdx, loadIdx + 4000);
    expect(body).toMatch(/didRestoreTxt\s*=\s*true/);
    expect(body).toMatch(/window\.electronAPI\.daemon\.onConnected\(/);
    // The listener resets the terminal and clears the flag.
    expect(body).toMatch(/terminal\.reset\(\)/);
    // Cleanup unregisters the listener.
    expect(src).toMatch(/removeDaemonConnectedForRestore\?\.\(\)/);
  });
});
