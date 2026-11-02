// Hermes Agent's conversation, read from its own session database.
//
// Hermes (Nous Research) keeps every conversation in one SQLite file,
// `<HERMES_HOME>/state.db`, in WAL mode: a `sessions` row per conversation and
// its `messages` rows. The columns read here exist in both versions read for
// this (v0.19.0, schema 23, and v0.22.5, schema 32): `hermes_state.py` and
// `hermes_state_common.py` respectively.
//
// Read-only, and nothing is ever created in Hermes' home:
//   - A read-only SQLite connection to a WAL database creates the `-wal` and
//     `-shm` files when they are missing (measured). So the database is opened
//     with `readonly_shm=1` only while both sidecars exist (Hermes has it
//     open), and as `immutable=1` only while neither exists and no rollback
//     journal does (nobody has it open: the file is a consistent snapshot).
//     Anything in between is a writer mid-change or a crash leftover, and is
//     not read.
//   - No connection is kept: Hermes defers its own maintenance while another
//     process holds the file (`foreign_state_db_holders`), so each read opens,
//     queries and closes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { ToolBody, TurnEvent } from '../../shared/transcript/turnEvents';
import { BUDGET_BYTES } from './TranscriptProjector';

/** Where Hermes keeps its home: `HERMES_HOME`, else `~/.hermes` (Windows:
 *  `%LOCALAPPDATA%\hermes`), as `hermes_constants.get_hermes_home` decides. A
 *  profile (`hermes -p <name>`) sets HERMES_HOME inside its own process only,
 *  so it is not found from the pane's environment. */
export function hermesHome(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  const set = env.HERMES_HOME?.trim();
  if (set) return set;
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim();
    return path.win32.join(local || path.win32.join(home, 'AppData', 'Local'), 'hermes');
  }
  return path.posix.join(home, '.hermes');
}

type Opener = (location: URL) => DatabaseSync;

const defaultOpener: Opener = (location) => {
  // Loaded on first use: a daemon that never reads Hermes never loads it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync: Database } = require('node:sqlite') as typeof import('node:sqlite');
  return new Database(location, { readOnly: true, timeout: 200 });
};

const exists = (file: string): boolean => {
  try { fs.lstatSync(file); return true; } catch { return false; }
};

/**
 * Open `db` read-only without creating anything beside it (see the header),
 * run `read`, close. Null when it cannot be read that way right now.
 */
export function withHermesDb<T>(db: string, read: (conn: DatabaseSync) => T, open: Opener = defaultOpener): T | null {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(db); } catch { return null; }
  if (!stat.isFile()) return null;
  const wal = exists(`${db}-wal`);
  const shm = exists(`${db}-shm`);
  const location = pathToFileURL(db);
  location.searchParams.set('mode', 'ro');
  if (wal && shm) location.searchParams.set('readonly_shm', '1');
  else if (!wal && !shm && !exists(`${db}-journal`)) location.searchParams.set('immutable', '1');
  else return null;
  let conn: DatabaseSync | undefined;
  try {
    conn = open(location);
    return read(conn);
  } catch {
    return null;
  } finally {
    try { conn?.close(); } catch { /* already closed */ }
  }
}

export interface HermesSession {
  id: string;
  /** Epoch ms. */
  startedAt: number;
}

/** Hermes' own session ids (`20261029_053840_ec122e`); anything else is not bound. */
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * The pane's conversation: the newest interactive CLI session (`source` 'cli';
 * Hermes records a folder only for those, `_launch_cwd_for_session`) started
 * in `cwds` at or after `sinceMs`. Hermes creates the row on its first message,
 * so a fresh Hermes has none yet; `/new` starts a newer one, which wins.
 */
