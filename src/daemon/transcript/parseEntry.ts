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
  ToolBody,
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
const NUL = '\u0000';
export const CODE_MARKER_PREFIX = `${NUL}code:`;
export const CODE_MARKER_SUFFIX = NUL;

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
    ? parseUserEntry(entry, content, baseId, ts, offsetHint)
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
  offsetHint: number,
): ParsedTranscriptLine {
  const empty: ParsedTranscriptLine = { events: [], bodies: new Map() };

  if (typeof content === 'string') {
    const meta = classifyMetaUser(entry, content);
    if (meta) return single(metaEvent(baseId, ts, meta.subtype, meta.label), empty);
    const clean = stripSystemReminders(content);
    // Claude Code records tool results as `user` entries too, so "has text" —
    // not "type is user" — is what marks a human turn (the isHumanTurn rule).
    if (!clean) {
      // The whole message WAS the injected reminder. An empty `user_text` would
      // render as a blank "You" card, so it degrades to a quiet meta row.
      return content.trim()
        ? single(metaEvent(baseId, ts, 'system_reminder', 'System reminder'), empty)
        : empty;
    }
    const ev: UserTextEvent = { id: baseId, kind: 'user_text', text: capText(stripNul(clean)), ...tsOf(ts) };
    return single(ev, empty);
  }

  if (!Array.isArray(content)) return empty;

  const out: TurnEvent[] = [];
  const parts: string[] = [];
  const bodies = new Map<string, Map<number, string>>();
  // One entry is one frame; the budget is spent across every body it carries.
  const budget = { remaining: INLINE_ENTRY_MAX_BYTES };
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
      out.push(toolResultEvent(block!, baseId, ts, out.length, offsetHint, bodies, budget));
    }
    // Any other block type (including invented ones) is skipped silently — R1.
  }
  const prose = parts.join('\n').trim();
  // Only classify when there IS prose: a bare tool-result entry keeps its
  // previous shape (results only, no chip) even if it carries `isMeta`.
  const meta = prose ? classifyMetaUser(entry, prose) : null;
  if (meta) {
    out.push(metaEvent(`${baseId}#${out.length}`, ts, meta.subtype, meta.label));
  } else {
    const clean = stripSystemReminders(prose);
    if (clean || hasImage) {
      const ev: UserTextEvent = {
        id: baseId,
        kind: 'user_text',
        text: capText(stripNul(clean)),
        ...(hasImage ? { hasImage: true } : {}),
        ...tsOf(ts),
      };
      out.push(ev);
    } else if (prose) {
      out.push(metaEvent(`${baseId}#${out.length}`, ts, 'system_reminder', 'System reminder'));
    }
  }
  const events = reid(out, baseId);
  return { events, bodies: remapBodies(bodies, out, baseId) };
}

/**
 * Claude Code injects machinery into `role:'user'` transcript entries, so a
 * user entry is only a HUMAN turn once these are excluded. Matching is an
 * explicit allowlist of known tags rather than "opens with any `<tag>`": a
 * person can legitimately paste XML or start a message with `<div>`, and
 * stealing those turns would be a worse misattribution than the one this
 * table fixes.
 *
 * Measured over the six most recent transcripts on a dogfood machine
 * (103 non-meta user entries carrying text): 64 real prose, 26
 * `task-notification`, 7 `command-name`, 3 `local-command-stdout`, 3
 * `command-message` — roughly a third of the "You" rows were not the user.
 */
const INJECTED_USER_TAGS: ReadonlyArray<{
  tag: string;
  subtype: MetaEvent['subtype'];
  label: string;
}> = [
  // Subagent-completion payload (`<task-id>`, `<output-file>`, `<status>`,
  // `<result>`). Kept as a VISIBLE row rather than dropped: the operator does
  // care that a subagent returned — the agent's next moves only make sense
  // with it — they just must not see it as their own message.
  { tag: 'task-notification', subtype: 'subagent', label: 'Subagent finished' },
  { tag: 'command-name', subtype: 'slash_command', label: 'slash command' },
  { tag: 'command-message', subtype: 'slash_command', label: 'slash command' },
  { tag: 'command-args', subtype: 'slash_command', label: 'slash command args' },
  { tag: 'local-command-stdout', subtype: 'command_output', label: 'Local command output' },
  { tag: 'local-command-caveat', subtype: 'caveat', label: 'Local command caveat' },
  { tag: 'system-reminder', subtype: 'system_reminder', label: 'System reminder' },
];

/** Contents of the first `<tag>…</tag>`, or '' — used only for meta labels. */
function innerTag(text: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match ? match[1].trim() : '';
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
  // Leading whitespace only — the tag must OPEN the entry. A reminder appended
  // to a real message is stripped by `stripSystemReminders` instead, so the
  // human's own words still render.
  const head = text.trimStart();
  for (const known of INJECTED_USER_TAGS) {
    if (!head.startsWith(`<${known.tag}>`)) continue;
    return { subtype: known.subtype, label: injectedLabel(head, known.tag) || known.label };
  }
  if (entry['isMeta'] === true) {
    return { subtype: 'caveat', label: 'Session note' };
  }
  return null;
}

