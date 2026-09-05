#!/usr/bin/env node
// wmux ↔ Claude Code hook bridge.
//
// Invoked by Claude Code when one of its hooks fires (PostToolUse, Stop,
// SubagentStop, SessionStart). This script:
//   1. Determines the hook name from process.argv[2].
//   2. Reads the Claude Code hook payload from stdin (JSON).
//   3. Builds the canonical AgentSignal envelope.
//   4. Sends the envelope to the first wmux endpoint that answers:
//        a. the DAEMON control pipe — `daemon.hooks.signal`, token from
//           ~/.wmux${suffix}/daemon-auth-token. The daemon is the always-on
//           process, so this is the one that still works with the GUI closed.
//        b. the MAIN pipe — `hooks.signal`, token from
//           ~/.wmux${suffix}-auth-token. The pre-M1 path; kept for an older
//           wmux, and forced by WMUX_HOOKS_TO_MAIN=1 (kill switch).
//   5. Logs the outcome (and which endpoint served it) to
//      ~/.wmux${suffix}/bridge.log.
//   6. Exits 0 (so a wmux problem never breaks Claude Code) — UNLESS invoked
//      with `--gate` and the endpoint answers with a `block`, in which case the
//      reason goes to stderr and the exit code is 2 (Claude Code's "do not let
//      this hook's action proceed" contract). Only the terminal orchestrator's
//      Stop hook is wired that way; every other invocation is byte-for-byte
//      what it always was.
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
// Stamped on every bridge.log line. Bump on behavior changes so a log tells you
// which bridge produced it — the installed copy is refreshed by byte-comparison
// (setupHooks.refreshHookBridge, run at boot), never by this number.
//   0.2.0 — daemon-first targeting (daemon.hooks.signal → hooks.signal).
//   0.3.0 — suffix-isolated lifecycle routing and bridge state.
const BRIDGE_VERSION = '0.4.0';

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
  // Turn START. Registered by hooks.json (plugin path), `wmux setup-hooks`
  // (plugin-less path) and the deck brain's generated profile alike, so an
  // ordinary pane goes 'running' the moment a prompt is submitted instead of
  // after the byte-rate heuristic has seen enough output.
  UserPromptSubmit: 'agent.user_prompt_submit',
};

// Determine the signal kind for a PostToolUse hook. AskUserQuestion completing
// means the user answered it right here on this machine, so it is promoted to
// agent.input_answered — the daemon expires the approval record that a remote
// device is still showing as pending (#770). Every other tool stays a plain
// activity stamp.
//
// Only the tool name is consulted. PostToolUse fires exclusively AFTER a tool
// completes, so reaching this function at all already means "it finished";
// there is no second payload field to confirm that. (An earlier revision also
// required `payload.fired`, which Claude Code's PostToolUse payload does not
// carry — the promotion could never fire and #770 stayed broken.) Callers only
// invoke this for hookName === 'PostToolUse', so a PreToolUse AskUserQuestion
// can never reach it and be mistaken for an answer.
function getPostToolUseKind(payload) {
  if (payload && payload.tool_name === 'AskUserQuestion') {
    return 'agent.input_answered';
  }
  return 'agent.activity';
}

// ----- Path helpers (Node built-ins only) ---------------------------------

// Instance suffix ('' in production, '-dev' under a dev build). PTY spawn
// propagation preserves WMUX_DATA_SUFFIX from the owning wmux process so every
// hook resolves back to that same instance. With no suffix, every path remains
// byte-identical to the production paths used before instance isolation.
function instanceSuffix() {
  return process.env.WMUX_DATA_SUFFIX || '';
}

function getHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || homedir();
}

function getWmuxHomeDir() {
  return join(getHomeDir(), `.wmux${instanceSuffix()}`);
}

function getAuthTokenPath() {
  return join(getHomeDir(), `.wmux${instanceSuffix()}-auth-token`);
}

