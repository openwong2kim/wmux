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
//   │ json:  parse → mcpServers[key] = {command:'node',args:[script]}   │
//   │        → JSON.stringify(2-space)                                   │
//   │ toml:  find [mcp_servers.<key>] block → replace, else append       │
//   └────────────────────────────────────────────────────────────────────┘

import { parse as parseTomlText } from 'smol-toml';
import type { McpConfigFormat } from './mcpTargets';

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
export function wmuxMcpEntry(scriptPath: string): McpServerEntry & { command: string } {
  return { command: 'node', args: [scriptPath] };
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

function upsertJson(text: string, key: string, scriptPath: string): string {
  const config = parseConfig(text, 'json');
  const servers = (config.mcpServers && typeof config.mcpServers === 'object'
    ? config.mcpServers
    : (config.mcpServers = {})) as Record<string, unknown>;
  servers[key] = wmuxMcpEntry(scriptPath);
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
function tomlBlock(key: string, scriptPath: string, eol: string): string {
  // JSON.stringify yields a valid TOML basic string for the path (escapes \ and
  // " the same way TOML does), so Windows backslash paths round-trip correctly.
  return [
    `[mcp_servers.${tomlKeySegment(key)}]`,
    `command = "node"`,
    `args = [${JSON.stringify(scriptPath)}]`,
  ].join(eol);
}

function upsertToml(text: string, key: string, scriptPath: string): string {
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const blockLines = tomlBlock(key, scriptPath, eol).split(eol);
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
 *  Throws ConfigParseError if the existing text is malformed (caller aborts). */
export function upsertMcpServer(
  text: string,
  format: McpConfigFormat,
  key: string,
  scriptPath: string,
): string {
  // Validate parseability up-front so a malformed file aborts instead of being
  // clobbered (TOML append would otherwise blindly tack a block onto garbage).
  parseConfig(text, format);
  const out = format === 'json' ? upsertJson(text, key, scriptPath) : upsertToml(text, key, scriptPath);
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
