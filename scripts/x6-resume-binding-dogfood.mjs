#!/usr/bin/env node
/**
 * X6 ③ resume-by-id — daemon KILL-REAL dogfood (the deterministic half).
 *
 * Drives the REAL bundled daemon through the resume-binding capture → persist →
 * SIGKILL(reboot) → recover path, exercising the parts print-mode can't and the
 * two codex review fixes. Five cases, each in an isolated HOME:
 *
 *   A. CAPTURE+SURVIVE — createSession (shim prints `claude-code` →
 *      lastDetectedAgent), daemon.setResumeBinding(bypass + a real transcript),
 *      SIGKILL, recover → listSessions reports resumeAgent='claude' AND
 *      resumeBinding with the right sessionId/permissionMode/cwd/transcriptPath.
 *   B. 2ND-REBOOT DURABILITY (codex P2 #3) — after A's recovery, SIGKILL the
 *      recovered daemon AGAIN with NO fresh hook, recover once more → the binding
 *      MUST still be present (carry-forward into recovered meta before the
 *      recovery save; without the fix it's dropped on the first recovery save).
 *   C. STICKY permissionMode (codex P2 #1) — setResumeBinding(bypass) then
 *      setResumeBinding(NO mode, the 64KB-tail-miss case) → on-disk meta MUST
 *      still be bypass (a null capture must not wipe a known mode).
 *   D. EXISTENCE-PROBE (D5) — binding with a transcript that is DELETED before
 *      recovery → resumeBinding MUST NOT be surfaced (dead id ⇒ fall back).
 *   E. CWD-GUARD (F7) — binding.cwd ≠ session.cwd → resumeBinding MUST NOT be
 *      surfaced.
 *
 * PASS on all = the daemon half of the resume-by-id dogfood gate holds on the
 * real bundle. The bridge envelope is covered by verify-bridge-resume-capture.mjs;
 * the GUI pill render is the CDP layer.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  EXECUTABLE_NAME,
  appHomeDir,
} from './helpers/packaged-app.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON_BUNDLE = path.join(REPO_ROOT, 'dist', 'daemon-bundle', 'index.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function markPidDeadAndClearPipe(wmuxDir, sessionId) {
  // A real reboot kills every process; here we only SIGKILL'd the daemon, so the
  // orphaned shim child stays alive and the next daemon would RECONNECT, not
  // RECOVER. Force the recovery branch by marking the pid dead, and remove the
  // stale daemon-pipe so the next daemon's fresh pipe is picked up.
  try {
    const f = path.join(wmuxDir, 'sessions.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
    const arr = Array.isArray(j) ? j : (j.sessions || []);
    const t = arr.find((s) => s && s.id === sessionId);
    if (t) t.pid = 999999;
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
  } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(wmuxDir, 'daemon-pipe')); } catch { /* ignore */ }
}

function writeShim(shimDir, marker) {
  let shimCmd;
  if (process.platform === 'win32') {
    shimCmd = path.join(shimDir, 'agentshell.cmd');
    fs.writeFileSync(shimCmd,
      `@echo off\r\nif exist "${marker}" goto loop\r\necho claude-code\r\ntype nul > "${marker}"\r\n:loop\r\nping -n 3600 127.0.0.1 >nul\r\ngoto loop\r\n`);
  } else {
    shimCmd = path.join(shimDir, 'agentshell.sh');
    fs.writeFileSync(shimCmd,
      `#!/bin/sh\nif [ ! -f "${marker}" ]; then echo claude-code; : > "${marker}"; fi\nwhile true; do sleep 3600; done\n`);
    fs.chmodSync(shimCmd, 0o755);
  }
  return shimCmd;
}

// Wait for a child to actually exit; on timeout force-SIGKILL so we never proceed
// with an orphan daemon still holding the pipe (which would make later cases
// nondeterministic — CodeRabbit). A short grace after the kill avoids hanging if
// the 'exit' event is missed.
async function waitForExitOrKill(proc, timeoutMs = 6000) {
  if (proc.exitCode !== null) return;
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    const hard = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already dead */ } setTimeout(done, 1500); }, timeoutMs);
    proc.once('exit', () => { clearTimeout(hard); done(); });
  });
}

async function killDaemon(d) {
  d.kill('SIGKILL');
  await waitForExitOrKill(d, 6000);
  await sleep(400);
}

let testHomes = [];
function makeHome(tag) {
  const testHome = path.join(os.tmpdir(), `${EXECUTABLE_NAME}-${tag}`);
  const wmuxDir = appHomeDir(testHome, '');
  const shimDir = path.join(testHome, 'shim');
  const projDir = path.join(testHome, 'proj');
  const tx = path.join(testHome, 'transcripts');
  for (const d of [wmuxDir, shimDir, projDir, tx]) fs.mkdirSync(d, { recursive: true });
  testHomes.push(testHome);
  return { testHome, wmuxDir, shimDir, projDir, tx };
}

