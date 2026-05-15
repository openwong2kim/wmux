#!/usr/bin/env node
/**
 * Phase A dynamic test — Task #15 (calibration for A5 timeout).
 *
 * Spawns the BUNDLED daemon (dist/daemon-bundle/index.js) in an isolated
 * state directory and exercises the shutdown path under conditions that
 * the unit suite cannot reach: real ConPTY spawning, real RingBuffer
 * lifecycle, real fs.rename under the atomic dump path (A4).
 *
 * Scenarios:
 *   T1  spawn → 1 s → createSession → 1 s → daemon.shutdown
 *       Asserts: .buf exists on disk for the session AND sessions.json
 *       contains the session entry. Locks the A1a/A1b/A4 invariants
 *       end-to-end.
 *
 *   T2  spawn → createSession → IMMEDIATELY daemon.shutdown
 *       Asserts: sessions.json contains the session entry. Confirms the
 *       A1a synchronous saveImmediate from inside createSession survives
 *       a shutdown that follows it within microseconds.
 *
 *   T5  spawn → createSession × N (N ∈ {1, 10, 50}) → daemon.shutdown
 *       Measures wall-clock latency. Result calibrates A3/A5 timeouts.
 *       Currently A3 uses a 4 s placeholder and A5 will use the T5
 *       p99 + 1 s headroom (capped at 4 s for the WM_ENDSESSION budget).
 *
 * T3 + T4 (PTY 1 MB payload + SIGKILL recovery) require a meaningful
 * stream of PTY output before the shutdown. They are deferred to the
 * manual Windows checklist (Task #9) because driving 1 MB through a
 * portable shell echo on Windows takes more time than the CI budget
 * affords and adds little signal beyond what the atomic-dump unit
 * tests already lock in.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DAEMON_BUNDLE = path.join(REPO_ROOT, 'dist', 'daemon-bundle', 'index.js');

if (!fs.existsSync(DAEMON_BUNDLE)) {
  console.error('Daemon bundle missing — run `npm run build:daemon` first');
  process.exit(2);
}

// Helpers ---------------------------------------------------------------

function makeTestHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-shutdown-dyn-'));
  fs.mkdirSync(path.join(home, '.wmux'), { recursive: true });
  return home;
}

function makePipeName(tag) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wmux-test-${tag}`;
  }
  return path.join(os.tmpdir(), `wmux-test-${tag}.sock`);
}

function writeConfig(wmuxDir, pipeName, authToken) {
  fs.writeFileSync(
    path.join(wmuxDir, 'config.json'),
    JSON.stringify(
      {
        version: 1,
        daemon: { pipeName, logLevel: 'warn', autoStart: true },
        session: {
          defaultShell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
          defaultCols: 80,
          defaultRows: 24,
          bufferSizeMb: 8,
          bufferMaxMb: 64,
          deadSessionTtlHours: 24,
          deadSessionDumpBuffer: true,
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(wmuxDir, 'daemon-auth-token'), authToken, 'utf-8');
}

function spawnDaemon(testHome) {
  return spawn(process.execPath, [DAEMON_BUNDLE], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      USERPROFILE: testHome,
      HOME: testHome,
      HOMEDRIVE: undefined,
      HOMEPATH: undefined,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForPipeFile(wmuxDir, timeoutMs = 10_000) {
  const pipeFile = path.join(wmuxDir, 'daemon-pipe');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(pipeFile)) return fs.readFileSync(pipeFile, 'utf-8').trim();
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('daemon-pipe did not appear within timeout');
}

function connectSocket(pipeName) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(pipeName, () => resolve(s));
    s.on('error', reject);
  });
}

function rpc(socket, method, params, authToken, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const id = `req-${Math.random().toString(36).slice(2, 10)}`;
    let buffer = '';
    const handler = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            socket.removeListener('data', handler);
            if (msg.ok) resolve(msg.result);
            else reject(new Error(msg.error ?? 'rpc error'));
            return;
          }
        } catch {
          /* ignore */
        }
      }
    };
    socket.on('data', handler);
    socket.write(JSON.stringify({ id, method, params, token: authToken }) + '\n');
    setTimeout(() => {
      socket.removeListener('data', handler);
      reject(new Error(`rpc timeout: ${method}`));
    }, timeoutMs);
  });
}

async function killDaemon(child) {
  if (child.killed) return;
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  if (!child.killed) child.kill('SIGKILL');
}

// Scenario runner -------------------------------------------------------

