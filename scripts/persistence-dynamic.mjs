#!/usr/bin/env node
/**
 * Dynamic verification for tmux-style persistence (the daemon-level core of
 * the before-quit DETACH model). The GUI Quit path reduces to exactly this on
 * the daemon side: the client closes its control socket and does NOT send
 * daemon.shutdown. This harness reproduces that against the BUNDLED daemon and
 * asserts the persistence guarantees the unit suite can't reach (real ConPTY,
 * real process lifetimes, real idle-shutdown timer).
 *
 * Scenarios:
 *   P1  spawn → createSession → DETACH (close socket, NO daemon.shutdown) →
 *       wait PAST the idle window → assert the daemon AND its PTY are still
 *       alive, and a fresh reconnect still lists the session.
 *       This is "Quit keeps my work running" — the headline persistence claim.
 *
 *   P1b spawn → DETACH with ZERO sessions → wait past idle+grace → assert the
 *       daemon self-terminated. This is the resource-cleanup half: an empty
 *       detached daemon must NOT linger forever (Watchdog idle-shutdown).
 *
 *   P2  spawn → createSession → daemon.shutdown (the explicit "Shut down
 *       completely" path) → assert the daemon process actually EXITS with no
 *       orphan. Locks the orphan-daemon fix (force-exit guarantee).
 *
 * Run: npm run build:daemon && node scripts/persistence-dynamic.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// import.meta.dirname is Node 20.11+; package.json supports Node >=18, so derive
// the script directory from import.meta.url instead (Codex P3).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON_BUNDLE = path.join(REPO_ROOT, 'dist', 'daemon-bundle', 'index.js');

if (!fs.existsSync(DAEMON_BUNDLE)) {
  console.error('Daemon bundle missing — run `npm run build:daemon` first');
  process.exit(2);
}

// --- helpers (mirrors daemon-shutdown-dynamic.mjs) ---------------------

function makeTestHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-persist-dyn-'));
  fs.mkdirSync(path.join(home, '.wmux'), { recursive: true });
  return home;
}

function makePipeName(tag) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\wmux-test-${tag}`;
  return path.join(os.tmpdir(), `wmux-test-${tag}.sock`);
}

function writeConfig(wmuxDir, pipeName, authToken) {
  fs.writeFileSync(
    path.join(wmuxDir, 'config.json'),
    JSON.stringify({
      version: 1,
      daemon: { pipeName, logLevel: 'warn', autoStart: true },
      session: {
        defaultShell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        defaultCols: 80, defaultRows: 24, bufferSizeMb: 8, bufferMaxMb: 64,
        deadSessionTtlHours: 24, deadSessionDumpBuffer: true,
      },
    }, null, 2),
  );
  fs.writeFileSync(path.join(wmuxDir, 'daemon-auth-token'), authToken, 'utf-8');
}

function spawnDaemon(testHome, extraEnv = {}) {
  return spawn(process.execPath, [DAEMON_BUNDLE], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      USERPROFILE: testHome, HOME: testHome,
      HOMEDRIVE: undefined, HOMEPATH: undefined,
      ...extraEnv,
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
        } catch { /* ignore */ }
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

async function createSessionWithRetry(socket, authToken, baseId, cwd, attempts = 6) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    const sessionId = i === 1 ? baseId : `${baseId}-r${i}`;
    try {
      const result = await rpc(socket, 'daemon.createSession', {
        id: sessionId,
        // Absolute path + a minimal PATH so ConPTY can resolve the shell even
        // though we pass a trimmed env (bare 'cmd.exe' with empty PATH throws
        // ERROR_INVALID_PARAMETER 87 on Windows).
        cmd: process.platform === 'win32' ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe') : '/bin/sh',
        cwd,
        env: process.platform === 'win32'
          ? { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH ?? process.env.Path ?? '' }
          : { PATH: process.env.PATH ?? '' },
        cols: 80, rows: 24,
      }, authToken);
      return { result, sessionId };
    } catch (err) {
      lastErr = err;
      if (!/error code: 87|ConPTY|Cannot create process/i.test(err?.message ?? '')) throw err;
      await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  throw lastErr ?? new Error('createSession failed after retries');
}

function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe'),
        ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'],
        { encoding: 'utf-8', timeout: 3000, windowsHide: true },
      );
      return out.includes(`"${pid}"`);
    } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function killDaemon(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  if (child.exitCode === null) child.kill('SIGKILL');
}

// Short idle window so P1 proves "sessions>0 keeps the daemon alive DESPITE an
// aggressive idle timer", and P1b can observe idle-shutdown in seconds.
const FAST_IDLE_ENV = {
  WMUX_IDLE_SHUTDOWN_MS: '2000',
  WMUX_IDLE_GRACE_MS: '500',
  WMUX_WATCHDOG_TICK_MS: '300',
};

// --- P1: detach keeps daemon + PTY + session alive ---------------------

