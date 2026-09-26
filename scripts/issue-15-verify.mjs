#!/usr/bin/env node
/**
 * issue-15-verify.mjs — dynamic verification for the issue #15 reference plugin
 * (examples/event-recorder/) against the actual packaged Electron app.
 *
 * Two things unit tests / the bench cannot prove:
 *   A) The reference plugin runs end to end as an external dev would invoke it:
 *      `node recorder.mjs --legacy --once` connects over the real pipe, polls
 *      the event bus, writes NDJSON, and exits 0 (legacy = grandfathered, so it
 *      works against the production enforce-mode app with no approval dialog).
 *   B) The enforce-mode identity contract the docs describe actually holds: a
 *      self-named external plugin (clientName = the recorder's real name, which
 *      is NOT first-party) that identifies + declares is REJECTED on its first
 *      gated RPC with rejection.reason='identity-status', status='unconfirmed',
 *      and a pendingApproval.promptId — the handler does not run until the user
 *      approves in the GUI. This is the withApprovalRetry idiom's trigger.
 *
 * Strategy / isolation: identical to scripts/m0-dynamic-verify.mjs — spawn the
 * packaged app at out/wmux-win32-x64/wmux.exe with a temp USERPROFILE/HOME/
 * APPDATA/LOCALAPPDATA + WMUX_DISABLE_CDP, pre-flight pipeAlive() abort if a
 * real wmux is on the per-user pipe, read the isolated token, talk raw
 * newline-JSON over the pipe, SIGTERM→SIGKILL cleanup.
 *
 * The win32 pipe name is shared per Windows account, so a REAL wmux must be
 * fully quit (not just window-closed — Quit/X detaches and keeps the daemon)
 * before running this.
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
const RECORDER = path.join(REPO_ROOT, 'examples', 'event-recorder', 'recorder.mjs');
const PIPE_NAME = `\\\\.\\pipe\\wmux-${os.userInfo().username}`;

if (!fs.existsSync(APP_EXE)) {
  console.error(`Packaged app missing at ${APP_EXE}. Run \`npm run package\` first.`);
  process.exit(2);
}
if (!fs.existsSync(RECORDER)) {
  console.error(`Recorder missing at ${RECORDER}.`);
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

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-i15-verify-'));
const AUTH_TOKEN_PATH = path.join(TEST_HOME, '.wmux-auth-token');
const NDJSON_OUT = path.join(TEST_HOME, 'events.ndjson');

let appProc;
const cleanup = () => new Promise((resolve) => {
  if (appProc && !appProc.killed) { try { appProc.kill('SIGTERM'); } catch {} }
  setTimeout(() => {
    if (appProc && !appProc.killed) { try { appProc.kill('SIGKILL'); } catch {} }
    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
    resolve();
  }, 1500);
});
process.on('exit', () => { if (appProc && !appProc.killed) { try { appProc.kill('SIGKILL'); } catch {} } });
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

// One-shot raw RPC. Optional clientName/clientVersion stamps the identity
// envelope (so we can exercise the enforce-mode plugin path). Returns the full
// response message { id, ok, result?, error?, rejection? } so the caller can
// inspect the rejection arm.
async function rpcRaw(method, params, token, clientName, clientVersion) {
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
      const env = { id, method, params, token };
      if (clientName) { env.clientName = clientName; if (clientVersion) env.clientVersion = clientVersion; }
      sock.write(JSON.stringify(env) + '\n');
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
            return resolve(msg);
          }
        } catch { /* ignore */ }
      }
    });
    sock.once('error', (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); });
  });
}

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function runRecorderLegacyOnce(token) {
  // Spawn the reference plugin exactly as an external dev would, pointing it at
  // the isolated app via WMUX_AUTH_TOKEN (it derives the same per-user pipe).
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RECORDER, '--legacy', '--once', '--out', NDJSON_OUT], {
      cwd: REPO_ROOT,
      env: { ...process.env, WMUX_AUTH_TOKEN: token, WMUX_SOCKET_PATH: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 30000);
    child.on('exit', (code) => { clearTimeout(killer); resolve({ code, out, err }); });
  });
}

