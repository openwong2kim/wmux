// wmux-managed: shared-hooks-bridge
// wmux ↔ Claude-compatible lifecycle hooks: ONE bridge for every CLI whose
// hooks follow Claude Code's contract (a command spawned per event, the event
// JSON on stdin, neutral = exit 0 with no output).
//
// Invocation:  node "<abs path to this file>" <flavour> [<EventName>]
//
//   <flavour>    a row of FLAVOURS below — the hook DIALECT: which event names
//                the CLI uses, where its payload keeps the session id and cwd,
//                and which wmux agent slug the signals are about.
//   <EventName>  optional. When the installer registered the hook per event it
//                passes the name here, because not every dialect repeats it in
//                the payload (GitHub Copilot CLI documents `hook_event_name`
//                for some PascalCase events and not for `Stop`). Without it,
//                the payload's `hook_event_name` names the event.
//
// This script:
//   1. Reads the hook payload from stdin (JSON, capped).
//   2. Normalises (flavour, event, payload) into the canonical wmux AgentSignal
//      envelope (src/shared/hooks/signal-types.ts) — the SAME envelope and the
//      SAME `hooks.signal` RPC every bespoke bridge uses, so the daemon's
//      kind-based dispatch and its hook > process > screen identity precedence
//      (src/daemon/canonicalAgent.ts) apply unchanged. There is no second path.
//   3. Sends it to the first wmux endpoint that answers: the DAEMON control
//      pipe (`daemon.hooks.signal`), else the MAIN pipe (`hooks.signal`).
//      WMUX_HOOKS_TO_MAIN=1 forces main-only.
//   4. Exits 0 ALWAYS, writes NOTHING to stdout, under a hard timeout, so a
//      wmux problem never stalls or steers the agent.
//
// Rules every flavour inherits (each one was paid for by a bespoke bridge):
//   * METADATA ONLY. Payloads carry the user's prompt, the model's reply and
//     tool inputs. The normaliser reads the event name, the session id, the
//     cwd and (on session start) the start `source` — nothing else is read,
//     logged or forwarded. Field paths are an allowlist, not a filter.
//   * Pane attribution comes from WMUX_PTY_ID only. A payload without it is
//     DROPPED: a session id is not a pane, and a cwd guess attaches the turn to
//     whichever pane happens to share the folder.
//   * Only an approval-specific event maps to agent.awaiting_input. A prompt
//     submit or a pre-tool hook is NOT "a human is being waited on" — the
//     conflation #898 punished. No signal beats a false one.
//   * Per-tool-call events are never mapped (a process spawn per tool call is
//     the one thing that makes a hook path heavier than the screen detector),
//     and an event nobody has seen fire is not a signal.
//
// SELF-CONTAINED: JS-only, Node built-ins only — no imports from src/. A bridge
// runs in the agent's runtime, where wmux's TypeScript is unreachable. The
// flavour table is mirrored by src/shared/hooks/hookFlavours.ts (the installer
// side) under a lockstep test, the same arrangement as the Codex hooks block.
//
// NO SHEBANG, deliberately: every host invokes this as `node <path>`, and
// Vitest cannot parse a `.mjs` that starts with one.

