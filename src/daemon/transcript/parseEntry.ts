// One raw Claude Code transcript JSONL line → 0..n normalized `TurnEvent`s.
//
// Pure and total: NEVER throws, and any shape it does not recognize yields `[]`
// rather than a guess. That discipline is copied from
// `src/main/claude/lastAssistantMessage.ts` — the transcript format is an
// upstream implementation detail that has drifted before, and a parser that
// throws on a new entry class would take the whole projector down with it.
//
// Deliberately re-implemented rather than imported (plan D4/D9):
// `lastAssistantMessage.ts` is main-only, and `tsconfig.daemon.json` scopes the
// daemon to `src/daemon/**` + `src/shared/**`. Both copies are test-covered.
//
// Entry classes observed in a real transcript (Claude Code 2.1.206) and what
// they map to here:
//   user / assistant                → the conversation (see below)
//   pr-link                         → meta
//   system, last-prompt, mode, permission-mode, attachment,
//   file-history-snapshot, ai-title, queue-operation, anything unknown → []
//
// The `[]` default is why a future Claude Code entry type cannot leak into the
// chat as if the agent had said it.

import { summarizeActivity } from '../../shared/activitySummary';
import type {
  AssistantTextEvent,
  CodeBlockRef,
  MetaEvent,
  ToolResultEvent,
  ToolUseEvent,
  TurnEvent,
  UserTextEvent,
} from '../../shared/transcript/turnEvents';

/**
 * Inline placeholder left in `AssistantTextEvent.text` where a fenced code
 * block was lifted out. NUL-delimited on purpose: NUL cannot occur in
 * transcript prose (Claude Code writes JSON-escaped UTF-8 text), so a
 * renderer's split on this marker can never cut real content in half.
 */
export const CODE_MARKER_PREFIX = '\u0000code:';
export const CODE_MARKER_SUFFIX = '\u0000';

/** Hard cap on the prose we keep per text event. A single 2MB paste must not
 *  become a 2MB wire payload (A3's byte budget is enforced upstream, but the
 *  cheapest place to bound a pathological entry is at the source). */
const MAX_TEXT_CHARS = 8000;

/** Bodies are extracted lazily on expand, so a huge block costs only its ref. */
const MAX_BODY_CHARS = 256 * 1024;

/**
 * Everything one transcript line produced. `events` is what crosses the wire;
 * `bodies` is the daemon-local side table the on-expand
 * `daemon.transcript.codeBlock` fetch answers from (A3 — code bodies are never
 * broadcast).
 */
export interface ParsedTranscriptLine {
  events: TurnEvent[];
  /** eventId → (CodeBlockRef.n → body text). */
  bodies: Map<string, Map<number, string>>;
}

/** One raw JSONL line → 0..n TurnEvents. NEVER throws; unknown shapes → []. */
export function parseTranscriptLine(line: string, offsetHint: number): TurnEvent[] {
  return parseTranscriptLineDetailed(line, offsetHint).events;
}

/**
 * As {@link parseTranscriptLine}, but also returns the code-block bodies that
 * were stripped out of the prose. Callers that only fan events out to clients
 * must use the narrow function above so a body cannot be broadcast by accident.
 */
export function parseTranscriptLineDetailed(
  line: string,
  offsetHint: number,
): ParsedTranscriptLine {
  const empty: ParsedTranscriptLine = { events: [], bodies: new Map() };
  // A UTF-8 BOM survives on the first line of a file written by some editors,
  // and JSON.parse rejects it.
  const trimmed = line.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return empty;

  let entry: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    // A JSON array / null / number line is valid JSON but not an entry.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    entry = parsed as Record<string, unknown>;
  } catch {
    // Expected on the partial leading line of any mid-file seek.
    return empty;
  }

  const type = typeof entry['type'] === 'string' ? (entry['type'] as string) : '';
  const message = asObject(entry['message']);
  const role = typeof message?.['role'] === 'string' ? (message['role'] as string) : '';
  const baseId = entryId(entry, offsetHint);
  const ts = entryTs(entry);

  // Non-conversation entry classes. `pr-link` is surfaced as a meta chip
  // because it is a real, user-visible outcome of the turn; the rest carry no
  // conversation content at all.
  if (type === 'pr-link') {
    return single(metaEvent(baseId, ts, 'unknown', prLinkLabel(entry)), empty);
  }
  const isUser = type === 'user' || role === 'user';
  const isAssistant = type === 'assistant' || role === 'assistant';
  if (!isUser && !isAssistant) return empty;

  // A sidechain entry belongs to a SUBAGENT's thread, not to the pane's
  // conversation. Inlining it would read as if the primary agent had said it,
  // so v1 collapses the whole run to one chip per entry.
  if (entry['isSidechain'] === true) {
    return single(metaEvent(baseId, ts, 'subagent', 'Subagent thread'), empty);
  }

  const content = message?.['content'];
  return isUser
    ? parseUserEntry(entry, content, baseId, ts)
    : parseAssistantEntry(content, baseId, ts, offsetHint);
}

