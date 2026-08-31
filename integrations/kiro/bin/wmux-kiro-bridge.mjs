// wmux-managed: kiro-lifecycle-bridge
// wmux ↔ Kiro CLI hook bridge.
//
// Registered inside a wmux-owned Kiro agent config (`~/.kiro/agents/wmux.json`):
//   "hooks": { "stop": [{ "command": "node <abs path to this file>" }] }
// Kiro spawns it on the hook trigger and writes the event JSON to STDIN. The
// spawned process inherits the pane env, so WMUX_PTY_ID pins the signal to the
// exact pane and WMUX_DATA_SUFFIX pins every endpoint/file to that instance.
//
// This script:
//   1. Reads the Kiro hook payload from stdin (JSON).
//   2. Maps `hook_event_name` to a canonical AgentSignal kind.
//   3. Builds a METADATA-ONLY envelope and sends it to the first wmux endpoint
//      that answers: the DAEMON control pipe (`daemon.hooks.signal`), else the
//      MAIN pipe (`hooks.signal`). WMUX_HOOKS_TO_MAIN=1 forces main-only.
//   4. Exits 0 ALWAYS, under a hard timeout, so a wmux problem never stalls Kiro.
//
// ----- What Kiro measurably does and does not give us (2026-08-16, kiro-cli
//       2.15.1, measured live — see plans/r2-neutral-syntax-kiro-gemini) -----
//
//   * Triggers: agentSpawn | userPromptSubmit | preToolUse | postToolUse | stop.
//   * Neutral = no output, exit 0. Same contract as Claude Code.
//   * A FAILING hook does not block the turn: stderr + exit 2 still let the
//     agent answer normally. We still never write stdout and always exit 0 —
//     "the host tolerates it" is not a reason to be noisy.
//   * The `stop` payload is `{hook_event_name, cwd, assistant_response}`.
//     There is NO session id. Two consequences, both deliberate:
//       - pane attribution comes from WMUX_PTY_ID only, and a payload with no
//         pty id is DROPPED rather than guessed at;
//       - resume binding is impossible, so unlike the Codex bridge this one
//         has no spool — that spool carries a session id + launch command,
//         and there is none to write. A failed send still costs the turn
//         boundary itself; see the send path for what that means and why the
//         idempotent kinds keep walking.
//   * The payload carries CONTENT: `prompt` is the user's full input and
//     `assistant_response` is the model's full reply. wmux's bridges are
//     metadata-only, so those fields are never read, logged, or forwarded. The
//     allowlist below is the enforcement — not a filter applied afterwards.
//
// SELF-CONTAINED: JS-only, Node built-ins only — no imports from src/ or
// integrations/shared/. Mirrors integrations/codex/bin/wmux-codex-notify.mjs;
// the duplication across bridges is by design (a bridge runs in the agent's
// runtime, where wmux's TypeScript is unreachable).
//
// NO SHEBANG, deliberately. Kiro always invokes this as `node "<path>"` (the
// agent config says so), so the line bought nothing — and Vitest cannot parse
// a `.mjs` that starts with one, which would make the pure envelope builder
// below untestable except through a subprocess. The OpenCode plugin is
// shebang-free for the same reason and its tests import it directly.