function getPipeName() {
  if (process.platform === 'win32') {
    const username = userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux${instanceSuffix()}-${username}`;
  }
  return join(homedir() || '/tmp', `.wmux${instanceSuffix()}.sock`);
}

// ----- Daemon endpoint (M1: hook ingest lives in the daemon) ---------------
//
// The daemon is the always-on process — it runs the detector, owns the dedup
// ledger, and stays up with the GUI closed, which is precisely when the MAIN
// pipe is absent and a hook signal used to be dropped on the floor. So we aim
// at the daemon first and keep the main pipe as the fallback for an older wmux
// (whose daemon has no `daemon.hooks.signal`) or a daemon that is down.
//
// Daemon credentials, hints, and fallback endpoints belong to the same
// suffix-aware wmux home as the hook. A suffixed event deliberately never
// probes the unsuffixed production daemon token or hint as a migration fallback.
function getDaemonAuthTokenPath() {
  return join(getWmuxHomeDir(), 'daemon-auth-token');
}

// Prefer the `daemon-pipe` hint file the daemon writes at boot — it carries the
// name the daemon ACTUALLY bound, which differs from the convention whenever a
// zombie pipe forced a `-N` fallback rename. Mirrors src/cli/client.ts
// `resolveDaemonPipeName` + src/shared/constants.ts `getDaemonSocketPath`.
function getDaemonPipeName() {
  try {
    const fromFile = readFileSync(join(getWmuxHomeDir(), 'daemon-pipe'), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch {
    // Hint file absent/unreadable — fall through to the derived name.
  }
  if (process.platform === 'win32') {
    const username = userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux-daemon${instanceSuffix()}-${username}`;
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

// Ordered endpoints for this hook. A target whose token file is missing is
// skipped — an absent token means that endpoint has never run, so connecting
// could only produce an `unauthorized` round-trip. WMUX_HOOKS_TO_MAIN=1 drops
// the daemon target entirely (kill switch: byte-for-byte the pre-M1 routing).
// `gateMode` narrows the walk to MAIN. The gate verdict is produced by the
// brain-pty lane inside main's `hooks.signal`; the daemon does not serve it, so
// a fallback to the daemon would answer `{ok:true}` with no block and silently
// turn every refusal into an allowed Stop. The brain already forces
// WMUX_HOOKS_TO_MAIN=1, so this is a no-op in practice — it is here so the
// no-fallback rule holds even if that env is ever lost.
function resolveTargets(gateMode = false) {
  // WMUX_PIPE_NAME collapses the walk to ONE explicit pipe, matching the codex
  // and opencode bridges (which have had it all along — this one did not, which
  // meant no harness could exercise this bridge without aiming it at the real
  // daemon. A dogfood run bound the production pipe because of exactly that:
  // a temp HOME isolates the data directory but the pipe name is derived from
  // the USERNAME, so it is global per user and a temp HOME does nothing).
  //
  // The point is that it must NOT leak onto the real daemon, so this returns a
  // single target rather than prepending one.
  //
  // Not a security widening: a same-user process can already read the auth
  // token off disk, so redirecting the pipe grants nothing it did not have.
  const pipeOverride = process.env.WMUX_PIPE_NAME;
  if (typeof pipeOverride === 'string' && pipeOverride.length > 0) {
    // Token order follows who the request is ADDRESSED to, not who owns the
    // pipe: a gate request is a `hooks.signal` for MAIN, so main's token has to
    // win. Preferring the daemon's here made a host with both tokens on disk
    // authenticate the gate with the wrong credential — `unauthorized`, no
    // verdict, and every refusal silently downgraded to an allowed Stop.
    const token = gateMode
      ? readTokenFile(getAuthTokenPath()) || readTokenFile(getDaemonAuthTokenPath())
      : readTokenFile(getDaemonAuthTokenPath()) || readTokenFile(getAuthTokenPath());
    if (!token) return [];
    // Addressed as the daemon, because that is what M1 made the bridge talk to
    // and what a probe needs to observe. In gate mode the override still aims
    // the socket wherever the harness points it, but the request is addressed
    // to MAIN — the daemon has no gate to consult.
    return gateMode
      ? [{ name: 'main', pipe: pipeOverride, token, method: 'hooks.signal' }]
      : [{ name: 'daemon', pipe: pipeOverride, token, method: 'daemon.hooks.signal' }];
  }
  const targets = [];
  if (!gateMode && process.env.WMUX_HOOKS_TO_MAIN !== '1') {
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
  const dir = getWmuxHomeDir();
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
// The spool lives under the suffix-aware wmux home so the bridge and daemon
// always resolve the same instance directory and concurrent instances cannot
// consume or overwrite one another's recovery records.
function getResumeSpoolDir() {
  const dir = join(getWmuxHomeDir(), 'resume-spool');
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

// Stamp files live next to bridge.log in the suffix-aware wmux home.
// One zero-byte file per throttle key; mtime is the last-send timestamp.
function getActivityStampPath(key) {
  const dir = join(getWmuxHomeDir(), 'activity-stamps');
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

// Leftover background-work mining for Stop-class envelopes.
//
// A Stop hook fires when the lead turn ends EVEN IF background tasks the
// agent started (run_in_background Bash) are still running — and while they
// run, no further hook events arrive to rebut a premature "finished"
// alarm. The count below lets the daemon's verdict gate treat such a Stop
// as "still working" instead of "done".
//
// Verified transcript shapes (live spike, 2026-08-15):
//  - START: an assistant record whose message.content[] has a tool_use block
//    with name "Bash" and input.run_in_background === true. NOTE: its
//    tool_result ("Command running in background with ID: …") is written
//    IMMEDIATELY at dispatch — it is NOT a completion signal, so plain
//    tool_use↔tool_result pairing always balances to zero.
//  - COMPLETION: a task-notification record, durable in the transcript even
//    after the queue drains it. Two observed shapes carrying the same
//    XML-tagged body (matched by <tool-use-id>, settled by
//    <status>completed|failed</status>):
//      {"type":"queue-operation","operation":"enqueue","content":"<task-notification>…"}
//      {"type":"attachment","attachment":{"type":"queued_command",
//       "commandMode":"task-notification","prompt":"<task-notification>…"}}
//
// Returns 0 on any failure (fail-open: the alarm then relies on the
// provisional window alone). A 1MB tail — much wider than the usage/mode
// readers, because the start record can sit behind an entire turn's tool
// output (measured: a real session's early starts were already 1.4MB deep).
// A substring pre-filter keeps the parse cost near zero for the common
// line. The residual miss case (a start pushed out of the window by a very
// verbose turn) reads as no leftover — the fail-open direction.
function countLeftoverBackgroundTasks(transcriptPath) {
  try {
    if (!existsSync(transcriptPath)) return 0;
    const stat = statSync(transcriptPath);
    const TAIL_BYTES = 1024 * 1024;
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

    const startedIds = new Set();
    const resultTexts = new Map(); // tool_use id → immediate tool_result text
    const settledIds = new Set();
    for (const line of lines) {
      // Cheap pre-filter: only the two marker substrings can contribute.
      if (!line.includes('"run_in_background"') && !line.includes('<task-notification>')
          && !line.includes('"tool_result"')) {
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      const content = entry.message && Array.isArray(entry.message.content)
        ? entry.message.content
        : null;
      if (content) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          // START shape — a run_in_background Bash dispatch.
          if (block.type === 'tool_use'
            && block.name === 'Bash' && block.input
            && block.input.run_in_background === true && typeof block.id === 'string'
          ) {
            startedIds.add(block.id);
          }
          // The IMMEDIATE tool_result of a background dispatch. Its text
          // separates a real start ("Command running in background with
          // ID: …") from a synchronously REJECTED attempt (hook error,
          // sandbox refusal): the latter never spawns a task and never
          // receives a task-notification, so counting it would suppress
          // every later Stop's alarm for the rest of the session.
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const text = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c) => (c && typeof c.text === 'string') ? c.text : '').join('')
                : '';
            if (!resultTexts.has(block.tool_use_id)) resultTexts.set(block.tool_use_id, text);
          }
        }
      }
      // COMPLETION shapes: both carry the XML-tagged notification body, in
      // `content` (queue-operation) or `attachment.prompt` (queued_command).
      const body = typeof entry.content === 'string'
        ? entry.content
        : entry.attachment && typeof entry.attachment.prompt === 'string'
          ? entry.attachment.prompt
          : null;
      // `includes` over `startsWith`: the body can carry leading whitespace
      // before the opening tag. The ARRIVAL of a task-notification for an id
      // settles it — neither the `<status>` value nor the tag's presence is
      // required. Both directions of that check have the same failure mode:
      // a value whitelist (completed|failed) that misses a future terminal
      // status, or a renamed/absent tag, leaves the task counted as running
      // FOREVER and permanently suppresses the completion alarm for the rest
      // of the session. A spuriously-settled task at worst fires one
      // window-gated alarm. Fail-open, same posture as the read errors above.
      if (body && body.includes('<task-notification>')) {
        const idMatch = body.match(/<tool-use-id>([^<]+)<\/tool-use-id>/);
        if (idMatch) settledIds.add(idMatch[1]);
      }
    }
    let leftover = 0;
    for (const id of startedIds) {
      if (settledIds.has(id)) continue;
      // Only a dispatch that actually spawned a background task counts.
      // A rejected attempt (error tool_result) or a missing result never
      // settles — treating either as leftover would permanently suppress
      // the completion alarm.
      const started = /running in background/i.test(resultTexts.get(id) ?? '');
      if (started) leftover++;
    }
    return leftover;
  } catch (err) {
    logEvent('transcript-leftover-read-error', { error: String(err) });
    return 0;
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
      settle({ ok: false, error: 'timeout', retryable: !wrote });
    }, timeoutMs);

    sock.on('connect', () => {
      sock.write(JSON.stringify(request) + '\n');
      wrote = true;
    });
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      // Newline-delimited JSON. Match OUR response by id and skip everything
      // else: the DAEMON control pipe also BROADCASTS session events
      // ({type,sessionId,data} — no `id`) to every connected socket, and a
      // broadcast landing between connect and response would otherwise be
      // settled as the reply. Unparseable lines are skipped for the same
      // reason; the timeout is the backstop if the reply never arrives.
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
      // retryable only if the request was never written (pre-connect failure).
      settle({ ok: false, error: 'connect-error', detail: err.code ?? err.message, retryable: !wrote });
    });
    sock.on('close', () => {
      clearTimeout(timer);
      settle({ ok: false, error: 'closed-without-response', retryable: !wrote });
    });
  });
}