// ---------------------------------------------------------------------------
// user entries
// ---------------------------------------------------------------------------

function parseUserEntry(
  entry: Record<string, unknown>,
  content: unknown,
  baseId: string,
  ts: number | undefined,
): ParsedTranscriptLine {
  const empty: ParsedTranscriptLine = { events: [], bodies: new Map() };

  // `isMeta` entries are Claude Code talking to itself: local-command caveats
  // and slash-command echoes. They are NOT human turns, and rendering them as
  // one would put words in the user's mouth.
  const text = typeof content === 'string' ? content : '';
  const meta = classifyMetaUser(entry, text);
  if (meta) return single(metaEvent(baseId, ts, meta.subtype, meta.label), empty);

  if (typeof content === 'string') {
    const clean = content.trim();
    // Claude Code records tool results as `user` entries too, so "has text" —
    // not "type is user" — is what marks a human turn (the isHumanTurn rule).
    if (!clean) return empty;
    const ev: UserTextEvent = { id: baseId, kind: 'user_text', text: capText(clean), ...tsOf(ts) };
    return single(ev, empty);
  }

  if (!Array.isArray(content)) return empty;

  const out: TurnEvent[] = [];
  const parts: string[] = [];
  let hasImage = false;
  for (const raw of content) {
    const block = asObject(raw);
    const blockType = typeof block?.['type'] === 'string' ? (block['type'] as string) : '';
    if (blockType === 'text') {
      const t = typeof block?.['text'] === 'string' ? (block['text'] as string) : '';
      if (t.trim()) parts.push(t);
    } else if (blockType === 'image') {
      hasImage = true;
    } else if (blockType === 'tool_result') {
      out.push(toolResultEvent(block!, baseId, ts, out.length));
    }
    // Any other block type (including invented ones) is skipped silently — R1.
  }
  const prose = parts.join('\n').trim();
  if (prose || hasImage) {
    const ev: UserTextEvent = {
      id: baseId,
      kind: 'user_text',
      text: capText(prose),
      ...(hasImage ? { hasImage: true } : {}),
      ...tsOf(ts),
    };
    out.push(ev);
  }
  return { events: reid(out, baseId), bodies: new Map() };
}

/**
 * Meta classification for a `user` entry. `isMeta:true` is the authoritative
 * flag, but the same payloads also appear without it, so the content markers
 * are checked independently.
 */
function classifyMetaUser(
  entry: Record<string, unknown>,
  text: string,
): { subtype: MetaEvent['subtype']; label: string } | null {
  const head = text.trimStart();
  const command = /<command-name>([^<]*)<\/command-name>/.exec(head);
  if (command) {
    const name = command[1].trim();
    return { subtype: 'slash_command', label: name || 'slash command' };
  }
  if (head.startsWith('<local-command-caveat>')) {
    return { subtype: 'caveat', label: 'Local command caveat' };
  }
  if (entry['isMeta'] === true) {
    return { subtype: 'caveat', label: 'Session note' };
  }
  return null;
}

function toolResultEvent(
  block: Record<string, unknown>,
  baseId: string,
  ts: number | undefined,
  index: number,
): ToolResultEvent {
  const toolUseId = typeof block['tool_use_id'] === 'string' ? (block['tool_use_id'] as string) : '';
  const body = flattenResultContent(block['content']);
  const ev: ToolResultEvent = {
    id: `${baseId}#${index}`,
    kind: 'tool_result',
    toolUseId,
    ok: block['is_error'] !== true,
    bytes: Buffer.byteLength(body, 'utf8'),
    ...(looksLikeDiff(body) ? { diffLike: true } : {}),
    ...tsOf(ts),
  };
  return ev;
}