import { readFileSync, existsSync, mkdirSync, appendFileSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';

const HOOK_TIMEOUT_MS = 2000; // hard cap so we never stall a Kiro turn
// Stamped on every kiro-bridge.log line; bump on behavior changes.
//   0.1.0 — initial: stop + agentSpawn, metadata-only, no resume binding.
const BRIDGE_VERSION = '0.1.0';
const CONNECT_RETRY_BACKOFFS_MS = [100, 250];
const TRANSIENT_CONNECT_CODES = new Set([
  'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EBUSY', 'EAGAIN',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Kiro's own default hook output cap is 10240 bytes; its payloads carry whole
// assistant replies, so cap what we will even hold in memory. Anything past
// this is a payload we have no business reading.
const MAX_STDIN_BYTES = 256 * 1024;

// ----- Trigger → AgentSignal kind -----------------------------------------
//
// Only the two triggers wmux can act on. `preToolUse`/`postToolUse` are
// deliberately absent: an activity stamp would cost a process spawn per tool
// call for a signal the server already throttles. `userPromptSubmit` is absent
// because Kiro has no approval-specific event, and mapping "a prompt was
// submitted" to awaiting_input would be the exact conflation #898 punished —
// no signal beats a false one.
const TRIGGER_TO_KIND = {
  stop: 'agent.stop',
  agentSpawn: 'agent.session_start',
};

// ----- Path helpers (Node built-ins only) ---------------------------------
//
// Kept in lockstep with src/shared/constants.ts. A non-empty suffix is an
// instance boundary: this bridge never probes production paths as a fallback
// when its selected namespace is suffixed.
// #1111: the envelope-less `legacy` grandfather these hook RPCs used to ride
// closes in the first release on or after 2026-09-30. `hooks.signal` on the
// MAIN pipe is `wmux.internal`, so no declaration can ever grant it; the
// enforcer instead recognises this exact clientName and allows that ONE method
// (src/main/mcp/hookBridge.ts). Keep it in lockstep with
// WMUX_HOOK_BRIDGE_CLIENT_NAME in src/shared/rpc.ts. Harmless on the daemon
// control pipe, which has no enforcer and ignores the extra envelope field.
const WMUX_CLIENT_NAME = 'wmux-hook-bridge';

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
// fallback rename), then derive within the same namespace.
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

// Ordered endpoints, daemon first (it is the always-on process and owns hook
// ingest). A target with no token file is skipped — that endpoint has never run.
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
  return join(dir, 'kiro-bridge.log');
}

// Never logs a caller-supplied payload field. `extra` is built by this file
// only, from the allowlist in main() — a log line is a place content leaks too.
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

// ----- stdin reader -------------------------------------------------------

function readStdin() {
  return new Promise((resolve, reject) => {
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
        resolve(null);
        return;
      }
      // Over the cap the JSON is truncated and will not parse; that lands in
      // the reject path and exits 0 silently, which is the right outcome for a
      // payload this bridge was never going to forward anyway.
      try {
        resolve(JSON.parse(buf));
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on('error', reject);
  });
}

// ----- RPC over named pipe (mirrors the Codex bridge) ---------------------

function sendRpc(pipePath, request, timeoutMs = HOOK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = createConnection(pipePath);
    let buffer = '';
    let settled = false;
    let wrote = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* already dead */ }
      resolve(result);
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
// ("this turn ended", "this session began") rather than appending a record, and
// wmux's HookSignalRouter keeps a dedup ledger, so a duplicate that lands
// inside its window is dropped before any user-visible dispatch.
//
// That matters because the alternative is not "one lost signal". Once ANY
// bridge signal reaches wmux the pane is hook-governed, and while that
// authority is fresh the detector's turn-end emissions are vetoed
// (HookIngest) — so a dropped `stop` is not re-derived from the screen, and
// the pane reads as still-working until the next signal lands or the authority
// ages out. Trading a possible duplicate (deduped) for a possible stall
// (minutes) is the right side of that bargain for these two kinds.
const IDEMPOTENT_KINDS = new Set(['agent.stop', 'agent.session_start']);

// Advance to the next endpoint when the request provably never reached a
// server — or when re-sending is harmless. An answered call owns the signal;
// a written-but-unanswered one is ambiguous, and for anything NOT in
// IDEMPOTENT_KINDS the ambiguity is where the walk stops.
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
    // here and the fallback endpoint would never be tried at all — the walk
    // would exist on paper only.
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
 * Build the canonical wmux AgentSignal for a Kiro hook payload.
 *
 * Returns null when the event is not one wmux acts on, or when the pane cannot
 * be identified. Dropping beats guessing: Kiro sends no session id, so a
 * payload with no WMUX_PTY_ID has nothing that could attribute it to a pane,
 * and attaching it to the wrong one is worse than losing it.
 *
 * The ONLY payload fields read are `hook_event_name` and `cwd`. `prompt` and
 * `assistant_response` are user and model content; this bridge is
 * metadata-only, and the allowlist here is where that is enforced.
 */
export function buildKiroEnvelope(payload, { env = process.env, now = Date.now() } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const trigger = nonEmptyStr(payload.hook_event_name);
  // hasOwn, not a bare index: `constructor` / `toString` / `__proto__` resolve
  // through the prototype chain to truthy values, sail past a `!kind` guard,
  // and produce an envelope whose `kind` is a function or `{}` — sent to the
  // daemon instead of being dropped. Measured before the fix:
  //   constructor -> kind=undefined (serialized), __proto__ -> kind={}
  const kind = trigger && Object.hasOwn(TRIGGER_TO_KIND, trigger)
    ? TRIGGER_TO_KIND[trigger]
    : undefined;
  if (!kind) return null;

  const ptyId = nonEmptyStr(env.WMUX_PTY_ID);
  if (!ptyId) return null;

  const workspaceId = nonEmptyStr(env.WMUX_WORKSPACE_ID);
  const surfaceId = nonEmptyStr(env.WMUX_SURFACE_ID);
  return {
    kind,
    agent: 'kiro',
    ptyId,
    ...(workspaceId ? { workspaceId } : {}),
    ...(surfaceId ? { surfaceId } : {}),
    cwd: nonEmptyStr(payload.cwd) ?? process.cwd(),
    // Metadata only. Kiro gives no session id, so there is no agentSessionId
    // and no resume binding to capture — see the header.
    payload: {},
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

  const envelope = buildKiroEnvelope(payload);
  if (!envelope) {
    // Two reasons, and the log distinguishes them without echoing content: an
    // event wmux does not act on, or a pane we cannot identify.
    const trigger = nonEmptyStr(payload?.hook_event_name);
    const known = Boolean(trigger) && Object.hasOwn(TRIGGER_TO_KIND, trigger);
    logEvent(known ? 'no-pty-id' : 'ignored-trigger', {
      trigger: known ? trigger : undefined,
    });
    return;
  }

  const targets = resolveTargets();
  if (targets.length === 0) {
    logEvent('no-auth-token', { paths: [getDaemonAuthTokenPath(), getAuthTokenPath()] });
    return;
  }

  // One id across the walk so a fallback is correlatable in the log; each
  // target carries its own method + token (see resolveTargets).
  const requestId = `kiro-hook-${randomUUID()}`;
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
    logEvent('ok', { kind: envelope.kind, target: target?.name });
  } else {
    // Nothing to spool: the existing spool carries a RESUME BINDING (session
    // id + launch command) for the daemon to reconcile at boot, and Kiro gives
    // no session id, so there is no such record to write.
    //
    // What a dropped signal costs, stated accurately: once any bridge signal
    // has reached wmux the pane is hook-governed, and while that authority is
    // fresh the detector's turn-end emissions are vetoed — so a lost `stop` is
    // NOT re-derived from the screen. The pane reads as still-working until
    // the next signal lands, the daemon restarts (authority is in-memory), or
    // the authority TTL expires. That bound is deliberate and shared with
    // every bridge (HOOK_AUTHORITY_TTL_MS: "short enough that a bridge killed
    // with -9 eventually returns the pane to the detector backstop"), but it
    // is minutes, not instant — which is why the walk above re-tries an
    // idempotent kind rather than stopping at the first ambiguous write.
    logEvent(outerOk ? 'rpc-rejected' : 'rpc-failed', {
      kind: envelope.kind,
      target: target?.name,
      reason: rpcResult?.result?.reason,
      error: rpcResult?.error,
      detail: rpcResult?.detail,
    });
  }
}

// Run only when Kiro spawned this file as a script. Under `import` (the unit
// tests, which exercise buildKiroEnvelope directly) the module must stay inert
// — otherwise it would read stdin and call process.exit(0) inside the test
// runner. Fails OPEN: anything it cannot determine is treated as a real launch,
// because a bridge that silently declines to run is the worse failure.
function invokedAsScript() {
  try {
    if (!process.argv[1]) return true;
    const self = fileURLToPath(import.meta.url);
    const entry = resolve(process.argv[1]);
    // realpath both sides before comparing. A textual match fails on a
    // symlinked install, an 8.3 short path, or a `subst` drive — and the only
    // symptom would be a bridge that silently never runs, which is the one
    // outcome this guard must not produce. realpathSync throws if the path is
    // gone; that lands in the catch, which fails OPEN by design.
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
  // Self-enforced hard stop. The header promises "exits 0 ALWAYS, under a hard
  // timeout", but HOOK_TIMEOUT_MS only bounds the SEND — a stdin that never
  // reaches EOF would hang before that, leaving the invariant resting entirely
  // on the host's own kill. Kiro was measured tolerating a hook that fails; it
  // was not measured killing one that hangs, so the bridge bounds itself.
  // `unref` so this never keeps the process alive on the normal path.
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