export function findHermesSession(conn: DatabaseSync, cwds: readonly string[], sinceMs: number): HermesSession | null {
  if (cwds.length === 0) return null;
  const marks = cwds.map(() => '?').join(', ');
  const row = conn.prepare(
    `SELECT id, started_at FROM sessions WHERE source = 'cli' AND cwd IN (${marks}) AND started_at >= ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
  ).get(...cwds, sinceMs / 1000) as { id?: unknown; started_at?: unknown } | undefined;
  if (!row || typeof row.id !== 'string' || !SESSION_ID.test(row.id) || typeof row.started_at !== 'number') return null;
  return { id: row.id, startedAt: Math.round(row.started_at * 1000) };
}

interface MessageRow {
  id: number;
  role: string;
  content: Uint8Array | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  timestamp: number | null;
  display_kind: string | null;
}

/** How many of the newest rows one read looks at. */
export const HERMES_PAGE_ROWS = 400;
const MAX_TEXT_CHARS = 8000;
const INLINE_BODY_CHARS = 4096;
const ARG_SUMMARY_CHARS = 120;
/** Hermes' marker for structured (list/dict) content (`SessionDB._CONTENT_JSON_PREFIX`). */
const CONTENT_JSON_PREFIX = '\u0000json:';

export interface HermesHistory {
  events: TurnEvent[];
  /** Older rows were left out: by the row cap or the byte budget. */
  truncatedHead: boolean;
  /** Changes only when rows already shown stop being true (rewind, compaction). */
  rawEpoch: string;
  /** The newest active row is the human's, or a tool's: a turn is under way. */
  turnOpen: boolean;
}

/** The session's active rows as turn events, newest last, within the page budget. */
export function readHermesHistory(conn: DatabaseSync, sessionId: string): HermesHistory {
  const rows = conn.prepare(
    // As a blob: structured content starts with a NUL, and text reads stop at one.
    `SELECT id, role, CAST(content AS BLOB) AS content, tool_call_id, tool_calls, tool_name, timestamp, display_kind FROM messages
     WHERE session_id = ? AND active = 1 ORDER BY id DESC LIMIT ?`,
  ).all(sessionId, HERMES_PAGE_ROWS + 1) as unknown as MessageRow[];
  // A rewind or a compaction turns rows inactive (`active = 0`); nothing else
  // retracts one, so their count names the history the shown rows belong to.
  const retired = conn.prepare('SELECT count(*) AS n FROM messages WHERE session_id = ? AND active = 0').get(sessionId) as { n?: unknown } | undefined;
  const rawEpoch = `hermes:${sessionId}:${Number(retired?.n ?? 0)}`;
  let truncatedHead = rows.length > HERMES_PAGE_ROWS;
  const newestFirst = rows.slice(0, HERMES_PAGE_ROWS);
  const newest = newestFirst[0];
  const turnOpen = !!newest && (newest.role === 'user' || newest.role === 'tool' || newest.role === 'assistant' && hasToolCalls(newest));
  const events: TurnEvent[] = [];
  let bytes = 2;
  for (const row of newestFirst) {
    const made = eventsOf(row);
    const size = Buffer.byteLength(JSON.stringify(made), 'utf8');
    if (bytes + size > BUDGET_BYTES) { truncatedHead = true; break; }
    bytes += size;
    events.unshift(...made);
  }
  return { events, truncatedHead, rawEpoch, turnOpen };
}

function hasToolCalls(row: MessageRow): boolean {
  return toolCalls(row.tool_calls).length > 0;
}

function toolCalls(raw: string | null): Array<{ id: string; name: string; args: string }> {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((call) => {
    const c = object(call);
    const fn = object(c.function);
    const id = typeof c.id === 'string' ? c.id : '';
    const name = typeof fn.name === 'string' ? fn.name : typeof c.name === 'string' ? c.name : '';
    const args = typeof fn.arguments === 'string' ? fn.arguments : fn.arguments === undefined ? '' : JSON.stringify(fn.arguments);
    return id && name ? [{ id, name, args }] : [];
  });
}

function eventsOf(row: MessageRow): TurnEvent[] {
  const id = `hermes:${row.id}`;
  const ts = typeof row.timestamp === 'number' && Number.isFinite(row.timestamp) ? { ts: Math.round(row.timestamp * 1000) } : {};
  const text = contentText(row.content);
  if (row.role === 'user') {
    // A row Hermes wrote in the human's place (a model switch note, an
    // automatic continue) is labelled by its kind, never shown as typed.
    if (row.display_kind) return [{ id, kind: 'meta', subtype: 'unknown', label: cap(row.display_kind, 80), ...ts }];
    return text.trim() ? [{ id, kind: 'user_text', text: cap(text, MAX_TEXT_CHARS), ...ts }] : [];
  }
  if (row.role === 'assistant') {
    const out: TurnEvent[] = [];
    if (text.trim()) out.push({ id, kind: 'assistant_text', text: cap(text, MAX_TEXT_CHARS), ...ts });
    toolCalls(row.tool_calls).forEach((call, index) => {
      const input = body(call.args);
      out.push({ id: `${id}:${index}`, kind: 'tool_use', toolUseId: call.id, name: cap(call.name, 80),
        argSummary: cap(call.args.replace(/\s+/g, ' ').trim(), ARG_SUMMARY_CHARS), ...(input ? { input } : {}), ...ts });
    });
    return out;
  }
  if (row.role === 'tool' && row.tool_call_id) {
    const output = body(text);
    return [{ id, kind: 'tool_result', toolUseId: row.tool_call_id, ok: true, bytes: Buffer.byteLength(text, 'utf8'),
      ...(output ? { output } : {}), ...ts }];
  }
  // System prompts and anything else are not conversation.
  return [];
}

/** Plain text of a content cell: a string, or the text parts of structured content. */
function contentText(raw: Uint8Array | null): string {
  if (!(raw instanceof Uint8Array)) return '';
  const content = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  if (!content.startsWith(CONTENT_JSON_PREFIX)) return content.split('\u0000').join('');
  let parsed: unknown;
  try { parsed = JSON.parse(content.slice(CONTENT_JSON_PREFIX.length)); } catch { return ''; }
  const parts = Array.isArray(parsed) ? parsed : [parsed];
  return parts.flatMap((part) => {
    const p = object(part);
    return p.type === 'text' && typeof p.text === 'string' ? [p.text] : [];
  }).join('\n');
}

/** A tool body inline up to its cap; there is no fetch for the rest from this source. */
function body(text: string): ToolBody | undefined {
  if (!text) return undefined;
  const truncated = text.length > INLINE_BODY_CHARS;
  return { n: 0, bytes: Buffer.byteLength(text, 'utf8'), inline: truncated ? text.slice(0, INLINE_BODY_CHARS) : text, ...(truncated ? { truncated: true } : {}) };
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * What the classic Hermes REPL's input area says (`HermesCLI
 * _get_tui_prompt_fragments`, v0.19.0): the bottom of the screen is a rule,
 * the prompt row(s), a rule. The prompt is the bare symbol (`❯ `) when Hermes
 * waits for input; any state puts an icon before it: `⚕` while the agent runs,
 * a braille spinner frame while a slash command runs, `⚠` for an approval or
 * confirmation, `?`/`✎` for a clarify question, `🔐`/`🔑` for a password or
 * secret, `●`/`◉`/`🎤` for voice. Measured on the idle
 * screen of v0.19.0. Another skin's prompt symbol, a profile prefix or the Ink
 * TUI reads as `unknown`.
 */
export type HermesPromptState = 'idle-empty' | 'idle-typed' | 'running' | 'dialog' | 'unknown';

const RULE = /^─{8,}$/;
const PROMPT = '❯';
const STATE_ICONS = ['⚠', '?', '✎', '🔐', '🔑', '●', '◉', '🎤'];

export function hermesPromptState(rows: readonly string[] | null): HermesPromptState {
  if (!rows) return 'unknown';
  let bottom = rows.length - 1;
  while (bottom >= 0 && !rows[bottom].trim()) bottom--;
  if (bottom < 2 || !RULE.test(rows[bottom].trim())) return 'unknown';
  let top = bottom - 1;
  while (top >= 0 && bottom - top <= 12 && !RULE.test(rows[top].trim())) top--;
  if (top < 0 || bottom - top > 12 || top === bottom - 1) return 'unknown';
  const first = rows[top + 1].trimEnd();
  if (first === PROMPT && top + 2 === bottom) return 'idle-empty';
  if (first.startsWith(`${PROMPT} `)) return 'idle-typed';
  const icon = first.split(' ')[0];
  // `⚕` is the agent's turn; a braille spinner frame is a slash command running.
  if (icon === '⚕' || /^[⠁-⣿]$/.test(icon)) return 'running';
  if (STATE_ICONS.includes(icon)) return 'dialog';
  return 'unknown';
}