import { readFileSync, existsSync, mkdirSync, appendFileSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';

const HOOK_TIMEOUT_MS = 2000; // hard cap so we never stall an agent turn
// Stamped on every log line; bump on behaviour changes.
//   0.1.0 — initial: kiro (moved from wmux-kiro-bridge.mjs), copilot, gemini.
const BRIDGE_VERSION = '0.1.0';
const CONNECT_RETRY_BACKOFFS_MS = [100, 250];
const TRANSIENT_CONNECT_CODES = new Set([
  'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EBUSY', 'EAGAIN',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Payloads can carry whole replies and tool inputs; cap what we even hold.
const MAX_STDIN_BYTES = 256 * 1024;

// #1111: the main pipe recognises this exact clientName and allows it ONE
// method (`hooks.signal`). Kept in lockstep with WMUX_HOOK_BRIDGE_CLIENT_NAME in
// src/shared/rpc.ts by hookBridge.lockstep.test.ts.
const WMUX_CLIENT_NAME = 'wmux-hook-bridge';

// ----- Flavour table -------------------------------------------------------
//
// Mirrored (events, agent, field paths) by COMPAT_HOOK_FLAVOURS in
// src/shared/hooks/hookFlavours.ts — hookFlavours.lockstep.test.ts fails on any
// drift. `logFile` and `requestPrefix` are runtime-only.
//
// `events` maps the dialect's event name to the wmux kind. `when` narrows an
// event to the payloads where one field equals one value (Gemini reports a
// permission prompt as a Notification with notification_type ToolPermission;
// its other notifications are not a wait on a human).
export const FLAVOURS = {
  // Kiro CLI 2.x agent-config hooks. Measured live on kiro-cli 2.15.1
  // (2026-08-16): camelCase triggers, payload {hook_event_name, cwd, ...} and
  // NO session id anywhere. This row is the old wmux-kiro-bridge.mjs, moved.
  kiro: {
    agent: 'kiro',
    events: {
      stop: { kind: 'agent.stop' },
      agentSpawn: { kind: 'agent.session_start' },
    },
    sessionIdFields: [],
    cwdFields: ['cwd'],
    sourceField: null,
    logFile: 'kiro-bridge.log',
    requestPrefix: 'kiro-hook',
  },
  // GitHub Copilot CLI, PascalCase (Claude-compatible) event names, which the
  // docs say switch the payload to snake_case fields. `sessionId` is listed as
  // a fallback because the docs show PermissionRequest only in camelCase.
  // Documented, not yet measured on a live CLI.
  copilot: {
    agent: 'copilot',
    events: {
      SessionStart: { kind: 'agent.session_start' },
      UserPromptSubmit: { kind: 'agent.user_prompt_submit' },
      Stop: { kind: 'agent.stop' },
      PermissionRequest: { kind: 'agent.awaiting_input' },
    },
    sessionIdFields: ['session_id', 'sessionId'],
    cwdFields: ['cwd'],
    sourceField: 'source',
    logFile: 'copilot-hooks.log',
    requestPrefix: 'copilot-hook',
  },
  // Gemini CLI settings.json hooks. Its own event vocabulary (BeforeAgent /
  // AfterAgent for the turn), Claude's payload envelope. Documented, not yet
  // measured on a live CLI.
  gemini: {
    agent: 'gemini',
    events: {
      SessionStart: { kind: 'agent.session_start' },
      BeforeAgent: { kind: 'agent.user_prompt_submit' },
      AfterAgent: { kind: 'agent.stop' },
      Notification: { kind: 'agent.awaiting_input', when: { field: 'notification_type', equals: 'ToolPermission' } },
    },
    sessionIdFields: ['session_id'],
    cwdFields: ['cwd'],
    sourceField: 'source',
    logFile: 'gemini-hooks.log',
    requestPrefix: 'gemini-hook',
  },
};

// A SessionStart `source` (read from the flavour's `sourceField`) is forwarded
// only when it is a value the daemon gives meaning to (isFreshSessionSource in
// src/shared/hooks/signal-types.ts); any other dialect-specific value (Copilot's
// "new") proves nothing and is dropped, not translated.
const FORWARDED_SESSION_SOURCES = new Set(['startup', 'resume', 'clear']);

// An agent session id is opaque, but it is persisted as a resume binding, so
// it must at least look like an id rather than a path or a sentence.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// ----- Path helpers (Node built-ins only) ---------------------------------
//
// Kept in lockstep with src/shared/constants.ts. A non-empty suffix is an
// instance boundary: this bridge never probes production paths as a fallback
// when its selected namespace is suffixed.
function dataSuffix() {
  return process.env.WMUX_DATA_SUFFIX || '';
}

function getHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || homedir();
}

function getWmuxHomeDir() {
  return join(getHomeDir(), `.wmux${dataSuffix()}`);
}

function getAuthTokenPath() {
  return join(getHomeDir(), `.wmux${dataSuffix()}-auth-token`);
}

function getPipeName() {
  const override = process.env.WMUX_PIPE_NAME;
  if (typeof override === 'string' && override.length > 0) return override;
  if (process.platform === 'win32') {
    const username = userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux${dataSuffix()}-${username}`;
  }
  return join(homedir() || '/tmp', `.wmux${dataSuffix()}.sock`);
}

function getDaemonAuthTokenPath() {
  return join(getWmuxHomeDir(), 'daemon-auth-token');
}

// Prefer the suffix-scoped `daemon-pipe` hint the daemon writes at boot (the
// name it ACTUALLY bound), then derive within the same namespace.
function getDaemonPipeName() {
  try {
    const fromFile = readFileSync(join(getWmuxHomeDir(), 'daemon-pipe'), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch {
    // Hint absent/unreadable — derive within the selected namespace.
  }
  if (process.platform === 'win32') {
    const username = userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux-daemon${dataSuffix()}-${username}`;
  }
  return join(getWmuxHomeDir(), 'daemon.sock');
}

function readTokenFile(tokenPath) {
  try {
    const token = readFileSync(tokenPath, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

// Ordered endpoints, daemon first (it owns hook ingest). A target with no
// token file is skipped — that endpoint has never run.
function resolveTargets() {
  const mainToken = readTokenFile(getAuthTokenPath());
  const pipeOverride = process.env.WMUX_PIPE_NAME;
  if (typeof pipeOverride === 'string' && pipeOverride.length > 0) {
    return mainToken ? [{ name: 'main', pipe: pipeOverride, token: mainToken, method: 'hooks.signal' }] : [];
  }
  const targets = [];
  if (process.env.WMUX_HOOKS_TO_MAIN !== '1') {
    const token = readTokenFile(getDaemonAuthTokenPath());
    if (token) {
      targets.push({ name: 'daemon', pipe: getDaemonPipeName(), token, method: 'daemon.hooks.signal' });
    }
  }
  if (mainToken) {
    targets.push({ name: 'main', pipe: getPipeName(), token: mainToken, method: 'hooks.signal' });
  }
  return targets;
}

// Log file per flavour; an unknown flavour logs to the shared file.
function getLogPath(flavourId) {
  const dir = getWmuxHomeDir();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch { /* appendFileSync below also fails → swallowed */ }
  const row = flavourId && Object.hasOwn(FLAVOURS, flavourId) ? FLAVOURS[flavourId] : null;
  return join(dir, row ? row.logFile : 'hooks-bridge.log');
}

// Never logs a caller-supplied payload field. `extra` is built by this file
// only — a log line is a place content leaks too.
function logEvent(flavourId, outcome, extra) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    bridge: BRIDGE_VERSION,
    flavour: flavourId && Object.hasOwn(FLAVOURS, flavourId) ? flavourId : undefined,
    pid: process.pid,
    outcome,
    ...(extra ?? {}),
  });
  try {
    appendFileSync(getLogPath(flavourId), line + '\n', { encoding: 'utf8' });
  } catch { /* no writable home → swallow */ }
}

// ----- stdin reader -------------------------------------------------------

function readStdin() {
  return new Promise((res, rej) => {
    const chunks = [];
    let total = 0;
    process.stdin.on('data', (c) => {
      if (total >= MAX_STDIN_BYTES) return; // keep draining; stop accumulating
      chunks.push(c);
      total += c.length;
    });
    process.stdin.on('end', () => {
      const buf = Buffer.concat(chunks).toString('utf8').trim();
      if (!buf) {
        res(null);
        return;
      }
      // Over the cap the JSON is truncated and will not parse; that lands in
      // the reject path and exits 0 silently.
      try {
        res(JSON.parse(buf));
      } catch (err) {
        rej(err);
      }
    });
    process.stdin.on('error', rej);
  });
}

// ----- RPC over named pipe (same transport as the Kiro and Codex bridges) --

function sendRpc(pipePath, request, timeoutMs = HOOK_TIMEOUT_MS) {
  return new Promise((res) => {
    const sock = createConnection(pipePath);
    let buffer = '';
    let settled = false;
    let wrote = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* already dead */ }
      res(result);
    };

    const timer = setTimeout(() => settle({ ok: false, error: 'timeout', retryable: !wrote }), timeoutMs);

    sock.on('connect', () => {
      sock.write(JSON.stringify(request) + '\n');
      wrote = true;
    });
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      // Match OUR response by id: the daemon control pipe BROADCASTS session
      // events (no `id`) to every connected socket.
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (!parsed || parsed.id !== request.id) continue;
        clearTimeout(timer);
        settle(parsed);
        return;
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      settle({ ok: false, error: 'connect-error', detail: err.code ?? err.message, retryable: !wrote });
    });
    sock.on('close', () => {
      clearTimeout(timer);
      settle({ ok: false, error: 'closed-without-response', retryable: !wrote });
    });
  });
}

