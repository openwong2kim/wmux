// Format-aware MCP-config read/write, shared by McpRegistrar (main) and the
// `wmux mcp` CLI so both registration paths behave identically.
//
// READ  — parse the file to inspect the wmux entry (status,
//          idempotency, foreign-key detection). TOML is parsed with smol-toml;
//          JSON with a proto-pollution-guarded JSON.parse.
// WRITE — JSON is object-merge + 2-space re-stringify (JSON has no comments, so
//          a round-trip is lossless). TOML is a SURGICAL block edit: only the
//          `[mcp_servers.<key>]` table (and any child sub-tables) is
//          appended/replaced/removed as text; every other byte — comments,
//          ordering, and quoted Windows-path keys like `[projects.'d:\wmux']` —
//          is preserved untouched. (A smol-toml round-trip was rejected: its
//          stringify silently drops backslashes in literal-string keys,
//          corrupting Codex's project-trust tables. `codex mcp add` itself does
//          a surgical append; this matches it.)
//
//   ┌─ upsertMcpServer ────────────────────────────────────────────────┐
//   │ resolve args = [script, ...profile flags, ...residual] (wmuxEntryArgs) │
//   │ json:  parse → mcpServers[key] = {command:'node', args}            │
//   │        → JSON.stringify(2-space)                                   │
//   │ toml:  find [mcp_servers.<key>] block → replace, else append       │
//   └────────────────────────────────────────────────────────────────────┘
//
// PROFILE — the surface the registered server launches with (DEFAULT_HOST_
// PROFILE below) is threaded through upsertMcpServer to every writer, so one
// constant decides what a fresh registration gets. An explicit caller profile
// wins; omitting it preserves the profile already on disk, which is what keeps
// an automatic re-registration from undoing a user's `--core`.

import { parse as parseTomlText } from 'smol-toml';
import type { McpConfigFormat } from './mcpTargets';
import { CORE_MODE_ARG } from './coreSurface';
import { COMMANDER_MODE_ARG } from './commanderSurface';

/** Thrown when a config file is present but unparseable. Callers choose: abort
 *  a write (never clobber a file we can't understand) vs. report "not
 *  registered" for a read. */
export class ConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigParseError';
  }
}

export interface McpServerEntry {
  command: string | null;
  args: string[];
}

// The wmux MCP entry shape written into every target. `node` (not the Electron
// execPath) + the absolute bundle script. No `env` field — Claude Code may
// replace rather than merge the subprocess environment.
//
// The launch-time surface profile rides in `args`, not `env`, on purpose:
// Claude Code may replace the subprocess environment, so an env-carried profile
// could silently change between launches.
export type WmuxMcpEntryProfile = 'full' | 'core';

/**
 * The profile every registration path writes unless the user asks for another.
 *
 * `full`, deliberately: the browser tools are first-class here — an agent
 * driving the workspace browser is a headline capability, and it works with
 * nothing to wire up precisely because the default registration carries
 * `browser_*`. `core` is an opt-in for hosts that do not need the browser
 * surface and would rather not pay ~27 KB of `tools/list` schema for it.
 *
 * ONE owner for the value: every writer resolves through here, so changing the
 * product default is a one-line change rather than an audit of each caller.
 */
export const DEFAULT_HOST_PROFILE: WmuxMcpEntryProfile = 'full';

/** Every argv flag that selects a launch profile. Used to READ a profile back
 *  off an existing entry, which is what makes a rewrite preserve the user's
 *  choice. `--commander` is included because it must survive a rewrite too,
 *  even though no host-config writer ever emits it (the deck brain adapters
 *  pass it at spawn time). */
const PROFILE_FLAGS: readonly string[] = [CORE_MODE_ARG, COMMANDER_MODE_ARG];

/** The argv flags a profile contributes. `full` is the bare surface — it adds
 *  no flag at all, which is also why it stays wire-compatible with every entry
 *  wmux has ever written. */
