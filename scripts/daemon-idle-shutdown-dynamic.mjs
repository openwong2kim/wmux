#!/usr/bin/env node
/**
 * Dynamic verification for the daemon idle-shutdown path. Spawns the
 * BUNDLED daemon (dist/daemon-bundle/index.js) in an isolated state
 * directory with WMUX_IDLE_SHUTDOWN_MS / WMUX_IDLE_GRACE_MS turned
 * down to seconds, connects + disconnects, then watches the daemon
 * process itself exit.
 *
 * Catches the bugs the unit suite cannot: TypeScript-to-bundle drift
 * in the env-var parser, Watchdog timer wiring against a real
 * setInterval, the doShutdown hoist actually firing before
 * setCallbacks runs at boot, the `[shutdown.phase] idle.timeout`
 * breadcrumb landing in the on-disk log.
 *
 * Usage:
 *   node scripts/daemon-idle-shutdown-dynamic.mjs
 *
 * Exit code: 0 on success, 1 on any verification failure.
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

// Isolated state directory + custom pipe name so we never collide
// with the real ~/.wmux/ daemon the user's app may be running.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-idle-dyn-'));
const TEST_WMUX = path.join(TEST_HOME, '.wmux');
fs.mkdirSync(TEST_WMUX, { recursive: true });

const PIPE_TAG = `idle-${randomUUID().slice(0, 8)}`;
const PIPE_NAME =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\wmux-test-${PIPE_TAG}`
    : path.join(TEST_HOME, `.wmux-test-${PIPE_TAG}.sock`);

const AUTH_TOKEN = randomUUID();

// Idle config — turn it down hard so the verification finishes in
// seconds, not minutes. The defaults (5 min idle / 60 s grace) match
// production but would make this script unusable on CI.
const IDLE_MS = 3_000;
const GRACE_MS = 1_500;

fs.writeFileSync(
  path.join(TEST_WMUX, 'config.json'),
  JSON.stringify(
    {
      version: 1,
      daemon: { pipeName: PIPE_NAME, logLevel: 'info', autoStart: true, idleShutdownMinutes: 5 },
      session: {
        defaultShell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        defaultCols: 120,
        defaultRows: 30,
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
fs.writeFileSync(path.join(TEST_WMUX, 'daemon-auth-token'), AUTH_TOKEN, 'utf-8');

console.log(`[setup] TEST_HOME=${TEST_HOME}`);
console.log(`[setup] PIPE=${PIPE_NAME}`);
console.log(`[setup] WMUX_IDLE_SHUTDOWN_MS=${IDLE_MS} WMUX_IDLE_GRACE_MS=${GRACE_MS}`);

const child = spawn(process.execPath, [DAEMON_BUNDLE], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    USERPROFILE: TEST_HOME,
    HOME: TEST_HOME,
    HOMEDRIVE: undefined,
    HOMEPATH: undefined,
    WMUX_IDLE_SHUTDOWN_MS: String(IDLE_MS),
    WMUX_IDLE_GRACE_MS: String(GRACE_MS),
    // Watchdog default tick is 30s; speeding it up to 500ms keeps this
    // verification finishing in well under 10s instead of ~35s.
    WMUX_WATCHDOG_TICK_MS: '500',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdoutBuf = '';
let stderrBuf = '';
child.stdout.on('data', (d) => {
  stdoutBuf += d.toString();
  process.stdout.write(`[daemon] ${d}`);
});
child.stderr.on('data', (d) => {
  stderrBuf += d.toString();
  process.stderr.write(`[daemon-err] ${d}`);
});

const exitPromise = new Promise((resolve) => {
  child.once('exit', (code, sig) => resolve({ code, sig }));
});

function waitForPipeFile(timeoutMs = 10_000) {
  const pipeFile = path.join(TEST_WMUX, 'daemon-pipe');
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (fs.existsSync(pipeFile)) {
        resolve(fs.readFileSync(pipeFile, 'utf-8').trim());
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('Daemon pipe file did not appear within timeout'));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

function rpc(socket, method, params = {}) {
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
        } catch { /* ignore */ }
      }
    };
    socket.on('data', handler);
    const req = JSON.stringify({ id, method, params, token: AUTH_TOKEN }) + '\n';
    socket.write(req);
    setTimeout(() => {
      socket.removeListener('data', handler);
      reject(new Error(`rpc timeout: ${method}`));
    }, 5000);
  });
}

let exitCode = 1;
try {
  // Phase 1 — daemon comes up.
  const pipeName = await waitForPipeFile();
  console.log(`[probe] daemon listening on ${pipeName}`);

  const socket = await new Promise((resolve, reject) => {
    const s = net.connect(pipeName);
    const t = setTimeout(() => { s.destroy(); reject(new Error('connect timeout')); }, 5000);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(e); });
  });

  // Phase 2 — verify ping works (daemon healthy + accepting traffic).
  const ping = await rpc(socket, 'daemon.ping', {});
  if (!ping || ping.status !== 'ok') {
    throw new Error(`unexpected ping response: ${JSON.stringify(ping)}`);
  }
  console.log(`[probe] daemon.ping ok`);

  // Phase 3 — disconnect. lastDisconnectAt should anchor here, the
  // grace window already started ticking at boot, idle countdown
  // begins now.
  socket.end();
  socket.destroy();
  const disconnectedAt = Date.now();
  console.log(`[probe] socket closed at t+${disconnectedAt - 0}ms`);

  // Phase 4 — wait for the daemon to self-terminate. We've driven the
  // Watchdog tick down to 500ms via WMUX_WATCHDOG_TICK_MS, so the
  // detection window is (grace + idle + ~1 tick) ≈ 5s. Add a 5s
  // safety margin for slow CI runners and shutdown-phase work.
  const deadlineMs = GRACE_MS + IDLE_MS + 5_000;
  console.log(`[probe] waiting up to ${deadlineMs}ms for self-terminate`);

  const result = await Promise.race([
    exitPromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`daemon did not self-terminate within ${deadlineMs}ms`)), deadlineMs),
    ),
  ]);

  console.log(`[probe] daemon exited code=${result.code} sig=${result.sig}`);

  // Phase 5 — verify the breadcrumb. The combined stdout buffer
  // should carry one [shutdown.phase] idle.timeout line.
  const combined = stdoutBuf + stderrBuf;
  if (!/idle\.timeout/.test(combined)) {
    throw new Error('expected [shutdown.phase] idle.timeout log line not found');
  }
  console.log(`[probe] found idle.timeout breadcrumb in daemon output`);

  // Phase 6 — exit code 0 means clean shutdown path.
  if (result.code !== 0) {
    throw new Error(`daemon exited non-zero: code=${result.code}`);
  }

  console.log('[PASS] idle shutdown end-to-end');
  exitCode = 0;
} catch (err) {
  console.error('[FAIL]', err?.message ?? err);
  if (!child.killed) child.kill('SIGKILL');
} finally {
  // Best-effort cleanup. Leaving the directory behind is fine on
  // a CI runner — the OS cleans tmp.
  try {
    if (!child.killed) child.kill('SIGKILL');
  } catch { /* ignore */ }
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(exitCode);
