// wmux-managed: codex-lifecycle-bridge
// wmux ↔ Codex CLI notify bridge (lifecycle + resume-binding capture).
//
// Registered as Codex's `notify` program in ~/.codex/config.toml:
//   notify = ["node", "<abs path to this file>"]
// Codex spawns it on lifecycle notifications, appending ONE extra argv. The
// official `agent-turn-complete` payload uses
// `{ type, thread-id, turn-id, cwd, input-messages, last-assistant-message }`;
// older Codex builds may use
// `{ session_id, transcript_path, cwd, hook_event_name, model, ... }`.
// Spawned by the Codex process in the pane, it inherits the pane env, so
// WMUX_PTY_ID pins the capture to the exact pane and WMUX_DATA_SUFFIX pins every
// endpoint/file to that instance. Spawned by a SHARED Codex app-server, it
// inherits the env of whichever pane started that server instead, so it is
// refused (see "Notifier origin" below, #1523).
//
// This script:
//   1. Parses the LAST argv as the Codex notify JSON payload.
//   2. Ignores unrelated official lifecycle event types.
//   3. Refuses a notification spawned by a shared Codex app-server: nothing is
//      sent or spooled under the identity that server inherited.
//   4. Builds a canonical, metadata-only AgentSignal envelope
//      (agent:'codex', kind:'agent.stop'); prompt and assistant content is never
//      logged or forwarded.
//   5. Sends the envelope to the first wmux endpoint that owns the request: the
//      DAEMON control pipe (`daemon.hooks.signal`, suffix-scoped daemon token —
//      the always-on process, so this still lands with the GUI closed), else the
//      MAIN pipe (`hooks.signal`, suffix-scoped main token). Either side builds
//      the resume binding from signal.agent + agentSessionId + cwd + optional
//      transcript_path; both paths are fully agent-agnostic.
//      WMUX_HOOKS_TO_MAIN=1 forces main-only.
//   6. On failure, spools a suffix-scoped resume-binding record for daemon boot.
//   7. Exits 0 ALWAYS, under a hard timeout, so a wmux problem never stalls Codex.
//
// SELF-CONTAINED: JS-only, Node built-ins only — no imports from src/ or
// integrations/shared/ (mirrors integrations/claude/bin/wmux-bridge.mjs; the
// Claude bridge's plugin constraint blocks a shared import, so full DRY across
// the two is impossible — the shared infra is duplicated by design). This
// bridge is leaner than the Claude one: Codex supplies an official thread id (or
// legacy session_id) directly and has no permission-mode / usage to extract.
//
// NO SHEBANG, deliberately — same reason as the Codex hooks bridge: every
// launcher runs this as `node "<path>"`, and Vitest cannot parse a `.mjs` that
// starts with one, which would leave the origin classifier testable only
// through a subprocess.

