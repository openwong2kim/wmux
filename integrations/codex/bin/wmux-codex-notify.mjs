#!/usr/bin/env node
// wmux ↔ Codex CLI notify bridge (resume-binding capture).
//
// Registered as Codex's `notify` program in ~/.codex/config.toml:
//   notify = ["node", "<abs path to this file>"]
// Codex spawns it on `agent-turn-complete`, appending ONE extra argv: a JSON
// payload `{ session_id, transcript_path, cwd, hook_event_name, model, ... }`
// (https://developers.openai.com/codex/config-advanced). The spawned process
// inherits the pane env, so WMUX_PTY_ID pins the capture to the exact pane.
//
// This script:
//   1. Parses the LAST argv as the Codex notify JSON payload.
//   2. Builds the canonical AgentSignal envelope (agent:'codex', kind:'agent.stop').
//   3. Reads the wmux auth token from ~/.wmux-auth-token.
//   4. Sends RPC hooks.signal to the wmux main-process pipe (main builds the
//      resume binding from signal.agent + agentSessionId + cwd + transcript_path
//      and relays daemon.setResumeBinding — see src/main/pipe/handlers/hooks.rpc.ts,
//      which is fully agent-agnostic).
//   5. On failure, spools a resume-binding record the daemon drains on next boot.
//   6. Exits 0 ALWAYS, under a hard timeout, so a wmux problem never stalls Codex.
//
// SELF-CONTAINED: JS-only, Node built-ins only — no imports from src/ or
// integrations/shared/ (mirrors integrations/claude/bin/wmux-bridge.mjs; the
// Claude bridge's plugin constraint blocks a shared import, so full DRY across
// the two is impossible — the shared ~120 lines of infra are duplicated by
// design, per the codex-resume-support eng review, decision 2). This bridge is
// LEANER than the Claude one: Codex gives session_id directly (no transcript
// basename derivation), and has no permission-mode / usage to extract.

import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';

const HOOK_TIMEOUT_MS = 2000; // hard cap so we never stall a Codex turn
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
  // WMUX_PIPE_NAME override: for the isolated capture probe
  // (scripts/codex-resume-capture-probe.mjs) and advanced multi-instance setups.
  // Not a security widening — a same-user process can already read the auth
  // token from ~/.wmux-auth-token, so redirecting the pipe grants nothing new.
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
  return join(dir, 'codex-notify.log');
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
// the daemon ingest expects (mirrors integrations/claude/bin/wmux-bridge.mjs).
// Path matches the bridge convention (~/.wmux, no data-suffix — a reserved
// WMUX_* var the pane env strips).
function getResumeSpoolDir() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const dir = join(home, '.wmux', 'resume-spool');
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

// ----- RPC over named pipe (mirrors the Claude bridge) ---------------------

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

// ----- Main ---------------------------------------------------------------

function nonEmptyStr(v) {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

async function main() {
  // Codex appends the notify JSON as the LAST argv token.
  const raw = process.argv[process.argv.length - 1];
  if (!raw || raw === import.meta.url || process.argv.length < 3) {
    logEvent('no-payload', { argc: process.argv.length });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    logEvent('malformed-payload', { error: String(err) });
    return;
  }
  if (!payload || typeof payload !== 'object') {
    logEvent('non-object-payload', {});
    return;
  }

  const sessionId = nonEmptyStr(payload.session_id);
  if (!sessionId) {
    // No session id → nothing resumable to capture. (Non-turn events, or a
    // Codex version that omits it.) Drop quietly.
    logEvent('no-session-id', { event: payload.hook_event_name });
    return;
  }
  const cwd = nonEmptyStr(payload.cwd) ?? process.cwd();
  const transcriptPath = nonEmptyStr(payload.transcript_path);

  const envPtyId = nonEmptyStr(process.env.WMUX_PTY_ID);
  const envWorkspaceId = nonEmptyStr(process.env.WMUX_WORKSPACE_ID);
  const envSurfaceId = nonEmptyStr(process.env.WMUX_SURFACE_ID);

  const tokenPath = getAuthTokenPath();
  if (!existsSync(tokenPath)) {
    logEvent('no-auth-token', { path: tokenPath });
    // Still spool so a later daemon boot reconciles the capture.
    if (envPtyId) spoolResumeBinding({ ptyId: envPtyId, agent: 'codex', sessionId, cwd, transcriptPath, ts: Date.now() });
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

  // Canonical AgentSignal envelope. kind 'agent.stop' = a turn completed (the
  // strongest "task done" signal); it triggers the agent-agnostic resume-binding
  // capture in hooks.rpc.ts. transcript_path rides in the payload — hooks.rpc
  // reads signal.payload.transcript_path for the binding's D5 liveness probe.
  const envelope = {
    kind: 'agent.stop',
    agent: 'codex',
    agentSessionId: sessionId,
    ...(envWorkspaceId ? { workspaceId: envWorkspaceId } : {}),
    ...(envSurfaceId ? { surfaceId: envSurfaceId } : {}),
    ...(envPtyId ? { ptyId: envPtyId } : {}),
    cwd,
    payload: { ...(transcriptPath ? { transcript_path: transcriptPath } : {}) },
    ts: Date.now(),
  };

  const request = {
    id: `codex-notify-${randomUUID()}`,
    method: 'hooks.signal',
    params: envelope,
    token,
  };

  const rpcResult = await sendRpcWithRetry(getPipeName(), request);
  const outerOk = rpcResult && rpcResult.ok === true;
  const innerOk = outerOk && rpcResult.result && rpcResult.result.ok === true;

  if (innerOk) {
    logEvent('ok', { sessionId });
  } else {
    logEvent(outerOk ? 'rpc-rejected' : 'rpc-failed', {
      reason: rpcResult?.result?.reason,
      error: rpcResult?.error,
      detail: rpcResult?.detail,
    });
    // Anything but a durable success would lose the capture. Spool it (needs
    // the exact per-pane key) so the daemon reconciles it on its next boot.
    if (envPtyId) {
      spoolResumeBinding({ ptyId: envPtyId, agent: 'codex', sessionId, cwd, transcriptPath, ts: envelope.ts });
    }
  }
}

main()
  .catch((err) => logEvent('uncaught', { error: String(err) }))
  .finally(() => process.exit(0));
