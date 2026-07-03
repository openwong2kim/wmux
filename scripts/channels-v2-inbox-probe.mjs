#!/usr/bin/env node
/**
 * Channels v2 durable-inbox probe — end-to-end through the REAL bundled
 * daemon (isolated home + pipe; production wmux untouched).
 *
 * Chain under test (steps 0–3a of the redesign):
 *   daemon-side caller stamping (senderPtyId → env-record workspace) →
 *   member cursor (lastReadSeq) → unread/mention read model → agent ack →
 *   wake-worker PTY nudge injection → cursor survival across daemon death.
 *
 * PASS criteria:
 *   P1  create with senderPtyId ONLY (no verifiedWorkspaceId) → stamped:
 *       channel.createdBy === ws-A
 *   P2  mutation with an unresolvable senderPtyId → NOT_AUTHORIZED (fail-closed)
 *   P3  join with senderPtyId B + member{memberId} (no workspace claim) →
 *       roster row pinned to ws-B
 *   P4  post from A @mentioning ws-B → B's a2a.channel.unread reports
 *       unread=1, mentionUnread=1
 *   P5  the wake worker injects the nudge line into B's PTY (observed via
 *       the session pipe stream: '[wmux] #<channel>' + the read command)
 *   P6  agent ack (memberId-narrowed, uptoSeq=head) → unread=0
 *   P7  daemon SIGKILL + respawn → the cursor SURVIVED daemon death:
 *       channels.json carries lastReadSeq AND a fresh unread query over the
 *       respawned daemon still reports 0 for B
 *
 * Run: npm run build:daemon && node scripts/channels-v2-inbox-probe.mjs
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

const WS_A = 'ws-probe-a';
const WS_B = 'ws-probe-b';
const SESS_A = 'sess-agent-a';
const SESS_B = 'sess-agent-b';

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

function spawnDaemon(testHome, logChunks) {
  const d = spawn(process.execPath, [DAEMON_BUNDLE], {
    cwd: REPO_ROOT,
    env: { ...process.env, USERPROFILE: testHome, HOME: testHome, HOMEDRIVE: undefined, HOMEPATH: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  d.stdout.on('data', (c) => logChunks && logChunks.push(c.toString()));
  d.stderr.on('data', (c) => logChunks && logChunks.push(c.toString()));
  return d;
}

async function waitForPipeFile(wmuxDir, timeoutMs = 15_000) {
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
            else reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
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

/**
 * Attach to a session's dedicated pipe and stream its PTY output.
 * On POSIX the daemon derives the socket path from ITS home — which the
 * probe overrides to the isolated testHome — so the tap must resolve
 * against testHome too, not the probe's own os.homedir() (CodeRabbit
 * review; Windows named pipes live in a global namespace and don't care).
 */
