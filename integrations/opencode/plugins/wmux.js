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
// Routing: the envelope carries WMUX_PTY_ID (injected by the Forge Mux daemon into
// the pane env at spawn) — the exact per-pane key hooks.rpc.ts prefers. Since
// opencode runs INSIDE a wmux pane, the env propagates through and pins the
// signal to the right pane even when a workspace has several panes.
//
// Best-effort + non-blocking: every failure is swallowed + logged to
// ~/.fmux/opencode-bridge.log; a wmux problem must never stall an opencode turn.

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
  return join(home, '.fmux-auth-token');
}

function getPipeName() {
  // WMUX_PIPE_NAME override for isolated / suffixed instances (same escape hatch
  // as the Codex bridge). Not a security widening — a same-user process can
  // already read the auth token, so redirecting the pipe grants nothing new.
  const override = process.env.WMUX_PIPE_NAME;
  if (typeof override === 'string' && override.length > 0) return override;
  if (process.platform === 'win32') {
    const username = userInfo().username || 'default';
    return `\\\\.\\pipe\\fmux-${username}`;
  }
  return join(homedir() || '/tmp', '.fmux.sock');
}

function getLogPath() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const dir = join(home, '.fmux');
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
 * Build a canonical wmux AgentSignal envelope for an OpenCode lifecycle event.
 * Pure: reads env + args, returns the object, does no I/O. `env` is injected so
 * the unit test can drive it without mutating process.env.
 *
 * `kind` is 'agent.stop' (a turn finished — the strongest "task done" signal) or
 * 'agent.awaiting_input' (the session is blocked on a permission approval).
 * agentSessionId is opaque/forensic; routing uses ptyId (exact per-pane) →
 * workspaceId → cwd, in that order (see signal-types.ts).
 */