const results = [];
const record = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`  ${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? `  (${detail})` : ''}`); };

async function setup(tag, { bindingCwd, transcriptName = 'origin-abc.jsonl', mode = 'bypassPermissions', createTranscript = true } = {}) {
  const h = makeHome(tag);
  const marker = path.join(h.testHome, 'shim-ran.marker');
  const shimCmd = writeShim(h.shimDir, marker);
  const pipeName = makePipeName(tag);
  const authToken = randomUUID();
  writeConfig(h.wmuxDir, pipeName, authToken);
  const sessionId = `x6bind-${tag}`;
  const childEnv = { ...process.env, USERPROFILE: h.testHome, HOME: h.testHome };
  const transcriptPath = path.join(h.tx, transcriptName);
  if (createTranscript) {
    fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'user', permissionMode: mode }) + '\n');
  }
  const sink = [];
  const d1 = spawnDaemon(h.testHome, sink);
  let resolved = await waitForPipeFile(h.wmuxDir);
  let sock = await connectSocket(resolved);
  await rpc(sock, 'daemon.createSession', { id: sessionId, cmd: shimCmd, cwd: h.projDir, env: childEnv, cols: 80, rows: 24 }, authToken);
  await sleep(2500); // shim prints claude-code → lastDetectedAgent persists
  const sessionId_origin = randomUUID();
  const binding = {
    agent: 'claude',
    sessionId: sessionId_origin,
    cwd: bindingCwd ?? h.projDir,
    permissionMode: mode,
    transcriptPath,
    ts: 1700000000000,
  };
  await rpc(sock, 'daemon.setResumeBinding', { id: sessionId, resumeBinding: binding }, authToken);
  await sleep(300);
  return { h, sock, d1, authToken, sessionId, binding, sink };
}

async function recover(h, tag) {
  const d = spawnDaemon(h.testHome, []);
  const resolved = await waitForPipeFile(h.wmuxDir);
  const sock = await connectSocket(resolved);
  await sleep(3000); // recoverSessions
  return { d, sock };
}