async function runP1(report) {
  const testHome = makeTestHome();
  const wmuxDir = path.join(testHome, '.wmux');
  const pipeName = makePipeName(`P1-${randomUUID().slice(0, 8)}`);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);
  const child = spawnDaemon(testHome, FAST_IDLE_ENV);
  let exited = false;
  child.on('exit', () => { exited = true; });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  let entry = { scenario: 'P1', pass: false };
  try {
    const resolvedPipe = await waitForPipeFile(wmuxDir);
    const socket = await connectSocket(resolvedPipe);
    await new Promise((r) => setTimeout(r, 1500)); // daemon settle before ConPTY
    const { result, sessionId } = await createSessionWithRetry(
      socket, authToken, `p1-${randomUUID().slice(0, 8)}`, wmuxDir,
    );
    const ptyPid = result?.pid;

    // DETACH: close the control socket WITHOUT daemon.shutdown — exactly what
    // main's before-quit does on a normal Quit now.
    socket.end();

    // Wait well past idle timeout (2000) + grace (500) + a couple ticks. A
    // daemon that honored persistence stays up because sessions>0.
    await new Promise((r) => setTimeout(r, 4000));

    const daemonAliveAfterDetach = !exited && isProcessAlive(child.pid);
    const ptyAliveAfterDetach = isProcessAlive(ptyPid);

    // Reconnect (relaunch the UI) and confirm the session is still served.
    let sessionStillListed = false;
    if (daemonAliveAfterDetach) {
      const socket2 = await connectSocket(resolvedPipe);
      try {
        const live = await rpc(socket2, 'daemon.listSessions', {}, authToken);
        sessionStillListed = Array.isArray(live) && live.some((s) => s.id === sessionId);
      } finally { socket2.end(); }
    }

    entry = {
      scenario: 'P1', sessionId, ptyPid,
      daemonAliveAfterDetach, ptyAliveAfterDetach, sessionStillListed,
      pass: daemonAliveAfterDetach && ptyAliveAfterDetach && sessionStillListed,
    };
  } catch (err) {
    entry = { scenario: 'P1', pass: false, error: err.message, stderr: stderr.slice(-600) };
  } finally {
    await killDaemon(child);
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  report.push(entry);
}

// --- P1b: empty detached daemon idle-shuts-down ------------------------

async function runP1b(report) {
  const testHome = makeTestHome();
  const wmuxDir = path.join(testHome, '.wmux');
  const pipeName = makePipeName(`P1b-${randomUUID().slice(0, 8)}`);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);
  const child = spawnDaemon(testHome, FAST_IDLE_ENV);
  let exited = false;
  child.on('exit', () => { exited = true; });

  let entry = { scenario: 'P1b', pass: false };
  try {
    const resolvedPipe = await waitForPipeFile(wmuxDir);
    const socket = await connectSocket(resolvedPipe);
    await new Promise((r) => setTimeout(r, 800));
    socket.end(); // DETACH with zero sessions

    // Past idle (2000) + grace (500) + ticks, with generous headroom.
    await new Promise((r) => setTimeout(r, 6000));
    const daemonExited = exited || !isProcessAlive(child.pid);
    entry = { scenario: 'P1b', daemonExited, pass: daemonExited };
  } catch (err) {
    entry = { scenario: 'P1b', pass: false, error: err.message };
  } finally {
    await killDaemon(child);
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  report.push(entry);
}

// --- P2: explicit full shutdown exits with no orphan -------------------

async function runP2(report) {
  const testHome = makeTestHome();
  const wmuxDir = path.join(testHome, '.wmux');
  const pipeName = makePipeName(`P2-${randomUUID().slice(0, 8)}`);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);
  const child = spawnDaemon(testHome); // default idle (won't fire during test)
  let exited = false;
  child.on('exit', () => { exited = true; });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  let entry = { scenario: 'P2', pass: false };
  try {
    const resolvedPipe = await waitForPipeFile(wmuxDir);
    const socket = await connectSocket(resolvedPipe);
    await new Promise((r) => setTimeout(r, 1500));
    await createSessionWithRetry(socket, authToken, `p2-${randomUUID().slice(0, 8)}`, wmuxDir);

    // Explicit "Shut down completely" path: graceful daemon.shutdown RPC.
    const ackStart = Date.now();
    let ackOk = false;
    try {
      await rpc(socket, 'daemon.shutdown', {}, authToken, 10_000);
      ackOk = true;
    } catch { /* ack miss is tolerated — the force-exit guarantee is the point */ }
    const ackElapsed = Date.now() - ackStart;
    socket.end();

    // Orphan-daemon fix: process.exit must be guaranteed even if pipeServer
    // .stop() hangs. Give the deferred setImmediate + force-exit timer room.
    await new Promise((r) => setTimeout(r, 2000));
    const daemonExited = exited || !isProcessAlive(child.pid);

    entry = {
      scenario: 'P2', ackOk, ackElapsed, daemonExited,
      // The hard requirement is daemonExited (no orphan). ackOk is reported
      // as a secondary signal (clean RPC round-trip) but not gated on.
      pass: daemonExited,
    };
  } catch (err) {
    entry = { scenario: 'P2', pass: false, error: err.message, stderr: stderr.slice(-600) };
  } finally {
    await killDaemon(child);
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  report.push(entry);
}

// --- main --------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : String(reason));
});

const report = [];
for (const [name, fn] of [['P1', runP1], ['P1b', runP1b], ['P2', runP2]]) {
  try { await fn(report); }
  catch (err) { console.error(`[${name}] threw: ${err.message}`); report.push({ scenario: name, pass: false, error: err.message }); }
}

console.log('\n=== PERSISTENCE REPORT ===');
for (const entry of report) console.log(JSON.stringify(entry));

const failed = report.filter((r) => r.pass === false);
if (failed.length > 0) {
  console.error(`\n[FAIL] ${failed.length}/${report.length} persistence scenarios failed.`);
  process.exit(1);
}
console.log(`\n[PASS] all ${report.length} persistence scenarios met their post-conditions.`);
process.exit(0);
