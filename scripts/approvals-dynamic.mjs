#!/usr/bin/env node
/**
 * M2 acceptance harness — approvals end to end, GUI closed.
 *
 * Sibling of scripts/hooks-daemon-dynamic.mjs and built on the same isolation:
 * the BUNDLED daemon (dist/daemon-bundle/index.js) in a temp USERPROFILE/HOME
 * **and** a fresh WMUX_DATA_SUFFIX, so even a failed home override cannot land
 * on the production ~/.wmux. No Electron main process exists at any point —
 * that IS the "GUI closed" condition the milestone is for.
 *
 * The unit suites for ApprovalRegistry and WebTerminalServer both run against
 * injected fakes (fake screen reader, fake writer, fake registry). Everything
 * that only breaks where those fakes meet reality is here:
 *
 *   - the QUESTION and OPTION LABELS survive the real bridge envelope → real
 *     HookIngest extraction → real registry → real HTTP body. The extractor is
 *     deliberately tolerant, so a shape mismatch degrades to absent fields and
 *     passes its unit tests silently; here they must be NON-EMPTY and VERBATIM.
 *   - `looksLikeApprovalPrompt` against a REAL ConPTY grid parsed by the REAL
 *     headless snapshot, not a hand-written string array. This is the single
 *     biggest unverified assumption in M2: if the heuristic rejects a screen a
 *     human would call answerable, every approve on that build is a 410.
 *   - the keystroke really reaches the PTY (visible in the pane's own echo) and
 *     really does NOT when the resolve refuses.
 *   - the read-only carve-out on ONE running server: approve works, /api/input
 *     on the same server is still 403.
 *   - the create event really rides the #600 replay channel with the content
 *     fields stripped, and a Last-Event-ID cursor really replays it.
 *   - pending really does not survive a SIGKILL.
 *
 * Scenarios:
 *
 *   S1  create. Hook awaiting_input with the canonical AskUserQuestion
 *       tool_input → pending over GET /api/approvals carrying the question text
 *       and both option labels byte-for-byte as sent.
 *
 *   S2  SSE. The create is observable on /api/events as an `approval` event
 *       (phase 'create', matching approvalId) with NO question/options/
 *       screenTail on the wire, and a Last-Event-ID cursor from before the
 *       create replays it on a fresh connection.
 *
 *   S3  approve on a READ-ONLY server. A fake AskUserQuestion screen is printed
 *       into the pane, the request is approved over HTTP, and '1' shows up in
 *       the pane's own echo. POST /api/input on the SAME server is still 403.
 *
 *   S3b unicode cursor row. The same thing with the glyph Claude's TUI actually
 *       renders (`│ ❯ 1. Yes`) instead of the ASCII `>`. This is the fidelity
 *       check for CURSOR_OPTION_ROW.
 *
 *   S3c deny. ESC, not '1' — the pane must show no digit.
 *
 *   S4  double-resolve. The second POST on a resolved id → 409 with
 *       resolvedBy naming the caller — 'operator' here, since the harness
 *       authenticates with the operator token. It used to be the constant
 *       'web' for every caller alike, which meant the roster could not say
 *       WHICH paired phone pressed a key into a terminal.
 *
 *   S5  supersede. A second awaiting_input on the same session → the old record
 *       leaves `pending` in state 'superseded'; resolving the OLD id → 410.
 *
 *   S6  prompt-gone. Flood the pane until no cursor-option row is left in the
 *       visible grid → approve → 410 prompt-gone, and NOT ONE BYTE written.
 *
 *   S7  tolerant + unsupported. awaiting_input whose payload is not an
 *       AskUserQuestion still creates a request (without question/options), and
 *       an `agent:'codex'` request answers 501 unsupported-agent while STAYING
 *       pending (unsupported is not an expiry).
 *
 *   S8  restart. SIGKILL the daemon, restart on the same suffix → the web
 *       server restores itself (#596) and GET /api/approvals reports zero
 *       pending, with the survivor recorded as 'expired'.
 *
 * Usage:  node scripts/approvals-dynamic.mjs
 * Exit:   0 all pass, 1 a scenario failed, 2 preconditions unmet.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DAEMON_BUNDLE = path.join(REPO_ROOT, 'dist', 'daemon-bundle', 'index.js');
const WEB_ASSETS = path.join(REPO_ROOT, 'dist', 'daemon-web', 'terminal.html');

if (!fs.existsSync(DAEMON_BUNDLE)) {
  console.error('Daemon bundle missing — run `npm run build:daemon` first');
  process.exit(2);
}
if (!fs.existsSync(WEB_ASSETS)) {
  console.error('Daemon web assets missing — run `node scripts/build-daemon-web.mjs` first');
  process.exit(2);
}

// === Isolation =============================================================

const RUN_TAG = randomUUID().slice(0, 8);
const DATA_SUFFIX = `-m2appr-${RUN_TAG}`;
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-m2appr-'));
const WMUX_DIR = path.join(TEST_HOME, `.wmux${DATA_SUFFIX}`);
const PANE_CWD = path.join(TEST_HOME, 'pane');
fs.mkdirSync(WMUX_DIR, { recursive: true });
fs.mkdirSync(PANE_CWD, { recursive: true });

const PIPE_NAME =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\wmux-test-m2appr-${RUN_TAG}`
    : path.join(TEST_HOME, `.wmux-test-m2appr-${RUN_TAG}.sock`);
const AUTH_TOKEN = randomUUID();
const SHELL = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
// Away from 7681 so a real `wmux web` on this machine is never touched.
const WEB_PORT = 19_000 + Math.floor(Math.random() * 800);

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
const APPROVALS_FILE = path.join(WMUX_DIR, 'approvals.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// === Control-pipe client ===================================================
// Responses are matched by `id` — the daemon interleaves id-less broadcast
// frames between RPC responses.

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
    return new PipeClient(socket, opts);
  }

  rpc(method, params = {}, timeoutMs = 15_000) {
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

// === HTTP client ===========================================================

let webToken = '';

function httpRequest(method, pathname, { token = webToken, body, headers = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: WEB_PORT,
        path: pathname,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let json = null;
          try { json = buf ? JSON.parse(buf) : null; } catch { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, raw: buf, json });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('http timeout')));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * Minimal SSE reader. Only what /api/events emits: `id:`, `event:`, `data:`,
 * and `: ping` comments.
 */