/** `tool_result.content` is a string or an array of `{type:'text'}` blocks. */
function flattenResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    const block = asObject(raw);
    if (block?.['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text'] as string);
    }
  }
  return parts.join('\n');
}

/**
 * Does this tool output OPEN as a diff? Deliberately looks only at the first
 * non-empty line: a diff-shaped chunk buried in the middle of a build log is
 * not a diff the user wants routed to the workspace-diff chip.
 */
function looksLikeDiff(body: string): boolean {
  // Bound the scan: only the head matters, and `body` is untrusted in size.
  const head = body.slice(0, 4096);
  for (const line of head.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    return /^diff --git /.test(l) || /^--- /.test(l) || /^@@ .*@@/.test(l);
  }
  return false;
}

// ---------------------------------------------------------------------------
// assistant entries
// ---------------------------------------------------------------------------

function parseAssistantEntry(
  content: unknown,
  baseId: string,
  ts: number | undefined,
  offsetHint: number,
): ParsedTranscriptLine {
  const bodies = new Map<string, Map<number, string>>();

  if (typeof content === 'string') {
    const clean = content.trim();
    if (!clean) return { events: [], bodies };
    return { events: [assistantText(baseId, ts, clean, false, offsetHint, bodies)], bodies };
  }
  if (!Array.isArray(content)) return { events: [], bodies };

  const out: TurnEvent[] = [];
  for (const raw of content) {
    const block = asObject(raw);
    const blockType = typeof block?.['type'] === 'string' ? (block['type'] as string) : '';
    if (blockType === 'text') {
      const t = typeof block?.['text'] === 'string' ? (block['text'] as string).trim() : '';
      if (t) out.push(assistantText(`${baseId}#${out.length}`, ts, t, false, offsetHint, bodies));
    } else if (blockType === 'thinking') {
      // The reasoning text lives in `thinking`; some builds mirror it in `text`.
      const t = typeof block?.['thinking'] === 'string'
        ? (block['thinking'] as string).trim()
        : typeof block?.['text'] === 'string' ? (block['text'] as string).trim() : '';
      if (t) out.push(assistantText(`${baseId}#${out.length}`, ts, t, true, offsetHint, bodies));
    } else if (blockType === 'tool_use') {
      const ev: ToolUseEvent = {
        id: `${baseId}#${out.length}`,
        kind: 'tool_use',
        toolUseId: typeof block?.['id'] === 'string' ? (block['id'] as string) : '',
        name: typeof block?.['name'] === 'string' ? (block['name'] as string) : '',
        // Reuses the Fleet activity-line grammar (`✎ file`, `$ cmd`, `⌕ pat`)
        // so one tool call reads the same wherever wmux shows it. Its own cap
        // (80) is inside this field's documented 120.
        argSummary: summarizeActivity(block?.['name'], block?.['input']),
        ...tsOf(ts),
      };
      out.push(ev);
    }
    // Unknown block types (incl. `image` on an assistant entry) are skipped.
  }
  return { events: reid(out, baseId), bodies: remapBodies(bodies, out, baseId) };
}

function assistantText(
  id: string,
  ts: number | undefined,
  text: string,
  thinking: boolean,
  offsetHint: number,
  bodies: Map<string, Map<number, string>>,
): AssistantTextEvent {
  const extracted = extractCodeBlocks(text, offsetHint);
  if (extracted.bodies.size > 0) bodies.set(id, extracted.bodies);
  return {
    id,
    kind: 'assistant_text',
    text: capText(extracted.text),
    ...(extracted.refs.length > 0 ? { codeBlocks: extracted.refs } : {}),
    ...(thinking ? { thinking: true } : {}),
    ...tsOf(ts),
  };
}

/**
 * Lift fenced code blocks out of prose (G1: a chat row must not open with 40
 * lines of code). The prose keeps a NUL-delimited marker where each block was,
 * the ref carries only `{n, lang, lines, path, srcOffset}`, and the body stays
 * daemon-side until the renderer expands the chip (A3).
 *
 * Fence handling is deliberately simple — matching CommonMark exactly is not
 * the job. An UNCLOSED fence is treated as running to the end of the text,
 * which is what Claude Code's own renderer does with a truncated response.
 */
