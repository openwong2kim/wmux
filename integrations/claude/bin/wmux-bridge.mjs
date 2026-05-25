#!/usr/bin/env node
// wmux ↔ Claude Code hook bridge.
//
// Invoked by Claude Code when one of its hooks fires (PostToolUse, Stop,
// SubagentStop, SessionStart). This script:
//   1. Determines the hook name from process.argv[2].
//   2. Reads the Claude Code hook payload from stdin (JSON).
//   3. Builds the canonical AgentSignal envelope.
//   4. Reads the wmux auth token from ~/.wmux-auth-token.
//   5. Connects to the wmux main-process named pipe.
//   6. Sends an RPC: hooks.signal { ...envelope }
//   7. Logs the outcome to ~/.wmux/bridge.log.
//   8. Exits 0 ALWAYS (so a wmux problem never breaks Claude Code).
//
// THIS FILE IS SELF-CONTAINED. It runs from inside a Claude Code plugin
// where TypeScript transpilation is NOT available. Do not import anything
// from src/, integrations/shared/, or node_modules — only Node built-ins.
//
// Codex review 2026-05-22 P0 #2: bridges must be JS-only.
// Codex review 2026-05-22 P0 #4: token is read from disk, not env.

import { readFileSync, existsSync, mkdirSync, appendFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';

const HOOK_TIMEOUT_MS = 2000; // hard cap so we never slow Claude
const BRIDGE_VERSION = '0.1.0';
// Cap stdin at 1MB. PostToolUse payloads can balloon when a tool returns
// a big diff or file content; we have no business forwarding that
// over the RPC channel. Truncation note is logged so the user sees the
// elision in bridge.log. (codex review round 2, P2 #10.)
const MAX_STDIN_BYTES = 1 * 1024 * 1024;

// ----- Hook name → AgentSignal kind ---------------------------------------

const HOOK_TO_KIND = {
  PostToolUse: 'agent.activity',
  Stop: 'agent.stop',
  SubagentStop: 'agent.subagent_stop',
  SessionStart: 'agent.session_start',
};

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

function getBridgeLogPath() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const dir = join(home, '.wmux');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // mkdir failures fall through; appendFileSync below will also fail
    // and the catch in logEvent will silently drop. We never throw
    // upward from this script.
  }
  return join(dir, 'bridge.log');
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
    // No writable home → swallow. Nothing more we can do.
  }
}

// ----- Transcript usage extraction ----------------------------------------

// Tail-read the last 64KB of a JSONL transcript and pull `usage` from
// the most recent assistant message. The tail approach keeps memory
// bounded even when transcripts grow into the tens of MB after a long
// session. Returns null on any failure — usage is best-effort, never
// blocks signal emission.
//
// Shape we look for (Claude Code transcript spec):
//   { "type": "assistant", "message": { "usage": {
//       "input_tokens": N, "output_tokens": M,
//       "cache_creation_input_tokens": X, "cache_read_input_tokens": Y
//   } } }
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
    // Trim leading partial line if we landed mid-line (offset > 0).
    const start = offset > 0 ? tail.indexOf('\n') + 1 : 0;
    const lines = tail.slice(start).split('\n').filter((l) => l.trim().length > 0);

    // Walk lines from the END backward — the last assistant message
    // carries the freshest cumulative usage.
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

// ----- stdin reader -------------------------------------------------------

