// wmux-managed: opencode-lifecycle-bridge
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
// AgentSignal (agent:'opencode', kind:'agent.stop') sent daemon-first over
// `daemon.hooks.signal`, with the main process's `hooks.signal` as the fallback
// when the daemon was not reached. Both handlers are agent-agnostic.
//
// SELF-CONTAINED: Node built-ins only (Bun implements node:net / node:fs /
// node:os / node:crypto), no imports from src/ or integrations/shared/ — the
// plugin runtime cannot resolve TS or repo-relative modules. The pipe-RPC infra
// is duplicated from integrations/codex/bin/wmux-codex-notify.mjs by design
// (same constraint the Codex/Claude bridges accept).
//
// Routing: the envelope carries WMUX_PTY_ID (injected by the wmux daemon into
// the pane env at spawn) — the exact per-pane key hook ingest prefers. Since
// opencode runs INSIDE a wmux pane, the env propagates through and pins the
// signal to the right pane even when a workspace has several panes.
//
// Best-effort + non-blocking: every failure is swallowed + logged to the
// selected ~/.wmux${WMUX_DATA_SUFFIX}/opencode-bridge.log namespace; a wmux
// problem must never stall an opencode turn.

import {
  readFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';

const HOOK_TIMEOUT_MS = 2000;
// Stamped on every opencode-bridge.log line; bump on behavior changes.
//   0.2.0 — suffix-isolated daemon-first lifecycle routing + durable stop metadata.
//   0.2.1 — session.idle dispatch detached from the OpenCode event loop.
//   0.2.2 — safe legacy-daemon fallback and canonical main socket discovery.
//   0.2.3 — consistent permission request/reply correlation.
const BRIDGE_VERSION = '0.2.3';
const CONNECT_RETRY_BACKOFFS_MS = [100, 250];
const TRANSIENT_CONNECT_CODES = new Set([
  'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EBUSY', 'EAGAIN',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- Path helpers (Node built-ins only) ---------------------------------

// Keep these formulas in lockstep with src/shared/constants.ts. A non-empty
// suffix is an instance boundary: this plugin never probes production paths as
// an implicit fallback when its selected namespace is suffixed.
export function dataSuffix() {
  return process.env.WMUX_DATA_SUFFIX || '';
}

export function getHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || homedir();
}

export function getWmuxHomeDir() {
  return join(getHomeDir(), `.wmux${dataSuffix()}`);
}

export function getAuthTokenPath() {
  return join(getHomeDir(), `.wmux${dataSuffix()}-auth-token`);
}

export function getPipeName() {
  // WMUX_PIPE_NAME is an explicit single-endpoint override for isolated probes
  // and advanced multi-instance setups. It must not fall through to a real
  // daemon when the selected override is unavailable.
  const override = process.env.WMUX_PIPE_NAME;
  if (typeof override === 'string' && override.length > 0) return override;
  if (process.platform === 'win32') {
    const username = userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux${dataSuffix()}-${username}`;
  }
  return join(homedir() || '/tmp', `.wmux${dataSuffix()}.sock`);
}

// ----- Daemon endpoint (hook ingest lives in the daemon) ------------------

export function getDaemonAuthTokenPath() {
  return join(getWmuxHomeDir(), 'daemon-auth-token');
}

// The hint records the socket the daemon actually bound, including a zombie-
// socket fallback rename. It is read only from the selected suffix namespace;
// the derived fallback is in that same namespace as well.
export function getDaemonPipeName() {
  try {
    const fromFile = readFileSync(join(getWmuxHomeDir(), 'daemon-pipe'), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch {
    // Hint absent/unreadable — derive inside the selected namespace.
  }
  if (process.platform === 'win32') {
    const username = userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux-daemon${dataSuffix()}-${username}`;
  }
  return join(getWmuxHomeDir(), 'daemon.sock');
}

// #1111: the envelope-less `legacy` grandfather these hook RPCs used to ride
// closes in the first release on or after 2026-09-30. `hooks.signal` on the
// MAIN pipe is `wmux.internal`, so no declaration can ever grant it; the
// enforcer instead recognises this exact clientName and allows that ONE method
// (src/main/mcp/hookBridge.ts). Keep it in lockstep with
// WMUX_HOOK_BRIDGE_CLIENT_NAME in src/shared/rpc.ts. Harmless on the daemon
// control pipe, which has no enforcer and ignores the extra envelope field.
const WMUX_CLIENT_NAME = 'wmux-hook-bridge';

function readTokenFile(tokenPath) {
  try {
    const token = readFileSync(tokenPath, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

// Ordered endpoints. Missing token files skip their endpoint. The existing
// WMUX_PIPE_NAME override remains a MAIN-addressed, one-target escape hatch;
// WMUX_HOOKS_TO_MAIN=1 is the main-only kill switch.
export function resolveTargets() {
  const mainToken = readTokenFile(getAuthTokenPath());
  const pipeOverride = process.env.WMUX_PIPE_NAME;
  if (typeof pipeOverride === 'string' && pipeOverride.length > 0) {
    return mainToken
      ? [{ name: 'main', pipe: pipeOverride, token: mainToken, method: 'hooks.signal' }]
      : [];
  }

  const targets = [];
  if (process.env.WMUX_HOOKS_TO_MAIN !== '1') {
    const daemonToken = readTokenFile(getDaemonAuthTokenPath());
    if (daemonToken) {
      targets.push({
        name: 'daemon',
        pipe: getDaemonPipeName(),
        token: daemonToken,
        method: 'daemon.hooks.signal',
      });
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

// ----- Resume-binding spool (daemon drains on next boot) -----------------

function getResumeSpoolDir() {
  const dir = join(getWmuxHomeDir(), 'resume-spool');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch { /* writeFileSync below throws + is swallowed */ }
  return dir;
}

// This is deliberately a resume-binding record, never a deferred signal. In
// particular it cannot contain permission titles, prompt text, or any payload.
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

    const timer = setTimeout(
      () => settle({ ok: false, error: 'timeout', retryable: !wrote }),
      timeoutMs,
    );

    sock.on('connect', () => {
      sock.write(JSON.stringify(request) + '\n');
      wrote = true;
    });
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      // The daemon broadcasts agent events on this same connection. Ignore
      // broadcasts, malformed lines, and other callers' replies; only our id
      // can settle this request.
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

// A multi-target walk shares one deadline so daemon-first routing never doubles
// the plugin's pre-existing maximum wait.
async function sendRpcWithRetry(pipePath, request, deadline = Date.now() + HOOK_TIMEOUT_MS) {
  let attempt = 0;
  let last = { ok: false, error: 'timeout', retryable: true };
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

// Advance only when the request provably never reached a server. Any outer-ok
// reply (including an inner logical rejection such as no-workspace-match) owns
// the signal, and a post-write disconnect is ambiguous, so both stop the walk.
// A dispatch/auth refusal from an old daemon has outer ok=false and no
// retryable=false marker; falling back to main is safe because the lifecycle
// handler did not run.
export function shouldTryNextTarget(result) {
  if (result && result.ok === true) return false;
  if (result && result.retryable === false) return false;
  return true;
}

async function sendToTargets(targets, buildRequest) {
  const deadline = Date.now() + HOOK_TIMEOUT_MS;
  let result = { ok: false, error: 'no-target', retryable: true };
  let target = null;
  for (const candidate of targets) {
    if (Date.now() >= deadline) break;
    target = candidate;
    result = await sendRpcWithRetry(candidate.pipe, buildRequest(candidate), deadline);
    if (!shouldTryNextTarget(result)) break;
  }
  return { result, target };
}

// ----- Signal dispatch -----------------------------------------------------

function spoolStopResumeBinding(envelope) {
  if (envelope.kind !== 'agent.stop' || !envelope.ptyId || !envelope.agentSessionId) return;
  spoolResumeBinding({
    ptyId: envelope.ptyId,
    agent: 'opencode',
    sessionId: envelope.agentSessionId,
    cwd: envelope.cwd,
    ts: envelope.ts,
  });
}

/** Send one already-built AgentSignal envelope to daemon first, then main. */
async function sendSignal(envelope, idPrefix) {
  const targets = resolveTargets();
  if (targets.length === 0) {
    logEvent('no-auth-token', { paths: [getDaemonAuthTokenPath(), getAuthTokenPath()] });
    spoolStopResumeBinding(envelope);
    return;
  }

  // Reuse one id across the target walk so every accepted reply is correlated
  // to this one lifecycle event.
  const requestId = `${idPrefix}-${randomUUID()}`;
  const { result: rpcResult, target } = await sendToTargets(targets, (candidate) => ({
    id: requestId,
    method: candidate.method,
    params: envelope,
    token: candidate.token,
    clientName: WMUX_CLIENT_NAME,
  }));
  const outerOk = rpcResult && rpcResult.ok === true;
  const innerOk = outerOk && rpcResult.result && rpcResult.result.ok === true;
  if (innerOk) {
    logEvent('ok', {
      kind: envelope.kind,
      target: target?.name,
      ptyId: envelope.ptyId,
      sessionId: envelope.agentSessionId,
    });
  } else {
    logEvent(outerOk ? 'rpc-rejected' : 'rpc-failed', {
      kind: envelope.kind,
      target: target?.name,
      reason: rpcResult?.result?.reason,
      error: rpcResult?.error,
      detail: rpcResult?.detail,
    });
    spoolStopResumeBinding(envelope);
  }
}

// ----- Plugin export -------------------------------------------------------

/** How long a permission request may sit unanswered before we treat it as a
 *  genuine wait. Auto-approved permissions fire an ask/update and then a reply
 *  within milliseconds; holding briefly lets us cancel those and only surface
 *  awaiting_input for permissions a human/orchestrator actually has to act on.
 *  Not latency-critical. */
const PERMISSION_SETTLE_MS = 500;

/**
 * The OpenCode plugin. Subscribes to the event stream and forwards:
 *   - session.idle                         → agent.stop
 *   - permission.asked / permission.updated → agent.awaiting_input,
 *                                             debounced for auto-approval.
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
  // permission request id → settle timer. A permission.replied for the same id
  // before the timer fires cancels awaiting_input (the permission auto-resolved).
  const pendingPermissions = new Map();
  const permissionRequestId = (properties = {}) => nonEmptyStr(properties.id)
    ?? nonEmptyStr(properties.requestID)
    ?? nonEmptyStr(properties.permissionID);

  return {
    event: async ({ event }) => {
      try {
        if (!event || typeof event.type !== 'string') return;

        if (event.type === 'session.idle') {
          const sessionId = nonEmptyStr(event?.properties?.sessionID);
          // OpenCode awaits plugin event handlers. Detach the child lookup and
          // pipe RPC so even a wedged endpoint cannot add the 2s transport cap
          // to the TUI's idle transition. The OpenCode process is long-lived;
          // sendSignal retains its own bounded deadline and error logging.
          void (async () => {
            try {
              if (await isChildSession(client, sessionId)) {
                logEvent('skip-child-idle', { sessionId });
                return;
              }
              await sendSignal(buildOpencodeEnvelope('agent.stop', { cwd, sessionId }), 'opencode-idle');
            } catch (err) {
              logEvent('idle-signal-error', { error: String(err) });
            }
          })();
          return;
        }

        if (event.type === 'permission.asked' || event.type === 'permission.updated') {
          // Current permission.asked and legacy permission.updated both carry a
          // request-like object with id/sessionID; legacy builds may add title.
          const perm = event?.properties ?? {};
          const permId = permissionRequestId(perm);
          if (!permId || pendingPermissions.has(permId)) return;
          const sessionId = nonEmptyStr(perm.sessionID) ?? nonEmptyStr(perm.sessionId);
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
          // Current/legacy SDKs have used requestID, permissionID, and id.
          const reply = event?.properties ?? {};
          const permId = permissionRequestId(reply);
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