function profileFlags(profile: WmuxMcpEntryProfile): string[] {
  return profile === 'core' ? [CORE_MODE_ARG] : [];
}

/** The profile flags an already-written entry carries, in argv order,
 *  de-duplicated (a hand-edited `--core --core` collapses to one). Empty for a
 *  `full` entry, a missing entry, or a foreign one. args[0] is the script path,
 *  never a flag, so it is skipped. */
export function entryProfileFlags(entry: McpServerEntry | null): string[] {
  if (!entry) return [];
  return [...new Set(entry.args.slice(1).filter((arg) => PROFILE_FLAGS.includes(arg)))];
}

/** Everything after the script path that is NOT a profile flag: a token the
 *  user added by hand, or one written by a NEWER wmux than the one rewriting
 *  this file. */
function entryResidualArgs(entry: McpServerEntry | null): string[] {
  if (!entry) return [];
  return entry.args.slice(1).filter((arg) => !PROFILE_FLAGS.includes(arg));
}

/**
 * The full `args` array for a wmux entry: the script, the profile flags, then
 * every other token the existing entry carried.
 *
 * `profile` is the CALLER'S EXPLICIT CHOICE and always wins — that is how
 * `wmux mcp register --profile full` walks a config back off `core`. Omitting
 * it means "I have no opinion", which is the case for every automatic
 * re-registration (app boot, path refresh). Those PRESERVE whatever profile the
 * entry already carries and fall back to {@link DEFAULT_HOST_PROFILE} only for
 * an entry that does not exist yet. Without that, a routine path refresh would
 * silently undo a user's `--core` on the next launch.
 *
 * RESIDUAL TOKENS PASS THROUGH VERBATIM, and that is load-bearing: this
 * function REWRITES only the args it recognises. Rebuilding the array from a
 * whitelist instead would make every automatic re-registration quietly delete a
 * token wmux did not put there — a user's own addition, or a flag from a newer
 * wmux sharing the config (two installs, or a downgrade). The registration path
 * is not a place to have opinions about argv it does not own.
 */
export function wmuxEntryArgs(
  scriptPath: string,
  profile?: WmuxMcpEntryProfile,
  existing?: McpServerEntry | null,
): string[] {
  const entry = existing ?? null;
  const existingFlags = entryProfileFlags(entry);
  const flags = profile
    ? profileFlags(profile)
    : (existingFlags.length > 0 ? existingFlags : profileFlags(DEFAULT_HOST_PROFILE));
  return [scriptPath, ...flags, ...entryResidualArgs(entry)];
}

export function wmuxMcpEntry(
  scriptPath: string,
  profile: WmuxMcpEntryProfile = DEFAULT_HOST_PROFILE,
): McpServerEntry & { command: string } {
  return { command: 'node', args: wmuxEntryArgs(scriptPath, profile) };
}

/** The container key that holds MCP server definitions for a given format.
 *  Codex (toml) uses `mcp_servers`; Claude/Gemini (json) use `mcpServers`. */
function serversKey(format: McpConfigFormat): 'mcp_servers' | 'mcpServers' {
  return format === 'toml' ? 'mcp_servers' : 'mcpServers';
}

/**
 * Parse a config file's text into a plain object. Empty/whitespace input is a
 * fresh file → `{}`. Throws {@link ConfigParseError} on malformed input.
 */
export function parseConfig(text: string, format: McpConfigFormat): Record<string, unknown> {
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = format === 'json'
      ? JSON.parse(text, (key, value) =>
          key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value)
      : parseTomlText(text);
  } catch (e) {
    throw new ConfigParseError(e instanceof Error ? e.message : String(e));
  }
  // The config root must be a plain object/table — a top-level array or scalar
  // (or `null`) is not a usable config and must not be silently accepted.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigParseError('config root is not a table/object');
  }
  // If the server container is present it must be a table, not an array — an
  // array `mcpServers` would corrupt entry lookups / writes.
  const servers = (parsed as Record<string, unknown>)[serversKey(format)];
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    throw new ConfigParseError(`"${serversKey(format)}" is not a table/object`);
  }
  return parsed as Record<string, unknown>;
}