async function readStdin() {
  const chunks = [];
  let total = 0;
  let truncated = false;
  return new Promise((resolve, reject) => {
    process.stdin.on('data', (c) => {
      // Codex review round 2, P2 #10 — cap input size so a runaway
      // tool response cannot OOM the bridge. Stop accumulating after
      // the cap; the resulting JSON will likely be malformed and the
      // parse-catch path below will log and exit 0.
      if (total + c.length > MAX_STDIN_BYTES) {
        truncated = true;
        const remaining = MAX_STDIN_BYTES - total;
        if (remaining > 0) chunks.push(c.subarray(0, remaining));
        total = MAX_STDIN_BYTES;
        process.stdin.removeAllListeners('data');
        process.stdin.destroy();
        // Allow the 'end' handler below to wrap up; if it doesn't fire
        // because we destroyed early, resolve here.
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

function sendRpc(pipePath, request) {
  return new Promise((resolve) => {
    const sock = createConnection(pipePath);
    let buffer = '';
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* socket already dead */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      settle({ ok: false, error: 'timeout' });
    }, HOOK_TIMEOUT_MS);

    sock.on('connect', () => {
      sock.write(JSON.stringify(request) + '\n');
    });
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        clearTimeout(timer);
        try {
          settle(JSON.parse(line));
        } catch {
          settle({ ok: false, error: 'malformed-response' });
        }
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      settle({ ok: false, error: 'connect-error', detail: err.code ?? err.message });
    });
    sock.on('close', () => {
      clearTimeout(timer);
      settle({ ok: false, error: 'closed-without-response' });
    });
  });
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
  // Empty stdin is allowed for SessionStart per Claude Code spec.
  if (payload === null && hookName !== 'SessionStart') {
    logEvent('empty-stdin', { hook: hookName });
    return;
  }

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

  // Prefer payload.cwd when Claude Code provides it — that's the
  // session's cwd, which is what the user means. Bridge's own
  // process.cwd() can be the plugin install dir on some platforms
  // when hooks are spawned outside the session shell. (codex round 2 P1 #6)
  const payloadCwd = (payload && typeof payload.cwd === 'string' && payload.cwd.length > 0)
    ? payload.cwd
    : null;

  // Token usage extraction from transcript_path. Claude Code's Stop /
  // SubagentStop hook payload carries `transcript_path` pointing at the
  // session JSONL. The last assistant message has the cumulative
  // `usage` block. Reading it is the authoritative way to get token
  // counts — the regex-based TokenTracker in wmux only fires when the
  // user types /cost, which most people never do.
  //
  // We only do this for stop-class kinds. PostToolUse / SessionStart
  // do not carry final usage and the cost of the read isn't justified
  // per tool call.
  let usage = null;
  const isStopClass = hookName === 'Stop' || hookName === 'SubagentStop';
  if (isStopClass && payload && typeof payload.transcript_path === 'string') {
    usage = extractUsageFromTranscript(payload.transcript_path);
  }

  // Env-first routing identifiers. When Claude Code runs inside a wmux
  // pane, the PTYManager injects WMUX_WORKSPACE_ID / WMUX_SURFACE_ID into
  // the shell env. Claude Code → bridge subprocess inherits the env. The
  // daemon prefers these over cwd because cwd matching is ambiguous when
  // multiple workspaces share a path (e.g. two panes opened in the same
  // repo). User dogfood 2026-05-24 hit this: workspace 4 turn-end was
  // routing to workspace 2's toast because both had the same cwd.
  const envWorkspaceId =
    typeof process.env.WMUX_WORKSPACE_ID === 'string' && process.env.WMUX_WORKSPACE_ID.length > 0
      ? process.env.WMUX_WORKSPACE_ID
      : undefined;
  const envSurfaceId =
    typeof process.env.WMUX_SURFACE_ID === 'string' && process.env.WMUX_SURFACE_ID.length > 0
      ? process.env.WMUX_SURFACE_ID
      : undefined;

  // Build the AgentSignal envelope. Schema mirrors
  // integrations/shared/signal-types.ts (kept in sync manually because
  // this is JS-only).
  const envelope = {
    kind: HOOK_TO_KIND[hookName],
    agent: 'claude',
    agentSessionId: (payload && typeof payload.session_id === 'string') ? payload.session_id : undefined,
    workspaceId: envWorkspaceId,
    surfaceId: envSurfaceId,
    cwd: payloadCwd ?? process.cwd(),
    payload: { ...(payload ?? {}), ...(usage ? { usage } : {}) },
    ts: Date.now(),
  };

  // Diagnostic dump for verification harnesses (scripts/verify-bridge-env-capture.mjs).
  // Stripped from production by the WMUX_BRIDGE_DEBUG gate — token never crosses
  // this branch. Payload usage block is stripped because transcript content can
  // be large and is not what we want to verify.
  if (process.env.WMUX_BRIDGE_DEBUG === '1') {
    const { payload: envelopePayload, ...envelopeMeta } = envelope;
    const usageOnly = envelopePayload && envelopePayload.usage ? { usage: envelopePayload.usage } : {};
    process.stderr.write(
      `WMUX_BRIDGE_DEBUG_ENVELOPE=${JSON.stringify({ ...envelopeMeta, payloadKeys: Object.keys(envelopePayload ?? {}), ...usageOnly })}\n`,
    );
  }

  const request = {
    id: `bridge-${randomUUID()}`,
    method: 'hooks.signal',
    params: envelope,
    token,
  };

  const rpcResult = await sendRpc(getPipeName(), request);

  // RpcResponse wraps the handler's return in { id, ok, result, error }.
  // The handler returns { ok, reason? } as well, so we need to unwrap
  // both layers. (codex round 2 P1 #3)
  const outerOk = rpcResult && rpcResult.ok === true;
  const innerOk = outerOk && rpcResult.result && rpcResult.result.ok === true;

  if (innerOk) {
    logEvent('ok', { hook: hookName });
  } else if (outerOk) {
    // Handler ran but reported a logical reason (no-workspace-match etc.)
    logEvent('rpc-rejected', {
      hook: hookName,
      reason: rpcResult.result?.reason ?? 'unknown',
    });
  } else {
    // Transport / auth / dispatch error.
    logEvent('rpc-failed', {
      hook: hookName,
      error: rpcResult?.error ?? 'unknown',
    });
  }
}

// Run; never throw upward (every error path logs and falls through to exit 0).
main()
  .catch((err) => {
    logEvent('uncaught', { error: String(err) });
  })
  .finally(() => {
    process.exit(0);
  });
