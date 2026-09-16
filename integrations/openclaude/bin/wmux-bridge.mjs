#!/usr/bin/env node
// wmux <-> OpenClaude hook bridge.
//
// Invoked by OpenClaude when one of its hooks fires (PostToolUse, Stop,
// SubagentStop, SessionStart). This script:
//   1. Determines the hook name from process.argv[2].
//   2. Reads the OpenClaude hook payload from stdin (JSON).
//   3. Builds the canonical AgentSignal envelope.
//   4. Sends it to the first wmux endpoint that answers: the DAEMON control
//      pipe (`daemon.hooks.signal`, token ~/.wmux/daemon-auth-token — works
//      with the GUI closed), else the MAIN pipe (`hooks.signal`, token
//      ~/.wmux-auth-token). WMUX_HOOKS_TO_MAIN=1 forces main-only.
//   5. Logs the outcome (and the endpoint that served it) to ~/.wmux/bridge.log.
//   6. Exits 0 ALWAYS (so a wmux problem never breaks OpenClaude).
//
// THIS FILE IS SELF-CONTAINED. It runs from inside an OpenClaude plugin
// where TypeScript transpilation is NOT available. Do not import anything
// from src/, integrations/shared/, or node_modules — only Node built-ins.
//
// Adapted from integrations/claude/bin/wmux-bridge.mjs for OpenClaude support.

import { readFileSync, existsSync, mkdirSync, appendFileSync, statSync, openSync, readSync, closeSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';

const HOOK_TIMEOUT_MS = 2000; // hard cap so we never slow OpenClaude
// Stamped on every bridge.log line; bump on behavior changes.
//   0.2.0 — daemon-first targeting (daemon.hooks.signal -> hooks.signal).
const BRIDGE_VERSION = '0.2.0';

// Retry transient connect failures within the HOOK_TIMEOUT_MS budget.
// A pipe that is ABSENT (ENOENT — wmux not running) is NOT retried.
const CONNECT_RETRY_BACKOFFS_MS = [100, 250];
const TRANSIENT_CONNECT_CODES = new Set([
  'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EBUSY', 'EAGAIN',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Cap stdin at 1MB to prevent OOM from large tool outputs.
const MAX_STDIN_BYTES = 1 * 1024 * 1024;

// ----- Hook name -> AgentSignal kind ---------------------------------------

const HOOK_TO_KIND = {
  PreToolUse: 'agent.awaiting_input',
  PostToolUse: 'agent.activity',
  Stop: 'agent.stop',
  SubagentStop: 'agent.subagent_stop',
  SessionStart: 'agent.session_start',
};

// AskUserQuestion completing means the user answered it on this machine, so
// PostToolUse is promoted to agent.input_answered and the daemon expires the
// approval record a remote device is still showing as pending (#770). Every
// other tool stays a plain activity stamp. PostToolUse only runs after a tool
// completes, so the tool name is the whole signal.
// #1111: the envelope-less `legacy` grandfather these hook RPCs used to ride
// closes in the first release on or after 2026-09-30. `hooks.signal` on the
// MAIN pipe is `wmux.internal`, so no declaration can ever grant it; the
// enforcer instead recognises this exact clientName and allows that ONE method
// (src/main/mcp/hookBridge.ts). Keep it in lockstep with
// WMUX_HOOK_BRIDGE_CLIENT_NAME in src/shared/rpc.ts. Harmless on the daemon
// control pipe, which has no enforcer and ignores the extra envelope field.
const WMUX_CLIENT_NAME = 'wmux-hook-bridge';

function getPostToolUseKind(payload) {
  if (payload && payload.tool_name === 'AskUserQuestion') {
    return 'agent.input_answered';
  }
  return 'agent.activity';
}

// ----- Path helpers (Node built-ins only) ---------------------------------

function getAuthTokenPath() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return join(home, '.wmux-auth-token');
}

function getPipeName() {
  if (process.platform === 'win32') {
    const username = userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux-${username}`;
  }
  return join(homedir() || '/tmp', '.wmux.sock');
}

// ----- Daemon endpoint (M1: hook ingest lives in the daemon) ---------------
//
// The daemon is the always-on process and owns hook ingest, so it is tried
// first; the main pipe stays as the fallback for an older wmux or a daemon
// that is down. Same ~/.wmux (no data-suffix) limitation as bridge.log — the
// pane env strips WMUX_DATA_SUFFIX, so a dev-suffix daemon is unreachable here.
function getDaemonAuthTokenPath() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return join(home, '.wmux', 'daemon-auth-token');
}

// Prefer the `daemon-pipe` hint file the daemon writes at boot (the name it
// ACTUALLY bound, which differs from the convention after a zombie-pipe
// fallback rename), then the derived name.
function getDaemonPipeName() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  try {
    const fromFile = readFileSync(join(home, '.wmux', 'daemon-pipe'), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch {
    // Hint file absent/unreadable — fall through to the derived name.
  }
  if (process.platform === 'win32') {
    const username = userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux-daemon-${username}`;
  }
  return join(home, '.wmux', 'daemon.sock');
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
// never run). WMUX_HOOKS_TO_MAIN=1 drops the daemon target — the kill switch.
function resolveTargets() {
  const targets = [];
  if (process.env.WMUX_HOOKS_TO_MAIN !== '1') {
    const token = readTokenFile(getDaemonAuthTokenPath());
    if (token) {
      targets.push({ name: 'daemon', pipe: getDaemonPipeName(), token, method: 'daemon.hooks.signal' });
    }
  }
  const mainToken = readTokenFile(getAuthTokenPath());
  if (mainToken) {
    targets.push({ name: 'main', pipe: getPipeName(), token: mainToken, method: 'hooks.signal' });
  }
  return targets;
}

function getBridgeLogPath() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const dir = join(home, '.wmux');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // mkdir failures fall through; appendFileSync below will also fail
    // and the catch in logEvent will silently drop.
  }
  return join(dir, 'bridge.log');
}

// Durable resume-binding spool dir for failed RPC calls.
function getResumeSpoolDir() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const dir = join(home, '.wmux', 'resume-spool');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Fall through; the writeFileSync below will throw and be swallowed.
  }
  return dir;
}

