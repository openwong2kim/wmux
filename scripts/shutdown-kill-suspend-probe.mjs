#!/usr/bin/env node
/**
 * Shutdown-kill suspend probe — reboot-reattach RCA fix (2026-07-02),
 * end-to-end through the REAL bundled daemon.
 *
 * Incident: during an OS reboot Windows killed the daemon's PTY children
 * (exitCode 0x40010004 = DBG_TERMINATE_PROCESS) BEFORE the daemon itself.
 * The daemon observed each pty-exit, marked the session 'dead', persisted the
 * tombstone — and post-reboot recovery purged exactly the sessions the user
 * was working in, while unobserved ghosts survived. Renderer reconcile then
 * found neither ptyId nor surfaceId → self-create → "terminal reset".
 *
 * The fix classifies 0x40010004 exits as involuntary → suspend (buffer dump +
 * persisted 'suspended') → recovery replays the SAME id.
 *
 * PASS criteria:
 *   P1  session exiting 0x40010004 → state 'suspended' (NOT dead), persisted
 *   P2  control session exiting a normal code → state 'dead' (fix doesn't
 *       over-suspend voluntary exits)
 *   P3  daemon force-killed within the reclassify window (= OS kills daemon),
 *       respawned daemon RECOVERS the suspended session under the SAME id
 *   P4  the dead control session is NOT resurrected
 *   P5  reclassification: a 0x40010004 exit with the daemon left ALIVE past
 *       the 15s window flips to 'dead' (cancelled-shutdown false positive)
 *   P6  adversarial-review finding: a client reconnect attempt against a
 *       'suspended' session (renderer retry during the misclassification
 *       window, before it knows the pty died) must reject gracefully — NOT
 *       wire a fresh SessionPipe into the destroyed ptyProcess and crash the
 *       daemon. Asserted by attaching, then confirming the daemon is still
 *       alive and answering RPCs afterward.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON_BUNDLE = path.join(REPO_ROOT, 'dist', 'daemon-bundle', 'index.js');
const SHUTDOWN_CODE = 1073807364; // 0x40010004 — must match shutdownKill.ts

function makePipeName(tag) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\wmux-test-${tag}`
    : path.join(os.tmpdir(), `wmux-test-${tag}.sock`);
}

function writeConfig(wmuxDir, pipeName, authToken) {
  fs.writeFileSync(
    path.join(wmuxDir, 'config.json'),
    JSON.stringify({
      version: 1,
      daemon: { pipeName, logLevel: 'info', autoStart: true },
      session: {
        defaultShell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        defaultCols: 80, defaultRows: 24, bufferSizeMb: 8, bufferMaxMb: 64,
        deadSessionTtlHours: 24, deadSessionDumpBuffer: true,
      },
    }, null, 2),
  );
  fs.writeFileSync(path.join(wmuxDir, 'daemon-auth-token'), authToken, 'utf-8');
}

function spawnDaemon(testHome, logChunks) {
  const d = spawn(process.execPath, [DAEMON_BUNDLE], {
    cwd: REPO_ROOT,
    env: { ...process.env, USERPROFILE: testHome, HOME: testHome, HOMEDRIVE: undefined, HOMEPATH: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  d.stdout.on('data', (c) => logChunks && logChunks.push(c.toString()));
  d.stderr.on('data', (c) => logChunks && logChunks.push(c.toString()));
  return d;
}

async function waitForPipeFile(wmuxDir, timeoutMs = 15_000) {
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
    setTimeout(() => { socket.removeListener('data', handler); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs);
  });
}

async function waitForState(sock, authToken, id, want, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '(absent)';
  while (Date.now() < deadline) {
    const sessions = await rpc(sock, 'daemon.listSessions', {}, authToken);
    const s = sessions.find((x) => x.id === id);
    last = s ? s.state : '(absent)';
    if (last === want) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`   waitForState(${id} → ${want}) timed out; last state = ${last}`);
  return false;
}

async function main() {
  if (!fs.existsSync(DAEMON_BUNDLE)) {
    console.error(`Daemon bundle missing: ${DAEMON_BUNDLE}\nRun: npm run build:daemon`);
    process.exit(2);
  }

  const tag = `shutkill-${randomUUID().slice(0, 8)}`;
  const testHome = path.join(os.tmpdir(), `wmux-${tag}`);
  const wmuxDir = path.join(testHome, '.wmux');
  fs.mkdirSync(wmuxDir, { recursive: true });

  const pipeName = makePipeName(tag);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);

  const shell = process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    : '/bin/sh';
  // exec unit = the command IS the pane process; its exit code IS the pty exit
  // code (cmd /d /s /c propagates natively). ~4s alive, then the target exit.
  const delayThenExit = (code) => process.platform === 'win32'
    ? `ping -n 5 127.0.0.1 >nul & exit ${code}`
    : `sleep 4; exit ${code}`;

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // --- Daemon #1: shutdown-kill exit vs voluntary exit ---
  console.log('phase 1: classify shutdown-kill vs voluntary exit');
  const d1Log = [];
  const d1 = spawnDaemon(testHome, d1Log);
  let resolved = await waitForPipeFile(wmuxDir);
  let sock = await connectSocket(resolved);

  await rpc(sock, 'daemon.createSession', {
    id: 'sess-shutkill', cmd: shell, cwd: testHome, cols: 80, rows: 24,
    exec: { command: delayThenExit(SHUTDOWN_CODE) },
  }, authToken);
  await rpc(sock, 'daemon.createSession', {
    id: 'sess-voluntary', cmd: shell, cwd: testHome, cols: 80, rows: 24,
    exec: { command: delayThenExit(42) },
  }, authToken);

  const p1 = await waitForState(sock, authToken, 'sess-shutkill', 'suspended', 15_000);
  check('P1 0x40010004 exit → suspended (not dead)', p1);
  const p2 = await waitForState(sock, authToken, 'sess-voluntary', 'dead', 15_000);
  check('P2 voluntary exit 42 → dead (no over-suspend)', p2);

  // P6 — reconnect attempt against the suspended session must reject, not
  // wire a pipe into the destroyed ptyProcess and crash the daemon.
  let p6AttachRejected = false;
  let p6AttachErr = '';
  try {
    await rpc(sock, 'daemon.attachSession', { id: 'sess-shutkill' }, authToken, 5_000);
  } catch (err) {
    p6AttachRejected = true;
    p6AttachErr = err.message ?? String(err);
  }
  check('P6a attachSession on suspended session rejects', p6AttachRejected, p6AttachErr);
  let p6DaemonAlive = false;
  try {
    await rpc(sock, 'daemon.listSessions', {}, authToken, 5_000);
    p6DaemonAlive = true;
  } catch { /* daemon crashed or hung */ }
  check('P6b daemon still alive/responsive after rejected attach', p6DaemonAlive);

  // Give the interrupted handler's dump+saveImmediate a beat to land, then
  // simulate the OS killing the daemon BEFORE the 15s reclassify window.
  await new Promise((r) => setTimeout(r, 1_500));
  sock.destroy();
  d1.kill('SIGKILL');
  await new Promise((r) => { d1.on('exit', r); setTimeout(r, 3_000); });

  const persisted = JSON.parse(fs.readFileSync(path.join(wmuxDir, 'sessions.json'), 'utf-8'));
  const persistedShut = persisted.sessions.find((s) => s.id === 'sess-shutkill');
  check('P1b persisted state is suspended (recovery payload)', persistedShut?.state === 'suspended',
    `state=${persistedShut?.state ?? '(absent)'}`);

  // --- Daemon #2: "post-reboot" recovery must replay the suspended session ---
  console.log('phase 2: respawn daemon → recovery');
  // SIGKILL leaves a stale daemon-pipe file — remove it so waitForPipeFile
  // resolves the NEW daemon's pipe, not the corpse's.
  try { fs.unlinkSync(path.join(wmuxDir, 'daemon-pipe')); } catch { /* absent */ }
  const d2Log = [];
  const d2 = spawnDaemon(testHome, d2Log);
  resolved = await waitForPipeFile(wmuxDir);
  sock = await connectSocket(resolved);

  // Assert quickly — the replayed exec unit re-runs its command and will exit
  // again in ~4s; we only need to see it come back LIVE under the same id.
  const sessions2 = await rpc(sock, 'daemon.listSessions', {}, authToken);
  const recovered = sessions2.find((s) => s.id === 'sess-shutkill');
  check('P3 suspended session recovered under SAME id',
    !!recovered && (recovered.state === 'attached' || recovered.state === 'detached'),
    `state=${recovered?.state ?? '(absent)'}`);
  const zombie = sessions2.find((s) => s.id === 'sess-voluntary');
  check('P4 dead control session NOT resurrected',
    !zombie || zombie.state === 'dead',
    `state=${zombie?.state ?? '(absent)'}`);

  // --- Phase 3: reclassification when the daemon SURVIVES the window ---
  console.log('phase 3: cancelled-shutdown false positive → reclassify to dead (waits ~20s)');
  await rpc(sock, 'daemon.createSession', {
    id: 'sess-reclass', cmd: shell, cwd: testHome, cols: 80, rows: 24,
    exec: { command: delayThenExit(SHUTDOWN_CODE) },
  }, authToken);
  const p5a = await waitForState(sock, authToken, 'sess-reclass', 'suspended', 15_000);
  const p5b = p5a && await waitForState(sock, authToken, 'sess-reclass', 'dead', 25_000);
  check('P5 daemon survives window → reclassified dead', p5a && p5b);

  await rpc(sock, 'daemon.shutdown', {}, authToken, 10_000).catch(() => {});
  sock.destroy();
  await new Promise((r) => { d2.on('exit', r); setTimeout(r, 5_000); });

  const daemonLogs = d1Log.join('') + d2Log.join('');
  const interruptLogged = daemonLogs.includes('session:interrupted id=sess-shutkill');
  check('LOG session:interrupted line present', interruptLogged);

  // Cleanup
  try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* locked logs on win */ }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} (${results.length} checks)`);
  if (failed.length > 0) {
    console.log('\n--- daemon log tail ---');
    console.log(daemonLogs.split('\n').slice(-60).join('\n'));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('probe crashed:', err);
  process.exit(1);
});