/** Read a single MCP server entry from already-parsed config, or null. */
export function getMcpServerEntry(
  parsed: Record<string, unknown>,
  format: McpConfigFormat,
  key: string,
): McpServerEntry | null {
  const container = parsed[serversKey(format)];
  if (!container || typeof container !== 'object') return null;
  const entry = (container as Record<string, unknown>)[key];
  if (!entry || typeof entry !== 'object') return null;
  const command = typeof (entry as { command?: unknown }).command === 'string'
    ? (entry as { command: string }).command
    : null;
  const rawArgs = (entry as { args?: unknown }).args;
  const args = Array.isArray(rawArgs)
    ? rawArgs.filter((a): a is string => typeof a === 'string')
    : [];
  return { command, args };
}

/** The script path (first arg) wmux wrote for a server key, or null when the
 *  key is absent / malformed / foreign-shaped. */
export function getMcpServerScript(
  parsed: Record<string, unknown>,
  format: McpConfigFormat,
  key: string,
): string | null {
  const entry = getMcpServerEntry(parsed, format, key);
  return entry && entry.args.length > 0 ? entry.args[0] : null;
}

/** True when an existing entry is wmux-owned: `node <script>`. A foreign entry
 *  (different command, e.g. a user-authored `[mcp_servers.wmux]` pointing
 *  elsewhere) returns false so the caller leaves it untouched. */
export function isWmuxOwnedEntry(entry: McpServerEntry | null): boolean {
  return !!entry && entry.command === 'node' && entry.args.length >= 1;
}

// ── JSON writers (object round-trip — lossless, JSON has no comments) ────────

function upsertJson(text: string, key: string, args: string[]): string {
  const config = parseConfig(text, 'json');
  const servers = (config.mcpServers && typeof config.mcpServers === 'object'
    ? config.mcpServers
    : (config.mcpServers = {})) as Record<string, unknown>;
  servers[key] = { command: 'node', args };
  return JSON.stringify(config, null, 2) + '\n';
}

function removeJson(text: string, keys: string[]): string {
  const config = parseConfig(text, 'json');
  const servers = config.mcpServers;
  if (!servers || typeof servers !== 'object') return text;
  let changed = false;
  for (const key of keys) {
    if ((servers as Record<string, unknown>)[key] !== undefined) {
      delete (servers as Record<string, unknown>)[key];
      changed = true;
    }
  }
  if (!changed) return text;
  if (Object.keys(servers as Record<string, unknown>).length === 0) delete config.mcpServers;
  return JSON.stringify(config, null, 2) + '\n';
}

// ── TOML surgical block writers (preserve every other byte) ──────────────────

function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Split a dotted TOML key path (`mcp_servers.'my-server'.env`) into unquoted
 *  segments, honoring basic- and literal-string quoting. */
function splitTomlKeyPath(path: string): string[] {
  const segs: string[] = [];
  let i = 0;
  while (i < path.length) {
    while (i < path.length && /\s/.test(path[i])) i++;
    if (i >= path.length) break;
    let seg = '';
    const ch = path[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < path.length && path[i] !== quote) {
        if (quote === '"' && path[i] === '\\') {
          // basic-string escape — keep the escaped char literally enough for
          // segment comparison (paths/keys don't rely on escape semantics here)
          seg += path[i + 1] ?? '';
          i += 2;
        } else {
          seg += path[i];
          i++;
        }
      }
      i++; // closing quote
    } else {
      while (i < path.length && path[i] !== '.') seg += path[i++];
      seg = seg.trim();
    }
    segs.push(seg);
    while (i < path.length && /\s/.test(path[i])) i++;
    if (path[i] === '.') i++;
  }
  return segs;
}

