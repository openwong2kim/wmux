#!/usr/bin/env node
/**
 * PR #76 dynamic verification — end-to-end exercise of:
 *   1. OSC 133 D EventBus tee (source:'osc133' lifecycle events)
 *   2. agent.awaiting_input lifecycle (Claude approval-prompt regex)
 *
 * Both signals are wired BOTH on the local-mode PTYBridge path AND
 * (after Codex round-1 P1) on the daemon-mode DaemonNotificationRouter
 * path. The packaged Electron app boots in daemon mode by default, so
 * this script exercises the daemon path — the production path Codex
 * R1 caught as missing.
 *
 * Strategy: spawn the packaged Electron app, connect to its pipe,
 * write a real PowerShell command into a PTY that emits OSC 133;D;<n>
 * raw bytes, then poll the EventBus for the matching agent.lifecycle
 * event. For awaiting_input, write a command that prints both the
 * Claude gate phrase and an approval-prompt line.
 *
 * Isolation pattern: same as orchestrator-flow-dynamic.mjs — temp
 * HOME, win32 pipe pre-flight, SIGKILL fallback.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const APP_EXE = path.join(REPO_ROOT, 'out', 'wmux-win32-x64', 'wmux.exe');
const PIPE_NAME = `\\\\.\\pipe\\wmux-${os.userInfo().username}`;

if (!fs.existsSync(APP_EXE)) {
  console.error(`Packaged app missing at ${APP_EXE}. Run \`npm run package\` first.`);
  process.exit(2);
}

function pipeAlive() {
  return new Promise((resolve) => {
    const sock = net.createConnection(PIPE_NAME);
    const done = (val) => { try { sock.destroy(); } catch {} resolve(val); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 300);
  });
}

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pr76-dyn-'));
const AUTH_TOKEN_PATH = path.join(TEST_HOME, '.wmux-auth-token');

let appProc;
const cleanup = () => new Promise((resolve) => {
  if (appProc && !appProc.killed) {
    try { appProc.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => {
    if (appProc && !appProc.killed) { try { appProc.kill('SIGKILL'); } catch {} }
    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
    resolve();
  }, 1500);
});
process.on('exit', () => {
  if (appProc && !appProc.killed) { try { appProc.kill('SIGKILL'); } catch {} }
});
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (label, fn, timeoutMs = 30000, intervalMs = 200) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`);
};

async function rpc(method, params = {}, token) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(PIPE_NAME);
    let buf = '';
    let settled = false;
    const id = randomUUID();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      reject(new Error(`rpc timeout: ${method}`));
    }, 10000);

    sock.once('connect', () => {
      sock.write(JSON.stringify({ id, method, params, token }) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            settled = true;
            clearTimeout(timer);
            try { sock.destroy(); } catch {}
            if (msg.ok === false) return reject(new Error(msg.error));
            return resolve(msg.result ?? msg);
          }
        } catch { /* ignore non-json */ }
      }
    });
    sock.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// Poll until at least one event of `kind` shows up, or timeout. Returns the
// first matching event (or null on timeout). Updates cursor in-place so the
// caller can chain polls without seeing stale events.
async function pollUntilEvent(token, wsId, cursorRef, predicate, label, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const poll = await rpc('events.poll', {
      workspaceId: wsId,
      cursor: cursorRef.value,
      types: ['agent.lifecycle'],
    }, token);
    cursorRef.value = poll.nextCursor;
    const events = poll.events ?? [];
    const match = events.find(predicate);
    if (match) return { event: match, all: events };
    await sleep(200);
  }
  return { event: null, all: [] };
}

