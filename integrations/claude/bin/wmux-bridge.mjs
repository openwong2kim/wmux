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

import { readFileSync, existsSync, mkdirSync, appendFileSync, statSync, openSync, readSync, closeSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';

const HOOK_TIMEOUT_MS = 2000; // hard cap so we never slow Claude
const BRIDGE_VERSION = '0.1.0';

// A2 (2026-05-29 user dogfood: 8 connect-errors during a brief main-process
// restart / handler-swap window): retry a TRANSIENT connect failure a few
// times WITHIN the HOOK_TIMEOUT_MS budget. A pipe that is ABSENT (ENOENT —
// wmux not running) is NOT retried, so plugin users without wmux open are
// never slowed; only a pipe that EXISTS but is momentarily contended is
// retried. The total stays under HOOK_TIMEOUT_MS so a hook never slows Claude
// beyond the existing cap. We retry ONLY connect-errors (never successfully
// sent) so a retry can't double-fire the signal.
const CONNECT_RETRY_BACKOFFS_MS = [100, 250];
const TRANSIENT_CONNECT_CODES = new Set([
  'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EBUSY', 'EAGAIN',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Cap stdin at 1MB. PostToolUse payloads can balloon when a tool returns
// a big diff or file content; we have no business forwarding that
// over the RPC channel. Truncation note is logged so the user sees the
// elision in bridge.log. (codex review round 2, P2 #10.)
const MAX_STDIN_BYTES = 1 * 1024 * 1024;

// Source-side throttle for PostToolUse (agent.activity) signals. The server
// already keeps a per-pane leading-edge throttle at 3s (hooks.rpc.ts
// ACTIVITY_THROTTLE_MS) and nothing else PostToolUse feeds needs per-call
// delivery (the latency meter is statistical; hook authority has a 30-minute
// TTL). Every suppressed call would otherwise still cost a fresh pipe
// connection — with N sessions × M parallel subagents all firing PostToolUse
// per tool call, that connection storm is what exhausts the main pipe's
// pending-accept instances and its per-second admission cap. Throttling at
// the source pins pipe traffic to ~1 activity RPC per pane per window no
// matter how many agents run. Slightly below the server's 3s window so the
// calls that DO go through still land inside the server's leading edge.
const ACTIVITY_STAMP_THROTTLE_MS = 2500;

// ----- Hook name → AgentSignal kind ---------------------------------------

const HOOK_TO_KIND = {
  PreToolUse: 'agent.awaiting_input',
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

// X6 ③ — durable resume-binding spool dir. When the hooks.signal RPC fails
// (main pipe ENOENT because wmux is mid-boot / restarting, no-workspace-match,
// timeout, …), the binding is otherwise lost forever. We instead drop a
// self-describing capture record here; the DAEMON drains it on its next boot
// (recovery) and reconnect, attributing each record to the EXACT pane by its
// WMUX_PTY_ID. Pipe-free local file write, so it never depends on wmux being up.
//
// Path matches the bridge.log convention (~/.wmux, NO data-suffix): the bridge
// cannot see WMUX_DATA_SUFFIX (a reserved WMUX_* var, stripped from the pane
// env), so dev/prod-concurrent isolation falls back to cwd routing — same
// pre-existing limitation as bridge.log. In production (no suffix) and in the
// USERPROFILE-isolated dogfood, bridge and daemon resolve the same dir.
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

// Persist one capture record, keyed by ptyId (last-write-wins per pane — a
// later Stop, whose agentSessionId is the #12235-safe transcript basename,
// overwrites an earlier SessionStart whose id was the payload.session_id
// fallback). Atomic via temp-then-rename. Never throws.
function spoolResumeBinding(record) {
  try {
    if (!record || !record.ptyId || !record.sessionId) return;
    const safe = String(record.ptyId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    if (!safe) return;
    const dir = getResumeSpoolDir();
    const file = join(dir, `${safe}.json`);
    // UNIQUE temp per write (pid + uuid): two concurrent same-pane hook exits must
    // not overwrite each other's in-flight temp and publish a stale payload — with
    // a shared temp, a newer Stop's rename could end up publishing an older
    // SessionStart's bytes (codex + CodeRabbit). The daemon prunes abandoned
    // `*.json.tmp` on ingest so a crashed write can't accumulate.
    const tmp = join(dir, `${safe}.${process.pid}.${randomUUID()}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    // Don't replace a spool file that already holds a NEWER capture — last-write
    // by ts, not by rename order. (The daemon ingest re-applies the same ordering
    // as a backstop; this just avoids publishing a known-stale record.) A corrupt
    // existing file falls through and is replaced.
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

// ----- PostToolUse activity stamp (source-side throttle) ------------------

// Stamp files live next to bridge.log (same no-suffix ~/.wmux limitation).
// One zero-byte file per throttle key; mtime is the last-send timestamp.
function getActivityStampPath(key) {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const dir = join(home, '.wmux', 'activity-stamps');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Fall through; stat/write below will throw and the caller fails open.
  }
  const safe = String(key).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return join(dir, safe || 'default');
}

// Leading-edge: returns true (skip the RPC) when a send for this key happened
// within ACTIVITY_STAMP_THROTTLE_MS; otherwise stamps NOW and returns false.
// The stamp is written BEFORE the send on purpose — a failed RPC must not
// open the gate for a burst of retrying siblings (the server drops extras
// anyway). Concurrent same-key hooks can race past a stale stamp; that only
// costs one extra RPC, never correctness. Any fs error → fail open (send).
function shouldThrottleActivity(key) {
  try {
    const file = getActivityStampPath(key);
    try {
      if (Date.now() - statSync(file).mtimeMs < ACTIVITY_STAMP_THROTTLE_MS) return true;
    } catch {
      // No stamp yet — first send for this key.
    }
    writeFileSync(file, '', { mode: 0o600 });
    return false;
  } catch {
    return false;
  }
}

// ----- Logging (best-effort, never throws) --------------------------------

// Rotate bridge.log once it exceeds the cap: rename to bridge.log.1
// (replacing the previous generation). Checked at most once per bridge
// process — one extra stat per hook spawn, nothing on the append path.
// Concurrent bridges racing the rename: one wins, the rest ENOENT and
// carry on appending to the fresh file. Best-effort, never throws.
const BRIDGE_LOG_MAX_BYTES = 5 * 1024 * 1024;
let logRotationChecked = false;
function rotateBridgeLogIfNeeded(logPath) {
  if (logRotationChecked) return;
  logRotationChecked = true;
  try {
    if (statSync(logPath).size > BRIDGE_LOG_MAX_BYTES) {
      renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // Missing file / lost rename race / locked .1 — all fine.
  }
}

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
    const logPath = getBridgeLogPath();
    rotateBridgeLogIfNeeded(logPath);
    appendFileSync(logPath, line + '\n', { encoding: 'utf8' });
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

// X6 ③: the permission mode the session is CURRENTLY in, read from the
// transcript. Two record shapes carry it (walk lines from the END; the most
// recent of either wins — that's the live mode):
//  - `{"type":"permission-mode","permissionMode":"..."}` — dedicated record,
//    written near the transcript tail with each prompt's metadata block
//    (observed live 2026-07-02; format the current Claude Code emits).
//  - `{"type":"user",...,"permissionMode":"..."}` — inline stamp on user turns
//    (F5, verified live 2026-06-14; older format, kept for back-compat).
// Recognizing the dedicated record matters: user-turn stamps are sparse, and a
// single large attachment/tool record can push the last stamped user turn out
// of the 64KB tail window — the exact miss that left a bypassPermissions
// session's binding without a mode in the 2026-07-02 incident (U-PERM dogfood:
// resume pill could not re-offer bypass). The dedicated record sits within a
// few KB of the tail, so it survives the bounded read.
// Mirrors extractUsageFromTranscript's parse-tolerant tail read (last 64KB).
// Returns one of the four known modes, or null (file absent, no record yet, or
// an unrecognized value).
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
    // Trim leading partial line if we landed mid-line (offset > 0).
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

// X6 ③ (#12235-safe): the origin session id is the transcript FILENAME without
// its .jsonl extension. `claude --resume <id>` mints a NEW session_id on the
// hook payload but APPENDS to the SAME transcript file (F3), so the filename is
// the only stable handle on the origin conversation. Falls back to the passed
// session_id when no transcript path is available.
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

function sendRpc(pipePath, request, timeoutMs = HOOK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = createConnection(pipePath);
    let buffer = '';
    let settled = false;
    // Track whether the request bytes were written. A reset/broken-pipe AFTER
    // the write still surfaces via sock.on('error') as connect-error, but the
    // server may have already received and processed the signal — retrying it
    // would double-fire the notification. Only a failure BEFORE the write
    // (`wrote === false`) is safe to retry. (codex review 2026-05-29 P2.)
    let wrote = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* socket already dead */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      settle({ ok: false, error: 'timeout' });
    }, timeoutMs);

    sock.on('connect', () => {
      sock.write(JSON.stringify(request) + '\n');
      wrote = true;
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
      // retryable only if the request was never written (pre-connect failure).
      settle({ ok: false, error: 'connect-error', detail: err.code ?? err.message, retryable: !wrote });
    });
    sock.on('close', () => {
      clearTimeout(timer);
      settle({ ok: false, error: 'closed-without-response' });
    });
  });
}

// A2 — sendRpc with bounded connect retry. Retries ONLY transient
// connect-errors (pipe exists but momentarily contended: EPERM/ECONNRESET/…),
// never an absent pipe (ENOENT → wmux not running, drop fast) and never a
// reached-server outcome (a response, timeout mid-request, or close-after-send
// — retrying those risks a duplicate signal). The shared deadline keeps the
// total under HOOK_TIMEOUT_MS so a hook never slows Claude beyond the cap.
async function sendRpcWithRetry(pipePath, request) {
  const deadline = Date.now() + HOOK_TIMEOUT_MS;
  let attempt = 0;
  let last = { ok: false, error: 'timeout' };
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return last;
    last = await sendRpc(pipePath, request, remaining);
    // Anything but a connect-error means the server was reached — return it.
    if (last.error !== 'connect-error') return last;
    // Retry ONLY when: the request was never written (retryable, so no
    // double-fire), the code is transient (pipe exists but contended — not an
    // absent ENOENT), and we have attempts left. A reset/broken-pipe AFTER the
    // write has retryable===false and is returned as-is. (codex 2026-05-29 P2.)
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

  // PreToolUse fires per tool call; we only treat AskUserQuestion as
  // "awaiting input". A future broad PreToolUse matcher can never tunnel a
  // spurious awaiting_input through here — other PreToolUse tools are dropped.
  if (hookName === 'PreToolUse'
      && !(payload && payload.tool_name === 'AskUserQuestion')) {
    logEvent('skip-pretooluse', { tool: payload && payload.tool_name });
    return;
  }

  // PostToolUse source-side throttle (see ACTIVITY_STAMP_THROTTLE_MS). Keyed
  // by the pane (WMUX_PTY_ID) when running inside wmux, else by the Claude
  // session id, else by cwd — the same identity the server routes on, so
  // suppression maps 1:1 to what the server would have dropped. Skips are
  // deliberately NOT logged: at N sessions × M subagents the skip volume is
  // exactly the churn this throttle exists to remove.
  if (hookName === 'PostToolUse') {
    const throttleKey = process.env.WMUX_PTY_ID
      || (payload && typeof payload.session_id === 'string' && payload.session_id)
      || (payload && typeof payload.cwd === 'string' && payload.cwd)
      || process.cwd();
    if (shouldThrottleActivity(throttleKey)) return;
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
  const transcriptPath = (payload && typeof payload.transcript_path === 'string' && payload.transcript_path.length > 0)
    ? payload.transcript_path
    : null;

  let usage = null;
  const isStopClass = hookName === 'Stop' || hookName === 'SubagentStop';
  if (isStopClass && transcriptPath) {
    usage = extractUsageFromTranscript(transcriptPath);
  }

  // X6 ③: capture the permission mode LIVE — on SessionStart and on every
  // Stop/SubagentStop while the session is still alive. This is deliberately
  // NOT a teardown/exit hook: a real reboot is SIGKILL, so no exit hook fires;
  // the resume binding must already be persisted from the last live hook (the
  // X6 ② SIGKILL-survival lesson). On SessionStart the transcript may not exist
  // yet (F9 — it appears on the first turn), so this is null until the first
  // turn lands; the next Stop fills it in.
  let permissionMode;
  const isSessionStart = hookName === 'SessionStart';
  if ((isSessionStart || isStopClass) && transcriptPath) {
    permissionMode = extractPermissionModeFromTranscript(transcriptPath) ?? undefined;
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
  // X6 ③: the EXACT pane this hook fired from. The daemon stamps WMUX_PTY_ID
  // (its own session id) into every pane's env at spawn, so this is the
  // strongest routing key — it pins the resume-binding capture to one pane even
  // when several panes share a workspaceId/cwd. Also the spool's attribution key.
  const envPtyId =
    typeof process.env.WMUX_PTY_ID === 'string' && process.env.WMUX_PTY_ID.length > 0
      ? process.env.WMUX_PTY_ID
      : undefined;

  // Build the AgentSignal envelope. Schema mirrors
  // integrations/shared/signal-types.ts (kept in sync manually because
  // this is JS-only).
  const envelope = {
    kind: HOOK_TO_KIND[hookName],
    agent: 'claude',
    // #12235-safe: derive from the transcript filename, NOT payload.session_id.
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

  // Diagnostic dump for verification harnesses (scripts/verify-bridge-env-capture.mjs).
  // Stripped from production by the WMUX_BRIDGE_DEBUG gate — token never crosses
  // this branch. Payload usage block is stripped because transcript content can
  // be large and is not what we want to verify.
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

  const request = {
    id: `bridge-${randomUUID()}`,
    method: 'hooks.signal',
    params: envelope,
    token,
  };

  const rpcResult = await sendRpcWithRetry(getPipeName(), request);

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
      detail: rpcResult?.detail, // connect-error code (ENOENT/EPERM/…) for diagnosis
    });
  }

  // X6 ③: a session-lifecycle capture that did NOT durably reach wmux (anything
  // but innerOk — ENOENT, no-workspace-match, timeout, internal-error) would be
  // lost forever. Spool it so the daemon reconciles it on its next boot/connect
  // and attributes it to the EXACT pane by ptyId. Gated on a real per-pane key
  // (ptyId) + a resumable id. A SessionStart whose transcript doesn't exist yet
  // still spools; a later Stop's spool overwrites it with the #12235-safe id.
  const isLifecycle = envelope.kind === 'agent.session_start'
    || envelope.kind === 'agent.stop'
    || envelope.kind === 'agent.subagent_stop';
  if (!innerOk && isLifecycle && envPtyId && envelope.agentSessionId) {
    spoolResumeBinding({
      ptyId: envPtyId,
      agent: 'claude',
      sessionId: envelope.agentSessionId,
      cwd: envelope.cwd,
      transcriptPath: transcriptPath ?? undefined,
      permissionMode: permissionMode ?? undefined,
      workspaceId: envWorkspaceId,
      ts: envelope.ts,
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
