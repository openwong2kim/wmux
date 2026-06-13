#!/usr/bin/env node
/**
 * X6 resume dynamic dogfood — supervised agent pane resumes on RECOVERY.
 *
 * Spawns the BUNDLED daemon (dist/daemon-bundle/index.js) in an isolated HOME,
 * creates a SUPERVISED exec unit whose command is `claude` (a recording shim on
 * PATH, NOT the real CLI — we are verifying the daemon's spawn rewrite, not the
 * Claude API; the spike already proved `claude --continue` resumes a real
 * conversation), then shuts the daemon down and respawns it so recoverSessions
 * replays the unit. The shim records its argv + cwd on every launch.
 *
 * PASS criteria (the headline "reboot survival of the conversation" path):
 *   L1  first launch (fresh createSession) runs `claude` with NO --continue
 *   L2  recovery replay runs `claude --continue` (X6 resume rewrite) ...
 *   L3  ... in the SAME cwd (resume is cwd-scoped; the rewrite is gated on it)
 *
 * Exercises the real recoverSessions suspended branch + resumeLaunchCommand +
 * the non-persisted execLaunchCommand channel in createSession. The supervisor
 * RESTART path shares the same helper and is covered by unit tests.
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

function readShimLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function main() {
  const tag = `x6-${randomUUID().slice(0, 8)}`;
  const testHome = path.join(os.tmpdir(), `wmux-${tag}`);
  const wmuxDir = path.join(testHome, '.wmux');
  const shimDir = path.join(testHome, 'shim');
  const projDir = path.join(testHome, 'proj');
  fs.mkdirSync(wmuxDir, { recursive: true });
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });

  // `claude` shim: record argv+cwd, then stay alive so the supervised unit is
  // "live" at shutdown (→ suspended → recovered). Invoked as `claude` by the
  // exec wrapper; resolved from PATH (shimDir prepended).
  const shimLog = path.join(testHome, 'shim.log');
  fs.writeFileSync(path.join(shimDir, 'claude-shim.mjs'),
    `import fs from 'node:fs';\n` +
    `fs.appendFileSync(process.env.X6_SHIM_LOG, JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd(), ts: Date.now()})+'\\n');\n` +
    `setInterval(() => {}, 1 << 30);\n`);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(shimDir, 'claude.cmd'), `@echo off\r\nnode "%~dp0claude-shim.mjs" %*\r\n`);
  } else {
    const sh = path.join(shimDir, 'claude');
    fs.writeFileSync(sh, `#!/bin/sh\nnode "$(dirname "$0")/claude-shim.mjs" "$@"\n`);
    fs.chmodSync(sh, 0o755);
  }

  const pipeName = makePipeName(tag);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);

  const childEnv = {
    ...process.env,
    PATH: shimDir + path.delimiter + (process.env.PATH ?? ''),
    Path: shimDir + path.delimiter + (process.env.Path ?? process.env.PATH ?? ''),
    X6_SHIM_LOG: shimLog,
  };

  const results = [];
  const sessionId = `x6sess`;

  // --- Daemon #1: create the supervised agent unit (FRESH launch) ---
  let d1 = spawnDaemon(testHome);
  d1.stderr.on('data', () => {});
  let resolved = await waitForPipeFile(wmuxDir);
  let sock = await connectSocket(resolved);
  await rpc(sock, 'daemon.createSession', {
    id: sessionId,
    cmd: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    cwd: projDir,
    env: childEnv,
    cols: 80, rows: 24,
    exec: { command: 'claude' },
    supervision: { restart: 'always', limit: { burst: 5, healthyUptimeSec: 300 } },
  }, authToken);
  await new Promise((r) => setTimeout(r, 2000)); // let the shim launch + record
  await rpc(sock, 'daemon.shutdown', {}, authToken, 10_000).catch(() => {});
  sock.destroy();
  await new Promise((r) => { d1.on('exit', r); setTimeout(r, 5000); });

  const afterFresh = readShimLog(shimLog);

  // --- Daemon #2: respawn → recoverSessions replays the unit (RESUME) ---
  let d2 = spawnDaemon(testHome);
  d2.stderr.on('data', () => {});
  resolved = await waitForPipeFile(wmuxDir);
  sock = await connectSocket(resolved);
  await new Promise((r) => setTimeout(r, 2500)); // let recovery replay + shim record
  await rpc(sock, 'daemon.shutdown', {}, authToken, 10_000).catch(() => {});
  sock.destroy();
  await new Promise((r) => { d2.on('exit', r); setTimeout(r, 5000); });

  const afterRecovery = readShimLog(shimLog);

  // --- Assertions ---
  const L1 = afterFresh.length >= 1 && !afterFresh[0].argv.includes('--continue');
  results.push(['L1 fresh launch has NO --continue', L1, JSON.stringify(afterFresh[0]?.argv ?? null)]);

  const recoveryLaunch = afterRecovery[afterFresh.length]; // the launch added by recovery
  const L2 = !!recoveryLaunch && recoveryLaunch.argv.includes('--continue');
  results.push(['L2 recovery replay runs claude --continue', L2, JSON.stringify(recoveryLaunch?.argv ?? null)]);

  // cwd preserved across recovery = the resume targets the same project as the
  // original launch (resume is cwd-scoped; this is what makes --continue resolve
  // the right session). Compare against the fresh launch's recorded cwd to avoid
  // realpath/case normalization noise.
  const L3 = !!recoveryLaunch && !!afterFresh[0] && recoveryLaunch.cwd === afterFresh[0].cwd;
  results.push(['L3 recovery resumes in the SAME cwd as fresh launch', L3,
    `fresh=${afterFresh[0]?.cwd} recovery=${recoveryLaunch?.cwd}`]);

  // cleanup
  try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log('\n=== X6 RESUME DOGFOOD ===');
  for (const [name, pass, detail] of results) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  [${detail}]`);
  }
  const allPass = results.every(([, p]) => p);
  console.log(`\n${allPass ? 'ALL PASS' : 'FAILURES PRESENT'}\n`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => { console.error('dogfood error:', err); process.exit(2); });
