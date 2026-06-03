#!/usr/bin/env node
/**
 * Orphan-daemon idle-reap reproduction. Covers the two idle-shutdown
 * paths the existing daemon-idle-shutdown-dynamic.mjs never exercises:
 *
 *   S1 — a daemon that boots and NEVER sees a client connect. The idle
 *        anchor must fall back to startTime (getLastDisconnectAt() is
 *        null). This is the closest analogue to orphan PID 31396, whose
 *        parent died before a client ever attached, yet which lived for
 *        3 days instead of self-terminating.
 *
 *   S2 — a daemon with one live session whose PTY is killed out from
 *        under it (parent crash leaves the PTY; the PTY later exits).
 *        The ProcessMonitor death->'dead' transition must drop
 *        listLiveSessions() to 0 so idle-shutdown can fire. If the dead
 *        transition never happens, the session stays `detached` forever
 *        and the daemon never reaps itself — the orphan-accumulation bug.
 *
 * Exit 0 only if BOTH daemons self-terminate within the idle window.
 *
 * Usage:  node scripts/daemon-orphan-idle-dynamic.mjs
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DAEMON_BUNDLE = path.join(REPO_ROOT, 'dist', 'daemon-bundle', 'index.js');
const WIN = process.platform === 'win32';

if (!fs.existsSync(DAEMON_BUNDLE)) {
  console.error('Daemon bundle missing — run `npm run build:daemon` first');
  process.exit(2);
}

// Idle config turned down so the verification finishes in seconds.
const IDLE_MS = 3_000;
const GRACE_MS = 1_500;
const TICK_MS = 500;

function rpc(socket, method, params, token) {
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
    socket.write(JSON.stringify({ id, method, params, token }) + '\n');
    setTimeout(() => {
      socket.removeListener('data', handler);
      reject(new Error(`rpc timeout: ${method}`));
    }, 5000);
  });
}

function connectSocket(pipeName) {
  return new Promise((resolve, reject) => {
    const s = net.connect(pipeName);
    const t = setTimeout(() => { s.destroy(); reject(new Error('connect timeout')); }, 5000);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function waitForPipeFile(wmuxDir, timeoutMs = 10_000) {
  const pipeFile = path.join(wmuxDir, 'daemon-pipe');
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (fs.existsSync(pipeFile)) {
        resolve(fs.readFileSync(pipeFile, 'utf-8').trim());
        return;
      }
      if (Date.now() >= deadline) { reject(new Error('pipe file timeout')); return; }
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function runScenario(name, opts) {
  const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), `wmux-orphan-${name}-`));
  const TEST_WMUX = path.join(TEST_HOME, '.wmux');
  fs.mkdirSync(TEST_WMUX, { recursive: true });
  const PIPE = WIN
    ? `\\\\.\\pipe\\wmux-test-${name}-${randomUUID().slice(0, 8)}`
    : path.join(TEST_HOME, `s-${randomUUID().slice(0, 8)}.sock`);
  const TOKEN = randomUUID();

  fs.writeFileSync(
    path.join(TEST_WMUX, 'config.json'),
    JSON.stringify({
      version: 1,
      daemon: { pipeName: PIPE, logLevel: 'info', autoStart: true, idleShutdownMinutes: 5 },
      session: {
        defaultShell: WIN ? 'cmd.exe' : '/bin/sh',
        defaultCols: 120, defaultRows: 30, bufferSizeMb: 8, bufferMaxMb: 64,
        deadSessionTtlHours: 24, deadSessionDumpBuffer: true,
      },
    }, null, 2),
  );
  fs.writeFileSync(path.join(TEST_WMUX, 'daemon-auth-token'), TOKEN, 'utf-8');

  const child = spawn(process.execPath, [DAEMON_BUNDLE], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      USERPROFILE: TEST_HOME, HOME: TEST_HOME, HOMEDRIVE: undefined, HOMEPATH: undefined,
      WMUX_IDLE_SHUTDOWN_MS: String(IDLE_MS),
      WMUX_IDLE_GRACE_MS: String(GRACE_MS),
      WMUX_WATCHDOG_TICK_MS: String(TICK_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(`[${name}] ${d}`); });
  child.stderr.on('data', (d) => { out += d.toString(); process.stderr.write(`[${name}-err] ${d}`); });
  const exitPromise = new Promise((res) => child.once('exit', (code, sig) => res({ code, sig })));

  try {
    const pipeName = await waitForPipeFile(TEST_WMUX);
    console.log(`[${name}] daemon up on ${pipeName}`);

    if (opts.createAndKill) {
      const socket = await connectSocket(pipeName);
      const ping = await rpc(socket, 'daemon.ping', {}, TOKEN);
      if (!ping || ping.status !== 'ok') throw new Error(`bad ping: ${JSON.stringify(ping)}`);
      const sess = await rpc(socket, 'daemon.createSession',
        { id: 'orphan1', cmd: WIN ? 'cmd.exe' : '/bin/sh', cwd: TEST_HOME, cols: 120, rows: 30 }, TOKEN);
      console.log(`[${name}] created session pid=${sess.pid} state=${sess.state}`);
      // Kill the PTY child out from under the daemon — simulates the PTY
      // exiting after the parent UI already crashed. ProcessMonitor must
      // notice and flip the session to 'dead'.
      try { process.kill(sess.pid); console.log(`[${name}] killed PTY pid=${sess.pid}`); }
      catch (e) { console.log(`[${name}] kill failed (already gone?): ${e.message}`); }
      // Disconnect — drop to 0 clients so only the (now-dead) session
      // could keep the daemon alive.
      socket.end(); socket.destroy();
      console.log(`[${name}] client disconnected`);
    } else {
      // S1: deliberately NEVER connect. lastDisconnectAt stays null.
      console.log(`[${name}] no client will ever connect (idle anchor = startTime)`);
    }

    const deadlineMs = opts.createAndKill
      ? GRACE_MS + IDLE_MS + 18_000   // + ProcessMonitor 5s detect + margin
      : GRACE_MS + IDLE_MS + 6_000;
    console.log(`[${name}] waiting up to ${deadlineMs}ms for self-terminate`);

    const result = await Promise.race([
      exitPromise,
      new Promise((_, rej) => setTimeout(
        () => rej(new Error(`did NOT self-terminate within ${deadlineMs}ms`)), deadlineMs)),
    ]);

    if (!/idle\.timeout/.test(out)) throw new Error('missing [shutdown.phase] idle.timeout breadcrumb');
    if (result.code !== 0) throw new Error(`exited non-zero code=${result.code}`);
    console.log(`[${name}] PASS — self-terminated code=${result.code}`);
    return true;
  } catch (err) {
    console.error(`[${name}] FAIL — ${err?.message ?? err}`);
    return false;
  } finally {
    try { if (!child.killed) child.kill('SIGKILL'); } catch { /* ignore */ }
    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const s1 = await runScenario('S1-no-client', { createAndKill: false });
const s2 = await runScenario('S2-pty-killed', { createAndKill: true });

console.log(`\n=== RESULT: S1(no-client)=${s1 ? 'PASS' : 'FAIL'}  S2(pty-killed)=${s2 ? 'PASS' : 'FAIL'} ===`);
process.exit(s1 && s2 ? 0 : 1);
