#!/usr/bin/env node
/**
 * Phase 3 dynamic verification — end-to-end exercise of the
 * `agent.lifecycle` EventBus tee (Phase 1) running inside the actual
 * packaged Electron app.
 *
 * Strategy: spawn the packaged Electron app, then talk to its pipe
 * directly with raw JSON-RPC. Fires hooks.signal RPC requests with
 * cwd-matched payloads and polls events.poll back for the resulting
 * agent.lifecycle events.
 *
 * What this proves that unit tests cannot:
 *   - hooks.signal handler is wired into the live IPC server (main/index.ts)
 *   - eventBus.emit lands in the ring and is visible via events.poll
 *   - The zod enum on wmux_events_poll actually accepts 'agent.lifecycle'
 *     and 'workspace.metadata.changed' (filter survives wire round-trip)
 *   - Dedup ledger interaction is observable from outside the process
 *
 * Detector source (PTYBridge tee) is NOT exercised here — it needs real
 * AgentDetector regex hits on real PTY output, which is non-deterministic
 * inside a packaged Electron test harness. Covered by
 * PTYBridge.lifecycle.test.ts.
 *
 * Isolation: same pattern as m0-dynamic-verify.mjs. Temp HOME, win32 pipe
 * pre-flight, SIGKILL fallback on cleanup.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  EXECUTABLE_NAME,
  authTokenPath as appAuthTokenPath,
  packagedAppExe,
  mainPipeName,
} from './helpers/packaged-app.mjs';

// `import.meta.dirname` is only available on Node 20.11+; package.json declares
// `engines.node: >=18`, so use the fileURLToPath shim to stay portable. Same
// pattern m0-dynamic-verify.mjs uses.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const APP_EXE = packagedAppExe();
const PIPE_NAME = mainPipeName('', os.userInfo().username);

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

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), `${EXECUTABLE_NAME}-orch-dyn-`));
const AUTH_TOKEN_PATH = appAuthTokenPath(TEST_HOME, '');

let appProc;
// Awaitable variant — resolves AFTER the SIGKILL deadline + temp HOME
// removal so callers that want to exit cleanly don't race the timer and
// leak `wmux-orch-dyn-*` directories. The previous fire-and-forget
// setTimeout never ran when the main flow exited 500ms later (codex P3).
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
    }, 8000);

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

(async () => {
  console.log(`pipe: ${PIPE_NAME}`);
  console.log(`temp HOME: ${TEST_HOME}`);

  if (await pipeAlive()) {
    console.error('A wmux pipe already exists for this Windows user — aborting.');
    cleanup();
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

  // Give the renderer time to materialize a default workspace + pane.
  await sleep(2500);

  // 1) workspace.list — get the default workspace + its cwd for signal routing
  const wsResult = await rpc('workspace.list', {}, token);
  const workspaces = wsResult?.workspaces ?? wsResult ?? [];
  check('workspace.list returns >=1 workspace', workspaces.length >= 1, `count=${workspaces.length}`);
  if (workspaces.length === 0) { cleanup(); process.exit(1); }
  const ws = workspaces[0];
  const wsId = ws.id || ws.workspaceId;
  const wsCwd = ws.metadata?.cwd;
  check('workspace has cwd metadata (needed for signal routing)', typeof wsCwd === 'string' && wsCwd.length > 0, `cwd=${wsCwd}`);
  if (!wsCwd) { cleanup(); process.exit(1); }

  // 2) Baseline events.poll cursor — anything emitted before this point
  //    (process.started, pane.created) lands here. We capture nextCursor
  //    so subsequent polls only see events AFTER our hook RPC.
  const baseline = await rpc('events.poll', { workspaceId: wsId, types: ['agent.lifecycle'] }, token);
  check('events.poll accepts agent.lifecycle filter', Array.isArray(baseline?.events), `bootId=${baseline?.bootId?.slice(0, 8)}…`);
  let cursor = baseline.nextCursor;

  // 3) Send hooks.signal for agent.stop matching this workspace cwd.
  //    Should land as exactly one agent.lifecycle event with source:'hook'
  //    decision:'emit'.
  const sig1 = await rpc('hooks.signal', {
    kind: 'agent.stop',
    agent: 'claude',
    cwd: wsCwd,
    payload: {},
    ts: Date.now(),
  }, token);
  check('hooks.signal agent.stop returns ok:true', sig1?.ok === true || sig1 === undefined, `result=${JSON.stringify(sig1)}`);

  // Give the bus a tick to settle (synchronous emit, but defensive).
  await sleep(150);

  const poll1 = await rpc('events.poll', { workspaceId: wsId, cursor, types: ['agent.lifecycle'] }, token);
  cursor = poll1.nextCursor;
  const ev1 = poll1.events ?? [];
  check('agent.stop hook produces 1 agent.lifecycle event', ev1.length === 1, `count=${ev1.length}`);
  if (ev1.length >= 1) {
    const e = ev1[0];
    check('event.type is agent.lifecycle', e.type === 'agent.lifecycle', `type=${e.type}`);
    check('event.source is hook', e.source === 'hook', `source=${e.source}`);
    check('event.kind is agent.stop', e.kind === 'agent.stop', `kind=${e.kind}`);
    check('event.agent is claude', e.agent === 'claude', `agent=${e.agent}`);
    check('event.decision is emit (first hook this turn)', e.decision === 'emit', `decision=${e.decision}`);
    check('event has ptyId (resolved from cwd)', typeof e.ptyId === 'string' && e.ptyId.length > 0, `ptyId=${e.ptyId}`);
    check('event.workspaceId matches caller scope', e.workspaceId === wsId, `workspaceId=${e.workspaceId}`);
  }

  // 4) Fire a SECOND agent.stop hook immediately — dedup ledger should
  //    record decision:'dedup' but the event still lands (tee is unconditional).
  await rpc('hooks.signal', {
    kind: 'agent.stop',
    agent: 'claude',
    cwd: wsCwd,
    payload: {},
    ts: Date.now(),
  }, token);
  await sleep(150);
  const poll2 = await rpc('events.poll', { workspaceId: wsId, cursor, types: ['agent.lifecycle'] }, token);
  cursor = poll2.nextCursor;
  const ev2 = poll2.events ?? [];
  // Note: same-kind dedup within the window — hook beats hook only when prior
  // was detector. Two hooks back-to-back: the second is a fresh emit (hook
  // dedup ledger keys on prior-source-was-detector). So we expect another
  // 'emit' decision, not 'dedup'. Check that we got SOMETHING.
  check('second hook also produces an event (dedup ledger is detector-vs-hook only)', ev2.length === 1, `count=${ev2.length}`);

  // 5) Fire agent.activity — should NOT produce a lifecycle event
  //    (intentionally excluded from the ring; Issue 1A decision).
  await rpc('hooks.signal', {
    kind: 'agent.activity',
    agent: 'claude',
    cwd: wsCwd,
    payload: {},
    ts: Date.now(),
  }, token);
  await sleep(150);
  const poll3 = await rpc('events.poll', { workspaceId: wsId, cursor, types: ['agent.lifecycle'] }, token);
  cursor = poll3.nextCursor;
  const ev3 = poll3.events ?? [];
  check('agent.activity hook produces NO lifecycle event (off-ring by design)', ev3.length === 0, `count=${ev3.length}`);

  // 6) Fire agent.subagent_stop — should produce a lifecycle event.
  await rpc('hooks.signal', {
    kind: 'agent.subagent_stop',
    agent: 'claude',
    cwd: wsCwd,
    payload: {},
    ts: Date.now(),
  }, token);
  await sleep(150);
  const poll4 = await rpc('events.poll', { workspaceId: wsId, cursor, types: ['agent.lifecycle'] }, token);
  cursor = poll4.nextCursor;
  const ev4 = poll4.events ?? [];
  check('agent.subagent_stop produces an event', ev4.length === 1, `count=${ev4.length}`);
  if (ev4.length >= 1) {
    check('event.kind is agent.subagent_stop', ev4[0].kind === 'agent.subagent_stop', `kind=${ev4[0].kind}`);
  }

  // 7) Fire hook with cwd that doesn't match any workspace → NO event.
  await rpc('hooks.signal', {
    kind: 'agent.stop',
    agent: 'claude',
    cwd: 'C:\\nonexistent\\path\\that\\no\\workspace\\owns',
    payload: {},
    ts: Date.now(),
  }, token);
  await sleep(150);
  const poll5 = await rpc('events.poll', { workspaceId: wsId, cursor, types: ['agent.lifecycle'] }, token);
  cursor = poll5.nextCursor;
  const ev5 = poll5.events ?? [];
  check('hook with no-workspace-match produces NO event', ev5.length === 0, `count=${ev5.length}`);

  // 8) Verify workspace.metadata.changed filter accepted (zod enum gap closed).
  //    We don't try to TRIGGER this event (would require renderer ops),
  //    just that the filter doesn't reject — accept any count.
  const poll6 = await rpc('events.poll', { workspaceId: wsId, types: ['workspace.metadata.changed'] }, token);
  check('events.poll accepts workspace.metadata.changed filter (pre-existing gap)', Array.isArray(poll6?.events), `count=${poll6?.events?.length ?? 'n/a'}`);

  // 9) Verify mixed filter accepts both new types in one call.
  const poll7 = await rpc('events.poll', { workspaceId: wsId, types: ['agent.lifecycle', 'workspace.metadata.changed'] }, token);
  check('events.poll accepts mixed agent.lifecycle + workspace.metadata.changed filter', Array.isArray(poll7?.events));

  // ── Summary ──────────────────────────────────────────────────────────────
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok).length;
  console.log('\n──────────────────────────────────────────');
  console.log(`Phase 3 dynamic verification: ${passed}/${checks.length} passed`);
  if (failed > 0) {
    console.error(`\nFailures:`);
    for (const c of checks) {
      if (!c.ok) console.error(`  ❌ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
  }
  console.log('──────────────────────────────────────────');

  // Await the full cleanup (SIGTERM → 1.5s grace → SIGKILL + temp HOME rm)
  // so we don't leak the wmux-orch-dyn-* temp dir on success.
  await cleanup();
  process.exit(failed > 0 ? 1 : 0);
})().catch(async (err) => {
  console.error('Fatal:', err);
  await cleanup();
  process.exit(1);
});
