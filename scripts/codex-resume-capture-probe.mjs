#!/usr/bin/env node
// Dynamic verification for the Codex resume-capture bridge
// (integrations/codex/bin/wmux-codex-notify.mjs).
//
// Runs the REAL notify script against a MOCK wmux main pipe and asserts:
//   P1: a well-formed Codex notify payload → a valid AgentSignal envelope
//       (agent:'codex', kind:'agent.stop', agentSessionId=session_id, ptyId from
//       env, cwd, payload.transcript_path) reaches the pipe with the auth token.
//   P2: when the pipe is DOWN, the script spools a resume-binding record keyed by
//       ptyId (so the daemon reconciles it on next boot) and still exits 0.
//   P3: a payload with no session_id captures nothing (quiet drop, exit 0).
//
// Isolated: overrides USERPROFILE/HOME to a temp dir (auth token + spool land
// there), so it never touches the user's real ~/.wmux. The pipe name is
// username-derived (not HOME-derived), so the mock listens on the real name —
// safe because wmux must be DOWN for the probe to bind it.
//
// Usage: node scripts/codex-resume-capture-probe.mjs   (wmux must not be running)

import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
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
function startMockPipe() {
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
    model: 'gpt-5.5',
    'last-assistant-message': 'done',
  };
  const exit1 = await runNotify(home1, payload);
  await wait(150);
  const req = mock.get();
  ok('exits 0', exit1 === 0, `exit=${exit1}`);
  ok('RPC reached the pipe', !!req, 'no RPC captured');
  if (req) {
    ok('method is hooks.signal', req.method === 'hooks.signal', req.method);
    ok('auth token forwarded', req.token === TOKEN);
    const p = req.params || {};
    ok('agent = codex', p.agent === 'codex', p.agent);
    ok('kind = agent.stop', p.kind === 'agent.stop', p.kind);
    ok('agentSessionId = session_id', p.agentSessionId === payload.session_id, p.agentSessionId);
    ok('cwd carried', p.cwd === payload.cwd, p.cwd);
    ok('ptyId from env', p.ptyId === 'pty-probe-1', p.ptyId);
    ok('workspaceId from env', p.workspaceId === 'ws-probe', p.workspaceId);
    ok('transcript_path in payload (D5)', p.payload && p.payload.transcript_path === payload.transcript_path);
    ok('ts is a finite number', typeof p.ts === 'number' && Number.isFinite(p.ts));
  }
  mock.server.close();
  rmSync(home1, { recursive: true, force: true });

  // ── P2: pipe DOWN → spool a resume-binding record keyed by ptyId ────────────
  await wait(100);
  const home2 = makeHome();
  const exit2 = await runNotify(home2, payload); // no server listening now
  await wait(150);
  ok('exits 0 with pipe down', exit2 === 0, `exit=${exit2}`);
  const spoolFile = join(home2, '.wmux', 'resume-spool', 'pty-probe-1.json');
  ok('spooled a record on RPC failure', existsSync(spoolFile), spoolFile);
  if (existsSync(spoolFile)) {
    const rec = JSON.parse(readFileSync(spoolFile, 'utf8'));
    ok('spool record: agent=codex, sessionId, cwd, transcriptPath',
      rec.agent === 'codex' && rec.sessionId === payload.session_id
      && rec.cwd === payload.cwd && rec.transcriptPath === payload.transcript_path,
      JSON.stringify(rec));
  }
  rmSync(home2, { recursive: true, force: true });

  // ── P3: no session_id → quiet drop, no spool, exit 0 ────────────────────────
  const home3 = makeHome();
  const exit3 = await runNotify(home3, { cwd: 'D:\\wmux', hook_event_name: 'agent-turn-complete' });
  await wait(100);
  ok('no-session-id → exits 0', exit3 === 0, `exit=${exit3}`);
  ok('no-session-id → nothing spooled',
    !existsSync(join(home3, '.wmux', 'resume-spool', 'pty-probe-1.json')));
  rmSync(home3, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