(async () => {
  console.log(`pipe: ${PIPE_NAME}`);
  console.log(`temp HOME: ${TEST_HOME}`);

  if (await pipeAlive()) {
    console.error('A wmux pipe already exists for this Windows user — fully quit wmux (Quit/X only detaches) and retry.');
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
  appProc = spawn(APP_EXE, [], { cwd: REPO_ROOT, env: isolatedEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  appProc.stdout.on('data', (b) => process.stderr.write(`[app] ${b}`));
  appProc.stderr.on('data', (b) => process.stderr.write(`[app:err] ${b}`));
  appProc.on('exit', (code) => console.error(`[app] exited with ${code}`));

  await waitFor('auth token file', () => fs.existsSync(AUTH_TOKEN_PATH), 30000);
  const token = fs.readFileSync(AUTH_TOKEN_PATH, 'utf-8').trim();
  console.log(`--- auth token loaded (${token.length} chars) ---`);
  await waitFor('pipe ready', () => pipeAlive(), 15000);
  await sleep(2500); // let the renderer materialize a default workspace + pane

  // ── Test A: reference plugin --legacy --once ───────────────────────────────
  console.log('\n--- A: node recorder.mjs --legacy --once ---');
  const rec = await runRecorderLegacyOnce(token);
  check('recorder exited 0', rec.code === 0, `code=${rec.code}`);
  check('recorder connected to the pipe', /connected\./.test(rec.err), '');
  check('recorder resolved + watched a workspace', /watching workspace:/.test(rec.err), '');
  const onceMatch = rec.err.match(/--once: recorded (\d+) events/);
  check('recorder completed a --once poll', !!onceMatch, onceMatch ? `recorded=${onceMatch[1]}` : 'no --once summary line');
  let ndjsonLines = 0;
  try {
    ndjsonLines = fs.readFileSync(NDJSON_OUT, 'utf-8').split('\n').filter((l) => l.trim()).length;
  } catch { /* file may be absent if zero events */ }
  // Parse the first NDJSON line to confirm it is a real event object.
  let firstEventOk = false;
  if (ndjsonLines > 0) {
    try {
      const first = JSON.parse(fs.readFileSync(NDJSON_OUT, 'utf-8').split('\n').filter((l) => l.trim())[0]);
      firstEventOk = typeof first.type === 'string' && typeof first.seq === 'number' && typeof first.workspaceId === 'string';
    } catch { /* leave false */ }
  }
  check('recorder wrote ≥1 well-formed NDJSON event', ndjsonLines > 0 && firstEventOk, `lines=${ndjsonLines}`);
  if (rec.code !== 0) {
    // The recorder logs to stderr; stdout is only --help text, but dump both
    // on failure so nothing is hidden.
    console.error(rec.err.split('\n').slice(-8).join('\n'));
    if (rec.out.trim()) console.error(`[stdout] ${rec.out.split('\n').slice(-4).join('\n')}`);
  }

  // ── Test B: enforce-mode identity contract for a non-first-party plugin ─────
  // Replicate exactly what the recorder does in identity mode, but stop at the
  // first gated RPC and inspect the rejection (the full recorder would loop on
  // withApprovalRetry forever with no GUI to approve).
  console.log('\n--- B: identity-mode pendingApproval contract ---');
  const NAME = 'wmux-examples.event-recorder';
  const VER = '0.1.0';
  // mcp.identify (bootstrap-exempt → ok:true even unconfirmed)
  const idResp = await rpcRaw('mcp.identify', { name: NAME, version: VER }, token, NAME, VER);
  check('mcp.identify ok', idResp.ok === true, `status=${idResp.result?.identity?.status ?? idResp.result?.status}`);
  // mcp.declarePermissions (bootstrap-exempt). The recorder's exact 6.
  const declResp = await rpcRaw('mcp.declarePermissions', {
    permissions: ['events.subscribe', 'workspace.read', 'pane.read', 'meta.read', 'meta.write:label', 'meta.write:custom.event-recorder.*'],
    rationale: 'issue-15-verify identity probe',
  }, token, NAME, VER);
  const declOk = declResp.ok === true && declResp.result?.ok === true;
  check('mcp.declarePermissions accepted the 6-capability declaration', declOk,
    declOk ? `accepted=${(declResp.result.accepted || []).length}` : `result=${JSON.stringify(declResp.result ?? declResp.error)}`);
  // First gated RPC: workspace.list (needs workspace.read). Unconfirmed + enforce
  // ⇒ identity-status rejection with pendingApproval.promptId; handler NOT run.
  const wsResp = await rpcRaw('workspace.list', {}, token, NAME, VER);
  const rej = wsResp.rejection;
  const isPending = wsResp.ok === false && rej?.reason === 'identity-status' && rej?.status === 'unconfirmed';
  check('first gated RPC rejected with identity-status/unconfirmed (enforce mode)', isPending,
    `ok=${wsResp.ok} reason=${rej?.reason} status=${rej?.status}`);
  check('rejection carries pendingApproval.promptId (the approval handshake)',
    isPending && typeof rej?.pendingApproval?.promptId === 'string' && rej.pendingApproval.promptId.length > 0,
    `promptId=${rej?.pendingApproval?.promptId ?? 'n/a'}`);
  // Control: the SAME workspace.list with NO clientName. This used to assert the
  // grandfather ALLOWED it; #1111 closes that lane (first release on or after
  // 2026-09-30), so the control now asserts the refusal instead — it still
  // proves the enforcer distinguishes the envelope-less caller, just the other
  // way round.
  const legacyWs = await rpcRaw('workspace.list', {}, token, undefined, undefined);
  const legacyRej = legacyWs.rejection;
  check('envelope-less workspace.list is REFUSED (grandfather lane closed, #1111)',
    legacyWs.ok === false && legacyRej?.reason === 'identity-status' && legacyRej?.status === 'legacy',
    `ok=${legacyWs.ok} reason=${legacyRej?.reason} status=${legacyRej?.status}`);

  // ── Summary ─────────────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed ===`);
  if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`); }

  await cleanup();
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('FATAL:', e.stack || e.message);
  await cleanup();
  process.exit(2);
});