class SseClient {
  constructor(req, res) {
    this.req = req;
    this.res = res;
    this.frames = [];
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let cut;
      while ((cut = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const frame = { id: null, event: 'message', data: '' };
        for (const line of raw.split('\n')) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('id: ')) frame.id = line.slice(4);
          else if (line.startsWith('event: ')) frame.event = line.slice(7);
          else if (line.startsWith('data: ')) frame.data += line.slice(6);
        }
        if (frame.event === 'message' && !frame.data) continue;
        let parsed = null;
        try { parsed = frame.data ? JSON.parse(frame.data) : null; } catch { /* keep raw */ }
        this.frames.push({ ...frame, json: parsed, at: Date.now() });
      }
    });
    res.on('error', () => {});
  }

  static connect(pathname, { lastEventId } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: WEB_PORT,
          path: pathname,
          method: 'GET',
          headers: {
            Authorization: `Bearer ${webToken}`,
            Accept: 'text/event-stream',
            ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`SSE ${pathname} → ${res.statusCode}`));
            res.resume();
            return;
          }
          resolve(new SseClient(req, res));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  async waitFor(predicate, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.frames.find(predicate);
      if (hit) return hit;
      await sleep(50);
    }
    return null;
  }

  close() {
    try { this.req.destroy(); } catch { /* ignore */ }
  }
}

// === Screen helpers ========================================================

/**
 * VERBATIM COPY of src/daemon/approvals/approvalKeystrokes.ts CURSOR_OPTION_ROW,
 * used for EVIDENCE ONLY — the harness never substitutes its own judgement for
 * the daemon's. Every pass/fail below is decided by the daemon's HTTP answer;
 * this only lets the report say WHICH row the daemon was looking at.
 */
const CURSOR_OPTION_ROW =
  /^[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*[❯>›»][ \t]*\d{1,2}[.)]\s+\S/;

/** The visible grid, exactly as the registry's readScreenTail sees it. */
async function readGrid(control, sessionId) {
  const out = await control.rpc('daemon.readSessionText', { id: sessionId, scrollback: 0 });
  if (!out || out.mode !== 'rows') return { rows: [], mode: out?.mode ?? 'error', reason: out?.reason };
  return { rows: out.rows.map((r) => r.text), mode: 'rows' };
}

