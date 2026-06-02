#!/usr/bin/env node
/**
 * Dynamic verification for the duplicate-daemon / split-brain fix
 * (plans/duplicate-daemon-split-brain.md, Step ③).
 *
 * Spawns the BUNDLED daemon in an isolated state dir (USERPROFILE/HOME →
 * tmpdir, unique pipe name) so it never touches the user's real ~/.wmux or
 * the production daemon.
 *
 * SB1 — the split-brain trigger, end-to-end:
 *   1. Spawn daemon A → it listens on the canonical pipe.
 *   2. Confirm A answers daemon.ping.
 *   3. Delete daemon.lock / daemon.pid / daemon-pipe — this reproduces what
 *      the launcher does right before spawning a second daemon (it cleans
 *      "stale" files, which is exactly how a redundant B gets past acquireLock).
 *   4. Spawn daemon B against the SAME state dir + config (same canonical pipe).
 *   5. Assert: B exits with DAEMON_EXIT_ALREADY_RUNNING (75) — it found A live
 *      on the canonical pipe and yielded (Step ③ fail-fast), instead of taking
 *      a `-1` suffix and becoming a second live daemon.
 *   6. Assert: NO `<pipe>-1` daemon exists (connect is refused).
 *   7. Assert: A is still alive (answers daemon.ping) — B did not kill it.
 *
 * SB2 — regression: a daemon on a CLEAN state dir starts normally on the
 *   canonical pipe (no fail-fast, no `-1`).
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DAEMON_BUNDLE = path.join(REPO_ROOT, 'dist', 'daemon-bundle', 'index.js');
const DAEMON_EXIT_ALREADY_RUNNING = 75; // mirror src/shared/constants.ts

if (!fs.existsSync(DAEMON_BUNDLE)) {
  console.error('Daemon bundle missing — run `npm run build:daemon` first');
  process.exit(2);
}

function makeTestHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-split-brain-'));
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
    JSON.stringify(
      {
        version: 1,
        daemon: { pipeName, logLevel: 'warn', autoStart: true },
        session: {
          defaultShell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
          defaultCols: 80, defaultRows: 24, bufferSizeMb: 8, bufferMaxMb: 64,
          deadSessionTtlHours: 24, deadSessionDumpBuffer: true,
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
    env: { ...process.env, USERPROFILE: testHome, HOME: testHome, HOMEDRIVE: undefined, HOMEPATH: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForPipeFile(wmuxDir, timeoutMs = 12_000) {
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

function rpc(socket, method, params, authToken, timeoutMs = 10_000) {
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
            if (msg.ok) resolve(msg.result ?? { status: 'ok' });
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

async function pingOnce(pipeName, authToken) {
  let socket;
  try {
    socket = await connectSocket(pipeName);
    await rpc(socket, 'daemon.ping', {}, authToken, 5000);
    return true;
  } catch {
    return false;
  } finally {
    if (socket) socket.end();
  }
}

// connect refused (or any error) ⇒ no daemon owns that name.
async function pipeHasOwner(pipeName) {
  return new Promise((resolve) => {
    const s = net.createConnection(pipeName, () => { s.destroy(); resolve(true); });
    s.on('error', () => { s.destroy(); resolve(false); });
    setTimeout(() => { s.destroy(); resolve(false); }, 2000);
  });
}

async function killDaemon(child) {
  if (!child || child.killed) return;
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
}

function exitOf(child) {
  return new Promise((resolve) => {
    let done = false;
    child.on('exit', (code, signal) => { if (!done) { done = true; resolve({ code, signal }); } });
    setTimeout(() => { if (!done) { done = true; resolve({ code: 'TIMEOUT', signal: null }); } }, 20_000);
  });
}

// SB1 -------------------------------------------------------------------
async function runSB1(report) {
  const testHome = makeTestHome();
  const wmuxDir = path.join(testHome, '.wmux');
  const tag = `sb1-${randomUUID().slice(0, 8)}`;
  const pipeName = makePipeName(tag);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);

  let childA;
  let bStderr = '';
  let bStdout = '';
  try {
    // 1-2. Daemon A up + answering ping.
    childA = spawnDaemon(testHome);
    await waitForPipeFile(wmuxDir);
    await new Promise((r) => setTimeout(r, 800));
    const aAliveBefore = await pingOnce(pipeName, authToken);

    // 3. Reproduce the launcher's pre-spawn stale-file cleanup so B can pass
    //    acquireLock (this is exactly how a redundant second daemon arises).
    for (const f of ['daemon.lock', 'daemon.pid', 'daemon-pipe']) {
      try { fs.unlinkSync(path.join(wmuxDir, f)); } catch { /* ignore */ }
    }

    // 4. Spawn daemon B against the same dir/config (same canonical pipe).
    const childB = spawnDaemon(testHome);
    childB.stderr.on('data', (d) => { bStderr += d.toString(); });
    childB.stdout.on('data', (d) => { bStdout += d.toString(); });
    const bExit = await exitOf(childB);

    // 5-7. Assertions.
    const noMinusOnePipe = !(await pipeHasOwner(`${pipeName}-1`));
    const aAliveAfter = await pingOnce(pipeName, authToken);

    const pass =
      bExit.code === DAEMON_EXIT_ALREADY_RUNNING &&
      noMinusOnePipe === true &&
      aAliveBefore === true &&
      aAliveAfter === true;

    report.push({
      scenario: 'SB1', pass,
      aAliveBefore, bExitCode: bExit.code, bExitSignal: bExit.signal,
      noMinusOnePipe, aAliveAfter,
      bStdoutTail: pass ? undefined : bStdout.slice(-700).replace(/\s+/g, ' '),
      bStderrTail: pass ? undefined : bStderr.slice(-500).replace(/\s+/g, ' '),
    });
  } catch (err) {
    report.push({ scenario: 'SB1', pass: false, error: err.message, bStderrTail: bStderr.slice(-500) });
  } finally {
    await killDaemon(childA);
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// SB2 (regression) ------------------------------------------------------
async function runSB2(report) {
  const testHome = makeTestHome();
  const wmuxDir = path.join(testHome, '.wmux');
  const tag = `sb2-${randomUUID().slice(0, 8)}`;
  const pipeName = makePipeName(tag);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);

  let child;
  try {
    child = spawnDaemon(testHome);
    const resolvedPipe = await waitForPipeFile(wmuxDir);
    await new Promise((r) => setTimeout(r, 800));
    const alive = await pingOnce(pipeName, authToken);
    const onCanonical = resolvedPipe === pipeName;            // no -N fallback on a clean dir
    const noMinusOne = !(await pipeHasOwner(`${pipeName}-1`));
    const pass = alive && onCanonical && noMinusOne;
    report.push({ scenario: 'SB2', pass, alive, resolvedPipe, onCanonical, noMinusOne });
  } catch (err) {
    report.push({ scenario: 'SB2', pass: false, error: err.message });
  } finally {
    await killDaemon(child);
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : String(reason));
});

const report = [];
await runSB2(report); // clean-start regression first
await runSB1(report); // then the split-brain trigger

console.log('\n=== SPLIT-BRAIN DYNAMIC REPORT ===');
for (const entry of report) console.log(JSON.stringify(entry));

const failed = report.filter((r) => r.pass === false);
if (failed.length > 0) {
  console.error(`\n[FAIL] ${failed.length} scenario(s) failed.`);
  process.exit(1);
}
console.log('\n[PASS] split-brain fail-fast + reconnect invariants hold.');
process.exit(0);