/** Classify a line as the header of our `mcp_servers.<key>` table, a child
 *  sub-table of it, or neither. Only a STANDARD single-bracket table `[t]` can
 *  be ours: an array-of-tables `[[t]]` is a different construct, and a mismatched
 *  `[t]]` / `[[t]` is malformed — both must be treated as "not ours" so we never
 *  replace/remove foreign array-of-tables. Quoted segments are honored. */
function classifyTomlHeader(line: string, key: string): 'exact' | 'child' | null {
  // Trailing inline comment after the close bracket is allowed (`[t] # note`).
  const m = line.match(/^\s*(\[\[?)\s*([^\]]*?)\s*(\]\]?)\s*(?:#.*)?$/);
  if (!m) return null;
  if (m[1] !== '[' || m[3] !== ']') return null; // [[array]] or mismatched → not ours
  const segs = splitTomlKeyPath(m[2]);
  if (segs.length < 2 || segs[0] !== 'mcp_servers' || segs[1] !== key) return null;
  return segs.length === 2 ? 'exact' : 'child';
}

function isAnyTableHeader(line: string): boolean {
  return /^\s*\[\[?[^\]]/.test(line);
}

/** Range [start, end) of lines spanning the `[mcp_servers.<key>]` table and any
 *  child sub-tables (e.g. `[mcp_servers.<key>.env]`). null when absent. */
function findTomlBlockRange(lines: string[], key: string): [number, number] | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (classifyTomlHeader(lines[i], key) === 'exact') {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isAnyTableHeader(lines[i])) {
      // a child sub-table stays part of our block; any other table ends it
      if (classifyTomlHeader(lines[i], key) === 'child') continue;
      end = i;
      break;
    }
  }
  // Exclude trailing blank lines from the block so the separator before the
  // next table (or EOF) is preserved in the surrounding text, not swallowed.
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  return [start, end];
}