export function extractCodeBlocks(
  text: string,
  offsetHint: number,
): { text: string; refs: CodeBlockRef[]; bodies: Map<number, string> } {
  const refs: CodeBlockRef[] = [];
  const bodies = new Map<number, string>();
  if (!text.includes('```') && !text.includes('~~~')) {
    return { text, refs, bodies };
  }

  const lines = text.split('\n');
  const out: string[] = [];
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const open = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*(.*)$/.exec(lines[i]);
    if (!open) {
      out.push(lines[i]);
      continue;
    }
    const marker = open[1];
    const info = open[2].trim();
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = new RegExp(`^[ \\t]{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
      if (close.test(lines[j])) break;
      body.push(lines[j]);
    }
    n += 1;
    const { lang, path } = parseFenceInfo(info);
    refs.push({
      n,
      lines: body.length,
      ...(lang ? { lang } : {}),
      ...(path ? { path } : {}),
      srcOffset: offsetHint,
    });
    const joined = body.join('\n');
    bodies.set(n, joined.length > MAX_BODY_CHARS ? joined.slice(0, MAX_BODY_CHARS) : joined);
    out.push(`${CODE_MARKER_PREFIX}${n}${CODE_MARKER_SUFFIX}`);
    i = j; // skip the closing fence (or land past the end for an unclosed one)
  }
  return { text: out.join('\n').trim(), refs, bodies };
}

/**
 * Fence info string → `{lang, path}`. The first token is the language when it
 * looks like one; any later token that looks like a path (a separator or a dot
 * extension) is surfaced so the chip can say WHICH file the block is about.
 */
function parseFenceInfo(info: string): { lang?: string; path?: string } {
  if (!info) return {};
  const tokens = info.split(/\s+/).filter(Boolean);
  let lang: string | undefined;
  let path: string | undefined;
  for (const token of tokens) {
    const value = token.replace(/^(path|title|file)=/, '');
    const isPathish = /[\\/]/.test(value) || /\.[A-Za-z0-9]{1,8}$/.test(value);
    if (!lang && !isPathish && /^[A-Za-z0-9+#._-]{1,20}$/.test(value)) {
      lang = value;
      continue;
    }
    if (!path && isPathish) path = value.slice(0, 200);
  }
  return { ...(lang ? { lang } : {}), ...(path ? { path } : {}) };
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Stable row key. The entry uuid when present; otherwise the byte offset the
 * line was read from, which is equally stable across re-reads (the same line
 * always sits at the same offset until the file is rotated, and a rotation
 * forces a full re-snapshot anyway).
 */
function entryId(entry: Record<string, unknown>, offsetHint: number): string {
  const uuid = entry['uuid'];
  if (typeof uuid === 'string' && uuid) return uuid;
  return `${offsetHint}:0`;
}

function entryTs(entry: Record<string, unknown>): number | undefined {
  const raw = entry['timestamp'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function tsOf(ts: number | undefined): { ts?: number } {
  return ts === undefined ? {} : { ts };
}

function capText(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}

function metaEvent(
  id: string,
  ts: number | undefined,
  subtype: MetaEvent['subtype'],
  label: string,
): MetaEvent {
  return { id, kind: 'meta', subtype, label: label.slice(0, 200), ...tsOf(ts) };
}

function prLinkLabel(entry: Record<string, unknown>): string {
  for (const key of ['url', 'prUrl', 'link']) {
    const value = entry[key];
    if (typeof value === 'string' && value) return value;
  }
  return 'pull request';
}

function single(event: TurnEvent, empty: ParsedTranscriptLine): ParsedTranscriptLine {
  return { events: [event], bodies: empty.bodies };
}

/**
 * A single-event entry keeps the bare uuid as its id (that is what a renderer
 * dedups a re-snapshot on). The `#i` suffix only exists to disambiguate an
 * entry that produced several events.
 */
function reid(events: TurnEvent[], baseId: string): TurnEvent[] {
  if (events.length === 1) events[0].id = baseId;
  return events;
}

/** Follow the `reid` collapse so a body stays reachable by its event's id. */
function remapBodies(
  bodies: Map<string, Map<number, string>>,
  events: TurnEvent[],
  baseId: string,
): Map<string, Map<number, string>> {
  if (events.length !== 1 || bodies.size === 0) return bodies;
  const only = bodies.values().next().value;
  return only ? new Map([[baseId, only]]) : bodies;
}
