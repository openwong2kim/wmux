import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level invariants for the before-quit daemon disconnect race fix.
//
// User dogfood (2026-05-16, 48-PTY daemon) hit this sequence in
// src/main/index.ts:
//
//   1. before-quit checks `daemonClient?.isConnected`.
//   2. `raceDaemonShutdown(daemonClient, 4000)` awaits up to 4 s.
//   3. During the wait, daemon closes socket → module-level
//      `daemonClient.on('disconnected')` handler fires and sets
//      `daemonClient = null`.
//   4. race times out (daemon shutdown was running long for 48 PTYs).
//   5. `await daemonClient.disconnect()` dereferences null →
//      "Cannot read properties of null (reading 'disconnect')" →
//      unhandled rejection blocks app.quit() and the tray Quit
//      leaves main process alive.
//
// Fix: capture `daemonClient` into a local `clientAtQuit` BEFORE the race,
// and use that local for the post-race disconnect, wrapped in try/catch so
// a torn-down socket does not throw past the quit sequence.

describe('before-quit daemon disconnect race — source invariants', () => {
  const indexPath = path.join(__dirname, '..', 'index.ts');
  const indexSrc = fs.readFileSync(indexPath, 'utf-8');

  it('captures daemonClient into clientAtQuit before the race', () => {
    expect(indexSrc).toMatch(/const\s+clientAtQuit\s*=\s*daemonClient\s*;/);
    // The capture happens before the isConnected check + race.
    const capturePos = indexSrc.indexOf('const clientAtQuit = daemonClient');
    const racePos = indexSrc.indexOf('raceDaemonShutdown(clientAtQuit');
    expect(capturePos).toBeGreaterThan(0);
    expect(racePos).toBeGreaterThan(capturePos);
  });

  it('races shutdown using the local capture (not module-level daemonClient)', () => {
    expect(indexSrc).toMatch(/raceDaemonShutdown\(\s*clientAtQuit\s*,/);
    // No call to raceDaemonShutdown using the module-level variable
    // inside the before-quit handler.
    const beforeQuitBlock = indexSrc.slice(
      indexSrc.indexOf("app.on('before-quit'"),
      indexSrc.indexOf("app.on('session-end'"),
    );
    expect(beforeQuitBlock).not.toMatch(/raceDaemonShutdown\(\s*daemonClient\s*,/);
  });

  it('post-race disconnect targets the local capture inside a try/catch', () => {
    const beforeQuitBlock = indexSrc.slice(
      indexSrc.indexOf("app.on('before-quit'"),
      indexSrc.indexOf("app.on('session-end'"),
    );
    expect(beforeQuitBlock).toMatch(
      /try\s*\{[\s\S]*?await\s+clientAtQuit\.disconnect\(\)\s*;[\s\S]*?\}\s*catch/,
    );
  });

  it("'disconnected' handler still nulls module-level daemonClient (race precondition is intentional)", () => {
    // The handler that races against us is the one we documented in the
    // capture comment. Locking the null assignment here means a refactor
    // that drops it (and therefore would defeat this whole class of bug
    // by accident) gets a heads-up failure that points at the dependency.
    expect(indexSrc).toMatch(
      /daemonClient\.on\(\s*['"]disconnected['"][\s\S]*?daemonClient\s*=\s*null/,
    );
  });
});
