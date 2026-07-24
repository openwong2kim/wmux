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
//   3. Sends the envelope to the first wmux endpoint that answers: the DAEMON
//      control pipe (`daemon.hooks.signal`, token ~/.wmux/daemon-auth-token —
//      the always-on process, so this still lands with the GUI closed), else
//      the MAIN pipe (`hooks.signal`, token ~/.wmux-auth-token). Either side
//      builds the resume binding from signal.agent + agentSessionId + cwd +
//      transcript_path; both paths are fully agent-agnostic.
//      WMUX_HOOKS_TO_MAIN=1 forces main-only.
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
// Stamped on every codex-notify.log line; bump on behavior changes.
//   0.2.0 — daemon-first targeting (daemon.hooks.signal → hooks.signal).
const BRIDGE_VERSION = '0.2.0';
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

// ----- Daemon endpoint (M1: hook ingest lives in the daemon) ---------------
//
// The daemon is the always-on process and owns hook ingest, so it is tried
// first; the main pipe stays as the fallback for an older wmux or a daemon that
// is down. Same ~/.wmux (no data-suffix) limitation as the log path — the pane
// env strips WMUX_DATA_SUFFIX, so a dev-suffix daemon is unreachable here.
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
// never run). Two ways to stay on the pre-M1 single-endpoint routing:
// WMUX_HOOKS_TO_MAIN=1 (kill switch) and WMUX_PIPE_NAME (explicit pipe — the
// isolated capture probe sets it, and it must NOT leak onto the real daemon).
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

// Advance to the next endpoint only when the request PROVABLY never reached a
// server: an answered call (outer ok) owns the signal, and a written-but-
// unanswered one (retryable === false) is ambiguous — re-sending would risk a
// duplicate capture. A refusal (`Unknown method` from a pre-M1 daemon,
// `unauthorized`) carries no `retryable` and does advance.
function shouldTryNextTarget(result) {
  if (result && result.ok === true) return false;
  if (result && result.retryable === false) return false;
  return true;
}

// Walk targets in order under one shared deadline; returns the last result and
// the endpoint that produced it (logged so the log shows who served it).
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

  // Endpoints to try, daemon first (see resolveTargets).
  const targets = resolveTargets();
  if (targets.length === 0) {
    logEvent('no-auth-token', { paths: [getDaemonAuthTokenPath(), getAuthTokenPath()] });
    // Still spool so a later daemon boot reconciles the capture.
    if (envPtyId) spoolResumeBinding({ ptyId: envPtyId, agent: 'codex', sessionId, cwd, transcriptPath, ts: Date.now() });
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

  // One id across the walk so a fallback is correlatable in the logs; each
  // target carries its own method + token (see resolveTargets).
  const requestId = `codex-notify-${randomUUID()}`;
  const { result: rpcResult, target } = await sendToTargets(targets, (t) => ({
    id: requestId,
    method: t.method,
    params: envelope,
    token: t.token,
  }));
  const outerOk = rpcResult && rpcResult.ok === true;
  const innerOk = outerOk && rpcResult.result && rpcResult.result.ok === true;

  if (innerOk) {
    logEvent('ok', { sessionId, target: target?.name });
  } else {
    logEvent(outerOk ? 'rpc-rejected' : 'rpc-failed', {
      target: target?.name,
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