// `deadline` is passed in so a multi-target walk shares ONE HOOK_TIMEOUT_MS budget.
async function sendRpcWithRetry(pipePath, request, deadline = Date.now() + HOOK_TIMEOUT_MS) {
  let attempt = 0;
  let last = { ok: false, error: 'timeout' };
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return last;
    last = await sendRpc(pipePath, request, remaining);
    if (last.error !== 'connect-error') return last;
    if (last.retryable === false
        || !TRANSIENT_CONNECT_CODES.has(last.detail)
        || attempt >= CONNECT_RETRY_BACKOFFS_MS.length) {
      return last;
    }
    const backoff = CONNECT_RETRY_BACKOFFS_MS[attempt++];
    if (Date.now() + backoff >= deadline) return last;
    await sleep(backoff);
  }
}

// Signals whose re-delivery cannot corrupt anything: each asserts a state, and
// HookSignalRouter's dedup ledger drops a duplicate. Once any bridge signal has
// reached wmux the pane is hook-governed and the detector's turn-end emissions
// are vetoed, so a LOST stop is a stall until the authority TTL — trading a
// possible (deduped) duplicate for that is the right side of the bargain.
// agent.user_prompt_submit is NOT here: the deck's brain lane claims it against
// a one-turn-at-a-time contract where a duplicate is not obviously free.
const IDEMPOTENT_KINDS = new Set(['agent.stop', 'agent.session_start']);