import {
  readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync, renameSync, unlinkSync,
  realpathSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HOOK_TIMEOUT_MS = 2000; // hard cap so we never stall a Codex turn
const AGENT_TURN_COMPLETE = 'agent-turn-complete';
// Stamped on every codex-notify.log line; bump on behavior changes.
//   0.2.0 — daemon-first targeting (daemon.hooks.signal → hooks.signal).
//   0.3.0 — official payload routing + suffix-isolated endpoint/state paths.
//   0.4.0 — refuse a notification spawned by a shared Codex app-server (#1523).
const BRIDGE_VERSION = '0.4.0';
const CONNECT_RETRY_BACKOFFS_MS = [100, 250];
const TRANSIENT_CONNECT_CODES = new Set([
  'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EBUSY', 'EAGAIN',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- Path helpers (Node built-ins only) ---------------------------------

// Keep these formulas in lockstep with src/shared/constants.ts. A non-empty
// suffix is an instance boundary: this bridge never probes production paths as
// a fallback when its selected namespace is suffixed.
function dataSuffix() {
  return process.env.WMUX_DATA_SUFFIX || '';
}

function getHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || homedir();
}

function getWmuxHomeDir() {
  return join(getHomeDir(), `.wmux${dataSuffix()}`);
}

function getAuthTokenPath() {
  return join(getHomeDir(), `.wmux${dataSuffix()}-auth-token`);
}

function getPipeName() {
  // WMUX_PIPE_NAME override: for the isolated capture probe
  // (scripts/codex-resume-capture-probe.mjs) and advanced multi-instance setups.
  // Not a security widening — a same-user process can already read the selected
  // namespace's auth token, so redirecting the pipe grants nothing new.
  const override = process.env.WMUX_PIPE_NAME;
  if (typeof override === 'string' && override.length > 0) return override;
  if (process.platform === 'win32') {
    const username = userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux${dataSuffix()}-${username}`;
  }
  return join(homedir() || '/tmp', `.wmux${dataSuffix()}.sock`);
}

// ----- Daemon endpoint (M1: hook ingest lives in the daemon) ---------------
//
// The daemon is the always-on process and owns hook ingest, so it is tried
// first; the main pipe stays as the fallback for an older wmux or a daemon that
// is down. WMUX_DATA_SUFFIX is propagated into pane environments, so daemon and
// main discovery stays inside the pane's selected instance namespace.
function getDaemonAuthTokenPath() {
  return join(getWmuxHomeDir(), 'daemon-auth-token');
}

// Prefer the suffix-scoped `daemon-pipe` hint the daemon writes at boot (the
// name it ACTUALLY bound, which differs from the convention after a zombie-pipe
// fallback rename), then derive a socket in that same namespace. Never consult
// an unsuffixed hint or endpoint for a suffixed instance.
function getDaemonPipeName() {
  try {
    const fromFile = readFileSync(join(getWmuxHomeDir(), 'daemon-pipe'), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch {
    // Hint file absent/unreadable — derive within the selected namespace.
  }
  if (process.platform === 'win32') {
    const username = userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux-daemon${dataSuffix()}-${username}`;
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
  const dir = getWmuxHomeDir();
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
// The spool lives in the same suffix-scoped data directory the daemon drains.
function getResumeSpoolDir() {
  const dir = join(getWmuxHomeDir(), 'resume-spool');
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

// ----- Notifier origin (#1523) --------------------------------------------
//
// Codex CLI 0.157+ runs turns in one shared, detached background server per
// account (`codex app-server --listen unix:// --managed-daemon`) instead of in
// the TUI. The first Codex to start that server hands it its environment, and
// this program is spawned FROM that server — so its WMUX_* variables name
// whichever pane started the server (a closed pane, or a pane of another wmux
// instance), not the pane whose turn finished. The payload names no pane
// either. A notification from a shared server therefore has no provable pane
// identity, and even its instance (WMUX_DATA_SUFFIX) is someone else's: it is
// dropped — not sent, not spooled.
//
// Older Codex builds, `--no-daemon` (what wmux's bash/zsh `codex` wrapper
// runs), `exec` and `review` spawn this program from the Codex process in the
// pane, where the inherited identity is exact. That path is unchanged, and so
// is a parent this program cannot inspect: its environment is trusted as
// before. The guarantee is "a notification from a shared server is never
// attributed", not "every attribution is proven".

const SELF_BASENAME = 'wmux-codex-notify.mjs';
// This program's own wrappers (a version-manager shim such as Volta's `node`
// re-runs the same command line as a child) plus the Codex process above them.
const MAX_ORIGIN_HOPS = 4;
// One budget for the whole ancestor walk. A PowerShell start is ~350 ms.
const ORIGIN_LOOKUP_BUDGET_MS = 1500;

function isSelfToken(token) {
  return typeof token === 'string'
    && (token.split(/[\\/]/).pop() ?? '').toLowerCase() === SELF_BASENAME;
}

/**
 * Quote-aware split of a Windows `CommandLine` (`"C:\Program Files\x" a b`),
 * which a bare whitespace split would tear apart. Escaped quotes are not
 * handled; only whole-token matches of `app-server` and this script's
 * basename are read from the result. Exported for tests.
 */
export function tokenizeCommandLine(cmdline) {
  const tokens = [];
  let cur = '';
  let quote = null;
  for (const ch of typeof cmdline === 'string' ? cmdline : '') {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/**
 * Who asked for this notification, from the argv of this process's ancestors,
 * nearest first. An ancestor whose argv runs this script is a wrapper of this
 * same command and is skipped; the first other ancestor spawned the
 * notification and decides:
 *   'shared-server'  one of its tokens is exactly `app-server`: a Codex
 *                    background server serving many panes. A prompt that
 *                    happens to hold that word only drops the signal.
 *   'process'        anything else — the Codex process in the pane.
 *   'unknown'        no readable ancestor, or only wrappers.
 * Exported for tests.
 */
export function classifyNotifierOrigin(chain) {
  for (const argv of Array.isArray(chain) ? chain : []) {
    if (!Array.isArray(argv) || argv.length === 0) return 'unknown';
    if (argv.some(isSelfToken)) continue;
    return argv.includes('app-server') ? 'shared-server' : 'process';
  }
  return 'unknown';
}

/**
 * Linux `/proc/<pid>/cmdline` + `/proc/<pid>/stat` → `{ argv, ppid }`. The
 * stat line is `pid (comm) state ppid …`, and comm may itself hold spaces and
 * parentheses, so the fields are read after the LAST `)`. Exported for tests.
 */
export function parseProcEntry(cmdline, stat) {
  const argv = cmdline.split('\0');
  if (argv[argv.length - 1] === '') argv.pop();
  const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  return { argv, ppid: Number.isInteger(ppid) ? ppid : 0 };
}

/**
 * One line of `ps -o ppid=,args=` → `{ argv, ppid }`, or null. The args
 * column is unquoted, so a spaced argument splits into several tokens — only
 * ever toward a refusal. Exported for tests.
 */
export function parsePsEntry(out) {
  const match = /^\s*(\d+)\s+(.*\S)/.exec(out);
  return match ? { argv: match[2].split(/\s+/), ppid: Number(match[1]) } : null;
}

// Linux: straight from /proc, no spawn.
function procEntryLinux(pid) {
  return parseProcEntry(readFileSync(`/proc/${pid}/cmdline`, 'utf8'), readFileSync(`/proc/${pid}/stat`, 'utf8'));
}

// macOS and other POSIX: one `ps` per hop.
function procEntryPs(pid, timeout) {
  return parsePsEntry(execFileSync(existsSync('/bin/ps') ? '/bin/ps' : 'ps',
    ['-ww', '-o', 'ppid=,args=', '-p', String(pid)],
    { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }));
}

// Windows: one Windows PowerShell for the whole walk, stopping at the first
// ancestor that is not a wrapper of this script, like readAncestorChain.
// `[wmi]` rather than Get-CimInstance: loading CimCmdlets alone added ~500 ms.
// One `L`-prefixed line per ancestor, line breaks inside a command line
// flattened. No UTF-8 switch: only the ASCII tokens `app-server` and this
// script's basename are read, and a legacy code page leaves those intact.
function ancestorChainWindows(startPid, timeout) {
  const powershell = join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    `$p=${Number(startPid)};`,
    `for ($i=0; $i -lt ${MAX_ORIGIN_HOPS} -and $p -gt 0; $i++) {`,
    "try { $w=[wmi]('Win32_Process.Handle=' + [char]34 + $p + [char]34) } catch { break };",
    "$c=[string]$w.CommandLine -replace '[\\r\\n]',' ';",
    "'L' + $c;",
    `if ($c -notlike '*${SELF_BASENAME}*') { break };`,
    '$p=[int]$w.ParentProcessId };',
    'exit 0',
  ].join(' ');
  const out = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  return out.split(/\r?\n/)
    .filter((line) => line.startsWith('L'))
    .map((line) => tokenizeCommandLine(line.slice(1)));
}

/**
 * The argv of this process's ancestors, nearest first, up to the first one
 * that is not a wrapper of this script. Never throws: a failed lookup ends
 * the chain, and an empty chain classifies as 'unknown'. PID 1 is never read
 * — a parent that already exited leaves this process re-parented to init,
 * which is not who asked for the notification.
 */
function readAncestorChain(startPid = process.ppid) {
  const deadline = Date.now() + ORIGIN_LOOKUP_BUDGET_MS;
  const chain = [];
  try {
    if (process.platform === 'win32') return ancestorChainWindows(startPid, ORIGIN_LOOKUP_BUDGET_MS);
    let pid = startPid;
    for (let hop = 0; hop < MAX_ORIGIN_HOPS && pid > 1; hop++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const entry = process.platform === 'linux' ? procEntryLinux(pid) : procEntryPs(pid, remaining);
      if (!entry) break;
      chain.push(entry.argv);
      if (!entry.argv.some(isSelfToken)) break;
      pid = entry.ppid;
    }
  } catch {
    // An unreadable ancestor ends the walk; what was read still counts.
  }
  return chain;
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
  } catch {
    // JSON parse diagnostics may quote the input; never copy them to the log.
    logEvent('malformed-payload');
    return;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    logEvent('non-object-payload');
    return;
  }

  // Official lifecycle payloads are explicitly typed. If `type` is present it
  // is authoritative: a legacy-looking session_id must not turn an unrelated
  // official event into agent.stop. With no official type, retain the legacy
  // notify behavior (including old clients that omitted hook_event_name).
  const hasOfficialType = Object.prototype.hasOwnProperty.call(payload, 'type');
  if (hasOfficialType && payload.type !== AGENT_TURN_COMPLETE) {
    logEvent('ignored-event-type', { format: 'official' });
    return;
  }

  const sessionId = nonEmptyStr(payload['thread-id']) ?? nonEmptyStr(payload.session_id);
  if (!sessionId) {
    // No thread/session id → nothing resumable to capture. Drop quietly without
    // logging any caller-provided payload field.
    logEvent('no-session-id', { format: hasOfficialType ? 'official' : 'legacy' });
    return;
  }
  const turnId = nonEmptyStr(payload['turn-id']);
  const cwd = nonEmptyStr(payload.cwd) ?? process.cwd();
  const transcriptPath = nonEmptyStr(payload.transcript_path);

  const envPtyId = nonEmptyStr(process.env.WMUX_PTY_ID);
  const envWorkspaceId = nonEmptyStr(process.env.WMUX_WORKSPACE_ID);
  const envSurfaceId = nonEmptyStr(process.env.WMUX_SURFACE_ID);

  // Before anything is sent OR spooled (the no-token branch below spools too):
  // a shared server's inherited identity is not this turn's pane (#1523).
  const origin = classifyNotifierOrigin(readAncestorChain());
  if (origin === 'shared-server') {
    logEvent('refused-shared-server', { sessionId, ...(envPtyId ? { claimedPtyId: envPtyId } : {}) });
    return;
  }

  // Endpoints to try, daemon first (see resolveTargets).
  const targets = resolveTargets();
  if (targets.length === 0) {
    logEvent('no-auth-token', { origin, paths: [getDaemonAuthTokenPath(), getAuthTokenPath()] });
    // Still spool so a later daemon boot reconciles the capture.
    if (envPtyId) spoolResumeBinding({ ptyId: envPtyId, agent: 'codex', sessionId, cwd, transcriptPath, ts: Date.now() });
    return;
  }

  // Canonical AgentSignal envelope. kind 'agent.stop' = a turn completed (the
  // strongest "task done" signal); it triggers the agent-agnostic resume-binding
  // capture in hooks.rpc.ts. Only non-sensitive, allowlisted metadata rides in
  // signal.payload: official turn-id and the legacy transcript_path used by the
  // binding's D5 liveness probe. Native input/assistant content is never copied.
  const envelope = {
    kind: 'agent.stop',
    agent: 'codex',
    agentSessionId: sessionId,
    ...(envWorkspaceId ? { workspaceId: envWorkspaceId } : {}),
    ...(envSurfaceId ? { surfaceId: envSurfaceId } : {}),
    ...(envPtyId ? { ptyId: envPtyId } : {}),
    cwd,
    payload: {
      ...(turnId ? { 'turn-id': turnId } : {}),
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    },
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
    logEvent('ok', { sessionId, target: target?.name, origin });
  } else {
    logEvent(outerOk ? 'rpc-rejected' : 'rpc-failed', {
      origin,
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

// Run only when launched as a script. Under `import` (the unit tests, which
// exercise the pure origin classifier directly) the module must stay inert.
// Fails OPEN: anything it cannot determine is treated as a real launch,
// because a bridge that silently declines to run is the worse failure.
// Mirrors wmux-codex-hooks-bridge.mjs.
function invokedAsScript() {
  try {
    if (!process.argv[1]) return true;
    const self = fileURLToPath(import.meta.url);
    const entry = resolve(process.argv[1]);
    // realpath both sides: a symlinked install, an 8.3 short path or a `subst`
    // drive would otherwise read as a different file.
    const real = (p) => {
      try {
        return realpathSync.native ? realpathSync.native(p) : realpathSync(p);
      } catch {
        return p;
      }
    };
    const norm = (p) => (process.platform === 'win32' ? real(p).toLowerCase() : real(p));
    return norm(self) === norm(entry);
  } catch {
    return true;
  }
}

if (invokedAsScript()) {
  main()
    .catch((err) => logEvent('uncaught', { error: String(err) }))
    .finally(() => process.exit(0));
}
