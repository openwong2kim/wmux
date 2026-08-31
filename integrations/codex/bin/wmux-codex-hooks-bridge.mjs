// wmux-managed: codex-hooks-bridge
// wmux ↔ Codex CLI lifecycle-hook bridge.
//
// Registered in `$CODEX_HOME/config.toml` (see integrations/codex/hooks/wmuxHooks.mjs):
//   [[hooks.Stop]]
//   matcher = "*"
//   [[hooks.Stop.hooks]]
//   type = "command"
//   command = "node \"<abs path to this file>\""
//
// Codex spawns it on the event and writes the event JSON to STDIN. The spawned
// process inherits the pane env, so WMUX_PTY_ID pins the signal to the exact
// pane and WMUX_DATA_SUFFIX pins every endpoint/file to that instance.
//
// This script:
//   1. Reads the Codex hook payload from stdin (JSON).
//   2. Maps `hook_event_name` to a canonical AgentSignal kind.
//   3. Builds a METADATA-ONLY envelope and sends it to the first wmux endpoint
//      that answers: the DAEMON control pipe (`daemon.hooks.signal`), else the
//      MAIN pipe (`hooks.signal`). WMUX_HOOKS_TO_MAIN=1 forces main-only.
//   4. On failure, spools a resume-binding record for the daemon's next boot.
//   5. Exits 0 ALWAYS, under a hard timeout, so a wmux problem never stalls Codex.
//
// ----- What Codex measurably does and does not give us --------------------
//       (2026-08-31, codex-cli 0.151.0 and 0.141.0, measured live against a
//        stub Responses endpoint; see integrations/codex/README.md)
//
//   * Events in the enum: PreToolUse, PermissionRequest, PostToolUse,
//     PreCompact, PostCompact, SessionStart, SessionEnd, UserPromptSubmit,
//     SubagentStart, SubagentStop, Stop, Interrupt.
//   * MEASURED FIRING: SessionStart, UserPromptSubmit, Stop, SessionEnd,
//     PreToolUse. The rest are enum members this bridge has NOT seen fire, and
//     none of them is mapped below — an unmeasured event is not a signal.
//   * `Stop` is a TURN boundary, not a session one. Measured across two turns
//     of one session: `Stop` fired once per turn carrying that turn's
//     `turn_id`, and `SessionEnd` fired separately, once, with no `turn_id`.
//     That is the whole reason this bridge exists.
//   * Payload envelope is Claude Code's, verbatim: `session_id`,
//     `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`,
//     plus `turn_id` on turn-scoped events. Codex even normalizes tool names
//     into Claude's vocabulary (a shell call arrives as `tool_name: "Bash"`).
//   * A session id IS present, unlike Kiro — so resume binding is possible and
//     this bridge keeps the notify bridge's spool.
//   * `SessionStart.source` is `"startup"` on a fresh session and `"resume"` on
//     `codex ... resume`, with the SAME `session_id`. Recorded as a
//     FUTURE-CANDIDATE field only: nothing in src/ reads it today, so it
//     identifies nothing yet. It rides along because it is free, measured, and
//     metadata — not because a consumer is waiting for it.
//   * The payload carries CONTENT: `prompt` (UserPromptSubmit),
//     `last_assistant_message` (Stop), `tool_input` (PreToolUse). wmux's
//     bridges are metadata-only, so those fields are never read, logged, or
//     forwarded. The allowlist in buildCodexHookEnvelope is the enforcement.
//   * TRUST GATE — the one operational surprise. Codex will not run a hook it
//     has not been told to trust, and it does so SILENTLY: with an untrusted
//     `[[hooks.Stop]]` in config.toml, `codex exec` printed no warning, no
//     "hooks need review" line, nothing — the hook simply never ran. Only
//     `--dangerously-bypass-hook-trust` (or an operator approving it in the
//     TUI) makes it fire. An installer therefore cannot make this work by
//     writing a file; see README.md.
//   * VERSION FLOOR 0.141.0, bisected. 0.140.0 and 0.135.0 both advertise
//     `hooks` as a stable feature AND accept `--dangerously-bypass-hook-trust`
//     AND parse `[[hooks.*]]` without complaint — and fire nothing. So the
//     feature flag, the flag's presence, and a clean config parse are all
//     useless as capability probes; only the version is load-bearing.
//
// SELF-CONTAINED: JS-only, Node built-ins only — no imports from src/ or
// integrations/shared/. Mirrors integrations/codex/bin/wmux-codex-notify.mjs
// and integrations/kiro/bin/wmux-kiro-bridge.mjs; the duplication across
// bridges is by design (a bridge runs in the agent's runtime, where wmux's
// TypeScript is unreachable).
//
// NO SHEBANG, deliberately — same reason as the Kiro bridge: Codex always
// invokes this as `node "<path>"`, and Vitest cannot parse a `.mjs` that
// starts with one, which would make the pure envelope builder untestable
// except through a subprocess.

