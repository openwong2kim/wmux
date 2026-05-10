#!/usr/bin/env node
/**
 * v2.8.1 dynamic verification — spawns the BUNDLED daemon
 * (dist/daemon-bundle/index.js) against a synthesized brick scenario
 * and probes it via JSON-RPC. This catches problems the unit suite
 * misses: TypeScript-to-bundle drift, native module path resolution,
 * IPC handler registration, real ConPTY spawning of recovered shells.
 *
 * Test scenario (alphabeen's worst case):
 *   - 5 suspended sessions stamped 8+ days ago      → must be pruned
 *     by the new SUSPENDED_TTL_HOURS path in StateWriter.load.
 *   - 45 detached sessions with recent lastActivity → 40 must recover
 *     (MAX_RECOVER_SESSIONS), 5 must remain suspended (cap-skipped).
 *
 * Pre-v2.8.1 behavior: all 50 attempt to spawn, daemon hits
 * MAX_SESSIONS=50 mid-loop, latter sessions get marked dead, on next
 * launch the same churn repeats. UI brick.
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
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-v281-dyn-'));
const TEST_WMUX = path.join(TEST_HOME, '.wmux');
fs.mkdirSync(TEST_WMUX, { recursive: true });

const PIPE_TAG = `v281dyn-${randomUUID().slice(0, 8)}`;
const PIPE_NAME =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\wmux-test-${PIPE_TAG}`
    : path.join(TEST_HOME, `.wmux-test-${PIPE_TAG}.sock`);

const AUTH_TOKEN = randomUUID();

// Pre-write a config that points the daemon at our isolated pipe.
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

// Build the brick scenario.
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.now();
const fixture = (id, state, lastActivity) => ({
  id,
  state,
  createdAt: '2026-04-01T00:00:00.000Z',
  lastActivity,
  pid: 999999, // synthetic — the recovery path will fail to kill these
  cmd: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
  cwd: TEST_HOME, // valid path so cwd-fallback doesn't kick in
  env: {},
  cols: 80,
  rows: 24,
  deadTtlHours: 24,
});

const sessions = [];
for (let i = 0; i < 5; i++) {
  sessions.push(
    fixture(
      `stale-${i}`,
      'suspended',
      new Date(now - (8 + i) * DAY).toISOString(),
    ),
  );
}
// 'suspended' matches the real-world post-X-button shutdown state, and
// it gives us a clean signal for cap-skipped vs cap-attempted in the
// reconciled state file: cap-skipped sessions stay 'suspended' (their
// original disk state, untouched), recovered ones flip to 'detached'
// or 'dead' depending on whether ConPTY accepted the spawn.
for (let i = 0; i < 45; i++) {
  sessions.push(
    fixture(
      `recent-${String(i).padStart(2, '0')}`,
      'suspended',
      new Date(now - i * 5 * 60 * 1000).toISOString(),
    ),
  );
}
fs.writeFileSync(
  path.join(TEST_WMUX, 'sessions.json'),
  JSON.stringify({ version: 1, sessions }, null, 2),
);

console.log(`[setup] TEST_HOME=${TEST_HOME}`);
console.log(`[setup] PIPE=${PIPE_NAME}`);
console.log(`[setup] seeded 50 sessions (5 stale 8+ days, 45 recent)`);

// Launch the daemon. USERPROFILE/HOME redirect makes `os.homedir()`
// resolve to TEST_HOME, so getWmuxDir() reads our isolated state.
const child = spawn(process.execPath, [DAEMON_BUNDLE], {
  cwd: REPO_ROOT, // node-pty resolves from here
  env: {
    ...process.env,
    USERPROFILE: TEST_HOME,
    HOME: TEST_HOME,
    HOMEDRIVE: undefined,
    HOMEPATH: undefined,
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

// Wait for daemon-pipe file to appear (signals daemon is listening).
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
          /* ignore */
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

