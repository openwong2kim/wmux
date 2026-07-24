#!/usr/bin/env node
/**
 * D1 dynamic verification — OSC 9/777/99 notification parser core.
 *
 * Spawns the BUNDLED daemon (dist/daemon-bundle/index.js) in an isolated
 * home, creates a real PowerShell session, types commands that make the
 * shell emit OSC 9 / OSC 777 / OSC 99 escape sequences through the real
 * ConPTY data path, and asserts that the daemon broadcasts matching
 * `notification.event` DaemonEvents on the control pipe. Also asserts the
 * negative case: ConEmu OSC 9 progress subcommands must NOT fire.
 *
 * This exercises what the unit suite can't: OscParser → TerminalNotification-
 * Parser → DaemonPTYBridge emit → DaemonSessionManager re-emit →
 * daemon/index broadcast, end to end over real PTY bytes (chunk boundaries
 * included).
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  EXECUTABLE_NAME,
  appHomeDir,
  sessionPipeName as appSessionPipeName,
} from './helpers/packaged-app.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DAEMON_BUNDLE = path.join(REPO_ROOT, 'dist', 'daemon-bundle', 'index.js');

if (!fs.existsSync(DAEMON_BUNDLE)) {
  console.error('Daemon bundle missing — run `npm run build:daemon` first');
  process.exit(2);
}

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), `${EXECUTABLE_NAME}-d1-osc-`));
const TEST_WMUX = appHomeDir(TEST_HOME, '');
fs.mkdirSync(TEST_WMUX, { recursive: true });

const PIPE_TAG = `d1osc-${randomUUID().slice(0, 8)}`;
const PIPE_NAME =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\${EXECUTABLE_NAME}-test-${PIPE_TAG}`
    : path.join(TEST_HOME, `.${EXECUTABLE_NAME}-test-${PIPE_TAG}.sock`);
const AUTH_TOKEN = randomUUID();

fs.writeFileSync(
  path.join(TEST_WMUX, 'config.json'),
  JSON.stringify({
    version: 1,
    daemon: { pipeName: PIPE_NAME, logLevel: 'info', autoStart: true },
    session: {
      defaultShell: 'powershell.exe',
      defaultCols: 120,
      defaultRows: 30,
      bufferSizeMb: 8,
      bufferMaxMb: 64,
      deadSessionTtlHours: 24,
      deadSessionDumpBuffer: false,
    },
  }, null, 2),
);
fs.writeFileSync(path.join(TEST_WMUX, 'daemon-auth-token'), AUTH_TOKEN, 'utf-8');
fs.writeFileSync(path.join(TEST_WMUX, 'sessions.json'), JSON.stringify({ version: 1, sessions: [] }));

console.log(`[setup] TEST_HOME=${TEST_HOME}`);

const child = spawn(process.execPath, [DAEMON_BUNDLE], {
  cwd: REPO_ROOT,
  env: { ...process.env, USERPROFILE: TEST_HOME, HOME: TEST_HOME, HOMEDRIVE: undefined, HOMEPATH: undefined },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => process.stdout.write(`[daemon] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[daemon-err] ${d}`));

async function waitForPipeFile(timeoutMs = 10_000) {
  const pipeFile = path.join(TEST_WMUX, 'daemon-pipe');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(pipeFile)) return fs.readFileSync(pipeFile, 'utf-8').trim();
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Daemon pipe file did not appear within timeout');
}

// Collected notification.event broadcasts, in arrival order.
const notifications = [];

function rpc(socket, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `req-${Math.random().toString(36).slice(2, 10)}`;
    const handler = (msg) => {
      if (msg.id !== id) return false;
      if (msg.ok) resolve(msg.result);
      else reject(new Error(msg.error ?? 'rpc error'));
      return true;
    };
    pendingRpc.push(handler);
    socket.write(JSON.stringify({ id, method, params, token: AUTH_TOKEN }) + '\n');
    setTimeout(() => {
      const idx = pendingRpc.indexOf(handler);
      if (idx !== -1) {
        pendingRpc.splice(idx, 1);
        reject(new Error(`rpc timeout: ${method}`));
      }
    }, 8000);
  });
}
const pendingRpc = [];

let exitCode = 1;
try {
  const pipeName = await waitForPipeFile();
  console.log(`[probe] daemon listening on ${pipeName}`);

  const control = await new Promise((resolve, reject) => {
    const s = net.createConnection(pipeName, () => resolve(s));
    s.on('error', reject);
  });

  // Single line-parser for both RPC responses and broadcast DaemonEvents.
  let buf = '';
  control.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'notification.event') {
        console.log(`[event] notification.event ←`, JSON.stringify(msg.data));
        notifications.push(msg);
        continue;
      }
      for (let i = 0; i < pendingRpc.length; i++) {
        if (pendingRpc[i](msg)) { pendingRpc.splice(i, 1); break; }
      }
    }
  });

  const SESSION_ID = 'd1-osc-test';
  await rpc(control, 'daemon.createSession', {
    id: SESSION_ID,
    cmd: 'powershell.exe',
    cwd: TEST_HOME,
    cols: 120,
    rows: 30,
  });
  console.log('[probe] session created');

  await rpc(control, 'daemon.attachSession', { id: SESSION_ID });
  const sessionPipeName = appSessionPipeName(SESSION_ID, os.tmpdir());

  const sessionSock = await new Promise((resolve, reject) => {
    const s = net.createConnection(sessionPipeName, () => resolve(s));
    s.on('error', reject);
  });
  sessionSock.write(AUTH_TOKEN + '\n');
  sessionSock.on('data', () => {}); // drain PTY echo
  console.log('[probe] session pipe attached');

  // Let PowerShell finish booting before typing.
  await new Promise((r) => setTimeout(r, 4000));

  const type = (cmd) => new Promise((r) => { sessionSock.write(cmd + '\r'); setTimeout(r, 1200); });
  const esc = '$([char]27)';
  const bel = '$([char]7)';

  // 1. OSC 9 — plain notification
  await type(`[console]::Write("${esc}]9;DYN-OSC9-HELLO${bel}")`);
  // 2. OSC 9 ConEmu progress — must NOT produce a notification
  await type(`[console]::Write("${esc}]9;4;1;50${bel}")`);
  // 3. OSC 777 notify with title+body
  await type(`[console]::Write("${esc}]777;notify;DYN-TITLE;DYN-BODY-777${bel}")`);
  // 4. OSC 777 unknown subcommand — must NOT fire
  await type(`[console]::Write("${esc}]777;other;X;Y${bel}")`);
  // 5. OSC 99 kitty, chunked title (d=0) then body (d=1), across two writes
  await type(`[console]::Write("${esc}]99;i=k1:d=0:p=title;DYN-K${bel}")`);
  await type(`[console]::Write("${esc}]99;i=k1:d=1:p=body;DYN-KITTY-BODY${bel}")`);

  await new Promise((r) => setTimeout(r, 1500));

  // === Assertions ===
  const bodies = notifications.map((n) => `${n.data.source}|${n.data.title ?? ''}|${n.data.body}`);
  console.log('\n[assert] received:', JSON.stringify(bodies, null, 2));

  const checks = [
    ['OSC 9 plain fired', bodies.some((b) => b === 'osc9||DYN-OSC9-HELLO')],
    ['ConEmu progress suppressed', !bodies.some((b) => b.includes('4;1;50'))],
    ['OSC 777 notify fired with title', bodies.some((b) => b === 'osc777|DYN-TITLE|DYN-BODY-777')],
    ['OSC 777 unknown subcommand suppressed', !bodies.some((b) => b === 'osc777|X|Y')],
    ['OSC 99 chunked assembly fired', bodies.some((b) => b === 'osc99|DYN-K|DYN-KITTY-BODY')],
    ['all sessionIds correct', notifications.every((n) => n.sessionId === SESSION_ID)],
    ['ts stamped', notifications.every((n) => typeof n.data.ts === 'number')],
  ];

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`[assert] ${ok ? 'PASS' : 'FAIL'} — ${name}`);
    if (!ok) failed++;
  }
  exitCode = failed === 0 ? 0 : 1;
  console.log(failed === 0 ? '\n=== D1 OSC notification dynamic: ALL PASS ===' : `\n=== ${failed} FAILED ===`);

  sessionSock.destroy();
  await rpc(control, 'daemon.shutdown', {}).catch(() => {});
  control.destroy();
} catch (err) {
  console.error('[fatal]', err);
} finally {
  child.kill();
  setTimeout(() => {
    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(exitCode);
  }, 500);
}
