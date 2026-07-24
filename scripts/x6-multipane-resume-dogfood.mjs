#!/usr/bin/env node
/**
 * X6 ③ ALL-PANE resume reliability — daemon KILL-REAL dogfood.
 *
 * The existing x6-resume-binding-dogfood.mjs proves the SINGLE-session happy
 * path: a live banner sets lastDetectedAgent and a manual setResumeBinding is
 * captured. It cannot reproduce the ACTUAL reported bug — "only the first
 * workspace's pill survives a reboot" — because it seeds the capture it is
 * meant to verify. This harness drives the real bundled daemon through the two
 * dominant failure modes the eng-review found, in isolated HOMEs:
 *
 *   A. Rung 0 — the daemon stamps WMUX_PTY_ID into each pane's env (the per-pane
 *      routing key the hook bridge echoes back; surfaceId is never injected).
 *   B. Rung 1 — a pane whose live banner was NEVER detected (silent shell) but
 *      whose setResumeBinding hook lands STILL gets lastDetectedAgent='claude',
 *      so the pill appears after reboot with the EXACT binding. (Pre-fix: no
 *      banner -> no pill, even though the exact uuid was captured.)
 *   C. Rung 3 — TWO panes in the SAME cwd, each with a spool record (simulating
 *      a failed live RPC: main pipe down at capture) keyed by its EXACT ptyId
 *      with a DIFFERENT uuid. After reboot each pane resumes its OWN uuid — pane
 *      B never inherits pane A's conversation. The headline shared-cwd
 *      correctness that cwd-only inference cannot achieve.
 *   D. Rung 3 guard — a spool record OLDER than a live binding does NOT clobber
 *      it (a stale spool can't overwrite a fresher live capture).
 *   E. Rung 3 guards — a spool record whose transcript is purged (D5) or whose
 *      cwd mismatches the pane (F7) is dropped, never surfaced as a bad --resume.
 *
 * PASS on all = the all-pane reliability rungs hold on the real bundle.
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

function spawnDaemon(testHome) {
  return spawn(process.execPath, [DAEMON_BUNDLE], {
    cwd: REPO_ROOT,
    env: { ...process.env, USERPROFILE: testHome, HOME: testHome, HOMEDRIVE: undefined, HOMEPATH: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

function markPidDeadAndClearPipe(wmuxDir, sessionIds) {
  // A real reboot kills every process; here we SIGKILL only the daemon, so the
  // orphaned shim children stay alive and the next daemon would RECONNECT, not
  // RECOVER. Force the recovery branch by marking each pid dead, and remove the
  // stale daemon-pipe so the next daemon's fresh pipe is picked up.
  try {
    const f = path.join(wmuxDir, 'sessions.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
    const arr = Array.isArray(j) ? j : (j.sessions || []);
    for (const id of sessionIds) {
      const t = arr.find((s) => s && s.id === id);
      if (t) t.pid = 999999;
    }
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
  } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(wmuxDir, 'daemon-pipe')); } catch { /* ignore */ }
}

// Idle shell: NEVER prints a claude banner. The whole point of cases B/C is that
// the live AgentDetector gate never fires, so lastDetectedAgent must come from a
// hook (Rung 1) or the spool (Rung 3), not the banner.
function writeSilentShim(shimDir) {
  let shimCmd;
  if (process.platform === 'win32') {
    shimCmd = path.join(shimDir, 'silent.cmd');
    fs.writeFileSync(shimCmd, `@echo off\r\n:loop\r\nping -n 3600 127.0.0.1 >nul\r\ngoto loop\r\n`);
  } else {
    shimCmd = path.join(shimDir, 'silent.sh');
    fs.writeFileSync(shimCmd, `#!/bin/sh\nwhile true; do sleep 3600; done\n`);
    fs.chmodSync(shimCmd, 0o755);
  }
  return shimCmd;
}

// Wait for a child to actually exit; on timeout force-SIGKILL so we never proceed
// with an orphan daemon still holding the pipe (which would make later cases
// nondeterministic — CodeRabbit). A short grace after the kill guarantees we don't
// hang if the 'exit' event is missed.
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
  const testHome = path.join(os.tmpdir(), `${EXECUTABLE_NAME}-mp-${tag}`);
  const wmuxDir = appHomeDir(testHome, '');
  const shimDir = path.join(testHome, 'shim');
  const projDir = path.join(testHome, 'proj');
  const tx = path.join(testHome, 'transcripts');
  for (const d of [wmuxDir, shimDir, projDir, tx]) fs.mkdirSync(d, { recursive: true });
  testHomes.push(testHome);
  return { testHome, wmuxDir, shimDir, projDir, tx };
}

