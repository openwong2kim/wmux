import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Rendered scrollback snapshots must continue in daemon mode. Raw daemon
// RingBuffer replay is not a stable UI transcript for repainting TUIs such as
// Codex; restore uses the rendered snapshot when present and raw replay only
// as fallback.
//
// Source-level only — running the helper requires Zustand + xterm
// instances inside a JSDOM React tree, which is heavy and orthogonal to
// the actual invariant under test (the daemon-mode gate).
describe('daemon-mode rendered scrollback snapshots (source-level)', () => {
  const appLayoutPath = path.join(__dirname, '..', 'AppLayout.tsx');
  const src = fs.readFileSync(appLayoutPath, 'utf-8');

  it('imports isDaemonModeActive from the renderer daemon module', () => {
    expect(src).toMatch(
      /import\s*{\s*isDaemonModeActive[\s\S]*?}\s*from\s*['"](?:\.\.\/){2}daemon\/daemonMode['"]/,
    );
  });

  it('dumpScrollbackBuffersSync does not short-circuit when daemon is active', () => {
    const fnIdx = src.indexOf('function dumpScrollbackBuffersSync(');
    expect(fnIdx).toBeGreaterThan(0);
    const body = src.slice(fnIdx, fnIdx + 2000);
    expect(body).not.toMatch(/if\s*\(\s*isDaemonModeActive\(\)\s*\)\s*\{[\s\S]*?return\s+new\s+Map\(\)/);
    expect(body).toMatch(/serializeTerminalBuffer\(/);
  });

  it('AppLayout subscribes to daemon onConnected + onDisconnected to keep the flag in sync', () => {
    // The effect that wires both listeners and the initial whenReady().
    expect(src).toMatch(/setDaemonModeActive\(\s*true\s*\)/);
    expect(src).toMatch(/setDaemonModeActive\(\s*false\s*\)/);
    expect(src).toMatch(/daemon\.onDisconnected/);
    expect(src).toMatch(/whenReady\(\)\.then[\s\S]*?setDaemonModeActive/);
  });

  it('cloneWithScrollback preserves the last rendered snapshot reference', () => {
    const fnIdx = src.indexOf('function cloneWithScrollback(');
    expect(fnIdx).toBeGreaterThan(0);
    const body = src.slice(fnIdx, fnIdx + 1500);
    expect(body).toMatch(/scrollbackFile:\s*dumped\.has\(s\.id\)\s*\?\s*s\.id\s*:\s*s\.scrollbackFile/);
    expect(body).not.toMatch(/daemonMode\s*\?\s*undefined\s*:\s*s\.scrollbackFile/);
  });
});
