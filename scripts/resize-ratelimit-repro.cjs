/**
 * Dynamic repro for the `pty:resize` rate-limit flood + uncaught-promise bug
 * and the `sendResize` fix (TODOS "pty:resize '[UNKNOWN] rate limited' flood").
 *
 * Forces the exact daemon condition behind the bug — a resize burst on a
 * single RPC socket exceeding DaemonPipeServer.PER_SOCKET_RATE_LIMIT (50/s) —
 * against the REAL bundled daemon, then proves both halves of the fix:
 *
 *   R1  Burst of 70 resizes on one socket → some come back "rate limited".
 *       (The trigger exists: a reconnect burst overruns the per-socket cap.)
 *
 *   R2  OLD renderer path — fire resizes with NO .catch (mimics
 *       `window.electronAPI.pty.resize(...)`). The rate-limited rejections
 *       float → Node emits `unhandledRejection`. This is the reported
 *       "Uncaught (in promise)" console spam.
 *
 *   R3  NEW `sendResize` path — same burst, but each call is `.catch`ed and a
 *       "rate limited" reject schedules ONE re-send of the live geometry after
 *       the 1.1 s window clears. Asserts: ZERO unhandledRejection AND the
 *       *target* geometry (137x42), which was rate-limited during the burst,
 *       self-heals onto the daemon session (verified via daemon.listSessions).
 *
 * Run with Electron's node ABI so the spawned daemon can load node-pty:
 *   $env:ELECTRON_RUN_AS_NODE=1; npx electron scripts/resize-ratelimit-repro.cjs
 */
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const DAEMON_BUNDLE = path.join(REPO_ROOT, 'dist', 'daemon-bundle', 'index.js');
// This script is CommonJS, so it cannot `require` helpers/packaged-app.mjs —
// it reads the same package.json field the helper does. `~/.<exe>` mirrors
// getWmuxHomeDir() in src/shared/constants.ts.
const EXECUTABLE_NAME =
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).executableName;
const appHomeDir = (home) => path.join(home, `.${EXECUTABLE_NAME}`);
const PER_SOCKET_LIMIT = 50; // DaemonPipeServer.PER_SOCKET_RATE_LIMIT
const BURST = 70;            // > limit so the tail of the burst is rate-limited
const TARGET = { cols: 137, rows: 42 }; // distinctive geometry for the self-heal

if (!fs.existsSync(DAEMON_BUNDLE)) {
  console.error('Daemon bundle missing — run `npm run build:daemon` first');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A permanent listener so the INTENTIONAL floats in R2 don't crash the
// process; a per-scenario counter is toggled via `countUnhandled`.
let unhandledCount = 0;
let counting = false;
process.on('unhandledRejection', () => { if (counting) unhandledCount++; });
process.on('uncaughtException', (err) => { console.error('[uncaughtException]', err.stack || err.message); });

function makeTestHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${EXECUTABLE_NAME}-resize-rl-`));
  fs.mkdirSync(appHomeDir(home), { recursive: true });
  return home;
}
function makePipeName(tag) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${EXECUTABLE_NAME}-test-${tag}`
    : path.join(os.tmpdir(), `${EXECUTABLE_NAME}-test-${tag}.sock`);
}
function writeConfig(wmuxDir, pipeName, authToken) {
  fs.writeFileSync(path.join(wmuxDir, 'config.json'), JSON.stringify({
    version: 1,
    daemon: { pipeName, logLevel: 'warn', autoStart: true },
    session: {
      defaultShell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      defaultCols: 80, defaultRows: 24, bufferSizeMb: 8, bufferMaxMb: 64,
      deadSessionTtlHours: 24, deadSessionDumpBuffer: true,
    },
  }, null, 2));
  fs.writeFileSync(path.join(wmuxDir, 'daemon-auth-token'), authToken, 'utf-8');
}
function spawnDaemon(testHome) {
  return spawn(process.execPath, [DAEMON_BUNDLE], {
    cwd: REPO_ROOT,
    env: { ...process.env, USERPROFILE: testHome, HOME: testHome, HOMEDRIVE: undefined, HOMEPATH: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function waitForPipeFile(wmuxDir, timeoutMs = 10_000) {
  const pipeFile = path.join(wmuxDir, 'daemon-pipe');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(pipeFile)) return fs.readFileSync(pipeFile, 'utf-8').trim();
    await sleep(100);
  }
  throw new Error('daemon-pipe did not appear within timeout');
}
function connectSocket(pipeName) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(pipeName, () => resolve(s));
    s.on('error', reject);
  });
}
function rpc(socket, method, params, authToken, timeoutMs = 15_000) {
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
async function createSessionWithRetry(socket, authToken, base, cwd, attempts = 6) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    const sessionId = i === 1 ? base : `${base}-r${i}`;
    try {
      await rpc(socket, 'daemon.createSession', {
        id: sessionId, cmd: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        cwd, env: {}, cols: 80, rows: 24,
      }, authToken);
      return sessionId;
    } catch (err) {
      lastErr = err;
      if (!/error code: 87|ConPTY|Cannot create process/i.test(err.message || '')) throw err;
      await sleep(800 * i);
    }
  }
  throw lastErr ?? new Error('createSession failed');
}
async function getSize(socket, sid, authToken) {
  const list = await rpc(socket, 'daemon.listSessions', {}, authToken);
  const s = Array.isArray(list) ? list.find((x) => x.id === sid) : null;
  return s ? { cols: s.cols, rows: s.rows } : null;
}

