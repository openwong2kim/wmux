#!/usr/bin/env node
/**
 * M1 acceptance harness — hook ingestion in the daemon, GUI closed.
 *
 * Spawns the BUNDLED daemon (dist/daemon-bundle/index.js) in a doubly-isolated
 * state dir (temp USERPROFILE/HOME **and** a fresh WMUX_DATA_SUFFIX, so even a
 * failed home override cannot land on the production ~/.wmux), creates real
 * PTY panes, and stands in for `integrations/<agent>/bin/wmux-bridge.mjs` by calling
 * `daemon.hooks.signal` straight over the daemon control pipe. No Electron main
 * process exists at any point — that IS the "GUI closed" condition M1 is for.
 *
 * What the unit suite cannot cover and this does:
 *   - the RPC is really registered on the bundled daemon (TS→bundle drift),
 *   - `agent.event` really reaches a pipe subscriber with source/decision stamps,
 *   - arbitration runs against the REAL AgentDetector fed by REAL ConPTY bytes,
 *   - the daemon's admission control vs. the bridge's one-connection-per-signal
 *     model under a hook storm,
 *   - meter state really resets when the daemon is SIGKILLed and comes back.
 *
 * Scenarios:
 *
 *   S1  GUI-closed authority. Minimum bridge envelope → `agent.event` broadcast
 *       with source:'hook', decision:'emit', hookKind, and the envelope echoed
 *       back in `signal`. Response is double-wrapped: {id, ok, result:{ok}}.
 *
 *   S2  Iron Rule, both orderings, driven by the real detector. A plain cmd.exe
 *       pane prints the Claude gate banner, then an idle-prompt line the
 *       AgentDetector matches → detector 'emit'. A hook of the same kind within
 *       the 10s window → 'dedup' (still broadcast — forensic policy; the toast
 *       gate lives in main). The hook then holds authority on the pane, so the
 *       next detector line → 'veto'.
 *
 *   S3  Metadata class. agent.activity and agent.session_start broadcast
 *       immediately as decision:'activity' with no daemon-side throttle, and
 *       never touch the dedup ledger.
 *
 *   S4  daemon.hooks.health. latency.total moves by exactly N over N signals;
 *       flood is null on a never-signalled daemon and an object afterwards;
 *       two back-to-back reads are identical (peek, not flush).
 *
 *   S5  Flood. 100 signals both ways — one fresh connection per signal (what
 *       the bridge actually does) and one reused connection — with daemon.ping
 *       interleaved throughout on a third connection. Counts accepted vs
 *       dropped by admission control (MAX_CONNECTIONS=20, 20 new conn/s).
 *
 *   S6  Restart invalidation. SIGKILL the daemon, restart on the same suffix →
 *       health resets to total=0/flood=null and a fresh signal still works
 *       end to end on a brand new pane.
 *
 * Usage:  node scripts/hooks-daemon-dynamic.mjs
 * Exit:   0 all pass, 1 a scenario failed, 2 preconditions unmet.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DAEMON_BUNDLE = path.join(REPO_ROOT, 'dist', 'daemon-bundle', 'index.js');

if (!fs.existsSync(DAEMON_BUNDLE)) {
  console.error('Daemon bundle missing — run `npm run build:daemon` first');
  process.exit(2);
}

// === Isolation =============================================================
// Two independent guards, because a single one failing would point the daemon
// at the user's real ~/.wmux: (1) USERPROFILE/HOME → a fresh temp dir,
// (2) WMUX_DATA_SUFFIX → a per-run suffix, so the data dir name itself can
// never equal `.wmux`.
const RUN_TAG = randomUUID().slice(0, 8);
const DATA_SUFFIX = `-m1hooks-${RUN_TAG}`;
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-m1hooks-'));
const WMUX_DIR = path.join(TEST_HOME, `.wmux${DATA_SUFFIX}`);
const PANE_CWD = path.join(TEST_HOME, 'pane');
fs.mkdirSync(WMUX_DIR, { recursive: true });
fs.mkdirSync(PANE_CWD, { recursive: true });

const PIPE_NAME =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\wmux-test-m1hooks-${RUN_TAG}`
    : path.join(TEST_HOME, `.wmux-test-m1hooks-${RUN_TAG}.sock`);
const AUTH_TOKEN = randomUUID();
const SHELL = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';

fs.writeFileSync(
  path.join(WMUX_DIR, 'config.json'),
  JSON.stringify({
    version: 1,
    daemon: { pipeName: PIPE_NAME, logLevel: 'info', autoStart: true },
    session: {
      defaultShell: SHELL,
      defaultCols: 120,
      defaultRows: 30,
      bufferSizeMb: 8,
      bufferMaxMb: 64,
      deadSessionTtlHours: 24,
      deadSessionDumpBuffer: false,
    },
  }, null, 2),
);
fs.writeFileSync(path.join(WMUX_DIR, 'daemon-auth-token'), AUTH_TOKEN, 'utf-8');
fs.writeFileSync(path.join(WMUX_DIR, 'sessions.json'), JSON.stringify({ version: 1, sessions: [] }));

const PIPE_HINT_FILE = path.join(WMUX_DIR, 'daemon-pipe');

// === Daemon lifecycle ======================================================

let daemon = null;
const daemonLog = [];

function spawnDaemon() {
  const child = spawn(process.execPath, [DAEMON_BUNDLE], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      USERPROFILE: TEST_HOME,
      HOME: TEST_HOME,
      HOMEDRIVE: undefined,
      HOMEPATH: undefined,
      WMUX_DATA_SUFFIX: DATA_SUFFIX,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { daemonLog.push(d.toString()); });
  child.stderr.on('data', (d) => { daemonLog.push(d.toString()); });
  return child;
}

async function waitForPipeFile(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(PIPE_HINT_FILE)) {
      const name = fs.readFileSync(PIPE_HINT_FILE, 'utf-8').trim();
      if (name) return name;
    }
    await sleep(100);
  }
  throw new Error('daemon-pipe hint file did not appear within timeout');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// === Control-pipe client ===================================================
//
// Responses are matched by `id` — the daemon interleaves id-less broadcast
// frames {type, sessionId, data} between RPC responses, so a naive
// "first line back is my answer" reader corrupts every result.

class PipeClient {
  constructor(socket, { onEvent } = {}) {
    this.socket = socket;
    this.pending = new Map();
    this.onEvent = onEvent ?? null;
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.id === 'string' && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(timer);
          if (msg.ok) resolve(msg.result);
          else reject(new Error(msg.error ?? 'rpc error'));
          continue;
        }
        if (msg.type && this.onEvent) this.onEvent(msg);
      }
    });
    socket.on('error', () => {});
  }

  static async connect(pipeName, opts) {
    const socket = await new Promise((resolve, reject) => {
      const s = net.createConnection(pipeName);
      const t = setTimeout(() => { s.destroy(); reject(new Error('connect timeout')); }, 8_000);
      s.once('connect', () => { clearTimeout(t); resolve(s); });
      s.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    const client = new PipeClient(socket, opts);
    // Events are opt-in on the daemon side, so a caller that passes onEvent has
    // to ask for them or it waits forever on frames that are never sent.
    if (opts?.onEvent) await client.rpc('daemon.events.subscribe');
    return client;
  }

  rpc(method, params = {}, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const id = `req-${Math.random().toString(36).slice(2, 12)}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params, token: AUTH_TOKEN }) + '\n');
    });
  }

  close() {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.socket.destroy();
  }
}

// === Event collection ======================================================

const events = [];          // every broadcast frame, in arrival order
let eventSeq = 0;

function recordEvent(msg) {
  events.push({ seq: eventSeq++, at: Date.now(), msg });
}

/** agent.event frames for a session, oldest first. */
function agentEventsFor(sessionId) {
  return events
    .filter((e) => e.msg.type === 'agent.event' && e.msg.sessionId === sessionId)
    .map((e) => ({ seq: e.seq, at: e.at, data: e.msg.data }));
}