// Persist one capture record, keyed by ptyId (last-write-wins per pane).
// Atomic via temp-then-rename. Never throws.
function spoolResumeBinding(record) {
  try {
    if (!record || !record.ptyId || !record.sessionId) return;
    const safe = String(record.ptyId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    if (!safe) return;
    const dir = getResumeSpoolDir();
    const file = join(dir, `${safe}.json`);
    const tmp = join(dir, `${safe}.${process.pid}.${randomUUID()}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    // Don't replace a spool file that already holds a NEWER capture.
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

// ----- Logging (best-effort, never throws) --------------------------------

function logEvent(outcome, extra) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    bridge: BRIDGE_VERSION,
    pid: process.pid,
    hook: process.argv[2] ?? '?',
    outcome,
    ...(extra ?? {}),
  });
  try {
    appendFileSync(getBridgeLogPath(), line + '\n', { encoding: 'utf8' });
  } catch {
    // No writable home -> swallow.
  }
}

// ----- Transcript usage extraction ----------------------------------------

// Tail-read the last 64KB of a JSONL transcript and pull `usage` from
// the most recent assistant message. Returns null on any failure.
function extractUsageFromTranscript(transcriptPath) {
  try {
    if (!existsSync(transcriptPath)) return null;
    const stat = statSync(transcriptPath);
    const TAIL_BYTES = 64 * 1024;
    const readBytes = Math.min(TAIL_BYTES, stat.size);
    const offset = stat.size - readBytes;
    const buf = Buffer.alloc(readBytes);
    const fd = openSync(transcriptPath, 'r');
    try {
      readSync(fd, buf, 0, readBytes, offset);
    } finally {
      closeSync(fd);
    }
    const tail = buf.toString('utf8');
    const start = offset > 0 ? tail.indexOf('\n') + 1 : 0;
    const lines = tail.slice(start).split('\n').filter((l) => l.trim().length > 0);

    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (entry && entry.type === 'assistant' && entry.message && entry.message.usage) {
        const u = entry.message.usage;
        const inputTokens = (typeof u.input_tokens === 'number' ? u.input_tokens : 0)
          + (typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0)
          + (typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0);
        const outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
        return {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        };
      }
    }
    return null;
  } catch (err) {
    logEvent('transcript-read-error', { error: String(err) });
    return null;
  }
}

// Extract permission mode from transcript. Returns one of the four known
// modes, or null.
const VALID_PERMISSION_MODES = new Set(['bypassPermissions', 'acceptEdits', 'plan', 'default']);
function extractPermissionModeFromTranscript(transcriptPath) {
  try {
    if (!existsSync(transcriptPath)) return null;
    const stat = statSync(transcriptPath);
    const TAIL_BYTES = 64 * 1024;
    const readBytes = Math.min(TAIL_BYTES, stat.size);
    const offset = stat.size - readBytes;
    const buf = Buffer.alloc(readBytes);
    const fd = openSync(transcriptPath, 'r');
    try {
      readSync(fd, buf, 0, readBytes, offset);
    } finally {
      closeSync(fd);
    }
    const tail = buf.toString('utf8');
    const start = offset > 0 ? tail.indexOf('\n') + 1 : 0;
    const lines = tail.slice(start).split('\n').filter((l) => l.trim().length > 0);

    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (entry && (entry.type === 'user' || entry.type === 'permission-mode')
          && typeof entry.permissionMode === 'string'
          && VALID_PERMISSION_MODES.has(entry.permissionMode)) {
        return entry.permissionMode;
      }
    }
    return null;
  } catch (err) {
    logEvent('transcript-permission-read-error', { error: String(err) });
    return null;
  }
}

// Derive session id from transcript filename (stable across --resume).
function sessionIdFromTranscript(transcriptPath, fallback) {
  if (typeof transcriptPath === 'string' && transcriptPath.length > 0) {
    const base = transcriptPath.split(/[\\/]/).pop() ?? '';
    const id = base.replace(/\.jsonl$/i, '');
    if (id) return id;
  }
  return fallback;
}

// ----- stdin reader -------------------------------------------------------

async function readStdin() {
  const chunks = [];
  let total = 0;
  let truncated = false;
  return new Promise((resolve, reject) => {
    process.stdin.on('data', (c) => {
      if (total + c.length > MAX_STDIN_BYTES) {
        truncated = true;
        const remaining = MAX_STDIN_BYTES - total;
        if (remaining > 0) chunks.push(c.subarray(0, remaining));
        total = MAX_STDIN_BYTES;
        process.stdin.removeAllListeners('data');
        process.stdin.destroy();
        const buf = Buffer.concat(chunks).toString('utf8').trim();
        try {
          const parsed = buf ? JSON.parse(buf) : null;
          if (truncated) logEvent('stdin-truncated', { totalBytes: total });
          resolve(parsed);
        } catch (err) {
          if (truncated) logEvent('stdin-truncated', { totalBytes: total });
          reject(err);
        }
        return;
      }
      chunks.push(c);
      total += c.length;
    });
    process.stdin.on('end', () => {
      const buf = Buffer.concat(chunks).toString('utf8').trim();
      if (!buf) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(buf));
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on('error', reject);
  });
}

// ----- RPC over named pipe ------------------------------------------------

function sendRpc(pipePath, request, timeoutMs = HOOK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = createConnection(pipePath);
    let buffer = '';
    let settled = false;
    let wrote = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* socket already dead */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      settle({ ok: false, error: 'timeout', retryable: !wrote });
    }, timeoutMs);

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

// sendRpc with bounded connect retry for transient errors. `deadline` is passed
// in so a multi-target walk shares ONE HOOK_TIMEOUT_MS budget.
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

// Advance to the next endpoint only when the request PROVABLY never reached a
// server: an answered call (outer ok) owns the signal, and a written-but-
// unanswered one (retryable === false) is ambiguous — re-sending would risk a
// duplicate notification. A refusal (`Unknown method` from a pre-M1 daemon,
// `unauthorized`) carries no `retryable` and does advance.
function shouldTryNextTarget(result) {
  if (result && result.ok === true) return false;
  if (result && result.retryable === false) return false;
  return true;
}

// Walk targets in order under one shared deadline; returns the last result and
// the endpoint that produced it (logged so bridge.log shows who served it).
async function sendToTargets(targets, buildRequest) {
  const deadline = Date.now() + HOOK_TIMEOUT_MS;
  let result = { ok: false, error: 'no-target' };
  let target = null;
  for (const candidate of targets) {
    if (Date.now() >= deadline) break;
    target = candidate;
    result = await sendRpcWithRetry(candidate.pipe, buildRequest(candidate), deadline);
    if (!shouldTryNextTarget(result)) break;
  }
  return { result, target };
}

// ----- Main ---------------------------------------------------------------

async function main() {
  const hookName = process.argv[2];
  if (!hookName || !HOOK_TO_KIND[hookName]) {
    logEvent('unknown-hook-name', { argv: process.argv });
    return; // exit 0 below
  }

  let payload;
  try {
    payload = await readStdin();
  } catch (err) {
    logEvent('malformed-stdin', { error: String(err) });
    return;
  }
  // Empty stdin is allowed for SessionStart per OpenClaude spec.
  if (payload === null && hookName !== 'SessionStart') {
    logEvent('empty-stdin', { hook: hookName });
    return;
  }

  // PreToolUse fires per tool call; we only treat AskUserQuestion as
  // "awaiting input".
  if (hookName === 'PreToolUse'
      && !(payload && payload.tool_name === 'AskUserQuestion')) {
    logEvent('skip-pretooluse', { tool: payload && payload.tool_name });
    return;
  }

  // Endpoints to try, daemon first (see resolveTargets). No token for either
  // endpoint means wmux has never run for this user — drop as before.
  const targets = resolveTargets();
  if (targets.length === 0) {
    logEvent('no-auth-token', { paths: [getDaemonAuthTokenPath(), getAuthTokenPath()] });
    return;
  }

  // Prefer payload.cwd when OpenClaude provides it.
  const payloadCwd = (payload && typeof payload.cwd === 'string' && payload.cwd.length > 0)
    ? payload.cwd
    : null;

  // Token usage extraction from transcript_path.
  const transcriptPath = (payload && typeof payload.transcript_path === 'string' && payload.transcript_path.length > 0)
    ? payload.transcript_path
    : null;

  let usage = null;
  const isStopClass = hookName === 'Stop' || hookName === 'SubagentStop';
  if (isStopClass && transcriptPath) {
    usage = extractUsageFromTranscript(transcriptPath);
  }

  // Capture permission mode on SessionStart and stop-class hooks.
  let permissionMode;
  const isSessionStart = hookName === 'SessionStart';
  if ((isSessionStart || isStopClass) && transcriptPath) {
    permissionMode = extractPermissionModeFromTranscript(transcriptPath) ?? undefined;
  }

  // Env-first routing identifiers from wmux pane environment.
  const envWorkspaceId =
    typeof process.env.WMUX_WORKSPACE_ID === 'string' && process.env.WMUX_WORKSPACE_ID.length > 0
      ? process.env.WMUX_WORKSPACE_ID
      : undefined;
  const envSurfaceId =
    typeof process.env.WMUX_SURFACE_ID === 'string' && process.env.WMUX_SURFACE_ID.length > 0
      ? process.env.WMUX_SURFACE_ID
      : undefined;
  const envPtyId =
    typeof process.env.WMUX_PTY_ID === 'string' && process.env.WMUX_PTY_ID.length > 0
      ? process.env.WMUX_PTY_ID
      : undefined;

  // Build the AgentSignal envelope.
  const envelope = {
    kind: hookName === 'PostToolUse'
      ? getPostToolUseKind(payload)
      : HOOK_TO_KIND[hookName],
    agent: 'openclaude',
    agentSessionId: sessionIdFromTranscript(
      transcriptPath,
      (payload && typeof payload.session_id === 'string') ? payload.session_id : undefined,
    ),
    workspaceId: envWorkspaceId,
    surfaceId: envSurfaceId,
    ptyId: envPtyId,
    cwd: payloadCwd ?? process.cwd(),
    payload: {
      ...(payload ?? {}),
      ...(usage ? { usage } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    },
    ts: Date.now(),
  };

  // Diagnostic dump for verification harnesses.
  if (process.env.WMUX_BRIDGE_DEBUG === '1') {
    const { payload: envelopePayload, ...envelopeMeta } = envelope;
    const usageOnly = envelopePayload && envelopePayload.usage ? { usage: envelopePayload.usage } : {};
    const permOnly = envelopePayload && envelopePayload.permissionMode
      ? { permissionMode: envelopePayload.permissionMode }
      : {};
    process.stderr.write(
      `WMUX_BRIDGE_DEBUG_ENVELOPE=${JSON.stringify({ ...envelopeMeta, payloadKeys: Object.keys(envelopePayload ?? {}), ...usageOnly, ...permOnly })}\n`,
    );
  }

  // One id across the walk so a fallback is correlatable in the logs; each
  // target carries its own method + token (see resolveTargets).
  const requestId = `bridge-${randomUUID()}`;
  const { result: rpcResult, target } = await sendToTargets(targets, (t) => ({
    id: requestId,
    method: t.method,
    params: envelope,
    token: t.token,
    clientName: WMUX_CLIENT_NAME,
  }));
  const targetName = target?.name;

  // Unwrap both RPC layers.
  const outerOk = rpcResult && rpcResult.ok === true;
  const innerOk = outerOk && rpcResult.result && rpcResult.result.ok === true;

  if (innerOk) {
    logEvent('ok', { hook: hookName, target: targetName });
  } else if (outerOk) {
    logEvent('rpc-rejected', {
      hook: hookName,
      target: targetName,
      reason: rpcResult.result?.reason ?? 'unknown',
    });
  } else {
    logEvent('rpc-failed', {
      hook: hookName,
      target: targetName,
      error: rpcResult?.error ?? 'unknown',
      detail: rpcResult?.detail,
    });
  }

  // Spool failed lifecycle captures for daemon recovery.
  const isLifecycle = envelope.kind === 'agent.session_start'
    || envelope.kind === 'agent.stop'
    || envelope.kind === 'agent.subagent_stop';
  if (!innerOk && isLifecycle && envPtyId && envelope.agentSessionId) {
    spoolResumeBinding({
      ptyId: envPtyId,
      agent: 'openclaude',
      sessionId: envelope.agentSessionId,
      cwd: envelope.cwd,
      transcriptPath: transcriptPath ?? undefined,
      permissionMode: permissionMode ?? undefined,
      workspaceId: envWorkspaceId,
      ts: envelope.ts,
    });
  }
}

// Run; never throw upward.
main()
  .catch((err) => {
    logEvent('uncaught', { error: String(err) });
  })
  .finally(() => {
    process.exit(0);
  });