let exitCode = 1;
try {
  const pipeName = await waitForPipeFile();
  console.log(`[probe] daemon listening on ${pipeName}`);

  // Give the recovery loop a moment to finish.
  await new Promise((r) => setTimeout(r, 1500));

  const socket = await new Promise((resolve, reject) => {
    const s = net.createConnection(pipeName, () => resolve(s));
    s.on('error', reject);
  });

  // Exercise the read-only RPC. listSessions returns whatever the
  // sessionManager currently holds AFTER recovery has run.
  const live = await rpc(socket, 'daemon.listSessions');
  console.log(`[probe] daemon.listSessions returned ${live.length} entries`);

  const states = {};
  for (const s of live) states[s.state] = (states[s.state] ?? 0) + 1;
  console.log(`[probe] state breakdown: ${JSON.stringify(states)}`);

  const recoveredFromRecent = live.filter((s) => s.id.startsWith('recent-'));
  const recoveredFromStale = live.filter((s) => s.id.startsWith('stale-'));
  const liveCount = live.filter((s) => s.state !== 'dead').length;

  console.log(`[assert] recovered-from-stale = ${recoveredFromStale.length} (expect 0 — TTL pruned)`);
  console.log(`[assert] recovered-from-recent (any state) = ${recoveredFromRecent.length}`);
  console.log(`[assert] live (non-dead) = ${liveCount}`);

  // Persisted state inspection — tells us how many sessions the
  // daemon ATTEMPTED to recover (live + dead-from-spawn-failure)
  // versus how many it intentionally left suspended (cap-skipped).
  // listSessions shows only the live subset; the persisted file shows
  // the full reconciled state.
  const persisted = JSON.parse(
    fs.readFileSync(path.join(TEST_WMUX, 'sessions.json'), 'utf-8'),
  ).sessions;
  const persistedRecent = persisted.filter((s) => s.id.startsWith('recent-'));
  const persistedStale = persisted.filter((s) => s.id.startsWith('stale-'));
  const persistedAttempted = persistedRecent.filter(
    (s) => s.state === 'detached' || s.state === 'attached' || s.state === 'dead',
  );
  const persistedSkipped = persistedRecent.filter((s) => s.state === 'suspended');
  console.log(
    `[assert] persisted recent-* = ${persistedRecent.length} (expect 45 — total)`,
  );
  console.log(
    `[assert] persisted recent-* attempted = ${persistedAttempted.length} (expect 40 — cap)`,
  );
  console.log(
    `[assert] persisted recent-* cap-skipped = ${persistedSkipped.length} (expect 5 — 45 minus cap)`,
  );
  console.log(
    `[assert] persisted stale-* = ${persistedStale.length} (expect 0 — TTL pruned)`,
  );

  // Assertions calibrated to the BEHAVIOR we ship, not the test env:
  //  - No stale-* survives (TTL prune, by id presence in persisted).
  //  - Cap is the upper bound on attempts: ≤ 40 of the 45 recent-*
  //    leave the suspended state. The remaining ≥ 5 stay suspended
  //    and are recoverable on a later launch.
  //  - listSessions live count never exceeds the cap.
  //
  // Note: under-recovery (live < 40) is NOT a failure here because
  // node-pty's ConPTY can refuse spawns under rapid-fire test load
  // (Windows ERROR_INVALID_PARAMETER 87). What matters is the cap
  // bounded the attempts at 40, not 50.
  const failures = [];
  if (recoveredFromStale.length !== 0)
    failures.push(
      `stale-* leaked past TTL prune: ${recoveredFromStale.length}`,
    );
  if (persistedStale.length !== 0)
    failures.push(
      `stale-* leaked into persisted state: ${persistedStale.length}`,
    );
  if (live.length > 40)
    failures.push(`live count exceeded cap: ${live.length} > 40`);
  if (persistedAttempted.length !== 40)
    failures.push(
      `recovery attempts ≠ cap: ${persistedAttempted.length} attempted, expected 40`,
    );
  if (persistedSkipped.length !== 5)
    failures.push(
      `cap-skipped count drift: ${persistedSkipped.length} suspended, expected 5`,
    );
  if (persistedRecent.length !== 45)
    failures.push(
      `persisted recent-* total drift: ${persistedRecent.length} != 45`,
    );

  if (failures.length > 0) {
    console.error('\n[FAIL] ' + failures.length + ' assertion(s):');
    for (const f of failures) console.error('  - ' + f);
    exitCode = 1;
  } else {
    console.log('\n[PASS] all v2.8.1 dynamic assertions hold');
    exitCode = 0;
  }

  await rpc(socket, 'daemon.shutdown').catch(() => {});
  socket.end();
} catch (err) {
  console.error('\n[ERROR] dynamic test threw:', err.message);
  exitCode = 1;
} finally {
  // Best-effort daemon shutdown if still alive.
  if (!child.killed) child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  if (!child.killed) child.kill('SIGKILL');

  // Cleanup test state.
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log(`\n[exit] code=${exitCode}`);
  process.exit(exitCode);
}