// Advance to the next endpoint when the request provably never reached a
// server — or when re-sending is harmless.
export function shouldTryNextTarget(result, kind) {
  if (result && result.ok === true) return false;
  if (result && result.retryable === false) return IDEMPOTENT_KINDS.has(kind);
  return true;
}

async function sendToTargets(targets, buildRequest, kind) {
  const deadline = Date.now() + HOOK_TIMEOUT_MS;
  let result = { ok: false, error: 'no-target' };
  let target = null;
  for (let i = 0; i < targets.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const candidate = targets[i];
    target = candidate;
    // Per-target slice, so a pipe that accepts and then hangs cannot spend the
    // whole budget and starve the fallback endpoint.
    const slice = Math.max(1, Math.floor(remaining / (targets.length - i)));
    result = await sendRpcWithRetry(candidate.pipe, buildRequest(candidate), Date.now() + slice);
    if (!shouldTryNextTarget(result, kind)) break;
  }
  return { result, target };
}

// ----- The normaliser (pure — exported for unit testing) -------------------

function nonEmptyStr(v) {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function firstStr(payload, fields) {
  for (const field of fields) {
    const v = Object.hasOwn(payload, field) ? nonEmptyStr(payload[field]) : undefined;
    if (v) return v;
  }
  return undefined;
}

/** The flavour row for an id, or undefined. Own-property only: `constructor`
 *  and `__proto__` resolve through the prototype chain to truthy values. */
export function flavourFor(flavourId) {
  return typeof flavourId === 'string' && Object.hasOwn(FLAVOURS, flavourId) ? FLAVOURS[flavourId] : undefined;
}

/**
 * The event this invocation is about: the argv name when the installer passed
 * one, else the payload's `hook_event_name`. Undefined when neither names one.
 */
export function resolveEventName(payload, argvEvent) {
  const fromArgv = nonEmptyStr(argvEvent);
  if (fromArgv) return fromArgv;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  return nonEmptyStr(payload.hook_event_name);
}

/**
 * Normalise one Claude-compatible hook event into the canonical wmux
 * AgentSignal envelope.
 *
 * Returns null when the flavour is unknown, the event is not one wmux acts on
 * (or its `when` condition does not hold), or the pane cannot be identified.
 * Dropping beats guessing.
 *
 * Reads ONLY the event name, the flavour's session-id and cwd fields, and
 * `source` on a session start.
 */
export function buildHookEnvelope(flavourId, payload, { env = process.env, now = Date.now(), event: argvEvent } = {}) {
  const flavour = flavourFor(flavourId);
  if (!flavour) return null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const event = resolveEventName(payload, argvEvent);
  const rule = event && Object.hasOwn(flavour.events, event) ? flavour.events[event] : undefined;
  if (!rule) return null;
  if (rule.when && payload[rule.when.field] !== rule.when.equals) return null;
  const kind = rule.kind;

  const ptyId = nonEmptyStr(env.WMUX_PTY_ID);
  if (!ptyId) return null;

  const rawSessionId = firstStr(payload, flavour.sessionIdFields);
  const sessionId = rawSessionId && SESSION_ID_RE.test(rawSessionId) ? rawSessionId : undefined;
  const rawSource = kind === 'agent.session_start' && flavour.sourceField
    ? firstStr(payload, [flavour.sourceField])
    : undefined;
  const source = rawSource && FORWARDED_SESSION_SOURCES.has(rawSource) ? rawSource : undefined;
  const workspaceId = nonEmptyStr(env.WMUX_WORKSPACE_ID);
  const surfaceId = nonEmptyStr(env.WMUX_SURFACE_ID);
  return {
    kind,
    agent: flavour.agent,
    ...(sessionId ? { agentSessionId: sessionId } : {}),
    ptyId,
    ...(workspaceId ? { workspaceId } : {}),
    ...(surfaceId ? { surfaceId } : {}),
    cwd: firstStr(payload, flavour.cwdFields) ?? process.cwd(),
    // Metadata only. No transcript path: nothing consumes one for these
    // agents, and it is a caller-controlled path.
    payload: source ? { source } : {},
    ts: now,
  };
}

// ----- Main ---------------------------------------------------------------

/**
 * Run one hook invocation for `flavourId`. Exported so a per-agent entry point
 * (integrations/kiro/bin/wmux-kiro-bridge.mjs) can run the shared path with its
 * flavour fixed.
 */
export async function runHook(flavourId, argvEvent) {
  if (!flavourFor(flavourId)) {
    // Length-capped: argv is caller-controlled, but it is not payload content.
    logEvent(undefined, 'unknown-flavour', { flavour: String(flavourId ?? '').slice(0, 32) });
    return;
  }
  let payload;
  try {
    payload = await readStdin();
  } catch {
    // Parse diagnostics can quote the input; never copy them to the log.
    logEvent(flavourId, 'malformed-stdin');
    return;
  }

  const envelope = buildHookEnvelope(flavourId, payload, { event: argvEvent });
  if (!envelope) {
    // An event wmux does not act on, or a pane we cannot identify. The event
    // NAME is metadata (never content) and the most useful thing in this log:
    // it is how a CLI that renamed or added an event becomes visible.
    const event = resolveEventName(payload, argvEvent);
    const known = Boolean(event) && Object.hasOwn(FLAVOURS[flavourId].events, event);
    logEvent(flavourId, known ? 'not-forwarded' : 'ignored-event', { event: event ? event.slice(0, 64) : undefined });
    return;
  }

  const targets = resolveTargets();
  if (targets.length === 0) {
    logEvent(flavourId, 'no-auth-token', { paths: [getDaemonAuthTokenPath(), getAuthTokenPath()] });
    return;
  }

  const requestId = `${FLAVOURS[flavourId].requestPrefix}-${randomUUID()}`;
  const { result: rpcResult, target } = await sendToTargets(targets, (t) => ({
    id: requestId,
    method: t.method,
    params: envelope,
    token: t.token,
    clientName: WMUX_CLIENT_NAME,
  }), envelope.kind);
  const outerOk = rpcResult && rpcResult.ok === true;
  const innerOk = outerOk && rpcResult.result && rpcResult.result.ok === true;

  if (innerOk) {
    logEvent(flavourId, 'ok', { kind: envelope.kind, target: target?.name });
  } else {
    // Nothing to spool: the resume spool exists for daemon-boot reconciliation
    // of a Codex/Claude binding; these flavours re-bind on their next signal.
    logEvent(flavourId, outerOk ? 'rpc-rejected' : 'rpc-failed', {
      kind: envelope.kind,
      target: target?.name,
      reason: rpcResult?.result?.reason,
      error: rpcResult?.error,
      detail: rpcResult?.detail,
    });
  }
}

/**
 * Run `runHook` as a process: a self-enforced hard stop (HOOK_TIMEOUT_MS only
 * bounds the SEND; a stdin that never reaches EOF would hang before that), and
 * an explicit exit 0 so a stray listener cannot hold the turn open.
 */
export function runHookProcess(flavourId, argvEvent) {
  const watchdog = setTimeout(() => {
    logEvent(flavourId, 'watchdog-exit');
    process.exit(0);
  }, HOOK_TIMEOUT_MS * 2);
  watchdog.unref?.();
  runHook(flavourId, argvEvent)
    .catch((err) => logEvent(flavourId, 'uncaught', { error: String(err) }))
    .finally(() => process.exit(0));
}

// Run only when a host spawned THIS file as a script. Under `import` (unit
// tests, or the Kiro entry point) the module stays inert. Fails OPEN: anything
// it cannot determine is treated as a real launch, because a bridge that
// silently declines to run is the worse failure.
function invokedAsScript() {
  try {
    if (!process.argv[1]) return true;
    const self = fileURLToPath(import.meta.url);
    const entry = resolve(process.argv[1]);
    // realpath both sides: a textual match fails on a symlinked install, an
    // 8.3 short path, or a `subst` drive.
    const real = (p) => {
      try {
        return realpathSync.native ? realpathSync.native(p) : realpathSync(p);
      } catch {
        return p;
      }
    };
    const norm = (p) => (process.platform === 'win32' ? real(p).toLowerCase() : real(p));
    return norm(self) === norm(entry);
  } catch {
    return true;
  }
}

if (invokedAsScript()) {
  runHookProcess(process.argv[2], process.argv[3]);
}
