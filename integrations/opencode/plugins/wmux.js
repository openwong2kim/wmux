// wmux ↔ OpenCode plugin bridge (turn-completion lifecycle signal).
//
// OpenCode plugins are IN-PROCESS modules loaded by the `opencode` CLI at
// startup from `.opencode/plugins/` (project) or `~/.config/opencode/plugins/`
// (global). Unlike the Codex bridge (a spawned `notify` program) this runs
// inside the long-lived opencode process and subscribes to its event stream.
//
// Why this exists: the wmux orchestrator (Command Deck) wakes on
// `agent.stop` lifecycle events. Claude Code emits them via its hook plugin and
// Codex via its notify bridge; OpenCode had NO bridge, so its turn completions
// reached wmux through neither the hook path (no bridge) nor the detector path
// (OpenCode's full-screen TUI never matches the placeholder REPL regex) nor
// osc133 (a shell-command-end marker, not a TUI turn end). Result: an
// orchestrator that assigned work to an OpenCode pane never learned when it
// finished. This plugin closes the gap on the DETERMINISTIC path: OpenCode's
// `session.idle` event (a session finished its turn) → a canonical wmux
// AgentSignal (agent:'opencode', kind:'agent.stop') sent over the same
// `hooks.signal` pipe RPC the Codex/Claude bridges use. hooks.rpc.ts is fully
// agent-agnostic, so no wmux-side change is needed to accept 'opencode'.
//
// SELF-CONTAINED: Node built-ins only (Bun implements node:net / node:fs /
// node:os / node:crypto), no imports from src/ or integrations/shared/ — the
// plugin runtime cannot resolve TS or repo-relative modules. The ~120 lines of
// pipe-RPC infra are duplicated from integrations/codex/bin/wmux-codex-notify.mjs
// by design (same constraint the Codex/Claude bridges accept).
//
// Routing: the envelope carries WMUX_PTY_ID (injected by the wmux daemon into
// the pane env at spawn) — the exact per-pane key hooks.rpc.ts prefers. Since
// opencode runs INSIDE a wmux pane, the env propagates through and pins the
// signal to the right pane even when a workspace has several panes.
//
// Best-effort + non-blocking: every failure is swallowed + logged to
// ~/.wmux/opencode-bridge.log; a wmux problem must never stall an opencode turn.

import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';

