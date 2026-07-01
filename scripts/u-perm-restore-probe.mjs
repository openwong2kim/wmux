#!/usr/bin/env node
/**
 * U-PERM dynamic probe — consent-gated unattended permission-mode restore on
 * RECOVERY, end-to-end through the REAL bundled daemon.
 *
 * This is the check jsdom/unit tests structurally cannot do: it drives the full
 * create-RPC -> persist(sessions.json) -> reboot(respawn) -> recoverSessions ->
 * resumeLaunchCommand -> spawn chain, catching any runtime field-drop of
 * `supervision.restorePermissionMode` that tsc can't see (the field is optional
 * on every hop, so a field-by-field copy silently omits it). Three such drops
 * existed and were fixed (pty.handler resolveSupervisionPolicy, daemon RPC
 * createSession handler, DaemonSessionManager meta copy).
 *
 * Two supervised `claude` units (a recording shim, NOT the real CLI) recover:
 *   POS: supervision.restorePermissionMode = true  + a bypassPermissions binding
 *   NEG: supervision.restorePermissionMode = false + a bypassPermissions binding
 *
 * PASS criteria:
 *   P1  POS recovery replay = `claude --resume <id> --dangerously-skip-permissions`
 *   P2  NEG recovery replay = `claude --resume <id>` with NO bypass flag (gate off)
 *   P3  daemon logs "permission-mode restore ON" exactly once (the POS unit)
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

function spawnDaemon(testHome, stderrChunks) {
  const d = spawn(process.execPath, [DAEMON_BUNDLE], {
    cwd: REPO_ROOT,
    env: { ...process.env, USERPROFILE: testHome, HOME: testHome, HOMEDRIVE: undefined, HOMEPATH: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  d.stdout.on('data', (c) => stderrChunks && stderrChunks.push(c.toString()));
  d.stderr.on('data', (c) => stderrChunks && stderrChunks.push(c.toString()));
  return d;
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
  if (!fs.existsSync(DAEMON_BUNDLE)) {
    console.error(`Daemon bundle missing: ${DAEMON_BUNDLE}\nRun: npm run build:daemon`);
    process.exit(2);
  }

  const tag = `uperm-${randomUUID().slice(0, 8)}`;
  const testHome = path.join(os.tmpdir(), `wmux-${tag}`);
  const wmuxDir = path.join(testHome, '.wmux');
  const shimDir = path.join(testHome, 'shim');
  const projPos = path.join(testHome, 'proj-pos');
  const projNeg = path.join(testHome, 'proj-neg');
  for (const d of [wmuxDir, shimDir, projPos, projNeg]) fs.mkdirSync(d, { recursive: true });

  // `claude` shim: record argv+cwd, then stay alive so the unit is LIVE at
  // shutdown (-> suspended -> recovered).
  const shimLog = path.join(testHome, 'shim.log');
  fs.writeFileSync(path.join(shimDir, 'claude-shim.mjs'),
    `import fs from 'node:fs';\n` +
    `fs.appendFileSync(process.env.UPERM_SHIM_LOG, JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd(), ts: Date.now()})+'\\n');\n` +
    `setInterval(() => {}, 1 << 30);\n`);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(shimDir, 'claude.cmd'), `@echo off\r\nnode "%~dp0claude-shim.mjs" %*\r\n`);
  } else {
    const sh = path.join(shimDir, 'claude');
    fs.writeFileSync(sh, `#!/bin/sh\nnode "$(dirname "$0")/claude-shim.mjs" "$@"\n`);
    fs.chmodSync(sh, 0o755);
  }

  // Real transcript files so bindingTranscriptLives (D5 existence probe) passes
  // and the EXACT-session --resume path fires (that's the branch that appends
  // the permission flag).
  const transcriptPos = path.join(testHome, 'conv-pos.jsonl');
  const transcriptNeg = path.join(testHome, 'conv-neg.jsonl');
  fs.writeFileSync(transcriptPos, '{"type":"user"}\n');
  fs.writeFileSync(transcriptNeg, '{"type":"user"}\n');

  const pipeName = makePipeName(tag);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);

  const childEnv = {
    ...process.env,
    PATH: shimDir + path.delimiter + (process.env.PATH ?? ''),
    Path: shimDir + path.delimiter + (process.env.Path ?? process.env.PATH ?? ''),
    UPERM_SHIM_LOG: shimLog,
  };
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const limit = { burst: 5, healthyUptimeSec: 300 };

  // --- Daemon #1: create both supervised units + their resume bindings ---
  const d1 = spawnDaemon(testHome, null);
  let resolved = await waitForPipeFile(wmuxDir);
  let sock = await connectSocket(resolved);

  await rpc(sock, 'daemon.createSession', {
    id: 'sess-pos', cmd: shell, cwd: projPos, env: childEnv, cols: 80, rows: 24,
    exec: { command: 'claude' },
    supervision: { restart: 'on-failure', limit, restorePermissionMode: true },
  }, authToken);
  await rpc(sock, 'daemon.setResumeBinding', {
    id: 'sess-pos',
    resumeBinding: { agent: 'claude', sessionId: 'conv-pos', cwd: projPos, permissionMode: 'bypassPermissions', transcriptPath: transcriptPos, ts: Date.now() },
  }, authToken);

  await rpc(sock, 'daemon.createSession', {
    id: 'sess-neg', cmd: shell, cwd: projNeg, env: childEnv, cols: 80, rows: 24,
    exec: { command: 'claude' },
    supervision: { restart: 'on-failure', limit, restorePermissionMode: false },
  }, authToken);
  await rpc(sock, 'daemon.setResumeBinding', {
    id: 'sess-neg',
    resumeBinding: { agent: 'claude', sessionId: 'conv-neg', cwd: projNeg, permissionMode: 'bypassPermissions', transcriptPath: transcriptNeg, ts: Date.now() },
  }, authToken);

  await new Promise((r) => setTimeout(r, 2000)); // fresh launches record
  await rpc(sock, 'daemon.shutdown', {}, authToken, 10_000).catch(() => {});
  sock.destroy();
  await new Promise((r) => { d1.on('exit', r); setTimeout(r, 5000); });

  const afterFresh = readShimLog(shimLog);

  // --- Daemon #2: respawn -> recoverSessions replays both units ---
  const d2Log = [];
  const d2 = spawnDaemon(testHome, d2Log);
  resolved = await waitForPipeFile(wmuxDir);
  sock = await connectSocket(resolved);
  await new Promise((r) => setTimeout(r, 3000)); // recovery replays + shims record
  await rpc(sock, 'daemon.shutdown', {}, authToken, 10_000).catch(() => {});
  sock.destroy();
  await new Promise((r) => { d2.on('exit', r); setTimeout(r, 5000); });

  const afterRecovery = readShimLog(shimLog);
  const recoveryLaunches = afterRecovery.slice(afterFresh.length);
  const daemonLog = d2Log.join('');

  const posLaunch = recoveryLaunches.find((e) => e.argv.includes('conv-pos'));
  const negLaunch = recoveryLaunches.find((e) => e.argv.includes('conv-neg'));

  const results = [];
  const P1 = !!posLaunch
    && posLaunch.argv.includes('--resume')
    && posLaunch.argv.includes('conv-pos')
    && posLaunch.argv.includes('--dangerously-skip-permissions');
  results.push(['P1 POS (consent ON) recovery = --resume <id> --dangerously-skip-permissions', P1, JSON.stringify(posLaunch?.argv ?? null)]);

  const P2 = !!negLaunch
    && negLaunch.argv.includes('--resume')
    && negLaunch.argv.includes('conv-neg')
    && !negLaunch.argv.includes('--dangerously-skip-permissions');
  results.push(['P2 NEG (consent OFF) recovery = --resume <id> with NO bypass flag', P2, JSON.stringify(negLaunch?.argv ?? null)]);

  const restoreOnCount = (daemonLog.match(/permission-mode restore ON/g) ?? []).length;
  const P3 = restoreOnCount === 1;
  results.push(['P3 daemon logged "restore ON" exactly once (POS only)', P3, `count=${restoreOnCount}`]);

  try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log('\n=== U-PERM PERMISSION-RESTORE PROBE ===');
  for (const [name, pass, detail] of results) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}\n        [${detail}]`);
  }
  const allPass = results.every(([, p]) => p);
  console.log(`\n${allPass ? 'ALL PASS' : 'FAILURES PRESENT'}\n`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => { console.error('probe error:', err); process.exit(2); });