// A2 — sendRpc with bounded connect retry. Retries ONLY transient
// connect-errors (pipe exists but momentarily contended: EPERM/ECONNRESET/…),
// never an absent pipe (ENOENT → wmux not running, drop fast) and never a
// reached-server outcome (a response, timeout mid-request, or close-after-send
// — retrying those risks a duplicate signal). The shared deadline keeps the
// total under HOOK_TIMEOUT_MS so a hook never slows Claude beyond the cap.
// `deadline` is passed in (not recomputed here) so a multi-target walk shares
// ONE budget: trying the daemon and then main must still cost at most
// HOOK_TIMEOUT_MS in total, or the fallback would double the hook's hard cap.
async function sendRpcWithRetry(pipePath, request, deadline = Date.now() + HOOK_TIMEOUT_MS) {
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

// Should the walk move on to the next endpoint? Same no-double-fire rule the A2
// retry uses, applied across targets: only advance when the request PROVABLY
// never reached a server.
//   - outer ok === true      → the endpoint answered (even `{ok:false,reason}`);
//                              it owns this signal. Stop.
//   - retryable === false    → the bytes were written but no answer came back
//                              (timeout / closed-after-send). AMBIGUOUS: the
//                              server may have processed it, so re-sending
//                              elsewhere risks a duplicate notification. Stop.
//   - anything else          → connect failure before the write, or an explicit
//                              refusal (`Unknown method` from a pre-M1 daemon,
//                              `unauthorized` from a stale token). Advance.
function shouldTryNextTarget(result) {
  if (result && result.ok === true) return false;
  if (result && result.retryable === false) return false;
  return true;
}

// Did a gate request reach a server and then lose its answer? `retryable ===
// false` is set by sendRpc exactly when the request bytes were WRITTEN, so it
// is the proof that the socket connected and main received the signal. Pair it
// with the two no-answer outcomes and the result is the ambiguous case the gate
// must fail closed on.
//
// Explicitly NOT lost, all failing open:
//   - `connect-error` (ENOENT / ECONNREFUSED / …): nothing was written, so no
//     main is holding a waiter. Almost always "Claude Code running outside
//     wmux", which must never be gated.
//   - `no-target`: no token on disk, same story.
//   - an outer-ok response the handler rejected: main ANSWERED. It ran the gate
//     lane and declined (no workspace match, not a brain pty). No block, allow.
function isGateAnswerLost(result) {
  if (!result || result.ok === true) return false;
  if (result.retryable !== false) return false;
  return result.error === 'timeout' || result.error === 'closed-without-response';
}

// Walk the targets in order under one shared deadline. Returns the last result
// plus the target that produced it (logged, so bridge.log shows which endpoint
// actually served the hook). The timeout defaults to HOOK_TIMEOUT_MS; the
// permission-gate mode passes GATE_PERMISSION_TIMEOUT_MS because the daemon
// holds the response open until the phone answers.
async function sendToTargets(targets, buildRequest, timeoutMs = HOOK_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
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

// ----- #783 — PreToolUse permission gate output --------------------------

// The modern Claude Code PreToolUse hook contract reads JSON from stdout and
// looks for hookSpecificOutput.permissionDecision. We output this ONLY in
// --permission-gate mode; every other invocation is byte-for-byte what it
// always was (exit 0, no stdout).
//
//   allow = proceed without prompting the user.
//   deny  = block the tool call (the reason is shown to the model).
//
// There is deliberately no third value. `ask` is NOT the neutral option: it is
// an active instruction to raise a prompt, and it OVERRIDES the session's
// permission mode. #898 — measured on Claude Code 2.1.233 with a probe hook on
// the wide `""` matcher, under `--permission-mode bypassPermissions`:
//
//   hook emits `ask`  -> permission_denials: [Read, Bash]  (agent blocked)
//   hook emits nothing -> permission_denials: []            (tools run)
//
// Same hook, same settings, same mode — the only difference was the JSON. The
// docs state the neutral contract directly: "Exit code 0 with no output means
// the hook has no decision to report, so the tool call continues through the
// normal permission flow."
//
// So every "wmux has no opinion here" path — gate disabled, headless, outside
// wmux, daemon unreachable, non-gated tool, broker self-deferred — must write
// NOTHING. Emitting `ask` for those is what made the plugin re-prompt for even
// a Read in a bypassPermissions session, with no way for the user to turn it
// off (WMUX_GATE=0 emitted `ask` too, so the escape hatch left the symptom in
// place — exactly what the reporter saw).
function outputPermissionDecision(decision, reasonText) {
  // Only a real verdict is ever written. Anything else — undefined, 'ask',
  // 'defer', or an unrecognised value from a newer daemon — is no opinion, and
  // the only faithful encoding of that is an empty stdout.
  if (decision !== 'allow' && decision !== 'deny') return;
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      ...(reasonText ? { permissionDecisionReason: reasonText } : {}),
    },
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}

// The gate blocks until the phone answers or the broker self-defers. This MUST
// be longer than the broker's DEFAULT_GATE_DEADLINE_MS (120s) so the broker
// defers first and the bridge gets a real verdict instead of a pipe timeout.
// Well under the harness's 600s PreToolUse budget.
const GATE_PERMISSION_TIMEOUT_MS = 130_000;

// ----- Main ---------------------------------------------------------------

async function main() {
  const hookName = process.argv[2];
  // Second argv token. `--gate` is the orchestrator Stop hook (exit-2-on-block);
  // `--permission-gate` is the PreToolUse permission gate (JSON permissionDecision).
  // Anything else is ignored, so an older wmux running a newer profile behaves
  // as before.
  const gateMode = process.argv.slice(3).includes('--gate');
  const permissionGateMode = process.argv.slice(3).includes('--permission-gate');
  if (!hookName || !HOOK_TO_KIND[hookName]) {
    logEvent('unknown-hook-name', { argv: process.argv });
    return; // exit 0 below
  }

  // #783 — PreToolUse permission gate. Three fast exit paths that NEVER reach
  // the daemon, so the agent is never slowed when the gate does not apply:
  //
  //   1. WMUX_GATE=0  — the operator (or a script) disabled the gate for this
  //      session. Read every call, so toggling takes effect on the next tool.
  //   2. Headless     — `claude -p`, CI, and subagents all read the same
  //      hooks.json. `WMUX_PTY_ID` is inherited by `claude -p` inside a pane
  //      (src/mcp/index.ts:355), so the env check alone cannot tell headless
  //      from interactive. `CLAUDE_CODE_ENTRYPOINT` is the distinguisher, and
  //      it is MEASURED, not assumed: an interactive pane reports `cli`, while
  //      `claude -p` reports `sdk-cli`. A tty check does NOT work here — Claude
  //      Code pipes the hook's stdio, so `process.stderr.isTTY` is false in BOTH
  //      modes and gating on it would keep the gate permanently dark. Anything
  //      that is not a known interactive entrypoint defers, so an unrecognised
  //      or future headless mode fails open rather than hanging.
  //      WMUX_PTY_ID is same-user spoofable (env is writable from inside the
  //      pane) — this is a UX guard, not a security control.
  //   3. No WMUX_PTY_ID — the agent is running outside any wmux pane.
  //
  // All three exit SILENTLY (see outputPermissionDecision): they mean "wmux has
  // no opinion", and only an empty stdout says that without overriding the
  // session's permission mode.
  const INTERACTIVE_ENTRYPOINTS = new Set(['cli', 'vscode', 'jetbrains']);
  if (permissionGateMode) {
    if (process.env.WMUX_GATE === '0') {
      logEvent('permission-gate-skipped', { reason: 'gate-disabled' });
      return;
    }
    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
    if (!process.env.WMUX_PTY_ID || !entrypoint || !INTERACTIVE_ENTRYPOINTS.has(entrypoint)) {
      logEvent('permission-gate-skipped', {
        reason: 'headless-or-outside-wmux',
        entrypoint: entrypoint ?? null,
      });
      return;
    }
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
  // "awaiting input" UNLESS this is a permission-gate call (--permission-gate
  // mode handles ALL tool names and sends agent.awaiting_permission instead).
  // A future broad PreToolUse matcher can never tunnel a spurious
  // awaiting_input through here — other PreToolUse tools are dropped.
  if (hookName === 'PreToolUse'
      && !permissionGateMode
      && !(payload && payload.tool_name === 'AskUserQuestion')) {
    logEvent('skip-pretooluse', { tool: payload && payload.tool_name });
    return;
  }

  // PostToolUse source-side throttle (see ACTIVITY_STAMP_THROTTLE_MS). Keyed
  // by the pane (WMUX_PTY_ID) when running inside wmux, else by the Claude
  // session id, else by cwd — the same identity the server routes on, so
  // suppression maps 1:1 to what the server would have dropped. Skips are
  // deliberately NOT logged: at N sessions × M subagents the skip volume is
  // exactly the churn this throttle exists to remove. Input-answered signals
  // (AskUserQuestion completion) must never be throttled — a delayed/dropped
  // signal leaves the phone with a pending approval the user already answered.
  if (hookName === 'PostToolUse') {
    const kind = getPostToolUseKind(payload);
    if (kind === 'agent.activity') {
      const throttleKey = process.env.WMUX_PTY_ID
        || (payload && typeof payload.session_id === 'string' && payload.session_id)
        || (payload && typeof payload.cwd === 'string' && payload.cwd)
        || process.cwd();
      if (shouldThrottleActivity(throttleKey)) return;
    }
  }

  // Endpoints to try, daemon first (see resolveTargets). No token for either
  // endpoint means wmux has never run for this user — drop as before.
  const targets = resolveTargets(gateMode);
  if (targets.length === 0) {
    logEvent('no-auth-token', { paths: [getDaemonAuthTokenPath(), getAuthTokenPath()] });
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

  // Leftover background-work count for the LEAD turn only — SubagentStop
  // rides a sidechain transcript where the flag is meaningless anyway
  // (the daemon drops child stops before the alarm gate). Stamped only
  // when > 0 so absent stays "no signal" for older daemons.
  let leftoverWork = 0;
  if (hookName === 'Stop' && transcriptPath) {
    leftoverWork = countLeftoverBackgroundTasks(transcriptPath);
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
  const kind = permissionGateMode
    ? 'agent.awaiting_permission'
    : hookName === 'PostToolUse'
      ? getPostToolUseKind(payload)
      : HOOK_TO_KIND[hookName];
  const envelope = {
    kind,
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
      ...(leftoverWork > 0 ? { wmux_leftover_work: leftoverWork } : {}),
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

  // One id across the walk so a fallback is correlatable in the logs; each
  // target gets its own method + token (see resolveTargets). Permission-gate
  // mode uses a MUCH longer timeout because the daemon holds the response open
  // until the phone answers (or the broker self-defers).
  const requestId = `bridge-${randomUUID()}`;
  const { result: rpcResult, target } = await sendToTargets(
    targets,
    (t) => ({
      id: requestId,
      method: t.method,
      params: envelope,
      token: t.token,
    }),
    permissionGateMode ? GATE_PERMISSION_TIMEOUT_MS : undefined,
  );
  const targetName = target?.name;

  // RpcResponse wraps the handler's return in { id, ok, result, error }.
  // The handler returns { ok, reason? } as well, so we need to unwrap
  // both layers. (codex round 2 P1 #3)
  const outerOk = rpcResult && rpcResult.ok === true;
  const innerOk = outerOk && rpcResult.result && rpcResult.result.ok === true;

  if (innerOk) {
    logEvent('ok', { hook: hookName, target: targetName });
  } else if (outerOk) {
    // Handler ran but reported a logical reason (no-workspace-match etc.)
    logEvent('rpc-rejected', {
      hook: hookName,
      target: targetName,
      reason: rpcResult.result?.reason ?? 'unknown',
    });
  } else {
    // Transport / auth / dispatch error.
    logEvent('rpc-failed', {
      hook: hookName,
      target: targetName,
      error: rpcResult?.error ?? 'unknown',
      detail: rpcResult?.detail, // connect-error code (ENOENT/EPERM/…) for diagnosis
    });
  }

  // Gate verdict. Two outcomes can end the turn's Stop in exit 2, and they are
  // deliberately NOT the same failure class:
  //
  //   - An explicit, successfully delivered refusal (`innerOk` + `block`).
  //   - A request that PROVABLY reached main and then lost its answer (see
  //     `isGateAnswerLost`). Main may be holding an open turn waiter for this
  //     very Stop, so allowing it would end a turn main still thinks is live.
  //     Fail CLOSED: exit 2 keeps the TUI working and the model stops again.
  //
  // Everything else still fails OPEN — above all a connect failure (ENOENT /
  // ECONNREFUSED = no main at the other end), which carries no gate authority
  // and must never wedge a Claude Code session that is merely running outside
  // wmux.
  let gateExitCode = 0;
  if (gateMode && innerOk) {
    const block = rpcResult.result.block;
    const reason = block && typeof block.reason === 'string' ? block.reason : null;
    if (reason) {
      // Exit 2 + stderr is Claude Code's contract for "block this and tell the
      // model why"; stderr is what the model is shown.
      process.stderr.write(`${reason}\n`);
      gateExitCode = 2;
      logEvent('gate-blocked', { hook: hookName, target: targetName });
    }
  } else if (gateMode && isGateAnswerLost(rpcResult)) {
    process.stderr.write(
      'wmux could not confirm this Stop with the orchestrator (the reply was lost in flight). '
        + 'Do not end the turn on this attempt — check the fleet and stop again.\n',
    );
    gateExitCode = 2;
    logEvent('gate-fail-closed', { hook: hookName, target: targetName, error: rpcResult?.error });
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

  // #783 — PreToolUse permission gate. The daemon's response carries
  // permissionDecision. The bridge translates it to the modern
  // hookSpecificOutput JSON on stdout, and ONLY a real verdict is written.
  //
  // #898 — everything else fails OPEN by staying silent: a transport error, a
  // non-gate daemon, an absent field, a non-gated tool, or a broker self-defer
  // all leave stdout empty, so the tool call continues through the session's
  // normal permission flow. This is what "exactly what would happen without the
  // gate" actually requires — an earlier revision defaulted to `ask` here,
  // which instead FORCED a prompt and overrode bypassPermissions.
  if (permissionGateMode) {
    const verdict = innerOk && rpcResult.result.permissionDecision
      ? rpcResult.result.permissionDecision
      : null;
    outputPermissionDecision(
      verdict,
      // Without a reason the model reads a bare refusal and retries the same
      // call. Say who refused (review: Claude).
      verdict === 'deny' ? 'denied from the wmux remote approval' : undefined,
    );
    logEvent('permission-gate', {
      hook: hookName,
      target: targetName,
      verdict: verdict === 'allow' || verdict === 'deny' ? verdict : 'no-opinion',
    });
    // Always exit 0 — the decision is in stdout, not the exit code.
    return 0;
  }

  return gateExitCode;
}

// Run; never throw upward (every error path logs and returns the allow code).
// main() resolves to the process exit code: 0 everywhere except a gated hook
// that was explicitly refused.
main()
  .catch((err) => {
    logEvent('uncaught', { error: String(err) });
    return 0;
  })
  .then((code) => {
    // `process.exitCode`, NOT `process.exit()`: the permission decision is a
    // stdout write, and exiting outright can drop it before the pipe flushes —
    // a remote deny would silently become "no decision" (review: Codex). Let
    // the loop drain and exit on its own.
    process.exitCode = typeof code === 'number' ? code : 0;
  });
