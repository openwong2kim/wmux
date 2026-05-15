import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Phase A — A6. The renderer helper that drives 5s autosave + beforeunload
// session save must skip its entire body in daemon mode so the
// scrollback:dump IPC is never invoked and `cloneWithScrollback` receives
// an empty Map (no stale scrollbackFile stamps onto session data).
//
// Source-level only — running the helper requires Zustand + xterm
// instances inside a JSDOM React tree, which is heavy and orthogonal to
// the actual invariant under test (the daemon-mode gate).
describe('A6 — dumpScrollbackBuffersSync daemon-mode skip (source-level)', () => {
  const appLayoutPath = path.join(__dirname, '..', 'AppLayout.tsx');
  const src = fs.readFileSync(appLayoutPath, 'utf-8');

  it('imports isDaemonModeActive from the renderer daemon module', () => {
    expect(src).toMatch(
      /import\s*{\s*isDaemonModeActive[\s\S]*?}\s*from\s*['"](?:\.\.\/){2}daemon\/daemonMode['"]/,
    );
  });

  it('dumpScrollbackBuffersSync returns an empty Map when daemon is active', () => {
    const fnIdx = src.indexOf('function dumpScrollbackBuffersSync(');
    expect(fnIdx).toBeGreaterThan(0);
    const body = src.slice(fnIdx, fnIdx + 2000);
    // The very first behavioural statement must be the daemon-mode guard.
    expect(body).toMatch(/if\s*\(\s*isDaemonModeActive\(\)\s*\)\s*\{[\s\S]*?return\s+new\s+Map\(\)/);
  });

  it('AppLayout subscribes to daemon onConnected + onDisconnected to keep the flag in sync', () => {
    // The effect that wires both listeners and the initial whenReady().
    expect(src).toMatch(/setDaemonModeActive\(\s*true\s*\)/);
    expect(src).toMatch(/setDaemonModeActive\(\s*false\s*\)/);
    expect(src).toMatch(/daemon\.onDisconnected/);
    expect(src).toMatch(/whenReady\(\)\.then[\s\S]*?setDaemonModeActive/);
  });

  // Codex review P2 #1 (stale scrollback reference). cloneWithScrollback
  // must zero out s.scrollbackFile in daemon mode so a session saved
  // before v2.9.1 / before daemon-readiness does not carry its stale
  // .txt file path forward into the next session restore cycle.
  it('cloneWithScrollback clears stale scrollbackFile in daemon mode', () => {
    const fnIdx = src.indexOf('function cloneWithScrollback(');
    expect(fnIdx).toBeGreaterThan(0);
    const body = src.slice(fnIdx, fnIdx + 1500);
    // The daemon-mode branch resolves to undefined rather than preserving
    // the stale s.scrollbackFile.
    expect(body).toMatch(/daemonMode\s*\?\s*undefined\s*:\s*s\.scrollbackFile/);
  });
});
