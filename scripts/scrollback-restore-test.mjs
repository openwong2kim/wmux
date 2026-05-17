#!/usr/bin/env node
/**
 * Fix 0 — scrollback restore daemon-side contract regression guard.
 *
 * Validates the daemon-half of the scrollback restore feature end to end,
 * using the bundled daemon subprocess + RPC probe pattern from
 * scripts/v281-dynamic-test.mjs (reference_dynamic_test_pattern).
 *
 * The renderer-half (paneGate + reconcilePtys + clearAllPtyState) is
 * validated by manual dogfood — this script is the safety net for the
 * daemon side: if buffer dump path, recovery cap, or sessions.json schema
 * drifts, this test breaks immediately instead of silently regressing the
 * restore feature again (as v2.8.x-v2.9.0 did).
 *
 * Scenario:
 *   1. Spawn isolated daemon (TEST_HOME, custom pipe).
 *   2. Create a single session via daemon.createSession RPC.
 *   3. Wait briefly so the shell prompt populates the ring buffer.
 *   4. Graceful daemon.shutdown — should dump buffer to disk.
 *   5. Assert ~/.wmux/buffers/{sessionId}.buf exists and is non-empty.
 *   6. Restart daemon against the SAME test home (recovery).
 *   7. RPC daemon.listSessions — savedId must appear in the recovered set.
 *   8. Pass.
 *
 * Out of scope (would require SessionPipe auth/flow):
 *   - flush bytes >= N assertion. The recovered ring buffer is provably
 *     non-empty (step 5) and the renderer's Fix A path verifies flush
 *     bytes in production via the pty:flush-complete IPC. Wiring that
 *     pipe up here is a follow-up if drift is suspected.
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

// Isolated state directory + custom pipe — never collide with the
// user's real ~/.wmux/ daemon if one is running.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-scrollback-restore-'));
const TEST_WMUX = path.join(TEST_HOME, '.wmux');
fs.mkdirSync(TEST_WMUX, { recursive: true });

const PIPE_TAG = `scrollback-${randomUUID().slice(0, 8)}`;
const PIPE_NAME =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\wmux-test-${PIPE_TAG}`
    : path.join(TEST_HOME, `.wmux-test-${PIPE_TAG}.sock`);
const AUTH_TOKEN = randomUUID();

function writeConfig() {
  fs.writeFileSync(
    path.join(TEST_WMUX, 'config.json'),
    JSON.stringify(
      {
        version: 1,
        daemon: { pipeName: PIPE_NAME, logLevel: 'info', autoStart: true },
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
}

writeConfig();

function spawnDaemon(label) {
  const child = spawn(process.execPath, [DAEMON_BUNDLE], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      USERPROFILE: TEST_HOME,
      HOME: TEST_HOME,
      HOMEDRIVE: undefined,
      HOMEPATH: undefined,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${label}-err] ${d}`));
  return child;
}

async function waitForPipeFile(timeoutMs = 10_000) {
  const pipeFile = path.join(TEST_WMUX, 'daemon-pipe');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(pipeFile)) return fs.readFileSync(pipeFile, 'utf-8').trim();
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Daemon pipe file did not appear within timeout');
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
        } catch {
          /* ignore non-JSON */
        }
      }
    };
    socket.on('data', handler);
    const req = JSON.stringify({ id, method, params, token: AUTH_TOKEN }) + '\n';
    socket.write(req);
    setTimeout(() => {
      socket.removeListener('data', handler);
      reject(new Error(`rpc timeout: ${method}`));
    }, 8000);
  });
}

async function connectControlPipe() {
  const pipeName = await waitForPipeFile();
  return new Promise((resolve, reject) => {
    const s = net.createConnection(pipeName, () => resolve(s));
    s.on('error', reject);
  });
}

let exitCode = 1;
let daemonA = null;
let daemonB = null;