async function withDaemon(label, body) {
  const testHome = makeTestHome();
  const wmuxDir = path.join(testHome, '.wmux');
  const tag = `${label}-${randomUUID().slice(0, 8)}`;
  const pipeName = makePipeName(tag);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);

  const child = spawnDaemon(testHome);
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  try {
    const resolvedPipe = await waitForPipeFile(wmuxDir);
    const socket = await connectSocket(resolvedPipe);
    try {
      return await body({ wmuxDir, socket, authToken });
    } finally {
      socket.end();
    }
  } catch (err) {
    if (stderr) console.error(`[${label}] daemon stderr tail:\n${stderr.slice(-2000)}`);
    throw err;
  } finally {
    await killDaemon(child);
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function runT1(report) {
  await withDaemon('T1', async ({ wmuxDir, socket, authToken }) => {
    await new Promise((r) => setTimeout(r, 1000));
    const sessionId = `t1-${randomUUID().slice(0, 8)}`;
    await rpc(socket, 'daemon.createSession', { id: sessionId, cmd: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', cwd: wmuxDir, env: {}, cols: 80, rows: 24 }, authToken);
    await new Promise((r) => setTimeout(r, 1000));
    await rpc(socket, 'daemon.shutdown', {}, authToken, 10_000).catch(() => {});
    // Give the daemon's deferred process.exit time to flush.
    await new Promise((r) => setTimeout(r, 800));

    const bufPath = path.join(wmuxDir, 'buffers', `${sessionId}.buf`);
    const sessionsJsonPath = path.join(wmuxDir, 'sessions.json');
    const bufExists = fs.existsSync(bufPath);
    let entryPresent = false;
    if (fs.existsSync(sessionsJsonPath)) {
      const persisted = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf-8'));
      entryPresent = persisted.sessions.some((s) => s.id === sessionId);
    }
    report.push({ scenario: 'T1', bufExists, entryPresent, pass: bufExists && entryPresent });
  });
}

async function runT2(report) {
  await withDaemon('T2', async ({ wmuxDir, socket, authToken }) => {
    const sessionId = `t2-${randomUUID().slice(0, 8)}`;
    // No wait — immediately follow createSession with shutdown.
    await rpc(socket, 'daemon.createSession', { id: sessionId, cmd: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', cwd: wmuxDir, env: {}, cols: 80, rows: 24 }, authToken);
    await rpc(socket, 'daemon.shutdown', {}, authToken, 10_000).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));

    const sessionsJsonPath = path.join(wmuxDir, 'sessions.json');
    let entryPresent = false;
    if (fs.existsSync(sessionsJsonPath)) {
      const persisted = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf-8'));
      entryPresent = persisted.sessions.some((s) => s.id === sessionId);
    }
    report.push({ scenario: 'T2', entryPresent, pass: entryPresent });
  });
}

async function measureShutdownLatency(label, n) {
  return await withDaemon(label, async ({ wmuxDir, socket, authToken }) => {
    // Spawn N sessions back-to-back. We don't try to fill 8 MB of PTY
    // output per session — that's beyond what a portable harness can
    // drive reliably on Windows. The measurement still captures the
    // daemon's shutdown overhead per session (atomic dump, sessions.json
    // merge, state save).
    //
    // Insert a small delay between spawns. Without it ConPTY on Windows
    // returns ERROR_INVALID_PARAMETER (87) under rapid-fire load — the
    // same constraint v281-dynamic-test.mjs documents.
    let spawned = 0;
    let spawnFailures = 0;
    for (let i = 0; i < n; i++) {
      const id = `${label}-${i}`;
      try {
        await rpc(socket, 'daemon.createSession', { id, cmd: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', cwd: wmuxDir, env: {}, cols: 80, rows: 24 }, authToken);
        spawned++;
      } catch (err) {
        spawnFailures++;
      }
      if (process.platform === 'win32') {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    // Quick settle so the periodic snapshot does not race the shutdown.
    await new Promise((r) => setTimeout(r, 300));

    const start = Date.now();
    await rpc(socket, 'daemon.shutdown', {}, authToken, 30_000).catch(() => {});
    const elapsed = Date.now() - start;
    return { elapsed, spawned, spawnFailures };
  });
}

async function runT5(report) {
  const sizes = [1, 10, 50];
  const latencies = {};
  for (const n of sizes) {
    const label = `T5n${n}`;
    try {
      const result = await measureShutdownLatency(label, n);
      latencies[n] = result;
      console.log(`[T5] N=${n} shutdown latency: ${result.elapsed} ms (spawned ${result.spawned}, failed ${result.spawnFailures})`);
    } catch (err) {
      console.error(`[T5] N=${n} failed: ${err.message}`);
      latencies[n] = null;
    }
  }
  report.push({ scenario: 'T5', latencies });
}

// Main ------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  console.error('[unhandledRejection]', msg);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.stack ?? err.message);
});

const report = [];
let exitCode = 0;
try {
  await runT1(report);
  await runT2(report);
  await runT5(report);
} catch (err) {
  console.error('[FAIL]', err.message);
  console.error(err.stack);
  exitCode = 1;
}

console.log('\n=== REPORT ===');
for (const entry of report) {
  console.log(JSON.stringify(entry));
}

const failed = report.filter((r) => r.scenario !== 'T5' && r.pass === false);
if (failed.length > 0) {
  console.error(`\n[FAIL] ${failed.length} non-T5 scenarios failed.`);
  exitCode = 1;
} else {
  console.log('\n[PASS] T1 + T2 scenarios met their post-conditions.');
  const t5 = report.find((r) => r.scenario === 'T5');
  if (t5) {
    const measurements = Object.values(t5.latencies).filter((v) => v != null && typeof v.elapsed === 'number');
    if (measurements.length > 0) {
      const max = Math.max(...measurements.map((m) => m.elapsed));
      console.log(`[T5] max latency across N∈{1,10,50}: ${max} ms`);
      console.log(`[T5] recommended A5 timeout: min(${max} + 1000 ms, 4000 ms) = ${Math.min(max + 1000, 4000)} ms`);
    }
  }
}

process.exit(exitCode);