export function buildOpencodeEnvelope(kind, { env = process.env, cwd, sessionId, payload, now } = {}) {
  const ptyId = nonEmptyStr(env.WMUX_PTY_ID);
  const workspaceId = nonEmptyStr(env.WMUX_WORKSPACE_ID);
  const surfaceId = nonEmptyStr(env.WMUX_SURFACE_ID);
  const resolvedCwd = nonEmptyStr(cwd) ?? process.cwd();
  const sid = nonEmptyStr(sessionId);
  return {
    kind,
    agent: 'opencode',
    ...(sid ? { agentSessionId: sid } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(surfaceId ? { surfaceId } : {}),
    ...(ptyId ? { ptyId } : {}),
    cwd: resolvedCwd,
    payload: payload && typeof payload === 'object' ? payload : {},
    ts: typeof now === 'number' ? now : Date.now(),
  };
}

/** Back-compat thin wrapper (agent.stop). */
export function buildOpencodeStopEnvelope(opts = {}) {
  return buildOpencodeEnvelope('agent.stop', opts);
}

/**
 * Is this session a CHILD (sub-agent) session? Sub-sessions go idle on every
 * sub-agent turn; waking the orchestrator on each would over-fire. We treat a
 * session with a `parentID` as a child and suppress its lifecycle signal
 * (matches opencode-notify's notifyChildSessions=false default). FAIL-OPEN: if
 * there is no client, no session id, or the lookup throws, return false (treat
 * as a root session and EMIT) — a slightly noisy wake beats a missed completion.
 * Exported for unit testing with a fake client.
 */
export async function isChildSession(client, sessionID) {
  if (!client || !sessionID) return false;
  try {
    const res = await client.session.get({ path: { id: sessionID } });
    // hey-api client returns { data, error }; older/fake clients may return the
    // session directly. Accept either shape.
    const session = res && typeof res === 'object' && 'data' in res ? res.data : res;
    return typeof session?.parentID === 'string' && session.parentID.length > 0;
  } catch {
    return false;
  }
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

/** Read the wmux auth token, or null (logged) when unavailable. */
function readAuthToken() {
  const tokenPath = getAuthTokenPath();
  if (!existsSync(tokenPath)) {
    logEvent('no-auth-token', { path: tokenPath });
    return null;
  }
  let token;
  try {
    token = readFileSync(tokenPath, 'utf8').trim();
  } catch (err) {
    logEvent('auth-token-read-error', { error: String(err) });
    return null;
  }
  if (!token) {
    logEvent('empty-auth-token', {});
    return null;
  }
  return token;
}

/** Send one already-built AgentSignal envelope over the wmux hooks.signal pipe. */
async function sendSignal(envelope, idPrefix) {
  const token = readAuthToken();
  if (!token) return;
  const request = {
    id: `${idPrefix}-${randomUUID()}`,
    method: 'hooks.signal',
    params: envelope,
    token,
  };
  const rpcResult = await sendRpcWithRetry(getPipeName(), request);
  const outerOk = rpcResult && rpcResult.ok === true;
  const innerOk = outerOk && rpcResult.result && rpcResult.result.ok === true;
  if (innerOk) {
    logEvent('ok', { kind: envelope.kind, ptyId: envelope.ptyId, sessionId: envelope.agentSessionId });
  } else {
    logEvent(outerOk ? 'rpc-rejected' : 'rpc-failed', {
      kind: envelope.kind,
      reason: rpcResult?.result?.reason,
      error: rpcResult?.error,
      detail: rpcResult?.detail,
    });
  }
}

// ----- Plugin export -------------------------------------------------------

/** How long a `permission.updated` may sit unanswered before we treat it as a
 *  genuine wait. Auto-approved permissions (opencode `"permission": "allow"`)
 *  fire permission.updated then permission.replied within milliseconds; holding
 *  briefly lets us cancel those and only surface awaiting_input for permissions
 *  a human/orchestrator actually has to act on. Not latency-critical. */
const PERMISSION_SETTLE_MS = 500;

/**
 * The OpenCode plugin. Subscribes to the event stream and forwards:
 *   - session.idle          → agent.stop           (a turn finished)
 *   - permission.updated    → agent.awaiting_input  (blocked on an approval),
 *                             debounced so auto-allowed permissions don't fire.
 * Child (sub-agent) sessions are suppressed so the orchestrator wakes on the
 * root session's turns, not every sub-agent turn. Every branch is guarded +
 * best-effort — an exception here must never disrupt the opencode session.
 *
 * `client` (the OpenCode SDK client) resolves a session's parentID; `directory`
 * seeds the envelope cwd; the pane env (WMUX_PTY_ID etc.) does the routing.
 */
export const WmuxBridge = async ({ directory, client } = {}) => {
  logEvent('loaded', { directory: nonEmptyStr(directory), hasClient: !!client });
  const cwd = nonEmptyStr(directory);
  // permissionID → settle timer. A permission.replied for the same id before the
  // timer fires cancels the awaiting_input (the permission auto-resolved).
  const pendingPermissions = new Map();

  return {
    event: async ({ event }) => {
      try {
        if (!event || typeof event.type !== 'string') return;

        if (event.type === 'session.idle') {
          const sessionId = nonEmptyStr(event?.properties?.sessionID);
          if (await isChildSession(client, sessionId)) {
            logEvent('skip-child-idle', { sessionId });
            return;
          }
          await sendSignal(buildOpencodeEnvelope('agent.stop', { cwd, sessionId }), 'opencode-idle');
          return;
        }

        if (event.type === 'permission.updated') {
          // properties: Permission { id, sessionID, title, ... }
          const perm = event?.properties ?? {};
          const permId = nonEmptyStr(perm.id);
          if (!permId || pendingPermissions.has(permId)) return;
          const sessionId = nonEmptyStr(perm.sessionID);
          const title = nonEmptyStr(perm.title);
          const timer = setTimeout(() => {
            pendingPermissions.delete(permId);
            void (async () => {
              try {
                // Only the root session's approvals are the orchestrator's to
                // handle (same child suppression as idle).
                if (await isChildSession(client, sessionId)) {
                  logEvent('skip-child-permission', { sessionId, permId });
                  return;
                }
                await sendSignal(
                  buildOpencodeEnvelope('agent.awaiting_input', {
                    cwd,
                    sessionId,
                    payload: title ? { title } : {},
                  }),
                  'opencode-perm',
                );
              } catch (err) {
                logEvent('permission-signal-error', { error: String(err) });
              }
            })();
          }, PERMISSION_SETTLE_MS);
          timer.unref?.();
          pendingPermissions.set(permId, timer);
          return;
        }

        if (event.type === 'permission.replied') {
          // properties: { sessionID, permissionID, response }
          const permId = nonEmptyStr(event?.properties?.permissionID);
          const timer = permId ? pendingPermissions.get(permId) : undefined;
          if (timer) {
            clearTimeout(timer);
            pendingPermissions.delete(permId);
            logEvent('permission-auto-resolved', { permId });
          }
          return;
        }
      } catch (err) {
        logEvent('event-handler-error', { error: String(err) });
      }
    },
  };
};

export default WmuxBridge;
