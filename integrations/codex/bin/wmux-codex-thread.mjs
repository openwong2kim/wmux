// wmux-managed: codex-thread-attribution
// Shared runtime for the notify and hooks bridges. Node built-ins only.
import { readFileSync, existsSync, readdirSync, openSync, readSync, closeSync, fstatSync,
  mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

function nonEmptyStr(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function codexHome(env) {
  return nonEmptyStr(env.CODEX_HOME) ?? join(env.USERPROFILE || env.HOME || homedir(), '.codex');
}

// ----- Process origin -----------------------------------------------------
// A shared app-server retains its starter's environment. Only pane-side
// SessionStart with confirmed rollout metadata may establish ownership.
// Shared servers require recorded ownership; unknown origins keep the legacy
// pane-environment fallback without establishing new ownership.

const SELF_BASENAMES = ['wmux-codex-notify.mjs', 'wmux-codex-hooks-bridge.mjs'];
// This program's own wrappers (a version-manager shim such as Volta's `node`
// re-runs the same command line as a child) plus the Codex process above them.
const MAX_ORIGIN_HOPS = 4;
// One budget for the whole ancestor walk, well under the 1.5 s the hook
// harmlessness gate allows a bridge over a no-op hook. A PowerShell start is
// ~300 ms; a lookup that runs out is 'unknown' and retains pane delivery.
const ORIGIN_LOOKUP_BUDGET_MS = 900;
// Test-only override of that budget, so a suite about classification does not
// depend on how fast a loaded CI runner starts PowerShell. Never set in use.
const ORIGIN_LOOKUP_BUDGET_ENV = 'WMUX_CODEX_ORIGIN_LOOKUP_BUDGET_MS';
function originLookupBudgetMs() {
  const override = Number(process.env[ORIGIN_LOOKUP_BUDGET_ENV]);
  return Number.isInteger(override) && override > 0 ? override : ORIGIN_LOOKUP_BUDGET_MS;
}
// On WSL this bridge is a Windows process and cannot see the Linux Codex that
// spawned the launcher; the launcher (WSL_CODEX_HOOK in
// src/shared/wslIntegration.ts) hands that argv over (parseHandedArgv). It
// sets the variable only for its own `exec` of this bridge.
const HANDED_ARGV_ENV = 'WMUX_CODEX_NOTIFIER_ARGV';

// Codex global options that take a value (codex-cli 0.158 `--help`; the
// bash/zsh `codex` wrapper in src/daemon/shell-integration.ts skips the same).
const CODEX_VALUE_OPTIONS = new Set([
  '-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env',
  '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox',
  '-C', '--cd', '--add-dir', '-a', '--ask-for-approval',
]);

function isSelfToken(token) {
  return typeof token === 'string'
    && SELF_BASENAMES.some(name => token.replace(/[\"']/g, '').toLowerCase().includes(name));
}

/**
 * Split a Windows `CommandLine` the way CommandLineToArgvW does: whitespace
 * outside double quotes separates arguments, 2n backslashes before a quote
 * are n backslashes and the quote toggles quoting, 2n+1 are n backslashes and
 * a literal quote, other backslashes are literal, and `""` inside quotes is a
 * literal quote. Single quotes are ordinary characters on Windows.
 * Exported for tests.
 */
export function tokenizeCommandLine(cmdline) {
  const s = typeof cmdline === 'string' ? cmdline : '';
  const tokens = [];
  let cur = '';
  let inToken = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      let n = 0;
      while (s[i] === '\\') { n++; i++; }
      if (s[i] === '"') {
        cur += '\\'.repeat(n >> 1);
        if (n % 2 === 1) cur += '"';
        else quoted = !quoted;
      } else {
        cur += '\\'.repeat(n);
        i--; // the character after the run is read by the next iteration
      }
      inToken = true;
    } else if (ch === '"') {
      if (quoted && s[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
      inToken = true;
    } else if ((ch === ' ' || ch === '\t') && !quoted) {
      if (inToken) tokens.push(cur);
      cur = '';
      inToken = false;
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (inToken) tokens.push(cur);
  return tokens;
}

/**
 * Index of a Codex command line's subcommand: the first positional after the
 * executable, past global options and their values. -1 when there is none —
 * after `--` every word is a prompt, and after `-i/--image` (which takes any
 * number of files) a word cannot be told apart from one more file.
 */
function codexSubcommandIndex(argv) {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') return -1;
    if (CODEX_VALUE_OPTIONS.has(arg)) { i++; continue; }
    if (arg === '-i' || arg === '--image' || arg.startsWith('--image=') || /^-i./.test(arg)) return -1;
    if (arg.startsWith('-')) continue; // a flag, or an option with its value attached
    return i;
  }
  return -1;
}

/**
 * Is this argv a SHARED Codex app-server — one that serves more than the one
 * client that started it? `app-server` must be the subcommand, and the server
 * a managed daemon or listening anywhere but stdio. The executable's name is
 * not checked: release binaries carry a target suffix and `ps` splits a spaced
 * path. That splitting also shifts positions, so `--managed-daemon` next to an
 * `app-server` word counts on its own. Exported for tests.
 */
export function isSharedServerArgv(argv) {
  if (!Array.isArray(argv)) return false;
  if (argv.includes('--managed-daemon') && argv.includes('app-server')) return true;
  const sub = codexSubcommandIndex(argv);
  if (sub < 0 || argv[sub] !== 'app-server') return false;
  for (let i = sub + 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    if (arg === '--managed-daemon') return true;
    const listen = arg === '--listen' ? argv[i + 1] : arg.startsWith('--listen=') ? arg.slice('--listen='.length) : undefined;
    if (listen !== undefined && listen !== 'stdio://') return true;
  }
  return false;
}

/**
 * Who asked for this notification, from the argv of this process's ancestors,
 * nearest first. An ancestor whose argv runs this script is a wrapper of this
 * same command and is skipped; the first other ancestor spawned the
 * notification and decides:
 *   'shared-server'  a shared Codex app-server (isSharedServerArgv).
 *   'process'        a confirmed Codex executable, including per-pane stdio.
 *   'unknown'        no confirmed Codex ancestor, including incomplete wrappers.
 * Exported for tests.
 */
export function classifyNotifierOrigin(chain) {
  for (const argv of Array.isArray(chain) ? chain : []) {
    if (!Array.isArray(argv) || argv.length === 0) return 'unknown';
    if (argv.some(isSelfToken)) continue;
    if (isSharedServerArgv(argv)) return 'shared-server';
    // A shell or unrelated parent is not proof of a pane-side Codex process.
    const executable = String(argv[0]).replace(/["']/g, '').split(/[\\/]/).pop();
    return /^codex(?:[-.](?:[a-z0-9_-]+))?$/i.test(executable ?? '') ? 'process' : 'unknown';
  }
  return 'unknown';
}

/**
 * Does this environment claim a pane or an instance? Only then can a shared
 * server's notification be attributed to the wrong one. Exported for tests.
 */
export function claimsPaneIdentity(env) {
  return ['WMUX_PTY_ID', 'WMUX_WORKSPACE_ID', 'WMUX_SURFACE_ID', 'WMUX_DATA_SUFFIX']
    .some((key) => typeof env?.[key] === 'string' && env[key].length > 0);
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
 * column is unquoted, so a spaced argument splits into several tokens; the
 * server test reads positions and names no prompt word. Exported for tests.
 */
export function parsePsEntry(out) {
  const match = /^\s*(\d+)\s+(.*\S)/.exec(out);
  return match ? { argv: match[2].split(/\s+/), ppid: Number(match[1]) } : null;
}

/**
 * The argv the WSL launcher hands over: `/proc/<pid>/cmdline` with every NUL
 * turned into U+001F, so each argument ENDS with one. The final terminator is
 * dropped, as parseProcEntry drops /proc's; a value the launcher cut short
 * keeps its last, partial argument. Exported for tests.
 */
export function parseHandedArgv(value) {
  const argv = value.split('\x1f');
  if (argv[argv.length - 1] === '') argv.pop();
  return argv;
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
// flattened. UTF-8 output: in a legacy code page a trail byte can read back as
// a backslash, and backslashes decide quoting in tokenizeCommandLine.
function ancestorChainWindows(startPid, timeout) {
  const powershell = join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
    `$p=${Number(startPid)};`,
    `for ($i=0; $i -lt ${MAX_ORIGIN_HOPS} -and $p -gt 0; $i++) {`,
    "try { $w=[wmi]('Win32_Process.Handle=' + [char]34 + $p + [char]34) } catch { break };",
    "$c=[string]$w.CommandLine -replace '[\\r\\n]',' ';",
    "'L' + $c;",
    `if ($c -notlike '*${SELF_BASENAMES[0]}*' -and $c -notlike '*${SELF_BASENAMES[1]}*') { break };`,
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
 * that is not a wrapper of this script — or the one argv the WSL launcher
 * handed over. Never throws: a failed lookup ends the chain, and an empty
 * chain classifies as 'unknown'. PID 1 is never read — a parent that already
 * exited leaves this process re-parented to init, which is not who asked for
 * the notification.
 */
export function readAncestorChain(startPid = process.ppid) {
  const handed = process.env[HANDED_ARGV_ENV];
  if (typeof handed === 'string' && handed.length > 0) return [parseHandedArgv(handed)];
  const budget = originLookupBudgetMs();
  const deadline = Date.now() + budget;
  const chain = [];
  try {
    if (process.platform === 'win32') return ancestorChainWindows(startPid, budget);
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

// ----- Sub-agent threads (#1696) -------------------------------------------
//
// A Codex sub-agent (`spawn_agent`) runs as its own thread inside the pane's
// Codex process. It inherits the pane env, so its `agent-turn-complete`
// arrives pane-exact, exactly like the main thread's. Sent as agent.stop it
// (a) replaces the pane's resume binding with a thread the user cannot type
// into ("Viewing sub-agent — direct input is disabled"), (b) raises a
// "Task finished" toast the Subagent mute never catches, and (c) reads as the
// lead turn ending. The notify payload does not say which kind of thread it
// is; the thread's rollout does. Its first line is `session_meta`, and a
// sub-agent's carries `source: { subagent: … }` plus the root thread's id
// (`session_id`, and `thread_spawn.parent_thread_id` one level up).
//
// Such a completion goes out as agent.subagent_stop with NO agentSessionId at
// all (#1697 review, "should fix" #4): the subagent category mute and the
// pane's own-turn-keeps-running behavior both key on `kind`, neither needs an
// id, and an imperfect root can therefore never rebind or replace a pane's
// resume binding — the one failure mode worth being paranoid about. A
// best-effort root, when one can be CONFIRMED, still rides along in the log
// line only (`threadLog.rootSessionId`), for operators reading
// codex-notify.log. Anything this cannot read fails open to today's
// agent.stop.
//
// "Confirmed" is deliberately strict (#1697 review, "must fix" #1/#2): a
// thread only becomes the reported root after classifyCodexThread has READ
// that thread's own session_meta and found it has no subagent source, or a
// sub-agent's session_meta names it directly (`session_id`, Codex's own
// cross-reference). A parent whose rollout is missing, unreadable, not a
// regular file, mis-paired with a different thread's id, or past the hop/
// cycle budget never becomes rootId — the walk reports "sub-agent, unknown
// root" instead of guessing.

const THREAD_ID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
// session_meta carries the base instructions, measured ~20 KB; this cap only
// bounds a malformed file.
const SESSION_META_MAX_BYTES = 1024 * 1024;
const MAX_PARENT_HOPS = 8;
// A day's rollout directory is normally tiny (one account, real usage); this
// only bounds a pathological or adversarial one so the scan cannot run past
// the hook's own timeout budget (#1697 review, "bound the lookup").
const MAX_ROLLOUT_DIR_ENTRIES = 20_000;

export function codexSessionsRoot(env) {
  return join(codexHome(env), 'sessions');
}

/** Creation time of a UUIDv7 thread id (ms), else undefined. */
export function uuidV7Millis(id) {
  if (!THREAD_ID_RE.test(id) || id[14] !== '7') return undefined;
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

/**
 * The rollout file of `id` under `sessionsRoot`, else undefined. Codex files a
 * rollout under `YYYY/MM/DD` of its local creation time, which a UUIDv7 id
 * carries, so this lists at most three day directories (±1 day absorbs a
 * timezone or midnight edge) instead of walking the whole history. Only
 * regular files are considered — `withFileTypes` reports a symlink or FIFO's
 * own dirent type without following it, so neither is ever opened as a
 * rollout (#1697 review).
 */
export function findRolloutFile(id, sessionsRoot) {
  const created = uuidV7Millis(id);
  if (created === undefined) return undefined;
  const suffix = `-${id}.jsonl`;
  for (const offset of [0, -DAY_MS, DAY_MS]) {
    const d = new Date(created + offset);
    const dir = join(
      sessionsRoot,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    );
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    let examined = 0;
    for (const entry of entries) {
      if (examined++ >= MAX_ROLLOUT_DIR_ENTRIES) break;
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) return join(dir, entry.name);
    }
  }
  return undefined;
}

/** `file`'s first line, or undefined past `SESSION_META_MAX_BYTES` or for
 *  anything that isn't a regular file (an fstat check, since a symlink/FIFO
 *  could in principle replace the path between listing and opening). */
function readFirstLine(file) {
  const fd = openSync(file, 'r');
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const chunk = Buffer.alloc(64 * 1024);
    const parts = [];
    let total = 0;
    while (total < SESSION_META_MAX_BYTES) {
      const n = readSync(fd, chunk, 0, chunk.length, total);
      if (n <= 0) break;
      const nl = chunk.subarray(0, n).indexOf(0x0a);
      if (nl >= 0) {
        parts.push(Buffer.from(chunk.subarray(0, nl)));
        return Buffer.concat(parts).toString('utf8');
      }
      parts.push(Buffer.from(chunk.subarray(0, n)));
      total += n;
    }
    return total < SESSION_META_MAX_BYTES ? Buffer.concat(parts).toString('utf8') : undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Classify an already-parsed session_meta `payload`. Returns
 * `{ subagent: false }` for a top-level thread, `{ subagent: true, rootId,
 * parentId }` for a sub-agent (either id may be undefined). A falsy
 * `source.subagent` — `undefined`, `null`, `false`, or any other empty value —
 * means "not a sub-agent" (#1697 review, "must fix" #3: a future `false`
 * must not be read as "has a subagent source").
 */
function classifyMetaPayload(meta) {
  const rawSubagent = meta.source && typeof meta.source === 'object' ? meta.source.subagent : undefined;
  if (!rawSubagent) return { subagent: false };
  const validId = (v) => (typeof v === 'string' && THREAD_ID_RE.test(v) ? v : undefined);
  const ownId = validId(meta.id);
  const sessionId = validId(meta.session_id);
  const spawn = typeof rawSubagent === 'object' ? rawSubagent.thread_spawn : undefined;
  return {
    subagent: true,
    rootId: sessionId && sessionId !== ownId ? sessionId : undefined,
    parentId: spawn && typeof spawn === 'object' ? validId(spawn.parent_thread_id) : undefined,
  };
}

/**
 * Read a rollout's first line as `session_meta`. Returns `{ subagent: false }`
 * for a top-level thread, `{ subagent: true, rootId, parentId }` for a
 * sub-agent, or undefined when the line is not a session_meta record. Exposed
 * for tests exercising the record shape directly; classifyCodexThread uses
 * {@link parseSessionMetaRecord} instead, to also check the record's own id
 * against the thread it was looked up for.
 */
export function parseSessionMeta(line) {
  const record = parseSessionMetaRecord(line);
  return record?.classification;
}

function parseSessionMetaRecord(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!record || record.type !== 'session_meta' || !record.payload || typeof record.payload !== 'object') {
    return undefined;
  }
  const { payload } = record;
  return {
    id: typeof payload.id === 'string' ? payload.id : undefined,
    classification: classifyMetaPayload(payload),
  };
}

/**
 * Classify thread `id`: `{ subagent: false, rootId: id }` for a CONFIRMED
 * top-level thread, or one whose own rollout cannot be read at all (fail
 * open — nothing here says it is a sub-agent); else `{ subagent: true,
 * rootId }` where rootId is the CONFIRMED top-level thread it belongs to, or
 * undefined when the walk cannot confirm one (a missing/unreadable/
 * mis-paired intermediate rollout, a cycle, or the hop budget running out —
 * #1697 review, "must fix" #1/#2). `rootId` is never an id whose own
 * session_meta was not read and found to have no subagent source, except via
 * a sub-agent's own explicit `session_id` cross-reference.
 */
export function classifyCodexThread(id, sessionsRoot) {
  const { confirmed: _confirmed, ...thread } = inspectCodexThread(id, sessionsRoot);
  return thread;
}

export function inspectCodexThread(id, sessionsRoot) {
  const visited = new Set();
  let current = id;
  let subagent = false;
  for (let hop = 0; hop < MAX_PARENT_HOPS; hop++) {
    if (visited.has(current)) break; // A→B→A cycle: no further progress possible.
    visited.add(current);
    const file = findRolloutFile(current, sessionsRoot);
    if (!file) break;
    let record;
    try {
      const line = readFirstLine(file);
      record = line === undefined ? undefined : parseSessionMetaRecord(line);
    } catch {
      record = undefined;
    }
    // The file must be the thread it was looked up for — a misplaced or
    // mis-paired rollout must not attribute another conversation's root here.
    if (!record || !record.classification || record.id !== current) break;
    const meta = record.classification;
    if (!meta.subagent) return { subagent, rootId: current, confirmed: true }; // read AND confirmed top-level
    subagent = true;
    if (meta.rootId) return { subagent, rootId: meta.rootId, confirmed: true }; // Codex's own cross-reference
    if (!meta.parentId) return { subagent, rootId: undefined, confirmed: true }; // e.g. a review sub-agent
    current = meta.parentId;
  }
  // Loop exited without confirming a root. subagent is still false only when
  // hop 0 itself could not be read — the original "unavailable initial-thread
  // metadata" fallback. Any later exit (missing/mis-paired intermediate,
  // cycle, or hop budget) already confirmed a sub-agent and must not guess.
  return { subagent, rootId: subagent ? undefined : id, confirmed: subagent };
}

// ----- TUI ownership ------------------------------------------------------
// The account's app-server serves multiple wmux instances. Its environment
// cannot select even an instance, so this index lives beside account history.
// Each record carries the TUI's suffix and endpoints; inherited routing is
// discarded on lookup. No credentials or conversation content are persisted.
const OWNER_ENV_KEYS = [
  'WMUX_PTY_ID', 'WMUX_WORKSPACE_ID', 'WMUX_SURFACE_ID', 'WMUX_DATA_SUFFIX',
  'WMUX_PIPE_NAME', 'WMUX_HOOKS_TO_MAIN',
];
const digest = value => createHash('sha256').update(value).digest('hex');
function ownerDir(env) { return join(codexHome(env), 'wmux-thread-owners'); }
function paneKey(env) { return digest(JSON.stringify([env.WMUX_DATA_SUFFIX || '', env.WMUX_PTY_ID])); }
function writeAtomic(file, record) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed or never created */ }
  }
}

export function invalidatePaneOwner(env = process.env) {
  if (!nonEmptyStr(env.WMUX_PTY_ID)) return;
  try { unlinkSync(join(ownerDir(env), `pane-${paneKey(env)}.json`)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Call only for a confirmed top-level SessionStart from the pane process. */
export function recordThreadOwner(id, env = process.env) {
  if (!nonEmptyStr(id) || !nonEmptyStr(env.WMUX_PTY_ID)) return false;
  try {
    invalidatePaneOwner(env);
    const dir = ownerDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const identity = Object.fromEntries(OWNER_ENV_KEYS.map(key => [key, env[key] || '']));
    const owner = { version: 1, id, env: identity, nonce: randomUUID() };
    // The per-pane pointer invalidates old thread bindings after /new or a
    // different resume. A torn pair is dropped, never guessed from stale env.
    writeAtomic(join(dir, `thread-${digest(id)}.json`), owner);
    writeAtomic(join(dir, `pane-${paneKey(identity)}.json`), { id, nonce: owner.nonce });
    return true;
  } catch { return false; }
}

export function readThreadOwner(id, env = process.env) {
  if (!nonEmptyStr(id)) return undefined;
  try {
    const dir = ownerDir(env);
    const owner = JSON.parse(readFileSync(join(dir, `thread-${digest(id)}.json`), 'utf8'));
    if (owner?.version !== 1 || owner.id !== id || !nonEmptyStr(owner.nonce)
        || !owner.env || !nonEmptyStr(owner.env.WMUX_PTY_ID)
        || OWNER_ENV_KEYS.some(key => typeof owner.env[key] !== 'string')) return undefined;
    const current = JSON.parse(readFileSync(join(dir, `pane-${paneKey(owner.env)}.json`), 'utf8'));
    if (current.id !== id || current.nonce !== owner.nonce) return undefined;
    return owner;
  } catch { return undefined; }
}

export function applyThreadOwner(owner, env = process.env) {
  for (const key of OWNER_ENV_KEYS) {
    delete env[key];
    if (owner.env[key]) env[key] = owner.env[key];
  }
  // These describe the app-server's original process, never the resolved TUI.
  delete env.WMUX_WSL_AGENT_PROC;
}

/** Skip expensive OS ancestry queries when there is no inherited identity. */
export function notifierOrigin(env = process.env, readChain = readAncestorChain) {
  return claimsPaneIdentity(env) ? classifyNotifierOrigin(readChain()) : 'unclaimed';
}

/** One bounded retry covers a turn finishing just ahead of relay persistence. */
export async function resolveThreadOwner(id, env = process.env, {
  readOwner = readThreadOwner, delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const owner = readOwner(id, env);
  if (owner || !nonEmptyStr(id)) return owner;
  await delay(75);
  return readOwner(id, env);
}

/** Direct and unknown pane processes retain their own identity. A positively
 * identified shared server must resolve ownership, even if it claims a pane.
 * With no identity to inspect, account ownership is the only possible route.
 */
export async function attributeThread(origin, thread, env = process.env, resolveOwner = resolveThreadOwner,
  confirmUnclaimed = () => classifyNotifierOrigin(readAncestorChain())) {
  if (origin !== 'shared-server' && nonEmptyStr(env.WMUX_PTY_ID)) return true;
  if (origin === 'process' || origin === 'unknown') return false;
  const owner = await resolveOwner(thread?.rootId, env);
  if (!owner) return false;
  // A no-identity hook normally costs no OS lookup. Before using a record,
  // distinguish a clean shared server from a direct launch outside wmux.
  if (origin === 'unclaimed' && confirmUnclaimed() !== 'shared-server') return false;
  applyThreadOwner(owner, env);
  return true;
}
