#!/usr/bin/env node
// wmux ↔ Claude Code hook bridge.
//
// Invoked by Claude Code when one of its hooks fires (PostToolUse, Stop,
// SubagentStop, SessionStart). This script:
//   1. Determines the hook name from process.argv[2].
//   2. Reads the Claude Code hook payload from stdin (JSON).
//   3. Builds the canonical AgentSignal envelope.
//   4. Sends the envelope to the first reachable Forge Mux endpoint:
//        a. Native hosts try the daemon control pipe first, then the main pipe.
//        b. WSL connects to the Windows main process over its authenticated TCP
//           fallback, trying mirrored-loopback and NAT-gateway addresses.
//   5. Logs the outcome (and which endpoint served it) to ~/.fmux/bridge.log.
//   6. Exits 0 ALWAYS (so a Forge Mux problem never breaks Claude Code).
//
// THIS FILE IS SELF-CONTAINED. It runs from inside a Claude Code plugin
// where TypeScript transpilation is NOT available. Do not import anything
// from src/, integrations/shared/, or node_modules — only Node built-ins.
//
// Codex review 2026-05-22 P0 #2: bridges must be JS-only.
// Codex review 2026-05-22 P0 #4: token is read from disk, not env.

import { readFileSync, existsSync, mkdirSync, appendFileSync, statSync, openSync, readSync, closeSync, writeFileSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';

const HOOK_TIMEOUT_MS = 2000; // hard cap so we never slow Claude
// Stamped on every bridge.log line. Bump on behavior changes so a log tells you
// which bridge produced it — the installed copy is refreshed by byte-comparison
// (setupHooks.refreshHookBridge, run at boot), never by this number.
//   0.2.0 — daemon-first targeting (daemon.hooks.signal → hooks.signal).
//   0.3.0 — WSL-to-Windows transport with daemon-first native fallback.
const BRIDGE_VERSION = '0.3.0';

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

// The home dir the bridge itself lives under (WSL home when in WSL). Used for
// diagnostics (bridge.log) that belong next to the running session.
function localHome() {
  return process.env.USERPROFILE || process.env.HOME || homedir();
}

// ----- WSL → Windows host bridging ----------------------------------------
//
// wmux is a native Windows app. When Claude Code runs inside WSL, none of the
// native transports cross the VM boundary: the Windows named pipe and the
// Linux Unix socket are each invisible to the other side. But the app also
// runs a TCP fallback (PipeServer.startTcpFallback → <bind>:<port>, port
// persisted to %USERPROFILE%\.fmux-tcp-port, token to
// %USERPROFILE%\.fmux-auth-token). We read the Windows-side token + port from
// the mounted drive and connect over TCP.
//
// Two WSL2 networking modes, both handled by trying targets in order:
//   - mirrored (`networkingMode=mirrored`): Windows loopback is reachable from
//     WSL as 127.0.0.1 → the first target connects.
//   - NAT (default): 127.0.0.1 is WSL's OWN loopback (fails fast), and Windows
//     is reachable only via the default-route gateway IP (the host's WSL
//     vEthernet address) → the second target. This requires the app to bind
//     beyond loopback when WSL is present (PipeServer.tcpBindHost); the port
//     stays token-authenticated + rate-limited, so the wider bind does not
//     weaken auth.

let _windowsHomeFromWsl; // memoized: string | null (undefined = not yet computed)

function isWsl() {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

// Translate a Windows path (`C:\Users\Name`) to its WSL mount (`/mnt/c/Users/Name`).
function winPathToWslMount(winPath) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return null;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

// A home is the LIVE wmux instance's when it holds both the token and the
// tcp-port file (the app writes the port on start and unlinks it on clean
// exit, so its presence is a running-instance signal).
function hasLiveWmuxFiles(dir) {
  return existsSync(join(dir, '.fmux-auth-token')) && existsSync(join(dir, '.fmux-tcp-port'));
}

// Locate the Windows user profile (as a WSL mount path) that holds the wmux
// instance files. Memoized — the bridge is a short-lived per-hook process.
// Precedence: explicit override → %USERPROFILE% (when WSL interop exposes it)
// → glob mounted drives' Users/ dirs, preferring a LIVE instance but falling
// back to any home with just the token so the resume-spool still lands where
// the Windows daemon can drain it.
function resolveWindowsHomeFromWsl() {
  if (_windowsHomeFromWsl !== undefined) return _windowsHomeFromWsl;

  const override = process.env.WMUX_WSL_WINHOME;
  if (override && existsSync(override)) return (_windowsHomeFromWsl = override);

  const fromEnv = process.env.USERPROFILE ? winPathToWslMount(process.env.USERPROFILE) : null;
  if (fromEnv && hasLiveWmuxFiles(fromEnv)) return (_windowsHomeFromWsl = fromEnv);

  let tokenOnlyFallback = null;
  let drives;
  try {
    drives = readdirSync('/mnt', { withFileTypes: true });
  } catch {
    drives = [];
  }
  for (const d of drives) {
    if (!d.isDirectory() || !/^[a-z]$/i.test(d.name)) continue;
    let users;
    try {
      users = readdirSync(`/mnt/${d.name}/Users`, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const u of users) {
      if (!u.isDirectory()) continue;
      const home = `/mnt/${d.name}/Users/${u.name}`;
      if (hasLiveWmuxFiles(home)) return (_windowsHomeFromWsl = home);
      if (!tokenOnlyFallback && existsSync(join(home, '.fmux-auth-token'))) {
        tokenOnlyFallback = home;
      }
    }
  }
  return (_windowsHomeFromWsl = tokenOnlyFallback);
}

// Base dir for files the Windows app / daemon must read (auth token,
// resume-spool). On WSL that's the Windows user profile; everywhere else it's
// the local home. Falls back to the local home when no Windows instance is
// found so non-WSL and native-Linux wmux behave exactly as before.
function hostHome() {
  if (isWsl()) {
    const winHome = resolveWindowsHomeFromWsl();
    if (winHome) return winHome;
  }
  return localHome();
}

function getAuthTokenPath() {
  return join(hostHome(), '.fmux-auth-token');
}

// Read the Windows-side TCP fallback port for the WSL→Windows bridge.
function readWindowsTcpPort(winHome) {
  try {
    const port = parseInt(readFileSync(join(winHome, '.fmux-tcp-port'), 'utf8').trim(), 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

// The IPv4 default-route gateway, parsed from /proc/net/route (no subprocess).
// Under WSL2 NAT this is the Windows host's address on the WSL vEthernet — the
// only way to reach Windows services from inside WSL. Returns null if absent.
function readDefaultGatewayIp() {
  try {
    const lines = readFileSync('/proc/net/route', 'utf8').split('\n').slice(1);
    for (const line of lines) {
      const f = line.trim().split(/\s+/);
      // Columns: Iface Destination Gateway Flags ... — default route has a
      // 0.0.0.0 destination and a non-zero gateway, both little-endian hex.
      if (f.length > 2 && f[1] === '00000000' && f[2] && f[2] !== '00000000') {
        const bytes = f[2].match(/../g).reverse().map((h) => parseInt(h, 16));
        if (bytes.length === 4 && bytes.every((b) => Number.isInteger(b))) {
          return bytes.join('.');
        }
      }
    }
  } catch {
    /* no /proc/net/route or unreadable */
  }
  return null;
}

// Ordered connect targets for sendRpc: each is an IPC path string (Windows
// pipe / Unix socket) OR a { host, port } TCP object. Tried in order until one
// connects; under WSL that's [loopback (mirrored mode), gateway (NAT mode)].
function getRpcTargets() {
  if (process.platform === 'win32') {
    const username = userInfo().username || 'default';
    return [`\\\\.\\pipe\\fmux-${username}`];
  }
  if (isWsl()) {
    const winHome = resolveWindowsHomeFromWsl();
    if (winHome) {
      const port = readWindowsTcpPort(winHome);
      if (port) {
        const targets = [{ host: '127.0.0.1', port }]; // mirrored networking
        const gateway = readDefaultGatewayIp(); // NAT networking (Windows host)
        if (gateway && gateway !== '127.0.0.1') targets.push({ host: gateway, port });
        return targets;
      }
    }
    // No reachable Windows instance — fall through to the Unix socket, which
    // ENOENTs fast (only a native-Linux wmux would answer it).
  }
  return [join(homedir() || '/tmp', '.fmux.sock')];
}

// ----- Daemon endpoint (M1: hook ingest lives in the daemon) ---------------
//
// The daemon is the always-on process — it runs the detector, owns the dedup
// ledger, and stays up with the GUI closed, which is precisely when the MAIN
// pipe is absent and a hook signal used to be dropped on the floor. So we aim
// at the daemon first and keep the main pipe as the fallback for an older wmux
// (whose daemon has no `daemon.hooks.signal`) or a daemon that is down.
//
// Same ~/.fmux (NO data-suffix) limitation as bridge.log: the bridge cannot see
// WMUX_DATA_SUFFIX (a reserved WMUX_* var, stripped from the pane env), so a
// dev-suffix daemon is unreachable from here — packaged-only testing for this
// path, unchanged from the pre-M1 bridge.
function getDaemonAuthTokenPath() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return join(home, '.fmux', 'daemon-auth-token');
}

// Prefer the `daemon-pipe` hint file the daemon writes at boot — it carries the
// name the daemon ACTUALLY bound, which differs from the convention whenever a
// zombie pipe forced a `-N` fallback rename. Mirrors src/cli/client.ts
// `resolveDaemonPipeName` + src/shared/constants.ts `getDaemonSocketPath`.
function getDaemonPipeName() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  try {
    const fromFile = readFileSync(join(home, '.fmux', 'daemon-pipe'), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch {
    // Hint file absent/unreadable — fall through to the derived name.
  }
  if (process.platform === 'win32') {
    const username = userInfo().username || 'default';
    return `\\\\.\\pipe\\fmux-daemon-${username}`;
  }
  return join(home, '.fmux', 'daemon.sock');
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
function resolveTargets() {
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
    const token = readTokenFile(getDaemonAuthTokenPath()) || readTokenFile(getAuthTokenPath());
    if (!token) return [];
    // Addressed as the daemon, because that is what M1 made the bridge talk to
    // and what a probe needs to observe.
    return [{ name: 'daemon', pipe: pipeOverride, token, method: 'daemon.hooks.signal' }];
  }
  const targets = [];
  // The daemon exposes a local control pipe, not the main process's TCP
  // fallback, so it is reachable only from the native host. WSL goes directly
  // to the Windows main process using getRpcTargets() below.
  if (!isWsl() && process.env.WMUX_HOOKS_TO_MAIN !== '1') {
    const token = readTokenFile(getDaemonAuthTokenPath());
    if (token) {
      targets.push({ name: 'daemon', pipe: getDaemonPipeName(), token, method: 'daemon.hooks.signal' });
    }
  }
  const mainToken = readTokenFile(getAuthTokenPath());
  if (mainToken) {
    for (const pipe of getRpcTargets()) {
      targets.push({ name: 'main', pipe, token: mainToken, method: 'hooks.signal' });
    }
  }
  return targets;
}

function getBridgeLogPath() {
  // Log stays on the LOCAL (WSL) home — it's read by whoever is debugging the
  // session in that environment, and must never depend on resolving Windows.
  const dir = join(localHome(), '.fmux');
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
// Path matches the bridge.log convention (~/.fmux, NO data-suffix): the bridge
// cannot see WMUX_DATA_SUFFIX (a reserved WMUX_* var, stripped from the pane
// env), so dev/prod-concurrent isolation falls back to cwd routing — same
// pre-existing limitation as bridge.log. In production (no suffix) and in the
// USERPROFILE-isolated dogfood, bridge and daemon resolve the same dir.
function getResumeSpoolDir() {
  // Spool under the HOST home (Windows profile in WSL) so the Windows daemon —
  // which drains this on its next boot — can actually see the records. On a
  // WSL degraded path they'd otherwise land in the WSL home the daemon never reads.
  const dir = join(hostHome(), '.fmux', 'resume-spool');
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

// Stamp files live next to bridge.log (same no-suffix ~/.fmux limitation).
// One zero-byte file per throttle key; mtime is the last-send timestamp.
function getActivityStampPath(key) {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const dir = join(home, '.fmux', 'activity-stamps');
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

// ----- RPC over named pipe / Unix socket / TCP ----------------------------

// `target` is either an IPC path string (Windows pipe, Unix socket) or a
// { host, port } object (WSL → Windows TCP loopback). createConnection accepts
// both shapes, so the retry/settle logic below is transport-agnostic.
function sendRpc(target, request, timeoutMs = HOOK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = createConnection(target);
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
      // `retryable` mirrors the error path: a timeout BEFORE the write bytes
      // went out (unreachable host — e.g. a NAT gateway with nothing bound) is
      // safe to fail over to the next target; a timeout mid-request is not
      // (the server may act on the already-sent signal → double-fire risk).
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
async function sendRpcWithRetry(target, request, deadline = Date.now() + HOOK_TIMEOUT_MS) {
  let attempt = 0;
  let last = { ok: false, error: 'timeout' };
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return last;
    last = await sendRpc(target, request, remaining);
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

// Walk the targets in order under one shared deadline. Returns the last result
// plus the target that produced it (logged, so bridge.log shows which endpoint
// actually served the hook).
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

  // Endpoints to try, daemon first (see resolveTargets). No token for either
  // endpoint means wmux has never run for this user — drop as before.
  const targets = resolveTargets();
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

  // Env-first routing identifiers. When Claude Code runs inside a Forge Mux
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

  // One id across the walk so a fallback is correlatable in the logs; each
  // target gets its own method + token (see resolveTargets).
  const requestId = `bridge-${randomUUID()}`;
  const { result: rpcResult, target } = await sendToTargets(targets, (t) => ({
    id: requestId,
    method: t.method,
    params: envelope,
    token: t.token,
  }));
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