/** Index to pass as `from` — take it BEFORE the call that should produce the
 *  event. The daemon broadcasts while it is still handling the RPC, so an
 *  index captured after the response has already skipped past the frame. */
const mark = () => events.length;

async function waitForEvent(predicate, timeoutMs = 8_000, from = 0) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = from; i < events.length; i++) {
      if (predicate(events[i])) return events[i];
    }
    await sleep(25);
  }
  return null;
}

// === Bridge stand-in =======================================================

/**
 * The MINIMUM envelope a bridge sends. `workspaceId` is deliberately omitted:
 * it cross-checks the pane env and is not needed once ptyId names a live
 * session (routing tier 1).
 */
function envelope(sessionId, kind = 'agent.stop', extra = {}) {
  return {
    kind,
    agent: 'claude',
    ptyId: sessionId,
    cwd: PANE_CWD,
    payload: {},
    ts: Date.now(),
    ...extra,
  };
}

/**
 * One-shot signal over a FRESH connection — exactly what wmux-bridge.mjs does
 * per hook. Never throws: an admission-dropped connection is data, not an
 * error (the daemon destroys excess sockets without a response).
 */
function oneShotSignal(pipeName, env, timeoutMs = 4_000) {
  return new Promise((resolve) => {
    const id = `req-${Math.random().toString(36).slice(2, 12)}`;
    let settled = false;
    let buf = '';
    // Mirrors wmux-bridge.mjs sendRpc: `wrote` is set the moment the request is
    // handed to the socket, and it is what decides whether the bridge may retry
    // or fall back (retryable === !wrote). Tracking it here turns "dropped" into
    // the two operationally different halves the bridge sees.
    let wrote = false;
    const sock = net.createConnection(pipeName);
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ ...outcome, wrote, bridgeWouldRetryOrFallBack: !wrote });
    };
    const timer = setTimeout(() => finish({ accepted: false, reason: 'timeout' }), timeoutMs);
    sock.on('connect', () => {
      sock.write(JSON.stringify({ id, method: 'daemon.hooks.signal', params: env, token: AUTH_TOKEN }) + '\n');
      wrote = true;
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === id) finish({ accepted: true, ok: msg.ok, result: msg.result, error: msg.error });
      }
    });
    sock.on('error', (e) => finish({ accepted: false, reason: `connect-error:${e.code ?? e.message}` }));
    sock.on('close', () => finish({ accepted: false, reason: 'destroyed-without-response' }));
  });
}