function tapSessionStream(sessionId, authToken, homeDir) {
  const pipeName = process.platform === 'win32'
    ? `\\\\.\\pipe\\wmux-session-${sessionId}`
    : path.join(homeDir, `.wmux-session-${sessionId}.sock`);
  const chunks = [];
  return new Promise((resolve, reject) => {
    const s = net.createConnection(pipeName, () => {
      s.write(authToken + '\n');
      resolve({
        text: () => chunks.join(''),
        close: () => { try { s.destroy(); } catch { /* ignore */ } },
      });
    });
    s.on('data', (c) => chunks.push(c.toString()));
    s.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Live handles for crash-path cleanup: a thrown RPC timeout or respawn
// failure must not leak a RUNNING daemon or open pipes (CodeRabbit review).
// The happy path tears these down in-line; the main().catch handler sweeps
// whatever is still live. The temp home is deliberately KEPT on crash —
// it holds the daemon's channels.json/sessions state, i.e. the postmortem.
const live = { daemon: null, sock: null, tapB: null, home: null };
function cleanupLive() {
  try { live.tapB?.close(); } catch { /* ignore */ }
  try { live.sock?.destroy(); } catch { /* ignore */ }
  try { live.daemon?.kill('SIGKILL'); } catch { /* ignore */ }
  live.tapB = live.sock = live.daemon = null;
}

async function main() {
  if (!fs.existsSync(DAEMON_BUNDLE)) {
    console.error(`Daemon bundle missing: ${DAEMON_BUNDLE}\nRun: npm run build:daemon`);
    process.exit(2);
  }

  const tag = `chv2-${randomUUID().slice(0, 8)}`;
  const testHome = path.join(os.tmpdir(), `wmux-${tag}`);
  const wmuxDir = path.join(testHome, '.wmux');
  fs.mkdirSync(wmuxDir, { recursive: true });
  live.home = testHome;
  const pipeName = makePipeName(tag);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const shell = process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    : '/bin/sh';
  const sessEnv = (ws) => ({
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    WMUX_WORKSPACE_ID: ws,
  });

  console.log(`channels-v2-inbox-probe — home=${testHome}`);
  const d1Log = [];
  let daemon = (live.daemon = spawnDaemon(testHome, d1Log));
  let resolved = await waitForPipeFile(wmuxDir);
  let sock = (live.sock = await connectSocket(resolved));

  // Two live "agent panes": A (sender) and B (the nudge target). Interactive
  // shells — they idle at a prompt, which is exactly the wake worker's
  // quiet-gate precondition.
  await rpc(sock, 'daemon.createSession', {
    id: SESS_A, cmd: shell, cwd: testHome, cols: 80, rows: 24, env: sessEnv(WS_A),
  }, authToken);
  await rpc(sock, 'daemon.createSession', {
    id: SESS_B, cmd: shell, cwd: testHome, cols: 80, rows: 24, env: sessEnv(WS_B),
  }, authToken);

  // P5 needs the session pipe live — attach B and tap its stream.
  await rpc(sock, 'daemon.attachSession', { id: SESS_B }, authToken);
  const tapB = (live.tapB = await tapSessionStream(SESS_B, authToken, testHome));

  // --- P1: stamped create (senderPtyId only) ---
  const created = await rpc(sock, 'a2a.channel.create', {
    name: 'probe-inbox',
    visibility: 'public',
    createdBy: { memberId: 'pm', memberName: 'pm' },
    senderPtyId: SESS_A,
  }, authToken);
  const channelId = created?.channel?.id ?? '';
  check('P1 create stamped from session env (createdBy === ws-A)',
    created?.ok === true && created?.channel?.createdBy === WS_A,
    `createdBy=${created?.channel?.createdBy ?? '(none)'}`);

  // --- P2: fail-closed on unresolvable senderPtyId ---
  const ghost = await rpc(sock, 'a2a.channel.post', {
    channelId, text: 'forged', sender: { memberId: 'x', memberName: 'x' }, senderPtyId: 'pty-ghost',
  }, authToken);
  check('P2 unresolvable senderPtyId mutation → NOT_AUTHORIZED',
    ghost?.ok === false && ghost?.error?.code === 'NOT_AUTHORIZED',
    ghost?.error?.message?.slice(0, 60));

  // --- P3: join B with member backfill ---
  const joined = await rpc(sock, 'a2a.channel.join', {
    channelId, member: { memberId: 'codex', memberName: 'codex' }, senderPtyId: SESS_B,
  }, authToken);
  const members = await rpc(sock, 'a2a.channel.getMembers', {
    channelId, senderPtyId: SESS_B,
  }, authToken);
  const rowB = (members?.members ?? []).find((m) => m.memberId === 'codex');
  check('P3 join backfills the member workspace from the daemon stamp',
    joined?.ok === true && rowB?.workspaceId === WS_B,
    `row=${JSON.stringify(rowB ?? null)}`);

  // --- P4: post with mention → unread + mentionUnread for B ---
  const posted = await rpc(sock, 'a2a.channel.post', {
    channelId,
    text: 'codex: please handle this',
    sender: { memberId: 'pm', memberName: 'pm' },
    mentions: [{ workspaceId: WS_B, memberId: 'codex', name: 'codex' }],
    senderPtyId: SESS_A,
  }, authToken);
  const unread1 = await rpc(sock, 'a2a.channel.unread', { senderPtyId: SESS_B }, authToken);
  const entryB = (unread1?.entries ?? []).find((e) => e.channelId === channelId && e.memberId === 'codex');
  check('P4 unread read-model: B owes 1 unread, 1 mention',
    posted?.ok === true && entryB?.unread === 1 && entryB?.mentionUnread === 1,
    `entry=${JSON.stringify(entryB ?? null)}`);

  // --- P4b: the POSTER owes nothing about its own message (self-exemption +
  // caught-up cursor ride — Codex review) ---
  const unreadA = await rpc(sock, 'a2a.channel.unread', { senderPtyId: SESS_A }, authToken);
  const entryA = (unreadA?.entries ?? []).find((e) => e.channelId === channelId);
  check('P4b poster owes nothing about its own post (cursor rode over it)',
    entryA != null && entryA.unread === 0 && entryA.lastReadSeq === 1,
    `entry=${JSON.stringify(entryA ?? null)}`);

  // --- P5: wake worker injects the nudge into B's PTY ---
  // Quiet gate = 10s of output silence; tick = 15s (post fast-path kicks a
  // sweep 1s after the post but the fresh prompt keeps the pane "active"
  // for a bit). Poll the tapped stream up to 45s.
  let nudged = false;
  {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const text = tapB.text();
      if (text.includes('[wmux] #probe-inbox') && text.includes('wmux channel read')) { nudged = true; break; }
      await sleep(1_000);
    }
  }
  check('P5 wake worker injected the nudge line into the idle member pane', nudged,
    nudged ? undefined : `streamTail=${JSON.stringify(tapB.text().slice(-200))}`);

  // --- P6a: a HUMAN-style ack (no memberId — the renderer's open-channel
  // read receipt) must NOT consume the agent's cursor (Codex re-review P1:
  // a human glancing at a channel used to clear agent unread and silence
  // the wake worker on unprocessed work) ---
  const receiptAck = await rpc(sock, 'a2a.channel.ack', {
    channelId, uptoSeq: entryB?.headSeq ?? 1, senderPtyId: SESS_B,
  }, authToken);
  const unreadAfterReceipt = await rpc(sock, 'a2a.channel.unread', { senderPtyId: SESS_B }, authToken);
  const entryBr = (unreadAfterReceipt?.entries ?? []).find((e) => e.channelId === channelId && e.memberId === 'codex');
  check('P6a receipt-only ack (no memberId) leaves the agent cursor untouched',
    receiptAck?.ok === true && entryBr?.unread === 1 && entryBr?.lastReadSeq === 0,
    `after=${JSON.stringify(entryBr ?? null)}`);

  // --- P6: agent ack clears unread ---
  const acked = await rpc(sock, 'a2a.channel.ack', {
    channelId, uptoSeq: entryB?.headSeq ?? 1, memberId: 'codex', senderPtyId: SESS_B,
  }, authToken);
  const unread2 = await rpc(sock, 'a2a.channel.unread', { senderPtyId: SESS_B }, authToken);
  const entryB2 = (unread2?.entries ?? []).find((e) => e.channelId === channelId && e.memberId === 'codex');
  check('P6 memberId-narrowed ack → unread 0 (cursor advanced)',
    acked?.ok === true && entryB2?.unread === 0 && entryB2?.lastReadSeq === (entryB?.headSeq ?? 1),
    `after=${JSON.stringify(entryB2 ?? null)}`);

  // --- P7: cursor survives daemon DEATH (SIGKILL, no graceful flush) ---
  tapB.close();
  try { sock.destroy(); } catch { /* ignore */ }
  daemon.kill('SIGKILL');
  await sleep(1_500);

  // channels.json on disk carries the cursor (saveImmediate on ack).
  let persistedCursor = null;
  try {
    const state = JSON.parse(fs.readFileSync(path.join(wmuxDir, 'channels.json'), 'utf8'));
    const row = (state.members?.[channelId] ?? []).find((m) => m.memberId === 'codex');
    persistedCursor = row?.lastReadSeq ?? null;
  } catch { /* file unreadable */ }

  // The SIGKILLed daemon left a stale daemon-pipe hint file — remove it so
  // waitForPipeFile observes the RESPAWNED daemon's write, and retry the
  // connect while the new listener comes up.
  try { fs.unlinkSync(path.join(wmuxDir, 'daemon-pipe')); } catch { /* ignore */ }
  const d2Log = [];
  daemon = live.daemon = spawnDaemon(testHome, d2Log);
  resolved = await waitForPipeFile(wmuxDir);
  sock = live.sock = null;
  {
    const deadline = Date.now() + 10_000;
    let lastErr = null;
    while (Date.now() < deadline && !sock) {
      try {
        sock = live.sock = await connectSocket(resolved);
      } catch (err) {
        lastErr = err;
        await sleep(300);
      }
    }
    if (!sock) throw lastErr ?? new Error('respawned daemon pipe never accepted');
  }
  // Recovery replays the session records (same ids, env preserved) — give it
  // a moment, then query unread over the RESPAWNED daemon with B's identity.
  await sleep(2_000);
  let unread3 = null;
  try {
    unread3 = await rpc(sock, 'a2a.channel.unread', { senderPtyId: SESS_B }, authToken);
  } catch (err) {
    unread3 = { err: String(err) };
  }
  const entryB3 = (unread3?.entries ?? []).find?.((e) => e.channelId === channelId && e.memberId === 'codex');
  check('P7 cursor survives daemon SIGKILL (persisted + respawned daemon agrees)',
    persistedCursor === (entryB?.headSeq ?? 1) && entryB3?.unread === 0,
    `disk=${persistedCursor} respawned=${JSON.stringify(entryB3 ?? unread3)}`);

  // Teardown (happy path also removes the temp home).
  cleanupLive();
  await sleep(300);
  try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} (${results.length} checks)`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('probe crashed:', err);
  cleanupLive();
  if (live.home) console.error(`temp home kept for postmortem: ${live.home}`);
  process.exit(1);
});