(async () => {
  console.log(`pipe: ${PIPE_NAME}`);
  console.log(`temp HOME: ${TEST_HOME}`);

  if (await pipeAlive()) {
    console.error('A wmux pipe already exists for this Windows user — aborting.');
    await cleanup();
    process.exit(3);
  }

  const isolatedEnv = {
    ...process.env,
    USERPROFILE: TEST_HOME,
    HOME: TEST_HOME,
    HOMEDRIVE: undefined,
    HOMEPATH: undefined,
    APPDATA: path.join(TEST_HOME, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(TEST_HOME, 'AppData', 'Local'),
    WMUX_DISABLE_CDP: 'true',
  };
  fs.mkdirSync(isolatedEnv.APPDATA, { recursive: true });
  fs.mkdirSync(isolatedEnv.LOCALAPPDATA, { recursive: true });

  console.log('--- spawning Electron app ---');
  appProc = spawn(APP_EXE, [], {
    cwd: REPO_ROOT,
    env: isolatedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  appProc.stdout.on('data', (b) => process.stderr.write(`[app] ${b}`));
  appProc.stderr.on('data', (b) => process.stderr.write(`[app:err] ${b}`));
  appProc.on('exit', (code) => console.error(`[app] exited with ${code}`));

  await waitFor('auth token file', () => fs.existsSync(AUTH_TOKEN_PATH), 30000);
  const token = fs.readFileSync(AUTH_TOKEN_PATH, 'utf-8').trim();
  console.log(`--- auth token loaded (${token.length} chars) ---`);

  await waitFor('pipe ready', () => pipeAlive(), 15000);
  console.log('--- pipe accepting connections ---');

  // Give the renderer time to spin up its default workspace + pane + PTY.
  await sleep(3500);

  // 1) workspace.list — grab the default workspace + its activePtyId.
  const wsResult = await rpc('workspace.list', {}, token);
  const workspaces = wsResult?.workspaces ?? wsResult ?? [];
  check('workspace.list returns >=1 workspace', workspaces.length >= 1, `count=${workspaces.length}`);
  if (workspaces.length === 0) { await cleanup(); process.exit(1); }
  const ws = workspaces[0];
  const wsId = ws.id || ws.workspaceId;
  const ptyId = ws.activePtyId ?? (Array.isArray(ws.ptyIds) ? ws.ptyIds[0] : null);
  check('workspace has an active PTY', typeof ptyId === 'string' && ptyId.length > 0, `ptyId=${ptyId}`);
  if (!ptyId) { await cleanup(); process.exit(1); }

  // Baseline cursor — anything before this point (process.started, etc.)
  // we discard. By-ref so pollUntilEvent can advance it.
  const baseline = await rpc('events.poll', { workspaceId: wsId, types: ['agent.lifecycle'] }, token);
  const cursorRef = { value: baseline.nextCursor };
  check('events.poll accepts agent.lifecycle filter', Array.isArray(baseline?.events), `bootId=${baseline?.bootId?.slice(0, 8)}…`);

  // Settle the shell prompt so any startup noise lands before our writes.
  await sleep(800);

  // ── Test 1: OSC 133 D with exitCode 0 (clean shell command lifecycle) ──
  // We emit OSC 133 raw bytes via a PowerShell Write-Host with the
  // [char]27 and [char]7 escapes. The shell prints ESC ] 133 ; D ; 0 BEL
  // to its stdout; OscParser inside DaemonPTYBridge parses it; the daemon
  // broadcasts a 'prompt.event'; DaemonNotificationRouter mirrors it as
  // source:'osc133' on the EventBus.
  const osc133D0 =
    `[Console]::Write([char]27 + ']133;D;0' + [char]7)`;
  await rpc('input.send', { ptyId, text: osc133D0, submit: true, raw: true }, token);
  const r1 = await pollUntilEvent(
    token, wsId, cursorRef,
    (e) => e.type === 'agent.lifecycle' && e.source === 'osc133' && e.exitCode === 0,
    'osc133 D exit=0',
  );
  check('OSC 133 D;0 → agent.lifecycle source:"osc133" with exitCode 0', !!r1.event, JSON.stringify(r1.event ?? { sawCount: r1.all.length }));
  if (r1.event) {
    check('  workspaceId scoped to caller', r1.event.workspaceId === wsId, `got=${r1.event.workspaceId}`);
    check('  kind is agent.stop (osc133 lifecycle category)', r1.event.kind === 'agent.stop', `kind=${r1.event.kind}`);
    check('  decision is emit (osc133 bypasses dedup ledger)', r1.event.decision === 'emit', `decision=${r1.event.decision}`);
    check('  ptyId attached', r1.event.ptyId === ptyId, `ptyId=${r1.event.ptyId}`);
    // agent may be null OR 'claude' depending on whether previous shell
    // output gated the detector. Either is valid at this point; we tighten
    // in Test 3 once the gate is explicitly tripped.
    check('  agent field present (null or known slug)',
      r1.event.agent === null || typeof r1.event.agent === 'string',
      `agent=${r1.event.agent}`);
  }

  // ── Test 2: OSC 133 D with non-zero exit code ──
  const osc133D1 =
    `[Console]::Write([char]27 + ']133;D;1' + [char]7)`;
  await rpc('input.send', { ptyId, text: osc133D1, submit: true, raw: true }, token);
  const r2 = await pollUntilEvent(
    token, wsId, cursorRef,
    (e) => e.type === 'agent.lifecycle' && e.source === 'osc133' && e.exitCode === 1,
    'osc133 D exit=1',
  );
  check('OSC 133 D;1 → agent.lifecycle with exitCode 1', !!r2.event, JSON.stringify(r2.event ?? { sawCount: r2.all.length }));

  // ── Test 3: agent.awaiting_input via Claude gate + approval prompt ──
  // First print the gate phrase to flip the AgentDetector into the Claude
  // Code recognizer state, then print the approval line. The new
  // line-end-anchored regex matches `Do you want to proceed?` on a line of
  // its own; conversational mentions are rejected.
  const gateAndPrompt =
    `Write-Host 'Claude Code'; Write-Host 'Do you want to proceed?'`;
  await rpc('input.send', { ptyId, text: gateAndPrompt, submit: true, raw: true }, token);
  const r3 = await pollUntilEvent(
    token, wsId, cursorRef,
    (e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input',
    'agent.awaiting_input lifecycle',
  );
  check('Claude gate + approval prompt → kind:"agent.awaiting_input"', !!r3.event, JSON.stringify(r3.event ?? { sawCount: r3.all.length }));
  if (r3.event) {
    check('  source is detector (regex-based)', r3.event.source === 'detector', `source=${r3.event.source}`);
    check('  agent is claude (slug from gated detector)', r3.event.agent === 'claude', `agent=${r3.event.agent}`);
    check('  workspaceId scoped', r3.event.workspaceId === wsId, `got=${r3.event.workspaceId}`);
  }

  // ── Test 4: Conversational mention does NOT trigger awaiting_input ──
  // Round-5 P2 fix: full-line anchor rejects leading conversational
  // phrases. We print a sentence that embeds the phrase mid-line, then
  // verify no NEW awaiting_input event landed.
  const cursorBeforeFalse = cursorRef.value;
  const falsePositive =
    `Write-Host 'Answer Do you want to proceed? with caution'`;
  await rpc('input.send', { ptyId, text: falsePositive, submit: true, raw: true }, token);
  // Sleep enough for any (mis)emit to land, then drain.
  await sleep(2000);
  const drainPoll = await rpc('events.poll', {
    workspaceId: wsId,
    cursor: cursorBeforeFalse,
    types: ['agent.lifecycle'],
  }, token);
  cursorRef.value = drainPoll.nextCursor;
  const awaitingAfterFalse = (drainPoll.events ?? []).filter(
    (e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input',
  );
  check('Conversational "Do you want to proceed?" mid-line → no awaiting_input',
    awaitingAfterFalse.length === 0,
    `count=${awaitingAfterFalse.length}`);

  // ── Summary ──────────────────────────────────────────────────────────
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok).length;
  console.log('\n──────────────────────────────────────────');
  console.log(`PR #76 dynamic verification: ${passed}/${checks.length} passed`);
  if (failed > 0) {
    console.error(`\nFailures:`);
    for (const c of checks) {
      if (!c.ok) console.error(`  ❌ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
  }
  console.log('──────────────────────────────────────────');

  await cleanup();
  process.exit(failed > 0 ? 1 : 0);
})().catch(async (err) => {
  console.error('Fatal:', err);
  await cleanup();
  process.exit(1);
});
