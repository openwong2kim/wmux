#!/usr/bin/env node
/**
 * X6 ② reboot-survival KILL-REAL dogfood — the test the seed-bypass missed.
 *
 * Unlike x6-pill-offer-isolated.mjs (which SEEDS lastDetectedAgent into
 * sessions.json, bypassing the detect->persist step), this drives the REAL path:
 *
 *   1. spawn the bundled daemon in an isolated HOME
 *   2. createSession an INTERACTIVE shell whose command is a shim that prints
 *      `claude-code` (matches the AgentDetector claude gate) then stays alive
 *   3. the daemon-side DaemonPTYBridge feeds PTY output to AgentDetector ->
 *      session:agent fires -> meta.lastDetectedAgent='claude' -> the handler
 *      persists it (saveImmediate after the fix; saveDebounced before)
 *   4. SIGKILL the daemon ~1s later — a REAL reboot, NOT a graceful shutdown,
 *      so no flush()/process.on('exit') runs. This is the 30s-debounce window.
 *   5. respawn the daemon -> recoverSessions reads persisted lastDetectedAgent
 *   6. assert daemon.listSessions reports resumeAgent='claude'
 *
 * With the fix (saveImmediate) the detection is on disk before the kill -> PASS.
 * Without it (saveDebounced) the detection sits in memory -> lost on SIGKILL ->
 * resumeAgent absent -> FAIL. Run it against both builds to see before/after.
 *
 * No state-changing RPC (attach/resize/etc.) happens between detection and the
 * kill, so nothing opportunistically flushes pendingState — this isolates the
 * debounce race exactly as a single idle agent pane hits it.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function spawnDaemon(testHome, sink) {
  const d = spawn(process.execPath, [DAEMON_BUNDLE], {
    cwd: REPO_ROOT,
    env: { ...process.env, USERPROFILE: testHome, HOME: testHome, HOMEDRIVE: undefined, HOMEPATH: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  d.stdout.on('data', (b) => sink && sink.push(b.toString()));
  d.stderr.on('data', (b) => sink && sink.push(b.toString()));
  return d;
}

async function waitForPipeFile(wmuxDir, timeoutMs = 12_000) {
  const pipeFile = path.join(wmuxDir, 'daemon-pipe');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(pipeFile)) return fs.readFileSync(pipeFile, 'utf-8').trim();
    await sleep(100);
  }
  throw new Error('daemon-pipe did not appear');
}

async function connectSocket(pipeName, retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const s = net.createConnection(pipeName, () => resolve(s));
        s.on('error', reject);
      });
    } catch (e) { if (i === retries - 1) throw e; await sleep(250); }
  }
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
          const m = JSON.parse(line);
          if (m.id === id) {
            socket.removeListener('data', handler);
            m.ok ? resolve(m.result) : reject(new Error(m.error ?? 'rpc error'));
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

function readSessions(wmuxDir) {
  const f = path.join(wmuxDir, 'sessions.json');
  if (!fs.existsSync(f)) return [];
  const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
  return Array.isArray(j) ? j : (j.sessions || []);
}

async function main() {
  if (!fs.existsSync(DAEMON_BUNDLE)) {
    console.log('FAIL — daemon bundle missing; run npm run build:daemon');
    process.exit(2);
  }
  const tag = `x6killreal-${randomUUID().slice(0, 6)}`;
  const testHome = path.join(os.tmpdir(), `wmux-${tag}`);
  const wmuxDir = path.join(testHome, '.wmux');
  const shimDir = path.join(testHome, 'shim');
  const projDir = path.join(testHome, 'proj');
  fs.mkdirSync(wmuxDir, { recursive: true });
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });

  // Shim shell: print the AgentDetector claude gate token ON FIRST RUN ONLY, then
  // stay alive so the session is a LIVE interactive agent pane at kill time. The
  // first-run guard (marker file) models a REAL reboot: the recovered pane is a
  // fresh shell that does NOT auto-relaunch claude, so the agent is NOT re-detected
  // live on recovery — otherwise line 1212 (recoveredAgentShellIds.delete on live
  // re-detect, the EC4 gate) would correctly drop the pill and mask the fix.
  const marker = path.join(testHome, 'shim-ran.marker');
  let shimCmd;
  if (process.platform === 'win32') {
    shimCmd = path.join(shimDir, 'agentshell.cmd');
    fs.writeFileSync(shimCmd,
      `@echo off\r\n` +
      `if exist "${marker}" goto loop\r\n` +
      `echo claude-code\r\n` +
      `type nul > "${marker}"\r\n` +
      `:loop\r\n` +
      `ping -n 3600 127.0.0.1 >nul\r\n` +
      `goto loop\r\n`);
  } else {
    shimCmd = path.join(shimDir, 'agentshell.sh');
    fs.writeFileSync(shimCmd,
      `#!/bin/sh\nif [ ! -f "${marker}" ]; then echo claude-code; : > "${marker}"; fi\nwhile true; do sleep 3600; done\n`);
    fs.chmodSync(shimCmd, 0o755);
  }

  const pipeName = makePipeName(tag);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);
  const childEnv = { ...process.env, USERPROFILE: testHome, HOME: testHome };
  const sessionId = 'x6killreal';
  const sink = [];

  // --- Daemon #1: interactive shell that emits the claude gate token ---
  const d1 = spawnDaemon(testHome, sink);
  let resolved = await waitForPipeFile(wmuxDir);
  let sock = await connectSocket(resolved);
  await rpc(sock, 'daemon.createSession', {
    id: sessionId, cmd: shimCmd, cwd: projDir, env: childEnv, cols: 80, rows: 24,
  }, authToken);

  // Let the shim print `claude-code` so DaemonPTYBridge's AgentDetector fires
  // session:agent and the handler persists lastDetectedAgent. NO attach/resize
  // in between, so only the agent-detection write can put it on disk.
  await sleep(2500);

  // Snapshot disk state at the instant a reboot would hit.
  const onDiskBeforeKill = readSessions(wmuxDir).find((s) => s.id === sessionId)?.lastDetectedAgent;

  // --- SIGKILL: a real reboot, not a graceful shutdown ---
  sock.destroy();
  d1.kill('SIGKILL');
  await new Promise((r) => { d1.on('exit', r); setTimeout(r, 6000); });
  await sleep(500);

  const persistedAfterKill = readSessions(wmuxDir).find((s) => s.id === sessionId)?.lastDetectedAgent;

  // A REAL OS reboot kills EVERY process, so the shell's pid is dead on the
  // other side. Here we only SIGKILL'd the daemon — the shim's child (the ping
  // loop) is orphaned but still alive, which would make daemon #2 RECONNECT
  // instead of RECOVER (recoveredIds would not include it -> no resume offer).
  // Mark the persisted pid dead to model the reboot precisely. We DO NOT touch
  // lastDetectedAgent — that is the value under test, written by the fix, and
  // confirmed present in `persistedAfterKill` above.
  try {
    const f = path.join(wmuxDir, 'sessions.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
    const arr = Array.isArray(j) ? j : (j.sessions || []);
    const t = arr.find((s) => s && s.id === sessionId);
    if (t) t.pid = 999999; // dead pid -> forces the recovery branch, not reconnect
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
  } catch { /* ignore */ }

  // The SIGKILL'd daemon leaves a stale daemon-pipe file; remove it so
  // waitForPipeFile picks up daemon #2's fresh pipe (a real reboot wipes it).
  try { fs.unlinkSync(path.join(wmuxDir, 'daemon-pipe')); } catch { /* ignore */ }

  // --- Daemon #2: cold recover, then read the resume offer ---
  const d2 = spawnDaemon(testHome, sink);
  resolved = await waitForPipeFile(wmuxDir);
  sock = await connectSocket(resolved);
  await sleep(3000); // recoverSessions
  const listed = await rpc(sock, 'daemon.listSessions', {}, authToken).catch((e) => ({ err: e.message }));
  const sessions = Array.isArray(listed) ? listed : (listed?.sessions || []);
  const got = sessions.find((s) => s && s.id === sessionId);
  await rpc(sock, 'daemon.shutdown', {}, authToken, 10_000).catch(() => {});
  sock.destroy();
  await new Promise((r) => { d2.on('exit', r); setTimeout(r, 5000); });

  // Best-effort cleanup of the orphaned shim child (ping loop) on Windows.
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/F', '/IM', 'PING.EXE', '/T'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }

  const resumeAgent = got?.resumeAgent;
  const pass = resumeAgent === 'claude';

  console.log('\n=== X6 ② KILL-REAL DOGFOOD (real detect -> SIGKILL -> recover) ===');
  console.log(`  lastDetectedAgent on disk BEFORE kill : ${onDiskBeforeKill ?? '<absent>'}`);
  console.log(`  lastDetectedAgent on disk AFTER  kill : ${persistedAfterKill ?? '<absent>'}`);
  console.log(`  recovered session found                : ${!!got}`);
  console.log(`  resumeAgent after recovery             : ${resumeAgent ?? '<absent>'}`);
  console.log(`\n  ${pass ? 'PASS' : 'FAIL'} — resume offer ${pass ? 'SURVIVED' : 'LOST'} the SIGKILL reboot`);
  if (!pass) {
    console.log('  (FAIL here = the detection never reached disk before the kill —');
    console.log('   the saveDebounced race. saveImmediate is required.)');
  }
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('ERROR', e); process.exit(2); });