try {
  console.log(`[setup] TEST_HOME=${TEST_HOME}`);
  console.log(`[setup] PIPE=${PIPE_NAME}`);

  // ─── Phase 1: spawn daemon, create session, dump on shutdown ──────
  console.log('\n[phase 1] spawn daemon, create session, graceful shutdown');
  daemonA = spawnDaemon('daemonA');
  let socket = await connectControlPipe();
  console.log('[phase 1] connected to daemon control pipe');

  // daemon.createSession requires client-supplied id (see src/daemon/index.ts:501
  // schema check). Use `cmd` not `shell` — the param name is cmd matching
  // DaemonCreateSessionParams.
  const sessionId = `t${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await rpc(socket, 'daemon.createSession', {
    id: sessionId,
    cmd: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    cwd: TEST_HOME,
    cols: 120,
    rows: 30,
  });
  console.log(`[phase 1] created session id=${sessionId}`);

  // Let the shell spawn and produce its prompt. The default shell prints
  // a banner / prompt within a few hundred ms; we wait 1.5s for safety
  // so the ring buffer has SOMETHING worth dumping.
  await new Promise((r) => setTimeout(r, 1500));

  // Graceful shutdown — this is the path that dumps ring buffers to disk.
  await rpc(socket, 'daemon.shutdown').catch(() => {
    // shutdown closes the pipe before responding; the error is expected.
  });
  socket.end();

  // Wait for the daemon process to actually exit before checking buffers.
  await new Promise((resolve) => {
    if (daemonA.killed || daemonA.exitCode !== null) return resolve();
    daemonA.once('exit', resolve);
    setTimeout(resolve, 5_000); // hard stop
  });
  console.log('[phase 1] daemonA exited');
  daemonA = null;

  // ─── Phase 2: verify buffer dump on disk ──────────────────────────
  console.log('\n[phase 2] verify buffer dump');
  const buffersDir = path.join(TEST_WMUX, 'buffers');
  if (!fs.existsSync(buffersDir)) {
    throw new Error(`buffers dir missing: ${buffersDir}`);
  }
  const bufFiles = fs.readdirSync(buffersDir);
  console.log(`[phase 2] buffers dir contains: ${bufFiles.join(', ') || '(empty)'}`);
  const sessionBuf = bufFiles.find((f) => f.startsWith(sessionId));
  if (!sessionBuf) {
    throw new Error(`no buffer file for session ${sessionId}. Found: ${bufFiles.join(',')}`);
  }
  const bufPath = path.join(buffersDir, sessionBuf);
  const bufSize = fs.statSync(bufPath).size;
  console.log(`[phase 2] ${sessionBuf} size=${bufSize} bytes`);
  if (bufSize === 0) {
    throw new Error(`buffer dump exists but is empty (size=0) — daemon dump path broken`);
  }

  // ─── Phase 3: restart daemon, verify recovery ─────────────────────
  console.log('\n[phase 3] restart daemon, verify recovery');
  daemonB = spawnDaemon('daemonB');
  socket = await connectControlPipe();
  console.log('[phase 3] connected to daemonB control pipe');

  // Give the recovery loop a moment to finish.
  await new Promise((r) => setTimeout(r, 1500));

  const live = await rpc(socket, 'daemon.listSessions');
  console.log(`[phase 3] daemon.listSessions returned ${live.length} entries`);
  const recovered = live.find((s) => s.id === sessionId);
  if (!recovered) {
    throw new Error(`recovery failed: session ${sessionId} missing from listSessions. Live ids: ${live.map((s) => s.id).join(',')}`);
  }
  console.log(`[phase 3] recovered session id=${sessionId} state=${recovered.state}`);

  await rpc(socket, 'daemon.shutdown').catch(() => {});
  socket.end();

  console.log('\n[PASS] daemon-side scrollback restore contract holds');
  console.log('  - createSession populated a ring buffer');
  console.log('  - graceful shutdown dumped buffer to disk (>0 bytes)');
  console.log('  - restart recovered the session into listSessions');
  exitCode = 0;
} catch (err) {
  console.error('\n[FAIL] dynamic test threw:', err.message);
  exitCode = 1;
} finally {
  for (const d of [daemonA, daemonB]) {
    if (!d) continue;
    if (!d.killed && d.exitCode === null) d.kill('SIGTERM');
  }
  await new Promise((r) => setTimeout(r, 800));
  for (const d of [daemonA, daemonB]) {
    if (!d) continue;
    if (!d.killed && d.exitCode === null) d.kill('SIGKILL');
  }
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  console.log(`\n[exit] code=${exitCode}`);
  process.exit(exitCode);
}