// The fix under test, reproduced faithfully from useTerminal.ts `sendResize`.
function sendResize(socket, sid, cols, rows, authToken) {
  rpc(socket, 'daemon.resizeSession', { id: sid, cols, rows }, authToken).catch((err) => {
    const msg = err && err.message ? err.message : String(err);
    if (!msg.includes('rate limited')) return; // not-found / other handled upstream
    setTimeout(() => {
      // "live geometry" — here the latest intended (cols, rows).
      rpc(socket, 'daemon.resizeSession', { id: sid, cols, rows }, authToken).catch(() => {});
    }, 1100);
  });
}

async function main() {
  const testHome = makeTestHome();
  const wmuxDir = appHomeDir(testHome);
  const tag = `resize-rl-${randomUUID().slice(0, 8)}`;
  const pipeName = makePipeName(tag);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);

  const child = spawnDaemon(testHome);
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const report = [];
  let socket;
  try {
    const resolvedPipe = await waitForPipeFile(wmuxDir);
    socket = await connectSocket(resolvedPipe);
    socket.setMaxListeners(0); // we fan out BURST concurrent rpc() data listeners
    await sleep(1500);
    const sid = await createSessionWithRetry(socket, authToken, `rl-${randomUUID().slice(0, 8)}`, wmuxDir);
    await sleep(1300); // fresh rate window before R1

    // ── R1: burst overruns the per-socket cap ─────────────────────────────
    const r1 = await Promise.allSettled(
      Array.from({ length: BURST }, (_, i) =>
        rpc(socket, 'daemon.resizeSession', { id: sid, cols: 80 + (i % 10), rows: 24 }, authToken)),
    );
    const ok = r1.filter((r) => r.status === 'fulfilled').length;
    const rl = r1.filter((r) => r.status === 'rejected' && /rate limited/.test(r.reason.message)).length;
    const other = r1.filter((r) => r.status === 'rejected' && !/rate limited/.test(r.reason.message)).length;
    report.push({ scenario: 'R1 burst→rate-limit', burst: BURST, ok, rateLimited: rl, other, pass: rl > 0 && ok > 0 });

    await sleep(1300); // reset window

    // ── R2: OLD path (no .catch) leaks unhandledRejection ─────────────────
    unhandledCount = 0; counting = true;
    for (let i = 0; i < BURST; i++) {
      // No await, no .catch — exactly like the pre-fix renderer call.
      rpc(socket, 'daemon.resizeSession', { id: sid, cols: 80 + (i % 10), rows: 24 }, authToken);
    }
    await sleep(700); // let the rejected promises surface as unhandledRejection
    counting = false;
    const r2Unhandled = unhandledCount;
    report.push({ scenario: 'R2 old-path uncaught', unhandledRejections: r2Unhandled, pass: r2Unhandled > 0 });

    await sleep(1300); // reset window

    // ── R3: NEW sendResize → no unhandled + target geometry self-heals ────
    // Baseline in a fresh window: pin the session to a known NON-target size.
    await rpc(socket, 'daemon.resizeSession', { id: sid, cols: 80, rows: 24 }, authToken);
    const baseline = await getSize(socket, sid, authToken); // expect 80x24, != TARGET
    await sleep(1300); // fresh window for the burst

    unhandledCount = 0; counting = true;
    for (let i = 0; i < BURST; i++) {
      // Put the distinctive TARGET geometry at the tail so it lands in the
      // rate-limited zone (after the first ~50 consume the window) — the
      // resize that gets DROPPED and must be recovered by the self-heal.
      const geo = i >= BURST - 5 ? TARGET : { cols: 80 + (i % 10), rows: 24 };
      sendResize(socket, sid, geo.cols, geo.rows, authToken);
    }
    // The ~20 rate-limited resizes each schedule a re-send at +1.1s (in the
    // NEXT, un-saturated window). Wait well past that AND past the rate
    // window so the verification listSessions runs clean.
    await sleep(2600);
    counting = false;
    const sizeAfterHeal = await getSize(socket, sid, authToken);
    const healed = !!sizeAfterHeal && sizeAfterHeal.cols === TARGET.cols && sizeAfterHeal.rows === TARGET.rows;
    const baselineWasNonTarget = !!baseline && !(baseline.cols === TARGET.cols && baseline.rows === TARGET.rows);
    report.push({
      scenario: 'R3 sendResize fix',
      unhandledRejections: unhandledCount,
      baseline, sizeAfterHeal, target: TARGET,
      baselineWasNonTarget, selfHealed: healed,
      pass: unhandledCount === 0 && healed && baselineWasNonTarget,
    });
  } catch (err) {
    if (stderr) console.error(`daemon stderr tail:\n${stderr.slice(-1500)}`);
    report.push({ scenario: 'SETUP', pass: false, error: err.message });
  } finally {
    try { if (socket) socket.end(); } catch { /* ignore */ }
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    await sleep(600);
    try { if (!child.killed) child.kill('SIGKILL'); } catch { /* ignore */ }
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n=== RESIZE RATE-LIMIT REPRO REPORT ===');
  for (const e of report) console.log(JSON.stringify(e));
  const failed = report.filter((r) => r.pass === false);
  if (failed.length) {
    console.error(`\n[FAIL] ${failed.length} scenario(s) failed.`);
    process.exit(1);
  }
  console.log('\n[PASS] R1 reproduces the rate-limit burst; R2 reproduces the uncaught-promise leak; R3 proves sendResize swallows it AND self-heals the dropped geometry.');
  process.exit(0);
}

main().catch((err) => { console.error('REPRO CRASHED:', err.stack || err.message); process.exit(1); });