function gridEvidence(rows) {
  const nonEmpty = rows.filter((r) => r.trim().length > 0);
  return {
    rowCount: rows.length,
    matchingRows: nonEmpty
      .map((text, i) => ({ i, text, matches: CURSOR_OPTION_ROW.test(text) }))
      .filter((r) => r.matches),
    lastRows: nonEmpty.slice(-8),
    // Codepoints of every row the heuristic accepted (or of the last row when
    // none did) — the only way to tell a real `❯` from a codepage-mangled one.
    codepoints: (nonEmpty.filter((t) => CURSOR_OPTION_ROW.test(t))[0] ?? nonEmpty[nonEmpty.length - 1] ?? '')
      .slice(0, 24)
      .split('')
      .map((ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`),
  };
}

function lastNonEmpty(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].trim().length > 0) return rows[i];
  }
  return '';
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
  const deadline = Date.now() + 8_000;
  while (!sawOutput && Date.now() < deadline) await sleep(100);
  await sleep(600);
  return {
    socket: sock,
    output: () => out,
    async type(line, waitMs = 500) {
      sock.write(`${line}\r`);
      await sleep(waitMs);
    },
  };
}

/**
 * Print something shaped like a Claude Code AskUserQuestion select into a plain
 * cmd.exe pane.
 *
 * `^>` is cmd's escape for the redirect operator, so the OUTPUT line is
 * `> 1. Yes` — the ASCII half of CURSOR_OPTION_ROW's cursor class. The typed
 * line itself starts with the drive letter of the prompt, so it can never match.
 */
async function printAsciiPrompt(pane) {
  await pane.type('echo Which deploy target should I use?');
  await pane.type('echo ^> 1. Yes');
  await pane.type('echo   2. No');
}

/** The glyph Claude's TUI really renders, inside its box frame. */
async function printUnicodePrompt(pane) {
  await pane.type('chcp 65001');
  await pane.type('echo Which deploy target should I use?');
  await pane.type('echo │ ❯ 1. Yes');
  await pane.type('echo │   2. No');
}

async function destroyPanes(control) {
  for (const id of Array.from(liveSessions)) {
    await control.rpc('daemon.destroySession', { id }).catch(() => {});
    liveSessions.delete(id);
  }
}

// === Bridge stand-in =======================================================

/** The canonical AskUserQuestion tool_input, as Claude Code sends it. */
function askUserQuestionPayload(question, optionLabels) {
  return {
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        {
          question,
          header: 'Deploy',
          multiSelect: false,
          options: optionLabels.map((label) => ({ label, description: `${label} description` })),
        },
      ],
    },
  };
}

function envelope(sessionId, kind, { agent = 'claude', payload = {} } = {}) {
  return {
    kind,
    agent,
    ptyId: sessionId,
    cwd: PANE_CWD,
    payload,
    ts: Date.now(),
  };
}

// === Approval helpers ======================================================

async function listApprovals() {
  return httpRequest('GET', '/api/approvals');
}

/**
 * Wait for approvals.json to satisfy `predicate`.
 *
 * A record becomes VISIBLE before it becomes DURABLE, by design:
 * ApprovalRegistry.mutate() pushes the record inside the mutation body, then
 * `await this.persist()`, and only then emits. So `list()` — and therefore
 * `GET /api/approvals` — legitimately answers with a record whose atomic
 * write-then-rename has not landed yet, and a synchronous existsSync right
 * after the HTTP poll is a race that loses on a busy machine.
 *
 * Polling is the honest read of a fire-and-forget write. A TIMEOUT here is not
 * a flake to widen — it is a durability defect, and the scenario fails.
 */
async function waitForPersisted(predicate, timeoutMs = 5_000) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf-8'));
      if (predicate(last)) return { ok: true, state: last, waitedMs: Date.now() - startedAt };
    } catch {
      // Absent (never written) or a torn read during the rename — both mean
      // "not yet", never "broken".
    }
    await sleep(50);
  }
  return { ok: false, state: last, waitedMs: Date.now() - startedAt };
}

const persistedIds = (state, filter = () => true) =>
  (state?.requests ?? []).filter(filter).map((r) => r.id);

async function waitForPending(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await listApprovals();
    last = res;
    if (res.status === 200) {
      const hit = (res.json?.pending ?? []).find(predicate);
      if (hit) return { hit, res };
    }
    await sleep(150);
  }
  return { hit: null, res: last };
}

// === Report ================================================================

const report = [];
function record(scenario, pass, evidence) {
  report.push({ scenario, pass, evidence });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${scenario}`);
}

// === Scenarios =============================================================

const S1_QUESTION = 'Which deploy target should I use for the release?';
const S1_OPTIONS = ['Staging (safe)', 'Production (irreversible)'];

/**
 * S1 + S2 — a hook creates a request whose question/options survive verbatim,
 * and the create rides /api/events with the content fields stripped.
 */
async function scenarioCreateAndSse(control, sessionId) {
  // Cursor into the event channel from BEFORE the create, so the replay
  // assertion has a cursor that provably predates it.
  const backlogBefore = await httpRequest('GET', '/api/events');
  const epoch = backlogBefore.json?.epoch;
  const headBefore = backlogBefore.json?.headId;
  const live = await SseClient.connect('/api/events');
  await sleep(200);

  const env = envelope(sessionId, 'agent.awaiting_input', {
    payload: askUserQuestionPayload(S1_QUESTION, S1_OPTIONS),
  });
  const rpcResult = await control.rpc('daemon.hooks.signal', env);
  const { hit, res } = await waitForPending((r) => r.sessionId === sessionId);

  // --- S1
  // Durability is asserted on the RECORD, not just the file: an approvals.json
  // that exists because some earlier mutation wrote it proves nothing about
  // this request.
  const persisted = hit
    ? await waitForPersisted((s) => (s?.requests ?? []).some((r) => r.id === hit.id))
    : { ok: false, state: null, waitedMs: 0 };
  const s1Evidence = {
    electronMainRunning: false,
    hookRpcResult: rpcResult,
    sentQuestion: S1_QUESTION,
    sentOptions: S1_OPTIONS,
    pendingRecord: hit,
    approvalsJsonHasRecord: persisted.ok,
    persistWaitMs: persisted.waitedMs,
    persistedRecord: (persisted.state?.requests ?? []).find((r) => r.id === hit?.id) ?? null,
    // The pipe seam the desktop/deck will use, cross-checked against HTTP.
    pipeList: await control.rpc('daemon.approvals.list', {}).catch((e) => ({ error: String(e) })),
  };
  const s1Pass =
    rpcResult?.ok === true &&
    hit !== null &&
    hit.state === 'pending' &&
    hit.agent === 'claude' &&
    hit.kind === 'awaiting_input' &&
    typeof hit.id === 'string' && hit.id.length > 0 &&
    hit.question === S1_QUESTION &&
    Array.isArray(hit.options) &&
    hit.options.length === S1_OPTIONS.length &&
    hit.options[0] === S1_OPTIONS[0] &&
    hit.options[1] === S1_OPTIONS[1] &&
    persisted.ok &&
    (s1Evidence.pipeList?.pending ?? []).some((r) => r.id === hit.id);
  record('S1 create-question-and-options-verbatim', s1Pass, s1Evidence);

  // --- S2
  const liveFrame = hit
    ? await live.waitFor((f) => f.event === 'approval' && f.json?.approvalId === hit.id)
    : null;
  const livePayload = liveFrame?.json ?? null;

  const replay = await SseClient.connect('/api/events', { lastEventId: `${epoch}:${headBefore}` });
  const replayFrame = hit
    ? await replay.waitFor((f) => f.event === 'approval' && f.json?.approvalId === hit.id, 6_000)
    : null;
  const sawReset = replay.frames.some((f) => f.event === 'reset');
  replay.close();
  live.close();

  const contentKeys = livePayload
    ? ['question', 'options', 'screenTail'].filter((k) => k in livePayload)
    : [];
  const s2Evidence = {
    cursorUsed: `${epoch}:${headBefore}`,
    liveFrame: liveFrame ? { id: liveFrame.id, event: liveFrame.event, payload: livePayload } : null,
    contentFieldsLeakedOnWire: contentKeys,
    replayFrame: replayFrame ? { id: replayFrame.id, payload: replayFrame.json } : null,
    replaySawReset: sawReset,
    replayFrameCount: replay.frames.length,
  };
  const s2Pass =
    livePayload !== null &&
    livePayload.phase === 'create' &&
    livePayload.state === 'pending' &&
    livePayload.sessionId === sessionId &&
    livePayload.approvalId === hit?.id &&
    typeof livePayload.id === 'number' &&
    contentKeys.length === 0 &&
    replayFrame !== null &&
    sawReset === false;
  record('S2 sse-create-nudge-and-replay', s2Pass, s2Evidence);

  return hit?.id ?? null;
}

/** S3 — approve on a read-only server; the byte really lands in the PTY. */
async function scenarioApprove(control, sessionId) {
  const pane = await attachPane(control, sessionId);
  try {
    await printAsciiPrompt(pane);
    const gridBefore = await readGrid(control, sessionId);

    await control.rpc('daemon.hooks.signal', envelope(sessionId, 'agent.awaiting_input', {
      payload: askUserQuestionPayload('Deploy to production?', ['Yes', 'No']),
    }));
    const { hit } = await waitForPending((r) => r.sessionId === sessionId);
    if (!hit) {
      record('S3 approve-on-readonly-server', false, { reason: 'no pending request appeared', gridBefore: gridEvidence(gridBefore.rows) });
      return null;
    }

    const post = await httpRequest('POST', `/api/approvals/${encodeURIComponent(hit.id)}`, {
      body: { decision: 'approve' },
    });
    await sleep(800);
    const gridAfter = await readGrid(control, sessionId);
    const after = await listApprovals();
    const resolved = (after.json?.recentlyResolved ?? []).find((r) => r.id === hit.id) ?? null;

    // The same server that just accepted an approve must still refuse arbitrary input.
    const inputRes = await httpRequest('POST', `/api/input?session=${encodeURIComponent(sessionId)}`, {
      body: 'x',
    });
    const configRes = await httpRequest('GET', '/api/config');

    const lastRow = lastNonEmpty(gridAfter.rows);
    const echoedDigit = /(^|\s|>)1\s*$/.test(lastRow);

    const evidence = {
      requestId: hit.id,
      gridBeforeResolve: gridEvidence(gridBefore.rows),
      postStatus: post.status,
      postBody: post.json,
      gridAfterResolve: gridEvidence(gridAfter.rows),
      lastRowAfterResolve: lastRow,
      digitEchoedInPane: echoedDigit,
      resolvedRecord: resolved,
      readOnlyServer: { apiConfig: configRes.json, inputStatus: inputRes.status, inputBody: inputRes.json },
    };
    const pass =
      post.status === 200 &&
      post.json?.state === 'resolved' &&
      echoedDigit &&
      resolved?.state === 'resolved' &&
      resolved?.decision === 'approve' &&
      resolved?.resolvedBy === 'operator' &&
      typeof resolved?.screenTail === 'string' && resolved.screenTail.length > 0 &&
      (after.json?.pending ?? []).every((r) => r.id !== hit.id) &&
      configRes.json?.allowInput === false &&
      inputRes.status === 403;
    record('S3 approve-on-readonly-server', pass, evidence);
    return hit.id;
  } finally {
    pane.socket.destroy();
  }
}

/**
 * S3b — the fidelity check the whole refusal path rests on: does
 * CURSOR_OPTION_ROW accept the glyph Claude's TUI actually renders?
 */
async function scenarioUnicodeCursor(control, sessionId) {
  const pane = await attachPane(control, sessionId);
  try {
    await printUnicodePrompt(pane);
    const grid = await readGrid(control, sessionId);

    await control.rpc('daemon.hooks.signal', envelope(sessionId, 'agent.awaiting_input', {
      payload: askUserQuestionPayload('Pick one', ['Yes', 'No']),
    }));
    const { hit } = await waitForPending((r) => r.sessionId === sessionId);
    if (!hit) {
      record('S3b unicode-cursor-row-accepted', false, { reason: 'no pending request appeared', grid: gridEvidence(grid.rows) });
      return;
    }
    const post = await httpRequest('POST', `/api/approvals/${encodeURIComponent(hit.id)}`, {
      body: { decision: 'approve' },
    });
    await sleep(700);
    const gridAfter = await readGrid(control, sessionId);

    const evidence = {
      regexUnderTest: String(CURSOR_OPTION_ROW),
      gridBeforeResolve: gridEvidence(grid.rows),
      harnessThinksPromptVisible: grid.rows.some((r) => CURSOR_OPTION_ROW.test(r)),
      postStatus: post.status,
      postBody: post.json,
      lastRowAfterResolve: lastNonEmpty(gridAfter.rows),
    };
    const pass = post.status === 200 && post.json?.state === 'resolved';
    record('S3b unicode-cursor-row-accepted', pass, evidence);
  } finally {
    pane.socket.destroy();
  }
}

/** S3c — deny is ESC. No digit may appear in the pane. */
async function scenarioDeny(control, sessionId) {
  const pane = await attachPane(control, sessionId);
  try {
    await printAsciiPrompt(pane);
    await control.rpc('daemon.hooks.signal', envelope(sessionId, 'agent.awaiting_input', {
      payload: askUserQuestionPayload('Delete the branch?', ['Delete it', 'Keep it']),
    }));
    const { hit } = await waitForPending((r) => r.sessionId === sessionId);
    if (!hit) {
      record('S3c deny-writes-escape-not-a-digit', false, { reason: 'no pending request appeared' });
      return;
    }
    const gridBefore = await readGrid(control, sessionId);
    const post = await httpRequest('POST', `/api/approvals/${encodeURIComponent(hit.id)}`, {
      body: { decision: 'deny' },
    });
    await sleep(800);
    const gridAfter = await readGrid(control, sessionId);
    const after = await listApprovals();
    const resolved = (after.json?.recentlyResolved ?? []).find((r) => r.id === hit.id) ?? null;
    const lastRow = lastNonEmpty(gridAfter.rows);

    const evidence = {
      requestId: hit.id,
      postStatus: post.status,
      postBody: post.json,
      resolvedRecord: resolved,
      lastRowBefore: lastNonEmpty(gridBefore.rows),
      lastRowAfter: lastRow,
      // ESC is not echoed by cmd.exe, so the observable claim is the NEGATIVE
      // one: whatever else happened, no '1' was typed into the pane.
      digitEchoedInPane: /(^|\s|>)1\s*$/.test(lastRow),
    };
    const pass =
      post.status === 200 &&
      post.json?.state === 'resolved' &&
      resolved?.decision === 'deny' &&
      resolved?.resolvedBy === 'operator' &&
      evidence.digitEchoedInPane === false;
    record('S3c deny-writes-escape-not-a-digit', pass, evidence);
  } finally {
    pane.socket.destroy();
  }
}

/** S4 — the loser of a two-device race gets 409 and is told who won. */
async function scenarioDoubleResolve(resolvedId) {
  if (!resolvedId) {
    record('S4 double-resolve-409', false, { reason: 'S3 produced no resolved id' });
    return;
  }
  const post = await httpRequest('POST', `/api/approvals/${encodeURIComponent(resolvedId)}`, {
    body: { decision: 'approve' },
  });
  const pass = post.status === 409 && post.json?.error === 'already-resolved' && post.json?.resolvedBy === 'operator';
  record('S4 double-resolve-409', pass, { requestId: resolvedId, status: post.status, body: post.json });
}

/** S5 — a re-prompt on the same pane supersedes; the old id answers 410. */
async function scenarioSupersede(control, sessionId) {
  await control.rpc('daemon.hooks.signal', envelope(sessionId, 'agent.awaiting_input', {
    payload: askUserQuestionPayload('First question?', ['A', 'B']),
  }));
  const first = await waitForPending((r) => r.sessionId === sessionId);
  if (!first.hit) {
    record('S5 supersede-then-410-on-old-id', false, { reason: 'first request never appeared' });
    return;
  }
  await control.rpc('daemon.hooks.signal', envelope(sessionId, 'agent.awaiting_input', {
    payload: askUserQuestionPayload('Second question?', ['C', 'D']),
  }));
  const second = await waitForPending((r) => r.sessionId === sessionId && r.id !== first.hit.id);

  const listed = await listApprovals();
  const pendingForSession = (listed.json?.pending ?? []).filter((r) => r.sessionId === sessionId);
  const oldRecord = (listed.json?.recentlyResolved ?? []).find((r) => r.id === first.hit.id) ?? null;
  const post = await httpRequest('POST', `/api/approvals/${encodeURIComponent(first.hit.id)}`, {
    body: { decision: 'approve' },
  });

  const evidence = {
    firstId: first.hit.id,
    firstQuestion: first.hit.question,
    secondId: second.hit?.id ?? null,
    secondQuestion: second.hit?.question ?? null,
    pendingForSessionAfter: pendingForSession.map((r) => ({ id: r.id, question: r.question })),
    oldRecordAfter: oldRecord,
    resolveOldStatus: post.status,
    resolveOldBody: post.json,
  };
  const pass =
    second.hit !== null &&
    pendingForSession.length === 1 &&
    pendingForSession[0].id === second.hit.id &&
    oldRecord?.state === 'superseded' &&
    post.status === 410 &&
    post.json?.error === 'expired' &&
    post.json?.state === 'superseded';
  record('S5 supersede-then-410-on-old-id', pass, evidence);
}

/** S6 — the prompt scrolled away: refuse, and write NOTHING. */
async function scenarioPromptGone(control, sessionId) {
  const pane = await attachPane(control, sessionId);
  try {
    await printAsciiPrompt(pane);
    await control.rpc('daemon.hooks.signal', envelope(sessionId, 'agent.awaiting_input', {
      payload: askUserQuestionPayload('Still there?', ['Yes', 'No']),
    }));
    const { hit } = await waitForPending((r) => r.sessionId === sessionId);
    if (!hit) {
      record('S6 prompt-gone-refuses-and-writes-nothing', false, { reason: 'no pending request appeared' });
      return;
    }
    const gridWithPrompt = await readGrid(control, sessionId);

    // Push the option rows off the VISIBLE grid (the registry reads with
    // scrollback: 0, so the buffer keeping them is not the buffer it looks at).
    await pane.type('for /L %i in (1,1,80) do @echo flood-line-%i', 2_500);
    await pane.type('echo FLOODMARKER', 700);
    const gridFlooded = await readGrid(control, sessionId);

    const post = await httpRequest('POST', `/api/approvals/${encodeURIComponent(hit.id)}`, {
      body: { decision: 'approve' },
    });
    await sleep(800);
    const gridAfter = await readGrid(control, sessionId);
    const after = await listApprovals();
    const record_ = (after.json?.recentlyResolved ?? []).find((r) => r.id === hit.id) ?? null;
    const lastRow = lastNonEmpty(gridAfter.rows);

    const evidence = {
      requestId: hit.id,
      gridWithPrompt: gridEvidence(gridWithPrompt.rows),
      gridAfterFlood: gridEvidence(gridFlooded.rows),
      floodMarkerVisible: gridFlooded.rows.some((r) => r.includes('FLOODMARKER')),
      postStatus: post.status,
      postBody: post.json,
      lastRowAfterRefusal: lastRow,
      digitEchoedInPane: /(^|\s|>)1\s*$/.test(lastRow),
      refusedRecord: record_,
    };
    const pass =
      gridWithPrompt.rows.some((r) => CURSOR_OPTION_ROW.test(r)) &&
      gridFlooded.rows.every((r) => !CURSOR_OPTION_ROW.test(r)) &&
      post.status === 410 &&
      post.json?.error === 'prompt-gone' &&
      evidence.digitEchoedInPane === false &&
      record_?.state === 'expired' &&
      record_?.decision === undefined;
    record('S6 prompt-gone-refuses-and-writes-nothing', pass, evidence);
  } finally {
    pane.socket.destroy();
  }
}

/**
 * S7 — the two "cannot act" shapes.
 *
 * The detector-sourced awaiting_input the contract forbids CANNOT be expressed
 * over this pipe at all: every `daemon.hooks.signal` is hook-sourced by
 * construction, and the detector path is daemon-internal. That structural
 * property is what the contract asks for, so what is testable here is the pair
 * of neighbouring cases: a payload that is not an AskUserQuestion (tolerated,
 * created WITHOUT question/options) and an agent with no keystroke map.
 */
async function scenarioTolerantAndUnsupported(control, tolerantSession, codexSession) {
  await control.rpc('daemon.hooks.signal', envelope(tolerantSession, 'agent.awaiting_input', {
    payload: { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } },
  }));
  const tolerant = await waitForPending((r) => r.sessionId === tolerantSession);

  await control.rpc('daemon.hooks.signal', envelope(codexSession, 'agent.awaiting_input', {
    agent: 'codex',
    payload: askUserQuestionPayload('Codex asks something', ['Yes', 'No']),
  }));
  const codex = await waitForPending((r) => r.sessionId === codexSession);
  const post = codex.hit
    ? await httpRequest('POST', `/api/approvals/${encodeURIComponent(codex.hit.id)}`, { body: { decision: 'approve' } })
    : { status: null, json: null };
  // unsupported-agent is explicitly NOT an expiry — the desktop can still answer.
  const afterUnsupported = await listApprovals();
  const stillPending = (afterUnsupported.json?.pending ?? []).some((r) => r.id === codex.hit?.id);

  const evidence = {
    tolerantRecord: tolerant.hit,
    tolerantHasQuestionField: tolerant.hit ? 'question' in tolerant.hit : null,
    tolerantHasOptionsField: tolerant.hit ? 'options' in tolerant.hit : null,
    codexRecord: codex.hit,
    codexResolveStatus: post.status,
    codexResolveBody: post.json,
    codexStillPendingAfter501: stillPending,
    note: 'detector-sourced awaiting_input is unreachable over daemon.hooks.signal by construction — every signal on this pipe is hook-sourced',
  };
  const pass =
    tolerant.hit !== null &&
    tolerant.hit.state === 'pending' &&
    !('question' in tolerant.hit) &&
    !('options' in tolerant.hit) &&
    codex.hit !== null &&
    codex.hit.agent === 'codex' &&
    post.status === 501 &&
    post.json?.error === 'unsupported-agent' &&
    stillPending === true;
  record('S7 tolerant-payload-and-unsupported-agent', pass, evidence);
  return codex.hit?.id ?? null;
}

/** S8 — a SIGKILLed daemon comes back with no pending approvals. */
async function scenarioRestart(control, survivorId) {
  const before = await listApprovals();
  const pendingBefore = (before.json?.pending ?? []).map((r) => ({ id: r.id, sessionId: r.sessionId, agent: r.agent }));
  // Same visible-before-durable window as S1, and here it decides what the
  // scenario even means: killing the daemon before the creates have landed
  // would test "a record that was never written is absent afterwards", which
  // is trivially true and not the invalidation rule. Wait for disk first.
  const persistGate = await waitForPersisted((s) =>
    pendingBefore.every(({ id }) =>
      (s?.requests ?? []).some((r) => r.id === id && r.state === 'pending')));
  const persistedBefore = persistGate.state;
  control.close();

  const oldPid = daemon.pid;
  const exited = new Promise((r) => daemon.once('exit', (code, sig) => r({ code, sig })));
  daemon.kill('SIGKILL');
  const exitInfo = await Promise.race([exited, sleep(10_000).then(() => ({ code: null, sig: 'no-exit' }))]);
  try { fs.rmSync(PIPE_HINT_FILE, { force: true }); } catch { /* ignore */ }
  await sleep(1_000);

  daemon = spawnDaemon();
  const newPipe = await waitForPipeFile();
  const fresh = await PipeClient.connect(newPipe, { onEvent: () => {} });

  // #596: the operator's `daemon.web.start` was persisted, so the server should
  // come back on its own. Poll rather than assume — and fall back to an explicit
  // start so a restore regression fails THIS assertion, not every later one.
  let restored = false;
  const deadline = Date.now() + 20_000;
  let listAfter = null;
  while (Date.now() < deadline) {
    try {
      listAfter = await listApprovals();
      if (listAfter.status === 200) { restored = true; break; }
    } catch { /* not listening yet */ }
    await sleep(300);
  }
  if (!restored) {
    const info = await fresh.rpc('daemon.web.start', { port: WEB_PORT, host: '127.0.0.1', allowInput: false });
    webToken = info?.token ?? webToken;
    listAfter = await listApprovals();
  }

  const persistedAfter = fs.existsSync(APPROVALS_FILE)
    ? JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf-8'))
    : null;
  const survivor = survivorId
    ? (listAfter.json?.recentlyResolved ?? []).find((r) => r.id === survivorId) ?? null
    : null;

  const evidence = {
    oldDaemonPid: oldPid,
    killSignalExit: exitInfo,
    newDaemonPid: daemon.pid,
    webServerSelfRestored: restored,
    pendingBeforeKill: pendingBefore,
    persistedPendingBeforeKill: persistedIds(persistedBefore, (r) => r.state === 'pending'),
    allPendingReachedDiskBeforeKill: persistGate.ok,
    persistWaitMs: persistGate.waitedMs,
    pendingAfterRestart: listAfter?.json?.pending ?? null,
    persistedPendingAfterRestart: persistedIds(persistedAfter, (r) => r.state === 'pending'),
    survivorRecordAfterRestart: survivor,
  };
  const pass =
    pendingBefore.length > 0 &&
    persistGate.ok &&
    listAfter?.status === 200 &&
    Array.isArray(listAfter.json?.pending) &&
    listAfter.json.pending.length === 0 &&
    evidence.persistedPendingAfterRestart.length === 0 &&
    (survivorId ? survivor?.state === 'expired' : true);
  record('S8 restart-invalidates-pending', pass, evidence);
  return fresh;
}

// === Main ==================================================================

let control = null;
let exitCode = 2;

try {
  console.log(`[setup] TEST_HOME=${TEST_HOME}`);
  console.log(`[setup] WMUX_DATA_SUFFIX=${DATA_SUFFIX} (data dir ${WMUX_DIR})`);
  console.log(`[setup] bundle mtime=${fs.statSync(DAEMON_BUNDLE).mtime.toISOString()}`);
  console.log(`[setup] web port=${WEB_PORT}`);

  daemon = spawnDaemon();
  const pipeName = await waitForPipeFile();
  console.log(`[setup] daemon pid=${daemon.pid} listening on ${pipeName}`);

  control = await PipeClient.connect(pipeName, { onEvent: () => {} });
  const ping = await control.rpc('daemon.ping', {});
  if (ping?.status !== 'ok') throw new Error(`daemon.ping unhealthy: ${JSON.stringify(ping)}`);

  // READ-ONLY web server on purpose: the approval carve-out is the thing under
  // test, so anything it can do here it can do without --allow-input.
  const webInfo = await control.rpc('daemon.web.start', {
    port: WEB_PORT,
    host: '127.0.0.1',
    allowInput: false,
  });
  if (!webInfo?.running || !webInfo.token) throw new Error(`web start failed: ${JSON.stringify(webInfo)}`);
  webToken = webInfo.token;
  console.log(`[setup] web server ${webInfo.host}:${webInfo.port} allowInput=${webInfo.allowInput}`);

  const panes = {
    create: `m2-create-${RUN_TAG}`,
    approve: `m2-approve-${RUN_TAG}`,
    unicode: `m2-unicode-${RUN_TAG}`,
    deny: `m2-deny-${RUN_TAG}`,
    supersede: `m2-super-${RUN_TAG}`,
    gone: `m2-gone-${RUN_TAG}`,
    tolerant: `m2-tolerant-${RUN_TAG}`,
    codex: `m2-codex-${RUN_TAG}`,
  };
  for (const id of Object.values(panes)) await createPane(control, id);

  await scenarioCreateAndSse(control, panes.create);
  const resolvedId = await scenarioApprove(control, panes.approve);
  await scenarioUnicodeCursor(control, panes.unicode);
  await scenarioDeny(control, panes.deny);
  await scenarioDoubleResolve(resolvedId);
  await scenarioSupersede(control, panes.supersede);
  await scenarioPromptGone(control, panes.gone);
  const survivorId = await scenarioTolerantAndUnsupported(control, panes.tolerant, panes.codex);
  control = await scenarioRestart(control, survivorId);

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
  console.error(daemonLog.join('').slice(-6000));
  exitCode = report.length > 0 ? 1 : 2;
} finally {
  try { if (control) await destroyPanes(control); } catch { /* ignore */ }
  try { control?.close(); } catch { /* ignore */ }
  if (daemon && !daemon.killed) {
    try { daemon.kill('SIGKILL'); } catch { /* ignore */ }
  }
  await sleep(500);
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(exitCode);
