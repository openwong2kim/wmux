// Dogfood: drive the REAL hook bridge, the way Claude Code drives it.
//
// Every harness so far called `daemon.hooks.signal` over the pipe directly.
// That proves the daemon's half. It does NOT prove the piece M1 actually
// changed: `integrations/claude/bin/wmux-bridge.mjs` deciding WHICH pipe to
// talk to, in what order, with what fallback. That file has never run.
//
// The repo's standing note says hook behaviour can only be tested in a packaged
// build, because the bridge cannot see WMUX_DATA_SUFFIX. A temp HOME looks like
// it solves that — the bridge does resolve its paths from USERPROFILE/HOME — and
// it does NOT. A named pipe is global per USER, not per home: the daemon derives
// its pipe name from the suffix and the username only, so an unsuffixed daemon
// in a private home still binds the PRODUCTION pipe name and squats on the real
// instance. That was tried here first and is why the isolation below looks the
// way it does.
//
// What actually works: give the DAEMON a suffix so its pipe name is private,
// then plant its `daemon-pipe` / `daemon-auth-token` hint files at the
// unsuffixed path the bridge reads. That is the bridge's PRIMARY resolution
// path (hint file first, username-derived name only as a fallback), so this
// exercises more of the real code than the packaged-only route would, and the
// production daemon is never reachable from here.
//
// Invocation contract, from the bridge itself: hook name in argv[2], Claude
// Code's hook payload as JSON on stdin, pane identity from WMUX_PTY_ID.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const REPO = process.cwd();
const DAEMON = path.join(REPO, 'dist', 'daemon-bundle', 'index.js');
const BRIDGE = path.join(REPO, 'integrations', 'claude', 'bin', 'wmux-bridge.mjs');
const TAG = Math.random().toString(36).slice(2, 8);
const TEST_HOME = path.join(os.tmpdir(), `wmux-bridge-dogfood-${TAG}`);
// A named pipe is global per USER, not per HOME: its name is derived from the
// suffix + username, so an unsuffixed daemon in a temp home still binds the
// PRODUCTION pipe. Suffix the daemon to get a private pipe, then plant its
// hint files at the unsuffixed path the (suffix-blind) bridge reads — which is
// the bridge's PRIMARY resolution path, not a fallback.
const SUFFIX = `-bridgedog-${TAG}`;
const DAEMON_DIR = path.join(TEST_HOME, `.wmux${SUFFIX}`);
const WMUX_DIR = path.join(TEST_HOME, '.wmux');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (scenario, pass, evidence) => {
  results.push({ scenario, pass, evidence });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${scenario}`);
};

// The bridge must never see a suffix — that is the condition being reproduced.
// Only the daemon gets one (see startDaemon), so the pipe name stays private.
const childEnv = (extra = {}) => {
  const env = { ...process.env, USERPROFILE: TEST_HOME, HOME: TEST_HOME, ...extra };
  delete env.WMUX_DATA_SUFFIX;
  return env;
};

function readPipeName() {
  return fs.readFileSync(path.join(DAEMON_DIR, 'daemon-pipe'), 'utf8').trim();
}
function readToken() {
  return fs.readFileSync(path.join(DAEMON_DIR, 'daemon-auth-token'), 'utf8').trim();
}

/** One RPC on its own connection, matching the response by id (the daemon pipe
 *  interleaves id-less broadcast frames). */
function rpc(method, params = {}) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const s = net.createConnection(readPipeName());
    let buf = '';
    const t = setTimeout(() => { s.destroy(); reject(new Error(`rpc timeout: ${method}`)); }, 15000);
    s.on('connect', () => s.write(`${JSON.stringify({ id, token: readToken(), method, params })}\n`));
    s.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== id) continue;          // a broadcast frame, keep reading
        clearTimeout(t); s.end();
        return msg.ok ? resolve(msg.result) : reject(new Error(String(msg.error)));
      }
    });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

/** A long-lived connection that collects broadcast frames. */
function broadcastListener() {
  const frames = [];
  const s = net.createConnection(readPipeName());
  let buf = '';
  // Events are opt-in on the daemon side — without the subscribe this listener
  // collects nothing and every waitFor below burns its full timeout.
  s.on('connect', () => {
    s.write(`${JSON.stringify({ id: `sub-${TAG}`, token: readToken(), method: 'daemon.events.subscribe', params: {} })}\n`);
    s.write(`${JSON.stringify({ id: `ping-${TAG}`, token: readToken(), method: 'daemon.listSessions', params: {} })}\n`);
  });
  s.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try { frames.push(JSON.parse(line)); } catch { /* partial */ }
    }
  });
  s.on('error', () => { /* torn down with the daemon */ });
  return {
    frames,
    close: () => { try { s.destroy(); } catch { /* already gone */ } },
    waitFor: async (pred, timeoutMs = 12000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = frames.find(pred);
        if (hit) return hit;
        await sleep(100);
      }
      return null;
    },
  };
}

function startDaemon() {
  const child = spawn(process.execPath, [DAEMON], {
    env: { ...childEnv(), WMUX_DATA_SUFFIX: SUFFIX }, detached: true, stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

async function waitReady(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(DAEMON_DIR, 'daemon-pipe')) && fs.existsSync(path.join(DAEMON_DIR, 'daemon-auth-token'))) {
      try { await rpc('daemon.listSessions'); return true; } catch { /* still booting */ }
    }
    await sleep(400);
  }
  return false;
}

/** Run the real bridge exactly as Claude Code does. */
function runBridge(hookName, payload, extraEnv = {}) {
  const started = Date.now();
  const out = spawnSync(process.execPath, [BRIDGE, hookName], {
    input: JSON.stringify(payload),
    env: childEnv(extraEnv),
    encoding: 'utf8',
    timeout: 20000,
  });
  return {
    status: out.status,
    ms: Date.now() - started,
    stdout: (out.stdout || '').trim().slice(0, 400),
    stderr: (out.stderr || '').trim().slice(0, 400),
  };
}

function bridgeLogTail(n = 12) {
  try {
    return fs.readFileSync(path.join(WMUX_DIR, 'bridge.log'), 'utf8')
      .trim().split('\n').slice(-n)
      .map((l) => { try { return JSON.parse(l); } catch { return l; } });
  } catch { return []; }
}

let daemonPid = null;
let sub = null;

try {
  fs.mkdirSync(TEST_HOME, { recursive: true });
  console.log(`[setup] TEST_HOME=${TEST_HOME}  (no WMUX_DATA_SUFFIX — the bridge cannot see one)`);
  console.log(`[setup] bundle mtime=${fs.statSync(DAEMON).mtime.toISOString()}`);
  console.log(`[setup] production daemon on this machine is NOT touched`);

  daemonPid = startDaemon();
  if (!await waitReady()) throw new Error('daemon never became ready');
  console.log(`[setup] daemon pid=${daemonPid} pipe=${readPipeName()}  (private, not the production name)`);
  fs.mkdirSync(WMUX_DIR, { recursive: true });
  fs.copyFileSync(path.join(DAEMON_DIR, 'daemon-pipe'), path.join(WMUX_DIR, 'daemon-pipe'));
  fs.copyFileSync(path.join(DAEMON_DIR, 'daemon-auth-token'), path.join(WMUX_DIR, 'daemon-auth-token'));
  console.log('[setup] planted daemon-pipe + daemon-auth-token at the unsuffixed path the bridge reads');

  const ptyId = `dogfood-${TAG}`;
  await rpc('daemon.createSession', {
    id: ptyId, cmd: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    cwd: TEST_HOME, cols: 120, rows: 30,
  });
  console.log(`[setup] pane=${ptyId}`);
  await sleep(1200);

  sub = broadcastListener();
  await sleep(400);

  // --- S1: the real bridge delivers a Stop to the daemon, GUI closed ---------
  const r1 = runBridge('Stop', {
    session_id: `claude-${TAG}`,
    cwd: TEST_HOME,
    hook_event_name: 'Stop',
  }, { WMUX_PTY_ID: ptyId });

  const ev1 = await sub.waitFor((f) => f.type === 'agent.event' && f.sessionId === ptyId
    && f.data?.source === 'hook' && f.data?.hookKind === 'agent.stop');

  const s1 = {
    bridgeExit: r1.status, bridgeMs: r1.ms, bridgeStderr: r1.stderr,
    daemonEvent: ev1?.data ? {
      agent: ev1.data.agent, status: ev1.data.status, source: ev1.data.source,
      hookKind: ev1.data.hookKind, decision: ev1.data.decision,
    } : null,
    bridgeLog: bridgeLogTail(4),
  };
  record('S1 real-bridge-reaches-daemon', r1.status === 0 && !!ev1 && ev1.data.decision === 'emit', s1);

  // --- S2: PreToolUse/AskUserQuestion creates a real approval request --------
  const r2 = runBridge('PreToolUse', {
    session_id: `claude-${TAG}`,
    cwd: TEST_HOME,
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [{
        question: 'Dogfood: which deploy target?',
        options: [{ label: 'Staging' }, { label: 'Production' }],
      }],
    },
  }, { WMUX_PTY_ID: ptyId });

  await sleep(900);
  const list = await rpc('daemon.approvals.list', {});
  const pend = (list?.pending ?? []).find((r) => r.sessionId === ptyId);
  const s2 = {
    bridgeExit: r2.status, bridgeMs: r2.ms,
    pending: pend ? { id: pend.id, agent: pend.agent, question: pend.question, options: pend.options } : null,
  };
  record('S2 bridge-PreToolUse-creates-approval-with-question',
    r2.status === 0 && !!pend && pend.question === 'Dogfood: which deploy target?'
    && Array.isArray(pend.options) && pend.options[0] === 'Staging' && pend.options[1] === 'Production',
    s2);

  // --- S3: kill switch routes to main only (no daemon delivery) -------------
  const before = sub.frames.length;
  const r3 = runBridge('Stop', {
    session_id: `claude-${TAG}`, cwd: TEST_HOME, hook_event_name: 'Stop',
  }, { WMUX_PTY_ID: ptyId, WMUX_HOOKS_TO_MAIN: '1' });
  await sleep(1200);
  const newHookEvents = sub.frames.slice(before).filter(
    (f) => f.type === 'agent.event' && f.sessionId === ptyId && f.data?.source === 'hook');
  const s3 = {
    bridgeExit: r3.status, bridgeMs: r3.ms,
    hookEventsAfterKillSwitch: newHookEvents.length,
    note: 'no main pipe exists in this temp home, so the bridge should fail fast and NOT reach the daemon',
    bridgeLog: bridgeLogTail(4),
  };
  record('S3 kill-switch-skips-the-daemon', newHookEvents.length === 0 && r3.ms < 8000, s3);

  // --- S4: daemon down — the bridge fails fast instead of hanging the agent --
  sub.close(); sub = null;
  try { process.kill(daemonPid, 'SIGKILL'); } catch { /* already gone */ }
  await sleep(1500);
  const r4 = runBridge('Stop', {
    session_id: `claude-${TAG}`, cwd: TEST_HOME, hook_event_name: 'Stop',
  }, { WMUX_PTY_ID: ptyId });
  const s4 = {
    bridgeExit: r4.status, bridgeMs: r4.ms,
    withinHookBudget: r4.ms < 8000,
    bridgeLog: bridgeLogTail(6),
    why: 'a hook that hangs stalls the agent itself — this is the property that matters most',
  };
  record('S4 no-daemon-no-hang', r4.ms < 8000, s4);
  daemonPid = null;

  console.log(`\n${JSON.stringify(results, null, 2)}\n`);
} catch (err) {
  console.error(`[fatal] ${err?.stack || err}`);
  results.push({ scenario: 'harness', pass: false, evidence: { error: String(err) } });
} finally {
  try { sub?.close(); } catch { /* ignore */ }
  if (daemonPid) { try { process.kill(daemonPid, 'SIGKILL'); } catch { /* ignore */ } }
  await sleep(700);
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log('=== Summary ===');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.scenario}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed} pass, ${failed} fail`);
  process.exit(failed === 0 ? 0 : 1);
}