import {
  readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync, renameSync, unlinkSync,
  realpathSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';

const HOOK_TIMEOUT_MS = 2000; // hard cap so we never stall a Codex turn
// Stamped on every codex-hooks.log line; bump on behavior changes.
//   0.1.0 — initial: SessionStart + UserPromptSubmit + Stop, metadata-only.
const BRIDGE_VERSION = '0.1.0';
const CONNECT_RETRY_BACKOFFS_MS = [100, 250];
const TRANSIENT_CONNECT_CODES = new Set([
  'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EBUSY', 'EAGAIN',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Codex payloads carry whole assistant replies and whole tool inputs, so cap
// what we will even hold in memory. Anything past this is a payload this
// bridge has no business reading. Matches the Kiro bridge's cap.
const MAX_STDIN_BYTES = 256 * 1024;

// ----- Event → AgentSignal kind -------------------------------------------
//
// ONLY events measured firing, and only those wmux can act on.
//
// Deliberately absent, each for its own reason:
//   * PreToolUse / PostToolUse — an activity stamp would cost a process spawn
//     per tool call, the one path that actually makes anything heavier, for a
//     signal the server already throttles. This is the Kiro judgement call and
//     it applies unchanged. Critically, PreToolUse must NOT be mapped to
//     agent.awaiting_input the way Claude's is: Codex fires PreToolUse on
//     EVERY tool call, gated or not, and has a separate PermissionRequest
//     event for the approval pause. Conflating them is the mistake #898
//     punished.
//   * PermissionRequest — the event that would retire the screen-scraped
//     approval regexes in AgentDetector.ts, and the one this bridge could NOT
//     measure: `codex exec` forces `approval: never`, so no approval pause can
//     occur in a non-interactive run. It is in the enum; it has not been seen
//     to fire, or its payload observed. Mapping it now would be guessing at
//     the field names, and a wrong awaiting_permission is worse than none.
//   * SessionEnd — measured firing, but there is no AgentSignalKind for
//     "session over"; agent.stop would be a lie (it is not a turn boundary).
//   * SubagentStart / SubagentStop / PreCompact / PostCompact / Interrupt —
//     enum members never observed firing.
const EVENT_TO_KIND = {
  SessionStart: 'agent.session_start',
  UserPromptSubmit: 'agent.user_prompt_submit',
  Stop: 'agent.stop',
};

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
// name it ACTUALLY bound, which differs from the convention after a zombie-pipe
// fallback rename), then derive a socket in that same namespace.
function getDaemonPipeName() {
  try {
    const fromFile = readFileSync(join(getWmuxHomeDir(), 'daemon-pipe'), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch {
    // Hint file absent/unreadable — derive within the selected namespace.
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

// Ordered endpoints. A target with no token file is skipped (that endpoint has
// never run). WMUX_HOOKS_TO_MAIN=1 and WMUX_PIPE_NAME both pin to main only.
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

function getLogPath() {
  const dir = getWmuxHomeDir();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch { /* appendFileSync below also fails → swallowed */ }
  return join(dir, 'codex-hooks.log');
}

function logEvent(outcome, extra) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    bridge: BRIDGE_VERSION,
    pid: process.pid,
    outcome,
    ...(extra ?? {}),
  });
  try {
    appendFileSync(getLogPath(), line + '\n', { encoding: 'utf8' });
  } catch { /* no writable home → swallow */ }
}

// ----- Resume-binding spool (daemon drains on next boot) -------------------
//
// Same record shape + ptyId key + atomic temp→rename + don't-replace-newer rule
// the daemon ingest expects (mirrors wmux-codex-notify.mjs). Unlike the Kiro
// bridge this one HAS a spool, because Codex supplies a session id.
function getResumeSpoolDir() {
  const dir = join(getWmuxHomeDir(), 'resume-spool');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch { /* writeFileSync below throws + is swallowed */ }
  return dir;
}

function spoolResumeBinding(record) {
  try {
    if (!record || !record.ptyId || !record.sessionId) return;
    const safe = String(record.ptyId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    if (!safe) return;
    const dir = getResumeSpoolDir();
    const file = join(dir, `${safe}.json`);
    const tmp = join(dir, `${safe}.${process.pid}.${randomUUID()}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    try {
      if (existsSync(file)) {
        const existing = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof existing?.ts === 'number' && existing.ts > record.ts) {
          try { unlinkSync(tmp); } catch { /* ignore */ }
          return;
        }
      }
    } catch { /* replace a corrupt/unreadable existing spool */ }
    renameSync(tmp, file);
    logEvent('resume-spooled', { ptyId: record.ptyId, sessionId: record.sessionId });
  } catch (err) {
    logEvent('resume-spool-error', { error: String(err) });
  }
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
      // the reject path and exits 0 silently, which is the right outcome for a
      // payload this bridge was never going to forward anyway.
      try {
        res(JSON.parse(buf));
      } catch (err) {
        rej(err);
      }
    });
    process.stdin.on('error', rej);
  });
}

// ----- RPC over named pipe (mirrors the notify + Kiro bridges) -------------

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
      // Match OUR response by id and skip everything else: the daemon control
      // pipe BROADCASTS session events (no `id`) to every connected socket, and
      // one landing before the reply would otherwise be settled as the reply.
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

// Signals whose re-delivery cannot corrupt anything: each asserts a state
// rather than appending a record, and wmux's HookSignalRouter keeps a dedup
// ledger. See the Kiro bridge for the full argument — the trade is a possible
// duplicate (deduped) against a possible minutes-long stall (not).
//
// agent.user_prompt_submit is NOT in the set: it is claimed by the deck's
// brain-pty lane against a "one turn at a time" contract, where a duplicate is
// not obviously free. It stops at the first ambiguous write.
const IDEMPOTENT_KINDS = new Set(['agent.stop', 'agent.session_start']);

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
    // Per-target slice, not the whole remaining budget: a pipe that accepts
    // the connection and then hangs would otherwise spend every millisecond
    // here and the fallback endpoint would never be tried at all.
    const slice = Math.max(1, Math.floor(remaining / (targets.length - i)));
    result = await sendRpcWithRetry(candidate.pipe, buildRequest(candidate), Date.now() + slice);
    if (!shouldTryNextTarget(result, kind)) break;
  }
  return { result, target };
}

// ----- Envelope (pure — exported for unit testing) -------------------------

function nonEmptyStr(v) {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Build the canonical wmux AgentSignal for a Codex hook payload.
 *
 * Returns null when the event is not one wmux acts on, or when the pane cannot
 * be identified. Dropping beats guessing: a payload with no WMUX_PTY_ID cannot
 * be attributed to a pane, and attaching it to the wrong one is worse than
 * losing it. Codex DOES supply a session id, but a session id is not a pane —
 * two panes can hold two sessions in the same cwd.
 *
 * The ONLY payload fields read are `hook_event_name`, `session_id`, `cwd`,
 * `turn_id`, `transcript_path` and `source`. `prompt`, `last_assistant_message`
 * and `tool_input` are user and model content; this bridge is metadata-only,
 * and the allowlist here is where that is enforced.
 */
export function buildCodexHookEnvelope(payload, { env = process.env, now = Date.now() } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const event = nonEmptyStr(payload.hook_event_name);
  // hasOwn, not a bare index: `constructor` / `toString` / `__proto__` resolve
  // through the prototype chain to truthy values, sail past a `!kind` guard,
  // and produce an envelope whose `kind` is a function or `{}`. Same trap the
  // Kiro bridge documents.
  const kind = event && Object.hasOwn(EVENT_TO_KIND, event)
    ? EVENT_TO_KIND[event]
    : undefined;
  if (!kind) return null;

  const ptyId = nonEmptyStr(env.WMUX_PTY_ID);
  if (!ptyId) return null;

  const sessionId = nonEmptyStr(payload.session_id);
  const turnId = nonEmptyStr(payload.turn_id);
  const transcriptPath = nonEmptyStr(payload.transcript_path);
  // `source` is "startup" | "resume" on SessionStart. Metadata, not content.
  // NO CONSUMER YET — nothing in src/ reads signal.payload.source; it is
  // carried because it is the only field that distinguishes a resumed session
  // from a fresh one without inspecting the transcript, and dropping it now
  // would mean re-measuring later.
  const source = kind === 'agent.session_start' ? nonEmptyStr(payload.source) : undefined;
  const workspaceId = nonEmptyStr(env.WMUX_WORKSPACE_ID);
  const surfaceId = nonEmptyStr(env.WMUX_SURFACE_ID);

  return {
    kind,
    agent: 'codex',
    ...(sessionId ? { agentSessionId: sessionId } : {}),
    ptyId,
    ...(workspaceId ? { workspaceId } : {}),
    ...(surfaceId ? { surfaceId } : {}),
    cwd: nonEmptyStr(payload.cwd) ?? process.cwd(),
    // Metadata only. `turn_id` correlates a Stop with its UserPromptSubmit;
    // `transcript_path` feeds the resume binding's liveness probe; `source`
    // marks a resumed session and currently has no reader. Nothing here is
    // user or model text.
    payload: {
      ...(turnId ? { turn_id: turnId } : {}),
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
      ...(source ? { source } : {}),
    },
    ts: now,
  };
}

// ----- Main ---------------------------------------------------------------

async function main() {
  let payload;
  try {
    payload = await readStdin();
  } catch {
    // Parse diagnostics can quote the input; never copy them to the log.
    logEvent('malformed-stdin');
    return;
  }

  const envelope = buildCodexHookEnvelope(payload);
  if (!envelope) {
    // Two reasons, and the log distinguishes them without echoing content: an
    // event wmux does not act on, or a pane we cannot identify.
    const event = nonEmptyStr(payload?.hook_event_name);
    const known = Boolean(event) && Object.hasOwn(EVENT_TO_KIND, event);
    // Log the event name in BOTH cases. An unmapped name is the single most
    // useful thing in this log — it is how a Codex that renamed or added an
    // event becomes visible — and a `hook_event_name` is metadata, never
    // content. It is length-capped because the field is caller-controlled.
    logEvent(known ? 'no-pty-id' : 'ignored-event', { event: event ? event.slice(0, 64) : undefined });
    return;
  }

  const targets = resolveTargets();
  const sessionId = envelope.agentSessionId;
  if (targets.length === 0) {
    logEvent('no-auth-token', { paths: [getDaemonAuthTokenPath(), getAuthTokenPath()] });
    // Still spool so a later daemon boot reconciles the capture — but only for
    // a turn boundary, same gate as the send-failure path below. The record is
    // a RESUME BINDING; one written at SessionStart would name a session with
    // no turn in it yet, and one written at UserPromptSubmit would name a turn
    // that has not finished. Both would then win the don't-replace-newer rule
    // against the real Stop for that same pty key.
    if (sessionId && envelope.kind === 'agent.stop') {
      spoolResumeBinding({
        ptyId: envelope.ptyId,
        agent: 'codex',
        sessionId,
        cwd: envelope.cwd,
        transcriptPath: envelope.payload.transcript_path,
        ts: envelope.ts,
      });
    }
    return;
  }

  // One id across the walk so a fallback is correlatable in the log; each
  // target carries its own method + token (see resolveTargets).
  //
  // TODO(#1111): this request sends no `clientName`, so the daemon sees it as
  // an anonymous wmux.internal caller on `hooks.signal`. That is not a local
  // omission — neither wmux-codex-notify.mjs nor wmux-kiro-bridge.mjs sends one
  // either, and the lane closure needs ONE identification pattern across all
  // the bridges rather than three. Deliberately not invented here; adopt
  // whatever #1111 lands for the existing bridges.
  const requestId = `codex-hook-${randomUUID()}`;
  const { result: rpcResult, target } = await sendToTargets(targets, (t) => ({
    id: requestId,
    method: t.method,
    params: envelope,
    token: t.token,
  }), envelope.kind);
  const outerOk = rpcResult && rpcResult.ok === true;
  const innerOk = outerOk && rpcResult.result && rpcResult.result.ok === true;

  if (innerOk) {
    logEvent('ok', { kind: envelope.kind, target: target?.name });
    return;
  }

  logEvent(outerOk ? 'rpc-rejected' : 'rpc-failed', {
    kind: envelope.kind,
    target: target?.name,
    reason: rpcResult?.result?.reason,
    error: rpcResult?.error,
    detail: rpcResult?.detail,
  });
  // Anything but a durable success would lose the capture. Spool it (needs the
  // exact per-pane key) so the daemon reconciles it on its next boot. Only
  // agent.stop is spooled: the spool record is a RESUME BINDING, and a binding
  // written at session start would name a session with no turn in it yet.
  if (sessionId && envelope.kind === 'agent.stop') {
    spoolResumeBinding({
      ptyId: envelope.ptyId,
      agent: 'codex',
      sessionId,
      cwd: envelope.cwd,
      transcriptPath: envelope.payload.transcript_path,
      ts: envelope.ts,
    });
  }
}

// Run only when Codex spawned this file as a script. Under `import` (the unit
// tests, which exercise buildCodexHookEnvelope directly) the module must stay
// inert. Fails OPEN: anything it cannot determine is treated as a real launch,
// because a bridge that silently declines to run is the worse failure.
function invokedAsScript() {
  try {
    if (!process.argv[1]) return true;
    const self = fileURLToPath(import.meta.url);
    const entry = resolve(process.argv[1]);
    // realpath both sides before comparing. A textual match fails on a
    // symlinked install, an 8.3 short path, or a `subst` drive — and the only
    // symptom would be a bridge that silently never runs.
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
  // Self-enforced hard stop. HOOK_TIMEOUT_MS only bounds the SEND — a stdin
  // that never reaches EOF would hang before that. `unref` so this never keeps
  // the process alive on the normal path.
  const watchdog = setTimeout(() => {
    logEvent('watchdog-exit');
    process.exit(0);
  }, HOOK_TIMEOUT_MS * 2);
  watchdog.unref?.();
  main()
    .catch((err) => logEvent('uncaught', { error: String(err) }))
    // `process.exit(0)`, not just a resolved promise: this bridge never writes
    // stdout, so there is no pending flush to lose, and an explicit 0 keeps a
    // stray listener from holding the turn open.
    .finally(() => process.exit(0));
}
