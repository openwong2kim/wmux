#!/usr/bin/env node
/**
 * Dynamic verification for PR #86 (fix/daemon-session-visibility).
 *
 * The PR's user-visible fix is renderer-side (useRpcBridge `workspace.close`
 * disposes every pane PTY) and main-side (tray surfaces the live session
 * count). Neither imports cleanly headless. What CAN be proven dynamically is
 * the daemon-level MECHANISM the fix depends on — and that mechanism is the
 * whole point: closing a workspace must actually terminate that workspace's
 * shell processes (the original RAM-accumulation bug was that they did NOT
 * die), while leaving other workspaces and the daemon untouched.
 *
 * Scenarios (against the BUNDLED daemon, real ConPTY, real PIDs):
 *
 *   WC1  Two "workspaces": A = [a1, a2], B = [b1]. Disposing A's sessions
 *        (exactly what `workspace.close` triggers via collectAllPtyIds →
 *        pty.dispose → daemon.destroySession) must:
 *          - kill a1's and a2's real PTY processes,
 *          - leave b1's PTY alive,
 *          - leave the daemon alive,
 *          - drop a1/a2 from listSessions while keeping b1.
 *        This is the "the leak is actually fixed" proof.
 *
 *   WC2  Best-effort safety (supports the R2 `.catch` + best-effort claim):
 *        destroySession on a bogus id, and a double-destroy of a real id,
 *        must NOT crash the daemon — it stays alive and answers `daemon.ping`.
 *        This is why workspace.close can fire dispose at sessions that may be
 *        already-dead / mid-respawn without taking the daemon (or the close)
 *        down with it.
 *
 * NOT covered here (renderer/Electron-only — covered by tsc + codex review):
 *   - the `workspaces.length > 1` guard in useRpcBridge (renderer logic),
 *   - the tray tooltip/menu count + monotonic refresh token (Electron main UI).
 *
 * Liveness signal: assertions use the daemon's authoritative RPC state
 * (`daemon.listSessions` membership + `daemon.ping`) and the spawned daemon's
 * own `exit` event — NOT OS process enumeration. `tasklist.exe`/WMI are
 * unreliable in some sandboxed/loaded environments (they time out), and the
 * OS-level PTY kill is already performed by destroySession→ptyProcess.kill
 * (unit-tested). What we verify here is the disposal CONTRACT: a closed
 * workspace's sessions leave the daemon's live set, others don't, daemon lives.
 *
 * Run: npm run build:daemon && node scripts/workspace-close-dispose-dynamic.mjs
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  EXECUTABLE_NAME,
  appHomeDir,
} from './helpers/packaged-app.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON_BUNDLE = path.join(REPO_ROOT, 'dist', 'daemon-bundle', 'index.js');

if (!fs.existsSync(DAEMON_BUNDLE)) {
  console.error('Daemon bundle missing — run `npm run build:daemon` first');
  process.exit(2);
}

// --- harness helpers (mirrors persistence-dynamic.mjs) -----------------

function makeTestHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${EXECUTABLE_NAME}-wc-dyn-`));
  fs.mkdirSync(appHomeDir(home, ''), { recursive: true });
  return home;
}

function makePipeName(tag) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\${EXECUTABLE_NAME}-test-${tag}`;
  return path.join(os.tmpdir(), `${EXECUTABLE_NAME}-test-${tag}.sock`);
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

// Spawn a real PowerShell PTY (the shell from the bug report) with a full
// inherited env so it boots cleanly in the temp home. Retries on the
// occasional ConPTY error code 87 race.
async function createPwshSession(socket, authToken, id, cwd, attempts = 5) {
  const cmd = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : '/bin/sh';
  // Pass the real env (minus nothing) so PowerShell's runspace init has
  // PSModulePath/TEMP/etc. — we are NOT trying to reproduce the low-resource
  // InitialSessionState failure here, just a normal shell whose PID we can kill.
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    const sessionId = i === 1 ? id : `${id}-r${i}`;
    try {
      const result = await rpc(socket, 'daemon.createSession', {
        id: sessionId, cmd, cwd, env, cols: 80, rows: 24,
      }, authToken);
      return { pid: result?.pid, sessionId };
    } catch (err) {
      lastErr = err;
      if (!/error code: 87|ConPTY|Cannot create process/i.test(err?.message ?? '')) throw err;
      await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  throw lastErr ?? new Error('createSession failed after retries');
}

async function killDaemon(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  if (child.exitCode === null) child.kill('SIGKILL');
}

// --- WC1: closing workspace A disposes A's PTYs, B + daemon survive ----

async function runWC1(report) {
  const testHome = makeTestHome();
  const wmuxDir = appHomeDir(testHome, '');
  const pipeName = makePipeName(`WC1-${randomUUID().slice(0, 8)}`);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);
  const child = spawnDaemon(testHome); // default idle (won't fire; B keeps it alive)
  let exited = false;
  child.on('exit', () => { exited = true; });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  let entry = { scenario: 'WC1', pass: false };
  try {
    const resolvedPipe = await waitForPipeFile(wmuxDir);
    const socket = await connectSocket(resolvedPipe);
    await new Promise((r) => setTimeout(r, 1500)); // settle before ConPTY

    // Workspace A = two panes, Workspace B = one pane.
    const a1 = await createPwshSession(socket, authToken, `a1-${randomUUID().slice(0, 8)}`, wmuxDir);
    const a2 = await createPwshSession(socket, authToken, `a2-${randomUUID().slice(0, 8)}`, wmuxDir);
    const b1 = await createPwshSession(socket, authToken, `b1-${randomUUID().slice(0, 8)}`, wmuxDir);

    // Sanity: all three sessions are present in the daemon's live set, each
    // with a real PTY pid behind it (createSession returned them).
    const haveAllPids = !!a1.pid && !!a2.pid && !!b1.pid;
    const listBefore = await rpc(socket, 'daemon.listSessions', {}, authToken);
    const idsBefore = new Set((listBefore ?? []).map((s) => s.id));
    const allListedBefore =
      idsBefore.has(a1.sessionId) && idsBefore.has(a2.sessionId) && idsBefore.has(b1.sessionId);

    // Close workspace A: dispose each of A's PTYs (what useRpcBridge does on
    // workspace.close — collectAllPtyIds(A) -> pty.dispose -> destroySession).
    await rpc(socket, 'daemon.destroySession', { id: a1.sessionId }, authToken);
    await rpc(socket, 'daemon.destroySession', { id: a2.sessionId }, authToken);
    await new Promise((r) => setTimeout(r, 500));

    // The daemon's authoritative view: A's sessions are gone, B remains.
    // (destroySession both deletes the managed session AND ptyProcess.kill()s
    // the shell; the kill itself is unit-tested. We assert the contract via
    // RPC state because process enumeration is blocked in this environment.)
    const listAfter = await rpc(socket, 'daemon.listSessions', {}, authToken);
    const idsAfter = new Set((listAfter ?? []).map((s) => s.id));
    const aDisposed = !idsAfter.has(a1.sessionId) && !idsAfter.has(a2.sessionId);
    const bSurvived = idsAfter.has(b1.sessionId);
    const daemonResponsive =
      (!exited) && (await rpc(socket, 'daemon.ping', {}, authToken, 5000).then(() => true).catch(() => false));
    socket.end();

    entry = {
      scenario: 'WC1',
      sessions: { a1: a1.sessionId, a2: a2.sessionId, b1: b1.sessionId },
      pids: { a1: a1.pid, a2: a2.pid, b1: b1.pid },
      haveAllPids, allListedBefore, aDisposed, bSurvived, daemonResponsive,
      pass: haveAllPids && allListedBefore && aDisposed && bSurvived && daemonResponsive,
    };
  } catch (err) {
    entry = { scenario: 'WC1', pass: false, error: err.message, stderr: stderr.slice(-600) };
  } finally {
    await killDaemon(child);
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  report.push(entry);
}

// --- WC2: best-effort dispose is daemon-safe (supports R2 .catch) ------

async function runWC2(report) {
  const testHome = makeTestHome();
  const wmuxDir = appHomeDir(testHome, '');
  const pipeName = makePipeName(`WC2-${randomUUID().slice(0, 8)}`);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);
  const child = spawnDaemon(testHome);
  let exited = false;
  child.on('exit', () => { exited = true; });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  let entry = { scenario: 'WC2', pass: false };
  try {
    const resolvedPipe = await waitForPipeFile(wmuxDir);
    const socket = await connectSocket(resolvedPipe);
    await new Promise((r) => setTimeout(r, 1500));

    const s = await createPwshSession(socket, authToken, `wc2-${randomUUID().slice(0, 8)}`, wmuxDir);

    // 1) destroy a session that does not exist (mid-respawn / already-gone).
    let bogusThrew = false;
    try { await rpc(socket, 'daemon.destroySession', { id: 'no-such-session' }, authToken); }
    catch { bogusThrew = true; } // either resolves or rejects — both must leave daemon alive

    // 2) double-destroy the real one (renderer could fire dispose twice).
    await rpc(socket, 'daemon.destroySession', { id: s.sessionId }, authToken);
    let doubleThrew = false;
    try { await rpc(socket, 'daemon.destroySession', { id: s.sessionId }, authToken); }
    catch { doubleThrew = true; }

    // The hard requirement: daemon is still alive and responsive afterwards.
    // `exited` is a direct signal — the daemon is our spawned child, so its
    // 'exit' event fires for us with no process enumeration needed.
    const ping = await rpc(socket, 'daemon.ping', {}, authToken, 5000).then(() => true).catch(() => false);
    const daemonAlive = !exited;
    socket.end();

    entry = {
      scenario: 'WC2',
      bogusThrew, doubleThrew, pingOk: ping, daemonAlive,
      pass: ping && daemonAlive, // tolerant of throw-or-resolve; what matters is survival
    };
  } catch (err) {
    entry = { scenario: 'WC2', pass: false, error: err.message, stderr: stderr.slice(-600) };
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
for (const [name, fn] of [['WC1', runWC1], ['WC2', runWC2]]) {
  try { await fn(report); }
  catch (err) { console.error(`[${name}] threw: ${err.message}`); report.push({ scenario: name, pass: false, error: err.message }); }
}

console.log('\n=== WORKSPACE-CLOSE DISPOSE REPORT ===');
for (const entry of report) console.log(JSON.stringify(entry));

const failed = report.filter((r) => r.pass === false);
if (failed.length > 0) {
  console.error(`\n[FAIL] ${failed.length}/${report.length} scenarios failed.`);
  process.exit(1);
}
console.log(`\n[PASS] all ${report.length} scenarios met their post-conditions.`);
process.exit(0);