// === Session helpers =======================================================

const liveSessions = new Set();

async function createPane(control, id) {
  await control.rpc('daemon.createSession', {
    id,
    cmd: SHELL,
    cwd: PANE_CWD,
    cols: 120,
    rows: 30,
  });
  liveSessions.add(id);
  return id;
}

/** Attach and return a writer that feeds bytes into the pane's stdin. */
async function attachPane(control, id) {
  await control.rpc('daemon.attachSession', { id });
  const sessionPipeName = process.platform === 'win32'
    ? `\\\\.\\pipe\\wmux-session-${id}`
    : path.join(WMUX_DIR, `session-${id}.sock`);
  const sock = await new Promise((resolve, reject) => {
    const s = net.createConnection(sessionPipeName);
    const t = setTimeout(() => { s.destroy(); reject(new Error('session pipe connect timeout')); }, 8_000);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(e); });
  });
  sock.write(AUTH_TOKEN + '\n');
  let sawOutput = false;
  let out = '';
  sock.on('data', (d) => { sawOutput = true; out += d.toString(); });
  sock.on('error', () => {});
  // Wait for the shell to actually print a prompt before typing at it.
  const deadline = Date.now() + 8_000;
  while (!sawOutput && Date.now() < deadline) await sleep(100);
  await sleep(800);
  return {
    socket: sock,
    output: () => out,
    /**
     * Type a line, then send a bare CR. cmd.exe prints its next prompt on the
     * SAME line as the command's output, so without the extra (empty-command)
     * CR the final output line never terminates — and AgentDetector only runs
     * status patterns on COMPLETED lines (gates alone see the partial tail).
     */
    async type(line) {
      sock.write(`${line}\r`);
      await sleep(700);
      sock.write('\r');
      await sleep(700);
    },
  };
}

async function destroyPanes(control) {
  for (const id of Array.from(liveSessions)) {
    await control.rpc('daemon.destroySession', { id }).catch(() => {});
    liveSessions.delete(id);
  }
}

