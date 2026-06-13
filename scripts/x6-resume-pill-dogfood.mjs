#!/usr/bin/env node
/**
 * X6 Feature ② resume-pill gate dynamic dogfood — daemon listSessions exposes
 * `resumeAgent` ONLY for an interactive agent pane RECOVERED this boot.
 *
 * Pre-seeds sessions.json with three sessions, respawns the real bundled daemon
 * (recovery runs), then queries daemon.listSessions and asserts the recovery-only
 * EC4 gate:
 *   P1  interactive non-exec session with lastDetectedAgent  → resumeAgent='claude'
 *   P2  interactive session WITHOUT lastDetectedAgent         → no resumeAgent
 *   P3  EXEC/supervised session with lastDetectedAgent        → no resumeAgent
 *       (it auto-resumes via Feature ①; a pill would double-resume)
 *
 * Validates the riskiest daemon-side logic (recoveredAgentShellIds population +
 * resumeOfferForRecovered exclusions + listSessions exposure). The renderer pill
 * itself is GUI and is left to visual dogfood.
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

async function main() {
  const tag = `x6pill-${randomUUID().slice(0, 8)}`;
  const testHome = path.join(os.tmpdir(), `wmux-${tag}`);
  const wmuxDir = path.join(testHome, '.wmux');
  const projDir = path.join(testHome, 'proj');
  fs.mkdirSync(wmuxDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });

  const pipeName = makePipeName(tag);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);
  const childEnv = { ...process.env, USERPROFILE: testHome, HOME: testHome };
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';

  // --- Daemon #1: create three real sessions (valid spawn env + shapes) ---
  let d1 = spawnDaemon(testHome);
  d1.stderr.on('data', () => {});
  let resolved = await waitForPipeFile(wmuxDir);
  let sock = await connectSocket(resolved);
  await rpc(sock, 'daemon.createSession', {
    id: 'p1-agent-shell', cmd: shell, cwd: projDir, env: childEnv, cols: 80, rows: 24,
  }, authToken); // interactive shell — will get lastDetectedAgent injected
  await rpc(sock, 'daemon.createSession', {
    id: 'p2-plain-shell', cmd: shell, cwd: projDir, env: childEnv, cols: 80, rows: 24,
  }, authToken); // interactive shell — stays agent-less
  await rpc(sock, 'daemon.createSession', {
    id: 'p3-exec-agent', cmd: shell, cwd: projDir, env: childEnv, cols: 80, rows: 24,
    exec: { command: 'claude' },
    supervision: { restart: 'always', limit: { burst: 5, healthyUptimeSec: 300 } },
  }, authToken); // supervised exec — excluded from the pill (auto-resumes via ①)
  await new Promise((r) => setTimeout(r, 800));
  await rpc(sock, 'daemon.shutdown', {}, authToken, 10_000).catch(() => {});
  sock.destroy();
  await new Promise((r) => { d1.on('exit', r); setTimeout(r, 5000); });

  // --- Inject lastDetectedAgent (simulates AgentDetector having fired before
  //     the reboot) into the persisted suspended sessions. ---
  const statePath = path.join(wmuxDir, 'sessions.json');
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  for (const s of persisted.sessions) {
    if (s.id === 'p1-agent-shell' || s.id === 'p3-exec-agent') s.lastDetectedAgent = 'claude';
  }
  fs.writeFileSync(statePath, JSON.stringify(persisted, null, 2));
  const seededStates = persisted.sessions.map((s) => `${s.id}:${s.state}`).join(',');

  // --- Daemon #2: respawn → recovery → query the gate ---
  let d2 = spawnDaemon(testHome);
  d2.stderr.on('data', () => {});
  resolved = await waitForPipeFile(wmuxDir);
  sock = await connectSocket(resolved);
  await new Promise((r) => setTimeout(r, 2500)); // let recovery run
  const sessions = await rpc(sock, 'daemon.listSessions', {}, authToken);
  await rpc(sock, 'daemon.shutdown', {}, authToken, 10_000).catch(() => {});
  sock.destroy();
  await new Promise((r) => { d2.on('exit', r); setTimeout(r, 5000); });
  console.log(`seeded states: ${seededStates}`);

  console.log('listSessions →', JSON.stringify(sessions.map((s) => ({ id: s.id, state: s.state, lastDetectedAgent: s.lastDetectedAgent, resumeAgent: s.resumeAgent })), null, 0));
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
  const results = [
    ['P1 interactive agent shell → resumeAgent=claude', byId['p1-agent-shell']?.resumeAgent === 'claude',
      `resumeAgent=${byId['p1-agent-shell']?.resumeAgent}`],
    ['P2 plain shell (no agent) → no resumeAgent', !byId['p2-plain-shell']?.resumeAgent,
      `resumeAgent=${byId['p2-plain-shell']?.resumeAgent ?? 'undefined'}`],
    ['P3 exec/supervised agent → no resumeAgent (auto-resumes via ①)', !byId['p3-exec-agent']?.resumeAgent,
      `resumeAgent=${byId['p3-exec-agent']?.resumeAgent ?? 'undefined'}`],
  ];

  try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log('\n=== X6 RESUME PILL GATE DOGFOOD ===');
  for (const [name, pass, detail] of results) console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  [${detail}]`);
  const allPass = results.every(([, p]) => p);
  console.log(`\n${allPass ? 'ALL PASS' : 'FAILURES PRESENT'}\n`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => { console.error('dogfood error:', err); process.exit(2); });
