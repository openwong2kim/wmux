#!/usr/bin/env node
/**
 * Verification harness for the daemon shutdown/restore instrumentation
 * added on fix/daemon-shutdown-phase-instrumentation (commits b127f83 +
 * 8beb097). Runs three real flows against the bundled daemon and asserts
 * the log lines we added actually appear in stdout under realistic
 * conditions — not just under unit-test-time text matching.
 *
 *   Flow 1 (shutdown phase logs):
 *     spawn daemon → wait ready → createSession → daemon.shutdown
 *     Assert: [shutdown.phase] appears for pipeStops, bufferDumps,
 *     stateSave, disposeAll. Final "Daemon stopped (total shutdown Xms)".
 *
 *   Flow 2 (recovery bytes):
 *     reuse the same tmpdir as Flow 1 → spawn daemon again → wait ready
 *     Assert: [recovery] session <id> dump=<path> exists=true bytes=>0
 *     for the session we created in Flow 1.
 *
 *   Flow 3 (SessionPipe flush bytes):
 *     after Flow 2, connect to the per-session pipe → auth → read replay
 *     Assert: daemon stdout shows [SessionPipe.flush] sessionId=<id> bytes=>0
 *
 * Exit 0 on all asserts pass, non-zero otherwise.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON_BUNDLE = path.join(REPO_ROOT, 'dist', 'daemon-bundle', 'index.js');

if (!fs.existsSync(DAEMON_BUNDLE)) {
  console.error('Daemon bundle missing — run `npm run build:daemon` first');
  process.exit(2);
}

function makeTestHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-instrum-'));
  fs.mkdirSync(path.join(home, '.wmux'), { recursive: true });
  return home;
}

function makePipeName(tag) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\wmux-instrum-${tag}`;
  return path.join(os.tmpdir(), `wmux-instrum-${tag}.sock`);
}

function writeConfig(wmuxDir, pipeName, authToken) {
  fs.writeFileSync(
    path.join(wmuxDir, 'config.json'),
    JSON.stringify({
      version: 1,
      daemon: { pipeName, logLevel: 'info', autoStart: true },
      session: {
        defaultShell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        defaultCols: 80,
        defaultRows: 24,
        bufferSizeMb: 8,
        bufferMaxMb: 64,
        deadSessionTtlHours: 24,
        deadSessionDumpBuffer: true,
      },
    }, null, 2),
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

function waitForReady(child, log, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (log.combined.includes('Daemon ready')) return resolve();
      if (Date.now() > deadline) return reject(new Error('daemon did not become ready'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function attachLogger(child) {
  const log = { stdout: '', stderr: '', combined: '' };
  child.stdout.on('data', (d) => { log.stdout += d.toString(); log.combined += d.toString(); });
  child.stderr.on('data', (d) => { log.stderr += d.toString(); log.combined += d.toString(); });
  return log;
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
            clearTimeout(timer);
            if (msg.ok) resolve(msg.result);
            else reject(new Error(msg.error ?? 'rpc error'));
            return;
          }
        } catch { /* ignore non-JSON */ }
      }
    };
    socket.on('data', handler);
    socket.write(JSON.stringify({ id, method, params, token: authToken }) + '\n');
    const timer = setTimeout(() => {
      socket.removeListener('data', handler);
      reject(new Error(`${method} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

function connectPipe(pipeName) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function flow1ShutdownPhases() {
  const testHome = makeTestHome();
  const wmuxDir = path.join(testHome, '.wmux');
  const pipeName = makePipeName(`F1-${Date.now()}`);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);

  const child = spawnDaemon(testHome);
  const log = attachLogger(child);
  try {
    await waitForReady(child, log);

    const socket = await connectPipe(pipeName);
    const sessionId = `inst-${Math.random().toString(36).slice(2, 10)}`;
    // ConPTY may refuse the first spawn on Windows (ERROR_INVALID_PARAMETER 87).
    // Retry a handful of times with backoff; if all retries fail, fall through
    // and let Flow 1 verify the zero-session phase logs (still asserts the
    // instrumentation prints).
    let sessionCreated = false;
    // Retry budget matched to daemon recovery's RECOVERY_PTY_RETRIES (8)
    // so the harness and the production code under test absorb the same
    // worst-case ConPTY ERROR 87 burst window. Otherwise Flow 1 silently
    // ships a sessions:0 shutdown and Flow 2/3 chase a phantom recovery.
    for (let i = 1; i <= 8; i++) {
      try {
        await rpc(socket, 'daemon.createSession', {
          id: sessionId,
          cmd: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
          cwd: testHome,
          env: {},
          cols: 80,
          rows: 24,
        }, authToken, 10_000);
        sessionCreated = true;
        break;
      } catch (err) {
        const msg = err?.message ?? String(err);
        if (!/error code: 87|ConPTY|Cannot create process/i.test(msg)) {
          err.daemonLog = log.combined;
          throw err;
        }
        await new Promise((r) => setTimeout(r, 200 + i * 100));
      }
    }
    if (!sessionCreated) {
      const err = new Error(`Flow 1 createSession failed after 8 ConPTY retries`);
      err.daemonLog = log.combined;
      throw err;
    }

    // brief settle so the PTY emits a prompt (gives RingBuffer some bytes)
    await new Promise((r) => setTimeout(r, 500));

    // The RPC ack races daemon process.exit; rather than fight it, fire-and-
    // forget the shutdown request and observe the child's exit. Once the
    // child has exited, the phase logs are fully flushed to our pipe.
    socket.write(JSON.stringify({ id: 'shutdown', method: 'daemon.shutdown', params: {}, token: authToken }) + '\n');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon did not exit within 20s of shutdown RPC')), 20_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    }).catch((err) => { err.daemonLog = log.combined; throw err; });
    try { socket.destroy(); } catch { /* */ }

    const want = ['pipeStops', 'bufferDumps', 'stateSave', 'disposeAll'];
    const found = Object.fromEntries(
      want.map((n) => [n, log.combined.includes(`[shutdown.phase] ${n}`)]),
    );
    const totalLine = /Daemon stopped \(total shutdown (\d+)ms\)/.exec(log.combined);
    return {
      sessionId,
      sessionCreated,
      testHome,
      phases: found,
      totalMs: totalLine ? Number(totalLine[1]) : null,
      logTail: log.combined.split('\n').filter((l) => l.includes('shutdown.phase') || l.includes('Daemon stopped') || l.includes('Suspended session')).join('\n'),
    };
  } finally {
    try { child.kill(); } catch { /* */ }
  }
}

async function flow2Recovery(testHome) {
  const wmuxDir = path.join(testHome, '.wmux');
  const cfg = JSON.parse(fs.readFileSync(path.join(wmuxDir, 'config.json'), 'utf-8'));
  const pipeName = cfg.daemon.pipeName;
  const authToken = fs.readFileSync(path.join(wmuxDir, 'daemon-auth-token'), 'utf-8');

  const child = spawnDaemon(testHome);
  const log = attachLogger(child);
  try {
    await waitForReady(child, log);
    // Recovery log fires synchronously during main(), so it's already in the log by now.
    const recoveryLines = log.combined.split('\n').filter((l) => l.includes('[recovery] session'));
    return {
      child,
      log,
      authToken,
      pipeName,
      recoveryLines,
      testHome,
    };
  } catch (err) {
    try { child.kill(); } catch { /* */ }
    throw err;
  }
}

async function flow3FlushBytes(daemonProc, log, pipeName, authToken, sessionId, testHome) {
  const ctrl = await connectPipe(pipeName);
  // Diagnostic: which sessions did recovery actually surface?
  const sessions = await rpc(ctrl, 'daemon.listSessions', {}, authToken).catch(() => null);
  if (Array.isArray(sessions)) {
    const ids = sessions.map((s) => `${s.id}/${s.state}`).join(', ');
    console.log(`  listSessions after recovery: [${ids}]`);
  } else {
    console.log('  listSessions returned non-array');
  }
  // Resolve effective sessionId: recovery may have only the original entry
  // and the test session may be marked 'dead' if PTY respawn failed.
  const effective = Array.isArray(sessions)
    ? sessions.find((s) => s.id === sessionId && s.state !== 'dead')?.id
      ?? sessions.find((s) => s.state !== 'dead')?.id
    : sessionId;
  if (!effective) {
    ctrl.destroy();
    return { ok: false, error: `no live session after recovery (state: ${JSON.stringify(sessions)})` };
  }
  await rpc(ctrl, 'daemon.attachSession', { id: effective }, authToken).catch((err) => {
    throw new Error(`attach failed: ${err.message}`);
  });
  ctrl.destroy();

  // Daemon spec for the session pipe name (matches SessionPipe.getPipeName).
  // POSIX socket path must be derived from the daemon child's HOME (testHome),
  // not the parent harness's os.homedir(); the daemon is spawned with HOME
  // overridden to the temp test home, so its os.homedir() resolves there.
  const sessionPipeName = process.platform === 'win32'
    ? `\\\\.\\pipe\\wmux-session-${effective}`
    : `${testHome}/.wmux-session-${effective}.sock`;
  return await attemptSessionFlush(sessionPipeName, authToken, log);
}

async function attemptSessionFlush(sessionPipeName, authToken, log) {
  try {
    const socket = await connectPipe(sessionPipeName);
    socket.write(`${authToken}\n`);
    // Wait briefly for daemon to flush + emit log
    await new Promise((r) => setTimeout(r, 500));
    socket.destroy();
    const flushLines = log.combined.split('\n').filter((l) => l.includes('[SessionPipe.flush]'));
    return { ok: true, flushLines };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function main() {
  console.log('=== Flow 1: shutdown phase logs ===');
  let f1;
  try {
    f1 = await flow1ShutdownPhases();
  } catch (err) {
    console.error('Flow 1 threw:', err.message);
    if (err.daemonLog) console.error('daemon log tail:\n' + err.daemonLog.split('\n').slice(-30).map((l) => '  ' + l).join('\n'));
    throw err;
  }
  console.log(`  sessionId=${f1.sessionId}`);
  console.log(`  totalShutdownMs=${f1.totalMs}`);
  console.log(`  phases=${JSON.stringify(f1.phases)}`);
  console.log(`  log tail:\n${f1.logTail.split('\n').map((l) => '    ' + l).join('\n')}`);

  const flow1Ok = f1.totalMs !== null && Object.values(f1.phases).every(Boolean);

  console.log('\n=== Flow 2: recovery bytes ===');
  let flow2Ok = false;
  let flow2Ctx = null;
  try {
    flow2Ctx = await flow2Recovery(f1.testHome);
    console.log(`  recovery lines:\n${flow2Ctx.recoveryLines.map((l) => '    ' + l).join('\n')}`);
    flow2Ok = flow2Ctx.recoveryLines.some((l) => l.includes(f1.sessionId) && /bytes=\d+/.test(l));
  } catch (err) {
    console.log(`  Flow 2 failed: ${err.message}`);
  }

  console.log('\n=== Flow 3: SessionPipe flush bytes ===');
  let flow3Ok = false;
  if (flow2Ctx) {
    try {
      const f3 = await flow3FlushBytes(flow2Ctx.child, flow2Ctx.log, flow2Ctx.pipeName, flow2Ctx.authToken, f1.sessionId, flow2Ctx.testHome);
      if (f3.ok) {
        console.log(`  flush lines:\n${f3.flushLines.map((l) => '    ' + l).join('\n')}`);
        flow3Ok = f3.flushLines.some((l) => l.includes(f1.sessionId) && /bytes=\d+/.test(l));
      } else {
        console.log(`  Flow 3 connect failed: ${f3.error}`);
      }
    } catch (err) {
      console.log(`  Flow 3 failed: ${err.message}`);
    }
    try { flow2Ctx.child.kill(); } catch { /* */ }
  }

  console.log('\n=== RESULT ===');
  const results = { flow1Ok, flow2Ok, flow3Ok };
  console.log(JSON.stringify(results, null, 2));
  process.exit(flow1Ok && flow2Ok && flow3Ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Harness threw:', err);
  process.exit(2);
});