async function main() {
  if (!fs.existsSync(DAEMON_BUNDLE)) { console.log('FAIL — daemon bundle missing; run npm run build:daemon'); process.exit(2); }
  console.log('\n=== X6 ③ RESUME-BINDING DAEMON DOGFOOD (real bundle, SIGKILL recover) ===\n');

  // ---- Case A + B: capture, survive a reboot, then a SECOND reboot ----
  {
    const tag = `A-${randomUUID().slice(0, 4)}`;
    const { h, sock, d1, authToken, sessionId, binding } = await setup(tag);
    const onDisk = readSessions(h.wmuxDir).find((s) => s.id === sessionId);
    record('A0 binding persisted to disk before kill', !!onDisk?.resumeBinding && onDisk.resumeBinding.permissionMode === 'bypassPermissions',
      `disk.permissionMode=${onDisk?.resumeBinding?.permissionMode ?? '<absent>'}`);
    sock.destroy();
    await killDaemon(d1);
    markPidDeadAndClearPipe(h.wmuxDir, sessionId);

    const r2 = await recover(h, tag);
    const list2 = await rpc(r2.sock, 'daemon.listSessions', {}, authToken).catch((e) => ({ err: e.message }));
    const got2 = (Array.isArray(list2) ? list2 : list2?.sessions || []).find((s) => s && s.id === sessionId);
    const a = got2?.resumeAgent === 'claude'
      && got2?.resumeBinding?.sessionId === binding.sessionId
      && got2?.resumeBinding?.permissionMode === 'bypassPermissions'
      && got2?.resumeBinding?.cwd === binding.cwd;
    record('A  capture survives reboot #1 (resumeAgent + resumeBinding correct)', a,
      `resumeAgent=${got2?.resumeAgent}, id=${got2?.resumeBinding?.sessionId?.slice(0, 8)}, mode=${got2?.resumeBinding?.permissionMode}`);

    // Case B: SECOND reboot, no fresh hook — durability fix (codex #3)
    r2.sock.destroy();
    await killDaemon(r2.d);
    markPidDeadAndClearPipe(h.wmuxDir, sessionId);
    const onDisk2 = readSessions(h.wmuxDir).find((s) => s.id === sessionId);
    const r3 = await recover(h, tag);
    const list3 = await rpc(r3.sock, 'daemon.listSessions', {}, authToken).catch((e) => ({ err: e.message }));
    const got3 = (Array.isArray(list3) ? list3 : list3?.sessions || []).find((s) => s && s.id === sessionId);
    record('B  binding survives a SECOND reboot w/ no fresh hook (codex #3 durability)',
      got3?.resumeBinding?.sessionId === binding.sessionId && got3?.resumeBinding?.permissionMode === 'bypassPermissions',
      `disk-after-recover1.permissionMode=${onDisk2?.resumeBinding?.permissionMode ?? '<absent>'}, surfaced=${got3?.resumeBinding?.permissionMode ?? '<absent>'}`);
    await rpc(r3.sock, 'daemon.shutdown', {}, authToken, 10_000).catch(() => {});
    r3.sock.destroy();
    await waitForExitOrKill(r3.d, 5000);
  }

  // ---- Case C: sticky permissionMode (codex #1) ----
  {
    const tag = `C-${randomUUID().slice(0, 4)}`;
    const { h, sock, d1, authToken, sessionId, binding } = await setup(tag);
    // A later Stop whose 64KB tail missed the user line → no permissionMode.
    await rpc(sock, 'daemon.setResumeBinding', {
      id: sessionId,
      resumeBinding: { agent: 'claude', sessionId: binding.sessionId, cwd: binding.cwd, transcriptPath: binding.transcriptPath, ts: 1700000009999 },
    }, authToken);
    await sleep(300);
    const onDisk = readSessions(h.wmuxDir).find((s) => s.id === sessionId);
    record('C  sticky permissionMode — a null capture does NOT wipe bypass (codex #1)',
      onDisk?.resumeBinding?.permissionMode === 'bypassPermissions',
      `disk.permissionMode=${onDisk?.resumeBinding?.permissionMode ?? '<absent>'}`);
    await rpc(sock, 'daemon.shutdown', {}, authToken, 10_000).catch(() => {});
    sock.destroy();
    await killDaemon(d1);
  }

  // ---- Case D: existence-probe (D5) — purged transcript → not surfaced ----
  {
    const tag = `D-${randomUUID().slice(0, 4)}`;
    const { h, sock, d1, authToken, sessionId, binding } = await setup(tag);
    sock.destroy();
    await killDaemon(d1);
    markPidDeadAndClearPipe(h.wmuxDir, sessionId);
    fs.unlinkSync(binding.transcriptPath); // purge the origin transcript
    const r2 = await recover(h, tag);
    const list2 = await rpc(r2.sock, 'daemon.listSessions', {}, authToken).catch((e) => ({ err: e.message }));
    const got2 = (Array.isArray(list2) ? list2 : list2?.sessions || []).find((s) => s && s.id === sessionId);
    // Pill still offered (resumeAgent present), but the EXACT-session binding is withheld → falls back to --continue.
    record('D  existence-probe hides a purged binding but keeps the pill (D5)',
      got2?.resumeAgent === 'claude' && !got2?.resumeBinding,
      `resumeAgent=${got2?.resumeAgent}, resumeBinding=${got2?.resumeBinding ? 'PRESENT(bad)' : 'withheld'}`);
    await rpc(r2.sock, 'daemon.shutdown', {}, authToken, 10_000).catch(() => {});
    r2.sock.destroy();
    await waitForExitOrKill(r2.d, 5000);
  }

  // ---- Case E: cwd-guard (F7) — binding.cwd ≠ session.cwd → not surfaced ----
  {
    const tag = `E-${randomUUID().slice(0, 4)}`;
    const { h, sock, d1, authToken, sessionId } = await setup(tag, { bindingCwd: path.join(os.tmpdir(), 'some-other-dir') });
    sock.destroy();
    await killDaemon(d1);
    markPidDeadAndClearPipe(h.wmuxDir, sessionId);
    const r2 = await recover(h, tag);
    const list2 = await rpc(r2.sock, 'daemon.listSessions', {}, authToken).catch((e) => ({ err: e.message }));
    const got2 = (Array.isArray(list2) ? list2 : list2?.sessions || []).find((s) => s && s.id === sessionId);
    record('E  cwd-guard withholds a mismatched-cwd binding (F7)',
      got2?.resumeAgent === 'claude' && !got2?.resumeBinding,
      `resumeBinding=${got2?.resumeBinding ? 'PRESENT(bad)' : 'withheld'}`);
    await rpc(r2.sock, 'daemon.shutdown', {}, authToken, 10_000).catch(() => {});
    r2.sock.destroy();
    await waitForExitOrKill(r2.d, 5000);
  }

  // cleanup
  if (process.platform === 'win32') { try { spawn('taskkill', ['/F', '/IM', 'PING.EXE', '/T'], { stdio: 'ignore' }); } catch { /* ignore */ } }
  for (const home of testHomes) { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== ${passed}/${results.length} PASS ===`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error('ERROR', e); process.exit(2); });
