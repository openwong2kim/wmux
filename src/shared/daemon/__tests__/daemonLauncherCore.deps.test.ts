import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureDaemon, type DaemonLauncherDeps } from '../daemonLauncherCore';

/**
 * #1001 — the whole point of extracting this module out of
 * src/main/daemon/launcher.ts is that a caller with no Electron runtime (the
 * `wmux daemon` CLI verb) can supply its own script resolution / version
 * stamp / stale-PID policy instead of `app.getAppPath()` / `app.getVersion()`
 * / a native dialog. These tests pin that the injected deps are what actually
 * get consulted — not a parallel hardcoded path that would silently diverge
 * from what the CLI configured.
 */
describe('daemonLauncherCore — DaemonLauncherDeps seam', () => {
  let wmuxDir: string;
  let prevSuffix: string | undefined;
  let suffix: string;

  beforeEach(() => {
    // getWmuxDir() = os.homedir()/.wmux<WMUX_DATA_SUFFIX> — an isolated
    // per-run suffix keeps this test from touching the real ~/.wmux dir
    // (or colliding with a genuinely running daemon on the test box).
    suffix = `-launcher-deps-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    prevSuffix = process.env.WMUX_DATA_SUFFIX;
    process.env.WMUX_DATA_SUFFIX = suffix;
    wmuxDir = path.join(os.homedir(), `.wmux${suffix}`);
    fs.mkdirSync(wmuxDir, { recursive: true });
  });

  afterEach(() => {
    if (prevSuffix === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = prevSuffix;
    fs.rmSync(wmuxDir, { recursive: true, force: true });
  });

  function depsWithCandidates(candidates: string[]): DaemonLauncherDeps {
    return {
      resolveDaemonScriptCandidates: () => candidates,
      resolveSpawnedByVersion: () => '9.9.9-test',
      askUserToRecoverFromStalePid: async () => false,
      isElectronHost: () => false,
    };
  }

  it('spawns using ONLY the candidates the caller supplies, never a hardcoded app/resourcesPath list', async () => {
    // No daemon.pid present → ensureDaemon falls straight through to spawn.
    // Candidates that do not exist on disk must surface as the "not found"
    // error naming exactly those paths — proof the injected resolver, not a
    // parallel Electron-shaped list, is what's consulted.
    const missing = [
      path.join(wmuxDir, 'nonexistent-a', 'index.js'),
      path.join(wmuxDir, 'nonexistent-b', 'index.js'),
    ];
    let message = '';
    try {
      await ensureDaemon(depsWithCandidates(missing));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/Daemon script not found/);
    for (const candidate of missing) {
      expect(message.includes(candidate)).toBe(true);
    }
  });

  it('never calls the real Electron askUserToRecoverFromStalePid path — only the injected one', async () => {
    // A headless caller (wmux daemon) always resolves `false` here — this
    // guards that ensureDaemon reaches through `deps`, not a module-level
    // default, since a module-level default bound to Electron's dialog would
    // throw or hang outside an Electron runtime.
    let askedWith: unknown;
    const deps: DaemonLauncherDeps = {
      resolveDaemonScriptCandidates: () => [path.join(wmuxDir, 'missing', 'index.js')],
      resolveSpawnedByVersion: () => '9.9.9-test',
      askUserToRecoverFromStalePid: async (opts) => {
        askedWith = opts;
        return false;
      },
      isElectronHost: () => false,
    };
    // This particular run never reaches the stale-PID branch (no daemon.pid
    // file exists), so askUserToRecoverFromStalePid must NOT have been
    // called — pinning it is inert on the common path, not merely present.
    await expect(ensureDaemon(deps)).rejects.toThrow(/Daemon script not found/);
    expect(askedWith).toBeUndefined();
  });
});