function writeTranscript(txDir, name, mode = 'bypassPermissions') {
  const p = path.join(txDir, name);
  fs.writeFileSync(p, JSON.stringify({ type: 'user', permissionMode: mode }) + '\n');
  return p;
}

// Write a bridge-shaped spool record (what wmux-bridge.mjs drops on a failed RPC).
function writeSpool(wmuxDir, record) {
  const dir = path.join(wmuxDir, 'resume-spool');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(record.ptyId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  fs.writeFileSync(path.join(dir, `${safe}.json`), JSON.stringify(record));
}

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? `  (${detail})` : ''}`);
};

async function bootDaemon(h, tag) {
  const d = spawnDaemon(h.testHome);
  const resolved = await waitForPipeFile(h.wmuxDir);
  const sock = await connectSocket(resolved);
  return { d, sock };
}

async function recover(h) {
  const d = spawnDaemon(h.testHome);
  const resolved = await waitForPipeFile(h.wmuxDir);
  const sock = await connectSocket(resolved);
  await sleep(3500); // recoverSessions + spool ingest
  return { d, sock };
}

function findSession(list, id) {
  const arr = Array.isArray(list) ? list : (list?.sessions || []);
  return arr.find((s) => s && s.id === id);
}

async function shutdown(sock, d, authToken) {
  await rpc(sock, 'daemon.shutdown', {}, authToken, 10_000).catch(() => {});
  sock.destroy();
  await waitForExitOrKill(d, 5000);
}

async function main() {
  if (!fs.existsSync(DAEMON_BUNDLE)) {
    console.log('FAIL — daemon bundle missing; run npm run build:daemon');
    process.exit(2);
  }
  console.log('\n=== X6 ③ MULTI-PANE / MISSED-CAPTURE RESUME DOGFOOD (real bundle) ===\n');

  // ---- Case A: Rung 0 — WMUX_PTY_ID stamped into the pane env ----
  {
    const tag = `A-${randomUUID().slice(0, 4)}`;
    const h = makeHome(tag);
    const shim = writeSilentShim(h.shimDir);
    const authToken = randomUUID();
    writeConfig(h.wmuxDir, makePipeName(tag), authToken);
    const id = `mpA-${tag}`;
    const { d, sock } = await bootDaemon(h, tag);
    await rpc(sock, 'daemon.createSession', { id, cmd: shim, cwd: h.projDir, cols: 80, rows: 24 }, authToken);
    await sleep(800);
    const onDisk = findSession(readSessions(h.wmuxDir), id);
    const stamped = onDisk?.env?.WMUX_PTY_ID;
    record('A  daemon stamps WMUX_PTY_ID = session id into the pane env (Rung 0)',
      stamped === id, `env.WMUX_PTY_ID=${stamped ?? '<absent>'} expected=${id}`);
    await shutdown(sock, d, authToken);
  }

  // ---- Case B: Rung 1 — hook arms the pill gate with NO live banner ----
  {
    const tag = `B-${randomUUID().slice(0, 4)}`;
    const h = makeHome(tag);
    const shim = writeSilentShim(h.shimDir);
    const authToken = randomUUID();
    writeConfig(h.wmuxDir, makePipeName(tag), authToken);
    const id = `mpB-${tag}`;
    const uuid = randomUUID();
    const tx = writeTranscript(h.tx, 'B-origin.jsonl');
    const { d, sock } = await bootDaemon(h, tag);
    await rpc(sock, 'daemon.createSession', { id, cmd: shim, cwd: h.projDir, cols: 80, rows: 24 }, authToken);
    await sleep(1500); // silent shell — the banner gate NEVER fires
    const before = findSession(readSessions(h.wmuxDir), id);
    const noBanner = !before?.lastDetectedAgent;
    // The hook lands (live capture path) even though no banner was seen.
    await rpc(sock, 'daemon.setResumeBinding', {
      id,
      resumeBinding: { agent: 'claude', sessionId: uuid, cwd: h.projDir, permissionMode: 'bypassPermissions', transcriptPath: tx, ts: Date.now() },
    }, authToken);
    await sleep(400);
    const after = findSession(readSessions(h.wmuxDir), id);
    record('B1 no live banner → lastDetectedAgent unset until the hook lands',
      noBanner, `before.lastDetectedAgent=${before?.lastDetectedAgent ?? '<unset>'}`);
    record('B2 setResumeBinding ALSO arms lastDetectedAgent (Rung 1, pill 2nd writer)',
      after?.lastDetectedAgent === 'claude', `after.lastDetectedAgent=${after?.lastDetectedAgent ?? '<unset>'}`);

    sock.destroy();
    await killDaemon(d);
    markPidDeadAndClearPipe(h.wmuxDir, [id]);
    const r = await recover(h);
    const list = await rpc(r.sock, 'daemon.listSessions', {}, authToken).catch((e) => ({ err: e.message }));
    const got = findSession(list, id);
    record('B3 after reboot the pill + EXACT binding surface for a banner-less pane',
      got?.resumeAgent === 'claude' && got?.resumeBinding?.sessionId === uuid,
      `resumeAgent=${got?.resumeAgent}, id=${got?.resumeBinding?.sessionId?.slice(0, 8)}`);
    await shutdown(r.sock, r.d, authToken);
  }

  // ---- Case C: Rung 3 — two panes, SAME cwd, spool → each its OWN uuid ----
  {
    const tag = `C-${randomUUID().slice(0, 4)}`;
    const h = makeHome(tag);
    const shim = writeSilentShim(h.shimDir);
    const authToken = randomUUID();
    writeConfig(h.wmuxDir, makePipeName(tag), authToken);
    const idA = `mpC-A-${tag}`;
    const idB = `mpC-B-${tag}`;
    const uuidA = randomUUID();
    const uuidB = randomUUID();
    const txA = writeTranscript(h.tx, 'C-A.jsonl');
    const txB = writeTranscript(h.tx, 'C-B.jsonl');
    const { d, sock } = await bootDaemon(h, tag);
    // BOTH panes in the SAME cwd (h.projDir) — the exact shared-cwd scenario.
    await rpc(sock, 'daemon.createSession', { id: idA, cmd: shim, cwd: h.projDir, cols: 80, rows: 24 }, authToken);
    await rpc(sock, 'daemon.createSession', { id: idB, cmd: shim, cwd: h.projDir, cols: 80, rows: 24 }, authToken);
    await sleep(800);
    // NO live setResumeBinding — simulate both panes losing the live RPC (main
    // pipe down at capture). The bridge instead spooled, keyed by exact ptyId.
    writeSpool(h.wmuxDir, { ptyId: idA, agent: 'claude', sessionId: uuidA, cwd: h.projDir, transcriptPath: txA, permissionMode: 'bypassPermissions', ts: Date.now() });
    writeSpool(h.wmuxDir, { ptyId: idB, agent: 'claude', sessionId: uuidB, cwd: h.projDir, transcriptPath: txB, permissionMode: 'plan', ts: Date.now() });

    sock.destroy();
    await killDaemon(d);
    markPidDeadAndClearPipe(h.wmuxDir, [idA, idB]);
    const r = await recover(h);
    const list = await rpc(r.sock, 'daemon.listSessions', {}, authToken).catch((e) => ({ err: e.message }));
    const gotA = findSession(list, idA);
    const gotB = findSession(list, idB);
    record('C1 pane A resumes its OWN uuid from the spool (per-pane attribution)',
      gotA?.resumeAgent === 'claude' && gotA?.resumeBinding?.sessionId === uuidA,
      `A.id=${gotA?.resumeBinding?.sessionId?.slice(0, 8)} expected=${uuidA.slice(0, 8)}`);
    record('C2 pane B resumes its OWN uuid (NOT pane A\'s) under the SAME cwd',
      gotB?.resumeAgent === 'claude' && gotB?.resumeBinding?.sessionId === uuidB
        && gotB?.resumeBinding?.sessionId !== uuidA,
      `B.id=${gotB?.resumeBinding?.sessionId?.slice(0, 8)} expected=${uuidB.slice(0, 8)}`);
    record('C3 each pane kept its own permission mode through the spool',
      gotA?.resumeBinding?.permissionMode === 'bypassPermissions' && gotB?.resumeBinding?.permissionMode === 'plan',
      `A=${gotA?.resumeBinding?.permissionMode}, B=${gotB?.resumeBinding?.permissionMode}`);
    const spoolDir = path.join(h.wmuxDir, 'resume-spool');
    const leftover = fs.existsSync(spoolDir) ? fs.readdirSync(spoolDir).filter((f) => f.endsWith('.json')).length : 0;
    record('C4 consumed spool records are deleted after ingest',
      leftover === 0, `leftover=${leftover}`);
    await shutdown(r.sock, r.d, authToken);
  }

  // ---- Case D: Rung 3 guard — a stale spool does NOT clobber a newer live binding ----
  {
    const tag = `D-${randomUUID().slice(0, 4)}`;
    const h = makeHome(tag);
    const shim = writeSilentShim(h.shimDir);
    const authToken = randomUUID();
    writeConfig(h.wmuxDir, makePipeName(tag), authToken);
    const id = `mpD-${tag}`;
    const liveUuid = randomUUID();
    const staleUuid = randomUUID();
    const txLive = writeTranscript(h.tx, 'D-live.jsonl');
    const txStale = writeTranscript(h.tx, 'D-stale.jsonl');
    const { d, sock } = await bootDaemon(h, tag);
    await rpc(sock, 'daemon.createSession', { id, cmd: shim, cwd: h.projDir, cols: 80, rows: 24 }, authToken);
    await sleep(600);
    const NOW = Date.now();
    // Live capture is the FRESH one.
    await rpc(sock, 'daemon.setResumeBinding', {
      id, resumeBinding: { agent: 'claude', sessionId: liveUuid, cwd: h.projDir, permissionMode: 'bypassPermissions', transcriptPath: txLive, ts: NOW },
    }, authToken);
    await sleep(300);
    // An OLDER spool record (a capture from before the live one) must NOT win.
    writeSpool(h.wmuxDir, { ptyId: id, agent: 'claude', sessionId: staleUuid, cwd: h.projDir, transcriptPath: txStale, permissionMode: 'plan', ts: NOW - 60_000 });

    sock.destroy();
    await killDaemon(d);
    markPidDeadAndClearPipe(h.wmuxDir, [id]);
    const r = await recover(h);
    const list = await rpc(r.sock, 'daemon.listSessions', {}, authToken).catch((e) => ({ err: e.message }));
    const got = findSession(list, id);
    record('D  a stale spool does NOT clobber a newer live binding',
      got?.resumeBinding?.sessionId === liveUuid,
      `surfaced=${got?.resumeBinding?.sessionId?.slice(0, 8)} expected-live=${liveUuid.slice(0, 8)}`);
    await shutdown(r.sock, r.d, authToken);
  }

  // ---- Case E: Rung 3 guards — purged transcript (D5) + cwd mismatch (F7) dropped ----
  {
    const tag = `E-${randomUUID().slice(0, 4)}`;
    const h = makeHome(tag);
    const shim = writeSilentShim(h.shimDir);
    const authToken = randomUUID();
    writeConfig(h.wmuxDir, makePipeName(tag), authToken);
    const idPurged = `mpE-P-${tag}`;
    const idCwd = `mpE-C-${tag}`;
    const { d, sock } = await bootDaemon(h, tag);
    await rpc(sock, 'daemon.createSession', { id: idPurged, cmd: shim, cwd: h.projDir, cols: 80, rows: 24 }, authToken);
    await rpc(sock, 'daemon.createSession', { id: idCwd, cmd: shim, cwd: h.projDir, cols: 80, rows: 24 }, authToken);
    await sleep(800);
    // D5: transcriptPath points at a file that does NOT exist.
    writeSpool(h.wmuxDir, { ptyId: idPurged, agent: 'claude', sessionId: randomUUID(), cwd: h.projDir, transcriptPath: path.join(h.tx, 'gone.jsonl'), ts: Date.now() });
    // F7: cwd does not match the pane's cwd.
    const txOk = writeTranscript(h.tx, 'E-ok.jsonl');
    writeSpool(h.wmuxDir, { ptyId: idCwd, agent: 'claude', sessionId: randomUUID(), cwd: path.join(os.tmpdir(), 'some-other-dir'), transcriptPath: txOk, ts: Date.now() });

    sock.destroy();
    await killDaemon(d);
    markPidDeadAndClearPipe(h.wmuxDir, [idPurged, idCwd]);
    const r = await recover(h);
    const list = await rpc(r.sock, 'daemon.listSessions', {}, authToken).catch((e) => ({ err: e.message }));
    const gotP = findSession(list, idPurged);
    const gotC = findSession(list, idCwd);
    record('E1 spool with a purged transcript is NOT applied (D5)',
      !gotP?.resumeBinding, `resumeBinding=${gotP?.resumeBinding ? 'PRESENT(bad)' : 'withheld'}`);
    record('E2 spool with a mismatched cwd is NOT applied (F7)',
      !gotC?.resumeBinding, `resumeBinding=${gotC?.resumeBinding ? 'PRESENT(bad)' : 'withheld'}`);
    await shutdown(r.sock, r.d, authToken);
  }

  // cleanup
  if (process.platform === 'win32') { try { spawn('taskkill', ['/F', '/IM', 'PING.EXE', '/T'], { stdio: 'ignore' }); } catch { /* ignore */ } }
  for (const home of testHomes) { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== ${passed}/${results.length} PASS ===`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error('ERROR', e); process.exit(2); });