/** Emit a key segment for a TOML header: bare when allowed, else basic-string. */
function tomlKeySegment(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

/** The canonical wmux block text (no leading/trailing blank lines). */
function tomlBlock(key: string, args: string[], eol: string): string {
  // JSON.stringify yields a valid TOML basic string for the path (escapes \ and
  // " the same way TOML does), so Windows backslash paths round-trip correctly.
  // Both writers are handed the SAME resolved `args` by upsertMcpServer rather
  // than each rebuilding one: two hand-kept arg lists would let a TOML host and
  // a JSON host end up on different surfaces.
  return [
    `[mcp_servers.${tomlKeySegment(key)}]`,
    `command = ${JSON.stringify('node')}`,
    `args = [${args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
  ].join(eol);
}

function upsertToml(text: string, key: string, args: string[]): string {
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const blockLines = tomlBlock(key, args, eol).split(eol);
  const range = findTomlBlockRange(lines, key);
  let result: string[];
  if (range) {
    const [start, end] = range;
    result = [...lines.slice(0, start), ...blockLines, ...lines.slice(end)];
  } else {
    // Append after the existing content with one blank-line separator.
    const trimmed = [...lines];
    while (trimmed.length && trimmed[trimmed.length - 1].trim() === '') trimmed.pop();
    result = trimmed.length ? [...trimmed, '', ...blockLines] : [...blockLines];
  }
  // End with exactly one trailing newline (no accumulated blank lines).
  while (result.length && result[result.length - 1].trim() === '') result.pop();
  return result.join(eol) + eol;
}

function removeToml(text: string, keys: string[]): string {
  const eol = detectEol(text);
  let lines = text.split(/\r?\n/);
  let changed = false;
  for (const key of keys) {
    const range = findTomlBlockRange(lines, key);
    if (!range) continue;
    const [start, end] = range;
    lines = [...lines.slice(0, start), ...lines.slice(end)];
    changed = true;
  }
  if (!changed) return text;
  // Collapse 3+ consecutive blank lines left behind, trim trailing blanks.
  return lines.join(eol).replace(new RegExp(`(?:${eol === '\r\n' ? '\\r\\n' : '\\n'}){3,}`, 'g'), eol + eol).replace(/\s*$/, '') + eol;
}

// ── Unified text→text API used by McpRegistrar + CLI ─────────────────────────

/** Return new file text with `key` set to the wmux `node <script>` entry.
 *  Throws ConfigParseError if the existing text is malformed (caller aborts).
 *
 *  `profile` is the caller's explicit choice; omit it to preserve whatever
 *  profile the existing entry carries (see {@link wmuxEntryArgs}). */
export function upsertMcpServer(
  text: string,
  format: McpConfigFormat,
  key: string,
  scriptPath: string,
  profile?: WmuxMcpEntryProfile,
): string {
  // Validate parseability up-front so a malformed file aborts instead of being
  // clobbered (TOML append would otherwise blindly tack a block onto garbage).
  const parsed = parseConfig(text, format);
  const args = wmuxEntryArgs(scriptPath, profile, getMcpServerEntry(parsed, format, key));
  const out = format === 'json' ? upsertJson(text, key, args) : upsertToml(text, key, args);
  // Never RETURN invalid TOML: the line-based surgical editor can't target an
  // inline-table entry (`wmux = { ... }` under `[mcp_servers]`) and would append
  // a duplicate table. Validate the output and throw rather than hand a caller a
  // string it might persist. (JSON re-stringify is always valid.)
  if (format === 'toml') parseConfig(out, format);
  return out;
}

/** Return new file text with the given wmux keys removed (only those keys). */
export function removeMcpServers(
  text: string,
  format: McpConfigFormat,
  keys: string[],
): string {
  parseConfig(text, format);
  return format === 'json' ? removeJson(text, keys) : removeToml(text, keys);
}

// ── Codex `notify` (root-level array) read/write ─────────────────────────────
//
// Codex's `notify` is a SINGLE root-level slot (`notify = ["prog", "args"...]`)
// spawned on agent-turn-complete. wmux registers its resume-capture bridge here.
// Unlike `mcp_servers.<key>` (a namespaced table where wmux and the user coexist),
// there is exactly one notify — so wmux only ever writes it when it is ABSENT or
// already wmux-owned, never over a foreign one (codex-resume-support eng review,
// decision 1: skip-if-foreign). Root keys must precede tables in TOML, so the
// insert lands before the first table header.

/** Basename of the wmux Codex notify bridge — how we recognize our own entry. */
export const CODEX_NOTIFY_BASENAME = 'wmux-codex-notify.mjs';

/** Read the root `notify` value (array of string tokens), or null when absent /
 *  not an array. Non-string elements are dropped (a shape we don't own). */
export function getNotify(parsed: Record<string, unknown>): string[] | null {
  const n = parsed['notify'];
  if (!Array.isArray(n)) return null;
  return n.filter((x): x is string => typeof x === 'string');
}

/** True when the notify entry is wmux-owned: `["node", "<…/wmux-codex-notify.mjs>"]`.
 *  A foreign notify (user's own program) returns false so we leave it untouched. */
export function isWmuxOwnedNotify(notify: string[] | null): boolean {
  return (
    !!notify &&
    notify.length >= 2 &&
    notify[0] === 'node' &&
    notify[1].replace(/\\/g, '/').endsWith(CODEX_NOTIFY_BASENAME)
  );
}

/** The canonical wmux notify line for a script path. JSON.stringify yields a
 *  valid TOML basic string (escapes \ and " like TOML), so Windows backslash
 *  paths round-trip. */
function notifyLineText(scriptPath: string): string {
  return `notify = ["node", ${JSON.stringify(scriptPath)}]`;
}

/**
 * Return new TOML text with a root-level `notify = ["node", <script>]`, replacing
 * an existing ROOT `notify = …` line in place, or inserting one before the first
 * table header (TOML requires root keys before tables). Every other byte —
 * comments, ordering, quoted project keys — is preserved. Caller has already
 * decided the slot is ours-or-absent (skip-if-foreign lives in registerCodexNotify).
 */
export function upsertNotifyToml(text: string, scriptPath: string): string {
  parseConfig(text, 'toml'); // abort on malformed rather than append to garbage
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const line = notifyLineText(scriptPath);

  let firstTable = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (isAnyTableHeader(lines[i])) { firstTable = i; break; }
  }
  // Replace an existing ROOT notify (only searched before the first table — a
  // `notify` under a table belongs to that table's namespace, not the root).
  for (let i = 0; i < firstTable; i++) {
    if (/^\s*notify\s*=/.test(lines[i])) {
      lines[i] = line;
      const out = lines.join(eol);
      parseConfig(out, 'toml'); // never return unparseable TOML
      return out;
    }
  }
  let out: string;
  if (firstTable < lines.length) {
    lines.splice(firstTable, 0, line); // insert as the last root key, before the first table
    out = lines.join(eol);
  } else {
    // No tables — append as the last root key with exactly one trailing newline.
    const trimmed = [...lines];
    while (trimmed.length && trimmed[trimmed.length - 1].trim() === '') trimmed.pop();
    trimmed.push(line);
    out = trimmed.join(eol) + eol;
  }
  parseConfig(out, 'toml');
  return out;
}

/** Return new TOML text with a wmux-owned root `notify` line removed. Leaves a
 *  foreign notify untouched. No-op (returns input) when absent/foreign. */
export function removeNotifyToml(text: string): string {
  const parsed = parseConfig(text, 'toml');
  if (!isWmuxOwnedNotify(getNotify(parsed))) return text;
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  let firstTable = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (isAnyTableHeader(lines[i])) { firstTable = i; break; }
  }
  for (let i = 0; i < firstTable; i++) {
    if (/^\s*notify\s*=/.test(lines[i])) {
      lines.splice(i, 1);
      const out = lines.join(eol);
      parseConfig(out, 'toml');
      return out;
    }
  }
  return text;
}

// ── Codex `[[hooks.*]]` lifecycle-bridge block read/write ─────────────────────
//
// wmux's Codex hooks bridge (#1107) registers as array-of-tables under
// `[[hooks.<Event>]]` in config.toml. Unlike the single-slot `notify` line,
// array-of-tables can COEXIST with a user's own hooks — so the wmux-owned
// region is bracketed by start/end marker comments, and every surgical edit is
// bounded by exactly those markers: a refresh replaces precisely what wmux
// rendered, never a foreign `[[hooks.*]]` section a user appended after ours,
// and never more of ours than the region even after Codex annotates sections
// with on-disk trust state (`enabled` / `trusted_hash`) that a naive rewrite
// would silently destroy — un-trusting the hook, the exact silent failure this
// whole lane exists to prevent.
//
// The renderer and the version gate are TS mirrors of the dependency-free
// source of truth in integrations/codex/hooks/wmuxHooks.mjs (a bridge-side
// module src/ cannot require() as ESM). A lockstep test asserts the copies are
// byte-identical, the same discipline hookBridge.lockstep.test.ts applies.

/** Basename of the wmux Codex hooks bridge. */
export const CODEX_HOOKS_BRIDGE_BASENAME = 'wmux-codex-hooks-bridge.mjs';

/** Marker comments bracketing the wmux-owned `[[hooks.*]]` region. */
export const CODEX_HOOKS_MANAGED_MARKER = 'wmux-managed: codex-hooks-bridge';
export const CODEX_HOOKS_MANAGED_END_MARKER = 'wmux-managed: codex-hooks-bridge end';

/** The events wmux registers — mirrors CODEX_HOOK_EVENTS in wmuxHooks.mjs. */
export const CODEX_HOOK_EVENTS: readonly string[] = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'PermissionRequest',
];

/** Codex's own hook timeout; mirrors CODEX_HOOK_TIMEOUT_MS in wmuxHooks.mjs. */
export const CODEX_HOOK_TIMEOUT_MS = 2500;

/**
 * Render the wmux-owned `[[hooks.*]]` block. Byte-identical to
 * `renderCodexHooksToml` in integrations/codex/hooks/wmuxHooks.mjs — the
 * lockstep test in __tests__/configIO.test.ts is what keeps them together.
 */
export function renderCodexHooksBlockToml(bridgeScript: string): string {
  const command = `node "${bridgeScript}"`;
  const lines = [`# ${CODEX_HOOKS_MANAGED_MARKER}`];
  for (const event of CODEX_HOOK_EVENTS) {
    lines.push(
      '',
      `[[hooks.${event}]]`,
      'matcher = "*"',
      `[[hooks.${event}.hooks]]`,
      'type = "command"',
      `command = ${JSON.stringify(command)}`,
      `commandWindows = ${JSON.stringify(command)}`,
      `timeout = ${CODEX_HOOK_TIMEOUT_MS}`,
      'async = false',
    );
  }
  lines.push('', `# ${CODEX_HOOKS_MANAGED_END_MARKER}`);
  return lines.join('\n') + '\n';
}

function markerLine(marker: string, line: string): boolean {
  return line.trim() === `# ${marker}`;
}

export interface CodexHooksBlockRegion {
  /** Inclusive line indices of the wmux-owned region: the start marker through
   *  the end marker, or through the last line of our own tables when another
   *  tool wrote a table inside the markers (see `orphanEndMarker`). */
  start: number;
  end: number;
  /** Line index of an end marker left BELOW foreign tables that were written
   *  inside the markers, or null when the region closes on its own marker. */
  orphanEndMarker: number | null;
  /** The region's text verbatim. */
  text: string;
  /** The first `command` value inside the region (the bridge path), or null. */
  commandPath: string | null;
}

/** True for a table header the wmux block renders — the only ones it owns. */
function isOwnCodexHooksHeader(line: string): boolean {
  const t = line.trim();
  return CODEX_HOOK_EVENTS.some((event) => t === `[[hooks.${event}]]` || t === `[[hooks.${event}.hooks]]`);
}

/**
 * Locate the wmux-owned hooks region. Returns null when no start marker is
 * present. A start marker WITHOUT an end marker (a hand-pasted block from the
 * pre-marker README flow, or a truncated edit) is returned as
 * `{ unterminated: true }` so callers can refuse to touch it rather than
 * guess at a boundary.
 */
export function findCodexHooksBlock(text: string):
  | CodexHooksBlockRegion
  | { unterminated: true }
  | null {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (markerLine(CODEX_HOOKS_MANAGED_MARKER, lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (markerLine(CODEX_HOOKS_MANAGED_END_MARKER, lines[i])) { end = i; break; }
  }
  if (end === -1) return { unterminated: true };
  // Codex rewrites config.toml with toml_edit, which keeps a comment at the
  // end of the document as trailing text. A table Codex adds later (`codex
  // mcp add`, a project trust entry) is therefore written ABOVE our end
  // marker, inside the markers — measured on codex-cli 0.153.4. The owned
  // region ends at the first table header we did not render: that header,
  // the comment/blank lines leading into it, and everything after it up to
  // the end marker belong to someone else. One of our headers AFTER a foreign
  // one means the region is interleaved and cannot be bounded — refuse.
  let ownedEnd = end;
  let orphanEndMarker: number | null = null;
  for (let i = start + 1; i < end; i++) {
    if (!isAnyTableHeader(lines[i]) || isOwnCodexHooksHeader(lines[i])) continue;
    for (let j = i + 1; j < end; j++) {
      if (isOwnCodexHooksHeader(lines[j])) return { unterminated: true };
    }
    let k = i - 1;
    while (k > start && (lines[k].trim() === '' || lines[k].trim().startsWith('#'))) k--;
    ownedEnd = k;
    orphanEndMarker = end;
    break;
  }
  const region = lines.slice(start, ownedEnd + 1);
  const found = { start, end: ownedEnd, orphanEndMarker, text: region.join('\n') };
  for (const line of region) {
    const m = line.match(/^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/);
    if (m) {
      // Our own render JSON.stringify's the value, so JSON.parse reverses it
      // exactly (incl. Windows backslash escapes).
      try {
        const command = JSON.parse(`"${m[1]}"`) as string;
        const path = /^node "(.*)"$/s.exec(command)?.[1] ?? null;
        return { ...found, commandPath: path };
      } catch {
        return { ...found, commandPath: null };
      }
    }
  }
  return { ...found, commandPath: null };
}

/**
 * Return new TOML text with the wmux hooks block written or refreshed.
 * Caller has already decided the file is ours-or-absent (skip-if-foreign and
 * version gating live in registerCodexHooks). Throws ConfigParseError on
 * malformed input, and on an unterminated marker pair — a block we cannot
 * bound is a block we must not rewrite.
 */
export function upsertCodexHooksToml(text: string, bridgeScript: string): string {
  parseConfig(text, 'toml'); // abort on malformed rather than append to garbage
  const eol = detectEol(text);
  const block = findCodexHooksBlock(text);
  if (block && 'unterminated' in block) {
    throw new ConfigParseError('wmux hooks block is missing its end marker; remove it manually and re-run');
  }
  const renderLines = renderCodexHooksBlockToml(bridgeScript).trimEnd().split('\n');
  const original = text.split(/\r?\n/);
  let lines: string[];
  if (block) {
    // Foreign tables Codex wrote inside the markers stay; the end marker left
    // below them is dropped because the fresh render carries its own.
    const tail = original.slice(block.end + 1);
    if (block.orphanEndMarker !== null) tail.splice(block.orphanEndMarker - block.end - 1, 1);
    lines = [...original.slice(0, block.start), ...renderLines, ...tail];
  } else {
    const trimmed = [...original];
    while (trimmed.length && trimmed[trimmed.length - 1].trim() === '') trimmed.pop();
    lines = trimmed.length ? [...trimmed, '', ...renderLines] : [...renderLines];
  }
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const out = lines.join(eol) + eol;
  parseConfig(out, 'toml'); // never return unparseable TOML
  return out;
}

/**
 * Return new TOML text with the wmux-owned hooks block removed. No-op (returns
 * input) when the region is absent or unterminated — never guesses a boundary.
 */
export function removeCodexHooksToml(text: string): string {
  parseConfig(text, 'toml');
  const block = findCodexHooksBlock(text);
  if (!block || 'unterminated' in block) return text;
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  // Drop an end marker stranded below foreign tables first (higher index, so
  // the region's indices stay valid); the foreign tables themselves stay.
  if (block.orphanEndMarker !== null) lines.splice(block.orphanEndMarker, 1);
  // Swallow at most one blank line immediately above the region so a removal
  // in the middle of a file does not leave a doubled blank gap.
  const start = block.start > 0 && lines[block.start - 1].trim() === ''
    ? block.start - 1
    : block.start;
  lines.splice(start, block.end - start + 1);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const out = lines.length ? lines.join(eol) + eol : '';
  if (out) parseConfig(out, 'toml');
  return out;
}

/**
 * True when a codex-cli version string is at or above the hooks floor
 * (0.141.0, bisected — see wmuxHooks.mjs for the measurement). Mirrors
 * `codexSupportsHooks` there; a lockstep test keeps the copies identical.
 * A version it cannot parse is TOO OLD: an unknown build that silently runs
 * no hooks is the failure this gate exists to prevent.
 */
export function codexVersionSupportsHooks(versionOutput: string | null | undefined): boolean {
  const parse = (text: string | null | undefined) => {
    const m = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(String(text ?? ''));
    return m
      ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: Boolean(m[4]) }
      : null;
  };
  const found = parse(versionOutput);
  const want = parse('0.141.0');
  if (!found || !want) return false;
  for (let i = 0; i < 3; i++) {
    if (found.nums[i] > want.nums[i]) return true;
    if (found.nums[i] < want.nums[i]) return false;
  }
  // Numerically equal to the floor: a pre-release of it predates it.
  return !found.pre;
}