/** A more specific label than the tag's default, when the payload carries one. */
function injectedLabel(head: string, tag: string): string {
  if (tag === 'task-notification') {
    // `<summary>` reads as `Agent "X" finished`, which is exactly the row.
    return innerTag(head, 'summary');
  }
  if (tag === 'command-name' || tag === 'command-message') {
    return innerTag(head, tag);
  }
  return '';
}

/**
 * Drop `<system-reminder>` blocks appended to an otherwise real user message.
 * The human's words must render; the reminder must not. Returns the trimmed
 * remainder, which the caller treats as "no human content" when empty.
 *
 * An UNCLOSED reminder is left alone on purpose — the parser would otherwise
 * have to guess where it ends and could swallow real prose.
 */
function stripSystemReminders(text: string): string {
  if (!text.includes('<system-reminder>')) return text.trim();
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

function toolResultEvent(
  block: Record<string, unknown>,
  baseId: string,
  ts: number | undefined,
  index: number,
  offsetHint: number,
  bodies: Map<string, Map<number, string>>,
  budget: { remaining: number },
): ToolResultEvent {
  const toolUseId = typeof block['tool_use_id'] === 'string' ? (block['tool_use_id'] as string) : '';
  const body = flattenResultContent(block['content']);
  const id = `${baseId}#${index}`;
  const ev: ToolResultEvent = {
    id,
    kind: 'tool_result',
    toolUseId,
    ok: block['is_error'] !== true,
    bytes: Buffer.byteLength(body, 'utf8'),
    ...(looksLikeDiff(body) ? { diffLike: true } : {}),
    // A diff-shaped result already renders as its own chip, so carrying the
    // body twice would pay the inline budget for something the reader is not
    // going to read here.
    ...(looksLikeDiff(body)
      ? {}
      : withBody('output', registerToolBody(id, unwrapToolError(body), offsetHint, bodies, budget))),
    ...tsOf(ts),
  };
  return ev;
}

/**
 * `<tool_use_error>…</tool_use_error>` is a wrapper Claude Code puts around a
 * failed tool's output. `is_error` already carries the fact, so the tags are
 * noise in the body — and left in, they read as if the tool itself printed
 * them. Borrowed from claude-replay's transcript reader, which strips the same
 * wrapper for the same reason.
 */
function unwrapToolError(body: string): string {
  const m = /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/.exec(body.trim());
  return m ? m[1] : body;
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
  // One entry is one frame; the budget is spent across every body it carries.
  const budget = { remaining: INLINE_ENTRY_MAX_BYTES };

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
      const id = `${baseId}#${out.length}`;
      const ev: ToolUseEvent = {
        id,
        kind: 'tool_use',
        toolUseId: typeof block?.['id'] === 'string' ? (block['id'] as string) : '',
        name: typeof block?.['name'] === 'string' ? (block['name'] as string) : '',
        // Reuses the Fleet activity-line grammar (`✎ file`, `$ cmd`, `⌕ pat`)
        // so one tool call reads the same wherever wmux shows it. Its own cap
        // (80) is inside this field's documented 120.
        argSummary: summarizeActivity(block?.['name'], block?.['input']),
        // The summary says WHICH tool ran; this says what it was actually
        // given. Kept as the rendered JSON rather than the raw object so the
        // body table stays `string` for every producer and the on-expand fetch
        // has one shape to answer with.
        ...withBody('input', registerToolBody(id, toolInputText(block?.['input']), offsetHint, bodies, budget)),
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
  raw: string,
  offsetHint: number,
): { text: string; refs: CodeBlockRef[]; bodies: Map<number, string> } {
  const refs: CodeBlockRef[] = [];
  const bodies = new Map<number, string>();
  // The marker's safety rests entirely on NUL not occurring in prose. Prose is
  // assistant-authored, so "cannot occur" is a claim about an untrusted string:
  // a response containing a literal NUL could otherwise forge a marker (making
  // arbitrary prose render as somebody else's code chip) or split one the parser
  // wrote. Strip it FIRST, so every NUL downstream is one this function put
  // there.
  const text = stripNul(raw);
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
    const joined = body.join('\n');
    // `lines` describes the WHOLE block, so a body cut at the cap would render
    // as if it were complete and be copied out of the chip that way. The ref
    // carries the fact.
    const truncated = joined.length > MAX_BODY_CHARS;
    refs.push({
      n,
      lines: body.length,
      ...(lang ? { lang } : {}),
      ...(path ? { path } : {}),
      srcOffset: offsetHint,
      ...(truncated ? { truncated: true } : {}),
    });
    bodies.set(n, truncated ? joined.slice(0, MAX_BODY_CHARS) : joined);
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

/** Remove NUL from untrusted prose. See the note in `extractCodeBlocks`. */
function stripNul(text: string): string {
  return text.includes(NUL) ? text.split(NUL).join('') : text;
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
/**
 * How much of a tool body rides inline on the event instead of waiting for an
 * on-expand fetch.
 *
 * Sized from a measured session: median tool output ~300 B, p90 ~2.5 KB, p99
 * ~9.5 KB. 4 KB therefore renders about nine calls in ten with no click, which
 * is the difference between reading a pane as a conversation and clicking
 * through it. It is also 0.4% of main's 1 MB control-pipe frame cap — and that
 * cap matters because overflowing it CLEARS the whole buffer silently, taking
 * unrelated in-flight events with it (DaemonClient.ts). So this number is a
 * safety bound, not a display preference.
 */
export const INLINE_BODY_MAX_BYTES = 4 * 1024;

/**
 * How much inline body ONE transcript entry may carry in total.
 *
 * The per-body cap alone does not bound a frame. A single assistant line holds
 * every parallel `tool_use` in that turn, and a single user line holds every
 * matching `tool_result` — a fan-out of 32 tools at 4 KB each is 128 KB from
 * one line, which is the projector's whole per-page budget (BUDGET_BYTES).
 *
 * That failure is worse than a big frame. `TranscriptProjector` fits a page by
 * reading LESS, and one JSONL line cannot be split — so an entry that busts the
 * budget on its own is skipped entirely and the turn vanishes from the
 * conversation with nothing said. Bodies past this budget therefore degrade to
 * head + fetch, which is the same thing an over-cap body already does and is
 * visible to the reader.
 *
 * Sized well under BUDGET_BYTES so the ids, names and summaries riding
 * alongside still fit.
 */
export const INLINE_ENTRY_MAX_BYTES = 32 * 1024;

/**
 * Ceiling on the body kept in the side table for an on-expand fetch.
 *
 * Counted in BYTES, unlike the code-block ceiling next to it: a tool body is
 * arbitrary program output, so a character-counted cut can land between a
 * surrogate pair and hand the reader a lone half of an emoji. Matches the
 * code-block ceiling in magnitude so one expand costs about the same either
 * way.
 */
const MAX_BODY_BYTES = 256 * 1024;

/** JSON the tool's input, or '' when there is nothing to show. */
function toolInputText(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    const json = JSON.stringify(input, null, 2);
    return typeof json === 'string' ? json : '';
  } catch {
    // Circular or otherwise unserializable — the summary line still stands.
    return '';
  }
}

/**
 * Truncate to a BYTE budget without splitting a UTF-8 character.
 *
 * `slice()` counts UTF-16 code units, so a byte cap applied that way can cut a
 * multi-byte character in half and produce a replacement char — visible as
 * mojibake on exactly the CJK and emoji output this project sees constantly.
 */
function sliceToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // Walk back off any continuation byte (10xxxxxx) to a character boundary.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Put one tool body in the side table and describe it for the wire.
 *
 * The full body always goes to `bodies` — that is what the on-expand fetch
 * re-derives and what keeps a large output reachable. Only the inline copy is
 * capped.
 */
function registerToolBody(
  eventId: string,
  text: string,
  offsetHint: number,
  bodies: Map<string, Map<number, string>>,
  budget: { remaining: number },
): ToolBody | undefined {
  if (!text) return undefined;
  const stored = sliceToBytes(text, MAX_BODY_BYTES);
  const existing = bodies.get(eventId) ?? new Map<number, string>();
  existing.set(1, stored);
  bodies.set(eventId, existing);

  const bytes = Buffer.byteLength(text, 'utf8');
  // The per-body cap AND what this entry has already spent. Later bodies in a
  // wide fan-out degrade to fetch rather than pushing the entry past the page
  // budget, where it would be dropped whole and silently.
  const allowance = Math.min(INLINE_BODY_MAX_BYTES, Math.max(0, budget.remaining));
  const inline = sliceToBytes(stored, allowance);
  const inlineBytes = Buffer.byteLength(inline, 'utf8');
  budget.remaining -= inlineBytes;
  // Truncated when the reader is not being shown all of it — either because
  // the body itself is over the cap, or because MAX_BODY_BYTES cut the stored
  // copy so even a fetch cannot return the whole thing.
  const truncated = inlineBytes < bytes;
  return {
    n: 1,
    bytes,
    ...(inline ? { inline } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(offsetHint >= 0 ? { srcOffset: offsetHint } : {}),
  };
}

/** Spread helper so an absent body adds no key at all. */
function withBody<K extends 'input' | 'output'>(
  key: K,
  body: ToolBody | undefined,
): Record<string, ToolBody> {
  return body ? ({ [key]: body } as Record<string, ToolBody>) : {};
}

function remapBodies(
  bodies: Map<string, Map<number, string>>,
  events: TurnEvent[],
  baseId: string,
): Map<string, Map<number, string>> {
  if (events.length !== 1 || bodies.size === 0) return bodies;
  const only = bodies.values().next().value;
  return only ? new Map([[baseId, only]]) : bodies;
}
