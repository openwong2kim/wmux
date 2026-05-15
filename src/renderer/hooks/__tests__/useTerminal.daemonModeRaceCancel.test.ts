import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Phase A — A6. The async scrollback.load() in useTerminal can resolve
// AFTER daemon mode becomes active. Writing the stale .txt content into
// the terminal at that point would compose with the daemon SessionPipe
// flush via the \r\n\x1b[0m\r\n divider and produce visibly broken
// scrollback (codex review Layer C corruption path).
//
// useTerminal is a 700-line React hook with xterm dependencies that are
// awkward to bootstrap in vitest, so we verify the race cancel at the
// source level. The integration assertion (daemon connects mid-load →
// terminal shows daemon flush only) is part of the manual Windows
// checklist in docs/upgrade-v2.9.1.md.
describe('A6 — useTerminal async restore race cancel (source-level)', () => {
  const hookPath = path.join(__dirname, '..', 'useTerminal.ts');
  const src = fs.readFileSync(hookPath, 'utf-8');

  it('imports isDaemonModeActive from the renderer daemon module', () => {
    expect(src).toMatch(
      /import\s*{\s*isDaemonModeActive\s*}\s*from\s*['"]\.\.\/daemon\/daemonMode['"]/,
    );
  });

  it('scrollback.load().then(content) guards on isDaemonModeActive() before writing', () => {
    const loadIdx = src.indexOf('scrollback.load(scrollbackFile)');
    expect(loadIdx).toBeGreaterThan(0);
    // Slice forward enough lines to capture the then handler body.
    const body = src.slice(loadIdx, loadIdx + 4000);
    // The guard substitutes the .txt content with null when daemon-mode
    // activated during the IPC round-trip.
    expect(body).toMatch(/isDaemonModeActive\(\)\s*\?\s*null\s*:\s*content/);
    // The write call must use the guarded value, not the raw `content`.
    expect(body).toMatch(/terminal\.write\(\s*restored\s*\)/);
  });

  it('still flushes pending PTY data after the daemon-mode skip', () => {
    const loadIdx = src.indexOf('scrollback.load(scrollbackFile)');
    const body = src.slice(loadIdx, loadIdx + 4000);
    // pendingData.length > 0 check happens whether or not restored ran.
    expect(body).toMatch(/scrollbackLoaded\s*=\s*true/);
    expect(body).toMatch(/for\s*\(\s*const\s+data\s+of\s+pendingData/);
  });

  // Codex review P2 #2 (cold-start race): if `.txt` restore lands before
  // daemon mode flips, the renderer must clear the terminal on the
  // subsequent daemon:connected event so the SessionPipe replay does not
  // compose with the stale text.
  it('arms a daemon.onConnected listener that clears the terminal after .txt restore', () => {
    // Module-scope flag declared at the top of the effect.
    expect(src).toMatch(/let\s+didRestoreTxt\s*=\s*false/);
    // Cleanup slot reserved.
    expect(src).toMatch(/let\s+removeDaemonConnectedForRestore/);
    // Inside the restore branch, the flag flips true and the listener arms.
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
