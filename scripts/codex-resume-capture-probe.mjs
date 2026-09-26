#!/usr/bin/env node
// Dynamic verification for the Codex resume-capture bridge
// (integrations/codex/bin/wmux-codex-notify.mjs).
//
// Runs the REAL notify script against a MOCK wmux main pipe and asserts:
//   P1: a well-formed Codex notify payload → a valid AgentSignal envelope
//       (agent:'codex', kind:'agent.stop', agentSessionId=session_id, no pane
//       identity from env, cwd, payload.transcript_path) reaches the pipe with the auth token.
//   P2: when the pipe is DOWN, no unverified resume binding is spooled.
//   P3: a payload with no session_id captures nothing (quiet drop, exit 0).
//
// Isolated: overrides USERPROFILE/HOME to a temp dir (auth token + spool land
// there), so it never touches the user's real ~/.wmux. The mock listens on a
// process-unique pipe override, so a running desktop instance is untouched.
//
// Usage: node scripts/codex-resume-capture-probe.mjs

import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(fileURLToPath(new URL('../integrations/codex/bin/wmux-codex-notify.mjs', import.meta.url)));
const TOKEN = 'probe-token-abc';
// Isolated test pipe (WMUX_PIPE_NAME override) so the probe runs even while the
// real wmux holds `\\.\pipe\wmux-<user>`. Unique per pid to avoid collisions.
const PIPE = process.platform === 'win32'
  ? `\\\\.\\pipe\\wmux-codexprobe-${process.pid}`
  : join(tmpdir(), `wmux-codexprobe-${process.pid}.sock`);

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'wmux-codexprobe-'));
  writeFileSync(join(home, '.wmux-auth-token'), TOKEN, 'utf8');
  return home;
}

function runNotify(home, payloadObj, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, JSON.stringify(payloadObj)], {
      env: {
        ...process.env,
        USERPROFILE: home, HOME: home,
        WMUX_PIPE_NAME: PIPE,
        WMUX_PTY_ID: 'pty-probe-1',
        WMUX_WORKSPACE_ID: 'ws-probe',
        ...extraEnv,
      },
      stdio: 'ignore',
    });
    child.on('exit', (code) => resolve(code));
  });
}

// Start a mock pipe server that captures the first hooks.signal RPC.
function startMockPipe(legacy = false) {
  let captured = null;
  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      try {
        const req = JSON.parse(buf.slice(0, nl));
        captured = req;
        if (legacy && req.method === 'hooks.notify.v1') {
          sock.write(JSON.stringify({ id: req.id, ok: false, error: 'Unknown method: hooks.notify.v1' }) + '\n');
          return;
        }

        sock.write(JSON.stringify({ id: req.id, ok: true, result: { ok: true } }) + '\n');
      } catch {
        sock.write(JSON.stringify({ ok: false }) + '\n');
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(PIPE, () => resolve({ server, get: () => captured }));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('Codex resume-capture probe\n');

  // ── P1: valid payload → valid AgentSignal envelope on the pipe ──────────────
  let mock;
  try {
    mock = await startMockPipe();
  } catch (e) {
    console.error(`Could not bind mock pipe ${PIPE} — is wmux running? (${e.code})`);
    process.exit(2);
  }
  const home1 = makeHome();
  const payload = {
    session_id: '019f2516-6c5c-78b3-9f1f-b430e9ed8af6',
    transcript_path: 'C:\\Users\\u\\.codex\\sessions\\2026\\07\\03\\rollout-019f2516.jsonl',
    cwd: 'D:\\wmux',
    hook_event_name: 'agent-turn-complete',
    'last-assistant-message': 'done',
  };
  const exit1 = await runNotify(home1, payload);
  await wait(150);
  const req = mock.get();
  ok('exits 0', exit1 === 0, `exit=${exit1}`);
  ok('RPC reached the pipe', !!req, 'no RPC captured');
  if (req) {
    ok('method is hooks.notify.v1', req.method === 'hooks.notify.v1', req.method);
    ok('auth token forwarded', req.token === TOKEN);
    const p = req.params || {};
    ok('agent = codex', p.agent === 'codex', p.agent);
    ok('kind = agent.stop', p.kind === 'agent.stop', p.kind);
    ok('agentSessionId = session_id', p.agentSessionId === payload.session_id, p.agentSessionId);
    ok('cwd carried', p.cwd === payload.cwd, p.cwd);
    ok('pane env retained for provenance', p.ptyId === 'pty-probe-1' && p.workspaceId === 'ws-probe');
    ok('parent provenance provided', Number.isSafeInteger(p.payload?.parentPid) && p.payload.parentPid > 0);
    ok('legacy payload distinguished', p.payload?.notifyFormat === 'legacy');
    ok('thread routing marker', p.payload?.source === 'codex.notify');
    ok('transcript_path in payload (D5)', p.payload && p.payload.transcript_path === payload.transcript_path);
    ok('ts is a finite number', typeof p.ts === 'number' && Number.isFinite(p.ts));
  }
  mock.server.close();
  rmSync(home1, { recursive: true, force: true });

  // ── P2: pipe DOWN → never spool an unverified resume binding ────────────
  await wait(100);
  const home2 = makeHome();
  const exit2 = await runNotify(home2, payload); // no server listening now
  await wait(150);
  ok('exits 0 with pipe down', exit2 === 0, `exit=${exit2}`);
  const spoolFile = join(home2, '.wmux', 'resume-spool', 'pty-probe-1.json');
  ok('no unverified record on RPC failure', !existsSync(spoolFile), spoolFile);
  rmSync(home2, { recursive: true, force: true });

  // ── P3: no session_id → quiet drop, no spool, exit 0 ────────────────────────
  const home3 = makeHome();
  const exit3 = await runNotify(home3, { cwd: 'D:\\wmux', hook_event_name: 'agent-turn-complete' });
  await wait(100);
  ok('no-session-id → exits 0', exit3 === 0, `exit=${exit3}`);
  ok('no-session-id → nothing spooled',
    !existsSync(join(home3, '.wmux', 'resume-spool', 'pty-probe-1.json')));
  rmSync(home3, { recursive: true, force: true });

  const home4 = makeHome();
  const old = await startMockPipe(true);
  const official = { type: 'agent-turn-complete', 'thread-id': 'thread-b', 'turn-id': 'turn-b', cwd: '/same-directory' };
  await runNotify(home4, official);
  const compatibility = old.get();
  ok('old server receives original method', compatibility?.method === 'hooks.signal');
  ok('old server receives full pane identity', compatibility?.params?.ptyId === 'pty-probe-1' && compatibility.params.workspaceId === 'ws-probe');
  ok('old server receives original payload', JSON.stringify(compatibility?.params?.payload) === JSON.stringify({ 'turn-id': 'turn-b' }));
  old.server.close();
  rmSync(home4, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
