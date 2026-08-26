// Issue #546 — boot-progress marker lifecycle, proven against the REAL bundled
// daemon rather than by reading source.
//
// The contract the launcher depends on:
//   1. `daemon-booting` exists (naming the daemon's PID) during boot, i.e.
//      while the daemon is alive but has no pipe open yet.
//   2. It is GONE once the daemon is ready (pipe file written).
//   3. It is gone after a clean shutdown, so it never outlives its daemon.
//
// If (2) or (3) regressed, the launcher would grant a wedged daemon a 90 s
// grace period instead of killing it. If (1) regressed, a cold-recovering
// daemon would be SIGKILLed again — the #537 symptom this exists to prevent.
//
// Runs the daemon under an isolated WMUX_DATA_SUFFIX so it can never touch the
// developer's live daemon or its sessions.
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { parseBootMarker } from '../../shared/daemon/daemonLauncherCore';

const SUFFIX = '-i546-test';
const dir = path.join(os.homedir(), `.wmux${SUFFIX}`);
const bundle = path.join(process.cwd(), 'dist', 'daemon-bundle', 'index.js');
const markerFile = path.join(dir, 'daemon-booting');
const pipeFile = path.join(dir, 'daemon-pipe');
const pidFile = path.join(dir, 'daemon.pid');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let child: ChildProcess | null = null;

afterAll(() => {
  try { child?.kill('SIGKILL'); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// The bundle is a build artifact; skip rather than fail when it is absent so a
// fresh checkout without `npm run build:daemon` doesn't red the suite.
const hasBundle = fs.existsSync(bundle);

/** Set by the CI job that promises to build the bundle first (see
 *  webRestart.runtime.test.ts). Outside the skipIf below on purpose: it has to
 *  run precisely in the case where the suite itself cannot, so a workflow that
 *  stops building the bundle goes red instead of quietly retiring this file. */
const bundlePromised = process.env.WMUX_REQUIRE_DAEMON_BUNDLE === '1';

describe.runIf(bundlePromised)('#546 boot marker suite prerequisites', () => {
  it('has the daemon bundle the promising job was supposed to build', () => {
    expect(hasBundle).toBe(true);
  });
});

describe.skipIf(!hasBundle)('#546 boot marker lifecycle (real daemon)', () => {
  it('writes the marker during boot and clears it once ready', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    child = spawn(process.execPath, [bundle], {
      env: { ...process.env, WMUX_DATA_SUFFIX: SUFFIX },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const spawnedPid = child.pid;
    expect(spawnedPid, 'spawn returned no pid').toBeDefined();

    // (1) The marker appears, and names the daemon's own PID. Poll densely —
    // boot with zero sessions to recover is ~300 ms, and the marker is written
    // at lock acquisition, so a 2 ms poll cannot realistically miss the window.
    //
    // Observing it is REQUIRED, not best-effort: a version that never writes
    // the marker would sail through the "gone once ready" assertions below, so
    // without this the test would pass against the very code it guards.
    let sawMarker: string | null = null;
    for (let i = 0; i < 2000; i++) {
      try {
        const raw = fs.readFileSync(markerFile, 'utf-8');
        // `writeFileSync` creates the file and then writes it, so a 2 ms poll
        // can win that race and read a not-yet-complete intermediate — which
        // parsed to NaN and reddened `validate` on PRs that never touch the
        // daemon. The production parser is the predicate here, not an
        // approximation of it: an empty read AND a torn one ("90" of "9052")
        // are equally unparseable boot claims, and both re-poll as "not yet",
        // exactly the way parseBootMarker() refuses them in the launcher.
        // (3-way review consensus on the first cut, which skipped only empty
        // reads and let a torn read through to the PID assertion below.)
        if (spawnedPid !== undefined && parseBootMarker(raw, spawnedPid)) {
          sawMarker = raw;
          break;
        }
      } catch { /* not yet */ }
      if (fs.existsSync(pipeFile)) break; // ready already — window closed
      await sleep(2);
    }
    expect(sawMarker, 'daemon never wrote its boot marker').not.toBeNull();

    // (2) Ready ⇒ marker gone. This is the assertion that must hold even if the
    // boot window above was too fast to observe.
    for (let i = 0; i < 600; i++) {
      if (fs.existsSync(pipeFile)) break;
      await sleep(50);
    }
    expect(fs.existsSync(pipeFile), 'daemon never became ready').toBe(true);
    expect(fs.existsSync(markerFile), 'marker outlived boot').toBe(false);

    const daemonPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    expect(parseInt((sawMarker ?? '').trim(), 10)).toBe(daemonPid);
  }, 60_000);

  it('leaves no marker behind after a clean shutdown', async () => {
    const pipeName = fs.readFileSync(pipeFile, 'utf-8').trim();
    const token = fs.readFileSync(path.join(dir, 'daemon-auth-token'), 'utf-8').trim();

    await new Promise<void>((resolve) => {
      const sock = net.connect(pipeName);
      sock.on('connect', () => {
        sock.write(JSON.stringify({ id: 'i546-shutdown', method: 'daemon.shutdown', params: {}, token }) + '\n');
      });
      sock.on('data', () => { sock.destroy(); resolve(); });
      sock.on('error', () => resolve());
      setTimeout(() => { sock.destroy(); resolve(); }, 20_000);
    });

    for (let i = 0; i < 100; i++) {
      if (!fs.existsSync(pidFile)) break;
      await sleep(100);
    }
    expect(fs.existsSync(markerFile), 'marker survived shutdown').toBe(false);
  }, 60_000);
});