// === Scenarios =============================================================

const report = [];
function record(scenario, pass, evidence) {
  report.push({ scenario, pass, evidence });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${scenario}`);
}

/** S1 — a bridge-shaped call reaches a pipe subscriber with the GUI closed. */
async function scenario1(control, sessionId) {
  const env = envelope(sessionId, 'agent.stop');
  const from = mark();
  const result = await control.rpc('daemon.hooks.signal', env);
  const evt = await waitForEvent(
    (e) => e.msg.type === 'agent.event'
      && e.msg.sessionId === sessionId
      && e.msg.data?.source === 'hook',
    8_000,
    from,
  );
  const data = evt?.msg.data ?? null;
  const pass =
    result?.ok === true &&
    data !== null &&
    data.source === 'hook' &&
    data.decision === 'emit' &&
    data.hookKind === 'agent.stop' &&
    data.status === 'complete' &&
    data.agent === 'Claude Code' &&
    !!data.signal &&
    data.signal.kind === 'agent.stop' &&
    data.signal.ptyId === sessionId &&
    data.signal.ts === env.ts;
  record('S1 gui-closed-authority', pass, {
    electronMainRunning: false,
    envelopeSent: env,
    rpcResultDoubleWrapped: result,
    broadcast: data,
  });
}

/**
 * S2 — Iron Rule against the REAL detector.
 *   detector emit → hook dedup → detector veto
 * The gate line activates AgentDetector's Claude patterns; each following
 * line is a distinct pattern match so the detector's own per-(agent,status)
 * emission dedup does not eat the second one.
 */
async function scenario2(control, sessionId) {
  const pane = await attachPane(control, sessionId);
  const evidence = { steps: [] };
  try {
    const gateFrom = mark();
    await pane.type('echo Claude Code');
    const gate = await waitForEvent(
      (e) => e.msg.type === 'agent.event'
        && e.msg.sessionId === sessionId
        && e.msg.data?.source === 'detector'
        && e.msg.data?.status === 'running',
      8_000,
      gateFrom,
    );
    evidence.steps.push({ step: 'gate', broadcast: gate?.msg.data ?? null });

    const detFrom = mark();
    await pane.type('echo bypass permissions on');
    const detectorEmit = await waitForEvent(
      (e) => e.msg.type === 'agent.event'
        && e.msg.sessionId === sessionId
        && e.msg.data?.source === 'detector'
        && e.msg.data?.decision === 'emit',
      8_000,
      detFrom,
    );
    evidence.steps.push({ step: 'detector', broadcast: detectorEmit?.msg.data ?? null });

    // Same kind, well inside the 10s dedup window.
    const hookAt = Date.now();
    const hookFrom = mark();
    const hookResult = await control.rpc('daemon.hooks.signal', envelope(sessionId, 'agent.stop'));
    const hookDedup = await waitForEvent(
      (e) => e.msg.type === 'agent.event'
        && e.msg.sessionId === sessionId
        && e.msg.data?.source === 'hook',
      8_000,
      hookFrom,
    );
    evidence.steps.push({
      step: 'hook',
      msSinceDetector: detectorEmit ? hookAt - detectorEmit.at : null,
      rpcResult: hookResult,
      broadcast: hookDedup?.msg.data ?? null,
    });

    // The hook now holds authority on this pane → the next detector line is
    // vetoed rather than deduped (no ledger write at all).
    const vetoFrom = mark();
    await pane.type('echo shift+tab to cycle');
    const detectorVeto = await waitForEvent(
      (e) => e.msg.type === 'agent.event'
        && e.msg.sessionId === sessionId
        && e.msg.data?.source === 'detector'
        && e.msg.data?.decision === 'veto',
      8_000,
      vetoFrom,
    );
    evidence.steps.push({ step: 'detector-after-hook', broadcast: detectorVeto?.msg.data ?? null });

    const decisions = agentEventsFor(sessionId)
      .filter((e) => e.data?.decision)
      .map((e) => `${e.data.source}:${e.data.decision}`);
    evidence.decisionOrder = decisions;
    evidence.allAgentEvents = agentEventsFor(sessionId).map((e) => ({
      source: e.data?.source, status: e.data?.status, decision: e.data?.decision ?? null, message: e.data?.message,
    }));
    evidence.paneOutputTail = pane.output().replace(/\[[0-9;?]*[A-Za-z]/g, '').slice(-600);

    const pass =
      detectorEmit !== null &&
      hookDedup?.msg.data?.decision === 'dedup' &&
      hookResult?.ok === true &&
      detectorVeto !== null &&
      decisions.join(' → ').includes('detector:emit → hook:dedup → detector:veto');
    record('S2 iron-rule-dedup-and-veto', pass, evidence);
  } finally {
    pane.socket.destroy();
  }
}

/** S3 — metadata-class kinds broadcast immediately, tagged decision:'activity'. */
async function scenario3(control, sessionId) {
  const out = {};
  for (const kind of ['agent.activity', 'agent.session_start']) {
    const env = envelope(sessionId, kind, { payload: { tool_name: 'Bash' } });
    const sentAt = Date.now();
    const from = mark();
    const result = await control.rpc('daemon.hooks.signal', env);
    const evt = await waitForEvent(
      (e) => e.msg.type === 'agent.event'
        && e.msg.sessionId === sessionId
        && e.msg.data?.hookKind === kind,
      8_000,
      from,
    );
    out[kind] = {
      rpcResult: result,
      latencyMs: evt ? evt.at - sentAt : null,
      broadcast: evt?.msg.data ?? null,
    };
  }
  const a = out['agent.activity'];
  const s = out['agent.session_start'];
  const pass =
    a.broadcast?.decision === 'activity' &&
    a.broadcast?.hookKind === 'agent.activity' &&
    a.broadcast?.status === 'running' &&
    a.broadcast?.message === '' &&
    a.latencyMs !== null && a.latencyMs < 1_000 &&
    s.broadcast?.decision === 'activity' &&
    s.broadcast?.hookKind === 'agent.session_start' &&
    s.latencyMs !== null && s.latencyMs < 1_000;
  record('S3 metadata-class-immediate', pass, out);
}

/** S4 — daemon.hooks.health counters move by N and read non-destructively. */
async function scenario4(control, sessionId, healthAtBoot) {
  const before = await control.rpc('daemon.hooks.health', {});
  const N = 5;
  for (let i = 0; i < N; i++) {
    await control.rpc('daemon.hooks.signal', envelope(sessionId, 'agent.activity'));
  }
  const after = await control.rpc('daemon.hooks.health', {});
  const afterAgain = await control.rpc('daemon.hooks.health', {});

  const evidence = {
    healthAtBoot,
    before: before.latency,
    afterNSignals: after.latency,
    N,
    delta: after.latency.total - before.latency.total,
    floodAtBoot: healthAtBoot.flood,
    floodAfter: after.flood,
    secondReadIdentical: JSON.stringify(after) === JSON.stringify(afterAgain),
    secondRead: afterAgain,
  };
  const pass =
    healthAtBoot.latency.total === 0 &&
    healthAtBoot.flood === null &&
    after.latency.total - before.latency.total === N &&
    after.flood !== null &&
    typeof after.flood.total === 'number' &&
    evidence.secondReadIdentical;
  record('S4 health-counters', pass, evidence);
}

/**
 * S5 — hook storm. Two delivery modes against the same daemon, with
 * daemon.ping interleaved on an already-established connection throughout.
 */
async function scenario5(control, pipeName, sessionId) {
  const BURST = 100;
  const pings = [];
  let pinging = true;
  const pingLoop = (async () => {
    while (pinging) {
      const t0 = Date.now();
      try {
        const res = await control.rpc('daemon.ping', {}, 5_000);
        pings.push({ ms: Date.now() - t0, status: res?.status ?? null });
      } catch (err) {
        pings.push({ ms: Date.now() - t0, status: `error:${err.message}` });
      }
      await sleep(200);
    }
  })();

  const healthBefore = await control.rpc('daemon.hooks.health', {});

  // Mode B — one FRESH connection per signal, all fired at once. This is what
  // the bridge really does, and it is the mode admission control bites.
  const perConnStart = Date.now();
  const perConn = await Promise.all(
    Array.from({ length: BURST }, () => oneShotSignal(pipeName, envelope(sessionId, 'agent.activity'))),
  );
  const perConnMs = Date.now() - perConnStart;
  const perConnAccepted = perConn.filter((r) => r.accepted && r.ok).length;
  const perConnDropped = perConn.length - perConnAccepted;
  const dropReasons = {};
  let dropRetryable = 0;
  let dropLostSilently = 0;
  for (const r of perConn) {
    if (r.accepted && r.ok) continue;
    const k = r.reason ?? `rpc-error:${r.error}`;
    dropReasons[k] = (dropReasons[k] ?? 0) + 1;
    if (r.bridgeWouldRetryOrFallBack) dropRetryable++;
    else dropLostSilently++;
  }

  // Let the 1s connection-rate window drain before the second mode.
  await sleep(1_500);

  // Mode A — ONE reused connection, all BURST signals pipelined. Sidesteps
  // connection admission entirely; only the per-socket RPC cap applies.
  const reused = await PipeClient.connect(pipeName, { onEvent: () => {} });
  const reusedStart = Date.now();
  const reusedResults = await Promise.allSettled(
    Array.from({ length: BURST }, () =>
      reused.rpc('daemon.hooks.signal', envelope(sessionId, 'agent.activity'), 10_000)),
  );
  const reusedMs = Date.now() - reusedStart;
  const reusedAccepted = reusedResults.filter((r) => r.status === 'fulfilled' && r.value?.ok === true).length;
  reused.close();

  pinging = false;
  await pingLoop;

  const healthAfter = await control.rpc('daemon.hooks.health', {});
  const slowPings = pings.filter((p) => p.ms >= 1_000 || p.status !== 'ok');

  const evidence = {
    burstSize: BURST,
    perSignalConnection: {
      accepted: perConnAccepted,
      dropped: perConnDropped,
      elapsedMs: perConnMs,
      dropReasons,
      // Split by the bridge's own no-double-fire rule (retryable === !wrote):
      // a drop AFTER the write is ambiguous to the bridge, so it neither
      // retries nor falls back to the main pipe — the signal is simply lost.
      droppedBeforeWrite_bridgeRetriesOrFallsBack: dropRetryable,
      droppedAfterWrite_bridgeStopsWalk: dropLostSilently,
      note: 'daemon admission: MAX_CONNECTIONS=20 (incl. this harness\'s 2 long-lived sockets), MAX_NEW_CONNECTIONS_PER_SEC=20; excess sockets are destroyed with no response',
    },
    singleReusedConnection: { accepted: reusedAccepted, elapsedMs: reusedMs },
    ping: {
      count: pings.length,
      maxMs: pings.reduce((m, p) => Math.max(m, p.ms), 0),
      allOkUnder1s: slowPings.length === 0,
      slow: slowPings,
    },
    latencyTotalDelta: healthAfter.latency.total - healthBefore.latency.total,
    expectedDelta: perConnAccepted + reusedAccepted,
  };
  const pass =
    pings.length > 0 &&
    slowPings.length === 0 &&
    reusedAccepted === BURST &&
    evidence.latencyTotalDelta === evidence.expectedDelta;
  record('S5 flood-ping-green', pass, evidence);
}

/** S6 — SIGKILL the daemon, restart on the same suffix, meters must be fresh. */
async function scenario6(control) {
  await destroyPanes(control);
  const healthBeforeKill = await control.rpc('daemon.hooks.health', {});
  control.close();

  const oldPid = daemon.pid;
  const exited = new Promise((r) => daemon.once('exit', (code, sig) => r({ code, sig })));
  daemon.kill('SIGKILL');
  const exitInfo = await Promise.race([exited, sleep(10_000).then(() => ({ code: null, sig: 'no-exit' }))]);
  try { fs.rmSync(PIPE_HINT_FILE, { force: true }); } catch { /* ignore */ }
  await sleep(1_000);

  daemon = spawnDaemon();
  const newPipe = await waitForPipeFile();
  const fresh = await PipeClient.connect(newPipe, { onEvent: recordEvent });

  const healthAfterRestart = await fresh.rpc('daemon.hooks.health', {});

  const sessionId = `m1-restart-${RUN_TAG}`;
  await createPane(fresh, sessionId);
  const env = envelope(sessionId, 'agent.stop');
  const from = mark();
  const result = await fresh.rpc('daemon.hooks.signal', env);
  const evt = await waitForEvent(
    (e) => e.msg.type === 'agent.event'
      && e.msg.sessionId === sessionId
      && e.msg.data?.source === 'hook',
    8_000,
    from,
  );
  const healthAfterSignal = await fresh.rpc('daemon.hooks.health', {});

  const evidence = {
    oldDaemonPid: oldPid,
    killSignalExit: exitInfo,
    newDaemonPid: daemon.pid,
    pipeAfterRestart: newPipe,
    healthBeforeKill: healthBeforeKill.latency,
    healthAfterRestart,
    freshSignalRpcResult: result,
    freshSignalBroadcast: evt?.msg.data ?? null,
    latencyTotalAfterOneSignal: healthAfterSignal.latency.total,
  };
  const pass =
    healthBeforeKill.latency.total > 0 &&
    healthAfterRestart.latency.total === 0 &&
    healthAfterRestart.flood === null &&
    result?.ok === true &&
    evt !== null &&
    evt.msg.data.decision === 'emit' &&
    evt.msg.data.source === 'hook' &&
    healthAfterSignal.latency.total === 1;
  record('S6 restart-invalidation', pass, evidence);
  return fresh;
}

// === Main ==================================================================

let control = null;
let eventsClient = null;
let exitCode = 2;

try {
  console.log(`[setup] TEST_HOME=${TEST_HOME}`);
  console.log(`[setup] WMUX_DATA_SUFFIX=${DATA_SUFFIX} (data dir ${WMUX_DIR})`);
  console.log(`[setup] bundle mtime=${fs.statSync(DAEMON_BUNDLE).mtime.toISOString()}`);

  daemon = spawnDaemon();
  const pipeName = await waitForPipeFile();
  console.log(`[setup] daemon pid=${daemon.pid} listening on ${pipeName}`);

  // Dedicated broadcast subscriber, separate from the RPC connection so a
  // saturated control socket can never hide an event.
  eventsClient = await PipeClient.connect(pipeName, { onEvent: recordEvent });
  control = await PipeClient.connect(pipeName, { onEvent: () => {} });

  const ping = await control.rpc('daemon.ping', {});
  if (ping?.status !== 'ok') throw new Error(`daemon.ping unhealthy: ${JSON.stringify(ping)}`);

  // Read health BEFORE any signal so S4 can assert the never-signalled shape.
  const healthAtBoot = await control.rpc('daemon.hooks.health', {});

  const hookSession = `m1-hook-${RUN_TAG}`;
  const detectorSession = `m1-det-${RUN_TAG}`;
  await createPane(control, hookSession);
  await createPane(control, detectorSession);

  await scenario1(control, hookSession);
  await scenario2(control, detectorSession);
  await scenario3(control, hookSession);
  await scenario4(control, hookSession, healthAtBoot);
  await scenario5(control, pipeName, hookSession);
  control = await scenario6(control);

  const failures = report.filter((r) => r.pass === false);
  exitCode = failures.length === 0 ? 0 : 1;

  console.log('\n=== Evidence ===');
  for (const r of report) console.log(JSON.stringify(r, null, 2));
  console.log('\n=== Summary ===');
  for (const r of report) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.scenario}`);
  console.log(`\n${report.length - failures.length} pass, ${failures.length} fail`);
} catch (err) {
  console.error('[fatal]', err?.stack ?? err);
  console.error('--- daemon output tail ---');
  console.error(daemonLog.join('').slice(-4000));
  // 2 = preconditions/setup never got far enough to judge M1; 1 = scenarios ran
  // and something is actually wrong.
  exitCode = report.length > 0 ? 1 : 2;
} finally {
  try { if (control) await destroyPanes(control); } catch { /* ignore */ }
  try { control?.close(); } catch { /* ignore */ }
  try { eventsClient?.close(); } catch { /* ignore */ }
  if (daemon && !daemon.killed) {
    try { daemon.kill('SIGKILL'); } catch { /* ignore */ }
  }
  await sleep(500);
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(exitCode);