const HOOK_TIMEOUT_MS = 2000;
const BRIDGE_VERSION = '0.1.0';
const CONNECT_RETRY_BACKOFFS_MS = [100, 250];
const TRANSIENT_CONNECT_CODES = new Set([
  'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EBUSY', 'EAGAIN',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- Path helpers (Node built-ins only) ---------------------------------

function getAuthTokenPath() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return join(home, '.wmux-auth-token');
}

function getPipeName() {
  // WMUX_PIPE_NAME override for isolated / suffixed instances (same escape hatch
  // as the Codex bridge). Not a security widening — a same-user process can
  // already read the auth token, so redirecting the pipe grants nothing new.
  const override = process.env.WMUX_PIPE_NAME;
  if (typeof override === 'string' && override.length > 0) return override;
  if (process.platform === 'win32') {
    const username = userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux-${username}`;
  }
  return join(homedir() || '/tmp', '.wmux.sock');
}

function getLogPath() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const dir = join(home, '.wmux');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch { /* appendFileSync below also fails → swallowed */ }
  return join(dir, 'opencode-bridge.log');
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

// ----- Envelope builder (pure — exported for unit testing) -----------------

function nonEmptyStr(v) {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Build the canonical wmux AgentSignal envelope for an OpenCode turn completion.
 * Pure: reads env + args, returns the object, does no I/O. `env` is injected so
 * the unit test can drive it without mutating process.env.
 *
 * kind 'agent.stop' = a turn finished (the strongest "task done" signal the
 * orchestrator wakes on). agentSessionId is opaque/forensic; routing uses ptyId
 * (exact per-pane) → workspaceId → cwd, in that order (see signal-types.ts).
 */
export function buildOpencodeStopEnvelope({ env = process.env, cwd, sessionId, now } = {}) {
  const ptyId = nonEmptyStr(env.WMUX_PTY_ID);
  const workspaceId = nonEmptyStr(env.WMUX_WORKSPACE_ID);
  const surfaceId = nonEmptyStr(env.WMUX_SURFACE_ID);
  const resolvedCwd = nonEmptyStr(cwd) ?? process.cwd();
  const sid = nonEmptyStr(sessionId);
  return {
    kind: 'agent.stop',
    agent: 'opencode',
    ...(sid ? { agentSessionId: sid } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(surfaceId ? { surfaceId } : {}),
    ...(ptyId ? { ptyId } : {}),
    cwd: resolvedCwd,
    payload: {},
    ts: typeof now === 'number' ? now : Date.now(),
  };
}

// ----- RPC over named pipe (mirrors the Codex bridge) ----------------------

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

    const timer = setTimeout(() => settle({ ok: false, error: 'timeout' }), timeoutMs);

    sock.on('connect', () => {
      sock.write(JSON.stringify(request) + '\n');
      wrote = true;
    });
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        try {
          settle(JSON.parse(buffer.slice(0, nl)));
        } catch {
          settle({ ok: false, error: 'malformed-response' });
        }
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      settle({ ok: false, error: 'connect-error', detail: err.code ?? err.message, retryable: !wrote });
    });
    sock.on('close', () => {
      clearTimeout(timer);
      settle({ ok: false, error: 'closed-without-response' });
    });
  });
}

async function sendRpcWithRetry(pipePath, request) {
  const deadline = Date.now() + HOOK_TIMEOUT_MS;
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

// ----- Signal dispatch -----------------------------------------------------

async function signalTurnComplete({ cwd, sessionId }) {
  const tokenPath = getAuthTokenPath();
  if (!existsSync(tokenPath)) {
    logEvent('no-auth-token', { path: tokenPath });
    return;
  }
  let token;
  try {
    token = readFileSync(tokenPath, 'utf8').trim();
  } catch (err) {
    logEvent('auth-token-read-error', { error: String(err) });
    return;
  }
  if (!token) {
    logEvent('empty-auth-token', {});
    return;
  }

  const envelope = buildOpencodeStopEnvelope({ cwd, sessionId });
  const request = {
    id: `opencode-idle-${randomUUID()}`,
    method: 'hooks.signal',
    params: envelope,
    token,
  };

  const rpcResult = await sendRpcWithRetry(getPipeName(), request);
  const outerOk = rpcResult && rpcResult.ok === true;
  const innerOk = outerOk && rpcResult.result && rpcResult.result.ok === true;
  if (innerOk) {
    logEvent('ok', { ptyId: envelope.ptyId, sessionId: envelope.agentSessionId });
  } else {
    logEvent(outerOk ? 'rpc-rejected' : 'rpc-failed', {
      reason: rpcResult?.result?.reason,
      error: rpcResult?.error,
      detail: rpcResult?.detail,
    });
  }
}

// ----- Plugin export -------------------------------------------------------

/**
 * The OpenCode plugin. Subscribes to the event stream and forwards each
 * `session.idle` (a session finished its turn) to wmux as an `agent.stop`
 * signal. Every branch is guarded + best-effort — an exception here must never
 * disrupt the opencode session.
 *
 * `directory` (the plugin context's project dir) seeds the envelope cwd; the
 * pane env (WMUX_PTY_ID etc.) does the actual routing.
 */
export const WmuxBridge = async ({ directory } = {}) => {
  logEvent('loaded', { directory: nonEmptyStr(directory) });
  return {
    event: async ({ event }) => {
      try {
        if (!event || event.type !== 'session.idle') return;
        // Field shape is version-dependent; read the session id defensively for
        // forensic logging only (routing never depends on it).
        const sessionId =
          nonEmptyStr(event?.properties?.sessionID) ??
          nonEmptyStr(event?.properties?.sessionId) ??
          nonEmptyStr(event?.sessionID);
        await signalTurnComplete({ cwd: nonEmptyStr(directory), sessionId });
      } catch (err) {
        logEvent('event-handler-error', { error: String(err) });
      }
    },
  };
};

export default WmuxBridge;
