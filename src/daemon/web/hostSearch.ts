import crypto from 'node:crypto';
import type { TurnEvent } from '../../shared/transcript/turnEvents';

/**
 * `GET /api/search` — the phone's search across this host's panes (turns,
 * pane metadata and run history, scrollback). Everything here is pure or runs
 * on readers the route injects, so the matching, the bounds and the cursor can
 * be tested without a daemon behind them.
 *
 * Offsets on the wire are UTF-16 code units, because the iOS client slices
 * with NSString ranges; JavaScript string indices are the same unit.
 */

export class SearchError extends Error {
  constructor(public readonly status: number, public readonly tag: string) { super(tag); }
}

export type SearchScope = 'turns' | 'sessions' | 'scrollback';
export type SearchKind = 'turn' | 'session' | 'scrollback';

const SCOPES: readonly SearchScope[] = ['turns', 'sessions', 'scrollback'];
const DEFAULT_SCOPES: readonly SearchScope[] = ['turns', 'sessions'];
/** The scopes that read conversation content and so ride `--allow-transcript`. */
const TRANSCRIPT_SCOPES: ReadonlySet<SearchScope> = new Set<SearchScope>(['turns', 'sessions']);

export const MIN_QUERY_UNITS = 2;
export const MAX_QUERY_UNITS = 200;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
/** Snippet width around the first match, widened only for a longer match. */
export const SNIPPET_UNITS = 160;
const MAX_MATCH_RANGES = 16;
const MAX_CURSOR_CHARS = 1024;
/** Search requests the daemon runs at once; a phone must not be able to saturate it. */
export const MAX_CONCURRENT_SEARCHES = 2;
/** Search requests ONE caller runs at once, so one device cannot hold both daemon-wide slots. */
export const MAX_SEARCHES_PER_CALLER = 1;
/** Searches one caller may start back to back before it has to wait for a token. */
export const SEARCH_BURST = 4;
/** One token comes back every this many ms: a sustained 30 searches a minute per caller. */
export const SEARCH_REFILL_MS = 2000;
/** Scrollback rows one extraction keeps: the `daemon.readSessionText` default. */
export const SCROLLBACK_ROWS = 5000;
/** Panes whose extracted scrollback text stays cached (up to SCROLLBACK_ROWS logical lines each). */
export const SCROLLBACK_CACHE_PANES = 8;
/**
 * Scrollback extractions queued or running at once, daemon-wide, INCLUDING
 * ones whose search already hit its deadline and moved on. They wait on the
 * concurrency-1 snapshot queue that desk attach and resync use, so this caps
 * how long an attach can sit behind searches.
 */
export const MAX_SCROLLBACK_EXTRACTIONS = 2;

export interface SearchLimits {
  /** The newest bytes of ONE transcript a search reads. */
  sessionBytes: number;
  /** Transcript bytes one request reads across every pane. */
  totalBytes: number;
  /** Wall clock for one request. */
  budgetMs: number;
  /** Fresh scrollback extractions one request may queue (cached ones are free). */
  scrollbackPanes: number;
}

/**
 * 4 MiB is sixteen of the projector's 256 KiB pages: the last several hundred
 * turns of a long session, and a few tens of milliseconds of parsing. 24 MiB
 * across a request keeps the worst case (six long sessions) inside the 3 s
 * wall clock with parsing time to spare. Six fresh scrollback extractions is
 * what the concurrency-1 snapshot queue can serve in that time without making
 * a desk attach behind it wait noticeably.
 */
export const SEARCH_LIMITS: SearchLimits = {
  sessionBytes: 4 * 1024 * 1024,
  totalBytes: 24 * 1024 * 1024,
  budgetMs: 3000,
  scrollbackPanes: 6,
};

export interface SearchRequest { query: string; scopes: SearchScope[]; limit: number; cursor: string | null }

/** Validate the query string. Scopes come back deduplicated, in canonical order. */
export function parseSearchRequest(params: URLSearchParams): SearchRequest {
  const query = (params.get('q') ?? '').trim();
  if (query.length < MIN_QUERY_UNITS || query.length > MAX_QUERY_UNITS || query.includes('\0')) {
    throw new SearchError(400, 'invalid-query');
  }
  let scopes = [...DEFAULT_SCOPES];
  const rawScope = params.get('scope');
  if (rawScope !== null) {
    const asked = rawScope.split(',').map((s) => s.trim());
    if (asked.some((s) => !(SCOPES as readonly string[]).includes(s))) throw new SearchError(400, 'invalid-scope');
    scopes = SCOPES.filter((s) => asked.includes(s));
  }
  let limit = DEFAULT_LIMIT;
  const rawLimit = params.get('limit');
  if (rawLimit !== null) {
    limit = /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : 0;
    if (limit < 1 || limit > MAX_LIMIT) throw new SearchError(400, 'invalid-limit');
  }
  const cursor = params.get('cursor');
  return { query, scopes, limit, cursor: cursor === null || cursor === '' ? null : cursor };
}

/** True when every requested scope needs the transcript grant this server lacks. */
export function searchForbidden(scopes: readonly SearchScope[], allowTranscript: boolean): boolean {
  return !allowTranscript && scopes.every((s) => TRANSCRIPT_SCOPES.has(s));
}

const CHANGES_WHEN_LOWERCASED = /\p{CWL}/gu;
/**
 * Lowercase WITHOUT moving a single offset. `toLowerCase` on the whole string
 * turns U+0130 into two code units, which would shift every match after it;
 * folding one character at a time and keeping the few whose lowercase has a
 * different length leaves index i of the result at index i of the input.
 * Locale-independent on purpose: a wire contract cannot depend on the host's
 * locale.
 */
export function foldCase(text: string): string {
  return text.replace(CHANGES_WHEN_LOWERCASED, (ch) => {
    const lower = ch.toLowerCase();
    return lower.length === ch.length ? lower : ch;
  });
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const CODE_MARKER = /\u0000code:\d+\u0000/g;

/** One code unit in, one out: a snippet is one line, and offsets survive. */
export function displayText(text: string): string {
  return text.replace(CONTROL, ' ');
}

/**
 * What of a turn is searched: what the user typed and what the agent answered.
 * Thinking blocks and tool traffic are left out — search finds what was SAID,
 * not every file an agent read. Code-block markers become a space.
 */
export function turnText(event: TurnEvent): string | null {
  if (event.kind === 'user_text') return displayText(event.text);
  if (event.kind === 'assistant_text' && !event.thinking) return displayText(event.text.replace(CODE_MARKER, ' '));
  return null;
}

const highSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const lowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

export interface Snippet { snippet: string; matchRanges: Array<[number, number]> }

/**
 * About SNIPPET_UNITS of `text` around the match at `at`, with every
 * occurrence inside it as `[start, length]` relative to the snippet. `folded`
 * is `foldCase(text)` and `needle` the folded query. An edge never splits a
 * surrogate pair.
 */
export function buildSnippet(text: string, folded: string, needle: string, at: number): Snippet {
  const width = Math.max(SNIPPET_UNITS, needle.length);
  let end = Math.min(text.length, Math.max(0, at - Math.floor((width - needle.length) / 2)) + width);
  let start = Math.max(0, end - width);
  if (start > 0 && lowSurrogate(text.charCodeAt(start))) start -= 1;
  if (end < text.length && highSurrogate(text.charCodeAt(end - 1))) end += 1;
  const window = folded.slice(start, end);
  const matchRanges: Array<[number, number]> = [];
  for (let i = window.indexOf(needle); i !== -1 && matchRanges.length < MAX_MATCH_RANGES; i = window.indexOf(needle, i + needle.length)) {
    matchRanges.push([i, needle.length]);
  }
  return { snippet: text.slice(start, end), matchRanges };
}

/** The title the daemon can compose: "workspace · agent · cwd leaf", missing parts dropped. */
export function composeTitle(parts: { workspace?: string; agent?: string; cwdLeaf?: string }, fallback: string): string {
  const title = [parts.workspace, parts.agent, parts.cwdLeaf].map((p) => p?.trim()).filter(Boolean).join(' · ');
  return title || fallback;
}

/** Headless-terminal rows → logical lines, so a match across a soft wrap is still one match. */
export function joinWrappedRows(rows: ReadonlyArray<{ text: string; wrapped: boolean }>): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.wrapped && lines.length > 0) lines[lines.length - 1] += row.text;
    else lines.push(row.text);
  }
  return lines;
}

/** Extracted scrollback text per pane, valid while its key (incarnation, bytes written, geometry) holds. */
export class ScrollbackTextCache {
  private readonly entries = new Map<string, { key: string; lines: string[] }>();
  constructor(private readonly max = SCROLLBACK_CACHE_PANES) {}
  get(sessionId: string, key: string): string[] | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.key !== key) return undefined;
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
    return entry.lines;
  }
  set(sessionId: string, key: string, lines: string[]): void {
    this.entries.delete(sessionId);
    this.entries.set(sessionId, { key, lines });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.max) break;
      this.entries.delete(oldest);
    }
  }
  /** Forget panes the session manager no longer holds. */
  retain(sessionIds: ReadonlySet<string>): void {
    for (const id of [...this.entries.keys()]) if (!sessionIds.has(id)) this.entries.delete(id);
  }
  get size(): number { return this.entries.size; }
}

/**
 * The scrollback extractions in flight. A pane already being extracted is not
 * queued again: a later search, or a later page, waits on the same promise.
 * An extraction outlives the search that started it (it cannot be pulled off
 * the snapshot queue), so it keeps its slot until it settles; with every slot
 * taken, `run` answers undefined and the pane is skipped rather than queued.
 */
export class ScrollbackExtractions {
  private readonly inFlight = new Map<string, Promise<string[] | null>>();
  constructor(private readonly max = MAX_SCROLLBACK_EXTRACTIONS) {}
  run(sessionId: string, extract: () => Promise<string[] | null>): Promise<string[] | null> | undefined {
    const running = this.inFlight.get(sessionId);
    if (running) return running;
    if (this.inFlight.size >= this.max) return undefined;
    const job: Promise<string[] | null> = Promise.resolve()
      .then(extract)
      .catch(() => null)
      .finally(() => { if (this.inFlight.get(sessionId) === job) this.inFlight.delete(sessionId); });
    this.inFlight.set(sessionId, job);
    return job;
  }
  get size(): number { return this.inFlight.size; }
}

/**
 * Per-caller admission: at most MAX_SEARCHES_PER_CALLER at once, and a token
 * bucket of SEARCH_BURST refilled one token per SEARCH_REFILL_MS. `admit`
 * answers the seconds to wait (Retry-After) when refused; a refusal spends no
 * token. A caller whose bucket is full and who has nothing running is
 * forgotten, so the map holds only callers active in the last few seconds.
 */
export class SearchAdmission {
  private readonly callers = new Map<string, { tokens: number; at: number; running: number }>();
  constructor(
    private readonly now: () => number,
    private readonly burst = SEARCH_BURST,
    private readonly refillMs = SEARCH_REFILL_MS,
    private readonly perCaller = MAX_SEARCHES_PER_CALLER,
  ) {}
  admit(caller: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = this.now();
    const state = this.callers.get(caller) ?? { tokens: this.burst, at: now, running: 0 };
    state.tokens = Math.min(this.burst, state.tokens + Math.max(0, now - state.at) / this.refillMs);
    state.at = now;
    this.callers.set(caller, state);
    if (state.running >= this.perCaller) return { ok: false, retryAfterSec: 1 };
    if (state.tokens < 1) return { ok: false, retryAfterSec: Math.max(1, Math.ceil(((1 - state.tokens) * this.refillMs) / 1000)) };
    state.tokens -= 1;
    state.running += 1;
    return { ok: true };
  }
  /** The admitted search finished. */
  release(caller: string): void {
    const state = this.callers.get(caller);
    if (!state) return;
    state.running = Math.max(0, state.running - 1);
    this.sweep();
  }
  private sweep(): void {
    const now = this.now();
    for (const [caller, state] of this.callers) {
      if (state.running === 0 && state.tokens + (now - state.at) / this.refillMs >= this.burst) this.callers.delete(caller);
    }
  }
  get size(): number { return this.callers.size; }
}

// --- ordering and the cursor ------------------------------------------------

/**
 * Total order of hits: `at` newest first (hits without one after every hit
 * with one), then the pane's creation time (newest first), then a tie-break
 * that is stable across calls. `pos` is the hit's place in its source, newest
 * first. Every part is fixed for the life of a hit, so a cursor means the same
 * place on the next call: ordering by pane activity instead moved every
 * untimed hit of a pane that printed between two pages.
 */
export interface SortKey { at: number | null; order: number; sessionId: string; kind: SearchKind; pos: number; id: string }

/**
 * Where a cursor continues: after `key`. For a scrollback hit, `anchor`
 * fingerprints the hit's line and the two above it. Line numbers shift when the
 * ring evicts old output, so the next page finds the anchor again and
 * renumbers that pane's lines to match before it continues.
 */
export interface SearchAfter { key: SortKey; anchor?: string }

const KIND_RANK: Record<SearchKind, number> = { turn: 0, session: 1, scrollback: 2 };

export function compareKeys(a: SortKey, b: SortKey): number {
  if (a.at !== b.at) {
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return b.at - a.at;
  }
  if (a.order !== b.order) return b.order - a.order;
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
  if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (a.pos !== b.pos) return b.pos - a.pos;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface SearchCursorCodec {
  encode(request: SearchRequest, key: SortKey, anchor?: string): string;
  /** Where to continue, or SearchError 400 `invalid-cursor`. */
  decode(request: SearchRequest, raw: string): SearchAfter;
}

/** Fingerprint of scrollback line `i` and the two above it (fewer at the top). */
export function scrollbackAnchor(lines: readonly string[], i: number): string {
  return crypto.createHash('sha256').update(lines.slice(Math.max(0, i - 2), i + 1).join('\n')).digest('base64url').slice(0, 16);
}

/**
 * Stateless cursor: the last returned hit's sort key, bound to the query and
 * scope set, MACed with a per-server key. A cursor from another query or scope
 * set, an edited one, and one minted before a daemon restart all read as
 * `invalid-cursor`, and the phone starts the search again.
 */
export function createSearchCursorCodec(secret: Buffer): SearchCursorCodec {
  const fingerprint = (request: SearchRequest) =>
    crypto.createHash('sha256').update(`${foldCase(request.query)}\0${request.scopes.join(',')}`).digest('base64url').slice(0, 16);
  const mac = (payload: string) => crypto.createHmac('sha256', secret).update(payload).digest();
  const invalid = () => new SearchError(400, 'invalid-cursor');
  return {
    encode(request, key, anchor) {
      const payload = Buffer.from(JSON.stringify({
        v: 2, f: fingerprint(request), k: [key.at, key.order, key.sessionId, key.kind, key.pos, key.id], a: anchor ?? null,
      })).toString('base64url');
      return `${payload}.${mac(payload).toString('base64url')}`;
    },
    decode(request, raw) {
      if (raw.length > MAX_CURSOR_CHARS) throw invalid();
      const [payload, signature, extra] = raw.split('.');
      if (!payload || !signature || extra !== undefined) throw invalid();
      const given = Buffer.from(signature, 'base64url');
      const expected = mac(payload);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw invalid();
      let o: unknown;
      try { o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw invalid(); }
      const r = o as { v?: unknown; f?: unknown; k?: unknown; a?: unknown };
      if (!r || r.v !== 2 || r.f !== fingerprint(request) || !Array.isArray(r.k) || r.k.length !== 6) throw invalid();
      const [at, order, sessionId, kind, pos, id] = r.k as unknown[];
      if ((at !== null && typeof at !== 'number') || typeof order !== 'number' || typeof sessionId !== 'string' ||
          typeof kind !== 'string' || !Object.hasOwn(KIND_RANK, kind) || typeof pos !== 'number' || typeof id !== 'string' ||
          (r.a !== null && typeof r.a !== 'string')) {
        throw invalid();
      }
      const key: SortKey = { at, order, sessionId, kind: kind as SearchKind, pos, id };
      return typeof r.a === 'string' ? { key, anchor: r.a } : { key };
    },
  };
}

// --- the search -------------------------------------------------------------

/** The line the anchor names, the nearest one at or above `near` first; null when it is gone. */
function findAnchor(lines: readonly string[], anchor: string, near: number): number | null {
  let below: number | null = null;
  for (let i = Math.min(near, lines.length - 1); i >= 0; i--) {
    if (scrollbackAnchor(lines, i) === anchor) return i;
  }
  for (let i = Math.max(0, near + 1); i < lines.length; i++) {
    if (scrollbackAnchor(lines, i) === anchor) { below = i; break; }
  }
  return below;
}

/** A pane as the search sees it. */
export interface SearchPane {
  sessionId: string;
  workspaceId?: string;
  workspace?: string;
  agent?: string;
  cwd?: string;
  cwdLeaf?: string;
  /** The desktop's own tab title, from the cached sidebar snapshot only. */
  surfaceTitle?: string;
  /** False unless attached or detached: a dead-session tombstone, or a suspended pane. */
  alive: boolean;
  /** Epoch ms of last activity: which panes a bounded scan reaches first. */
  recency: number;
  /** Epoch ms the pane was created: orders hits without `at`. Never changes. */
  createdAt: number;
}

export interface HistoryEntry { id: string; sessionId: string; workspace: string; agent: string; at: number; summary: string }

/** One backward page of a transcript: `lineEnds[i]` belongs to `events[i]`. */
export interface TurnPage { events: TurnEvent[]; lineEnds: number[]; bytes: number; done: boolean }

export type TurnSource =
  /** A transcript file read newest page first; `next` answers null when the file became unreadable. */
  | { kind: 'file'; next: () => TurnPage | null | Promise<TurnPage | null>; cursorFor?: (lineEnd: number) => string }
  /** A bounded page the reader already holds (OpenCode, managed chat). */
  | { kind: 'page'; events: TurnEvent[] }
  | { kind: 'skip'; reason: string };

export interface ScrollbackReader {
  /** Lines still current in the cache — free. */
  cached(sessionId: string): string[] | undefined;
  /**
   * Extract now, on the shared snapshot queue; null when the ring cannot be
   * read, `busy` when every daemon-wide extraction slot is taken.
   */
  read(sessionId: string): Promise<string[] | null | 'busy'>;
}

export interface SearchSources {
  /** Panes the turn view may read (brain excluded), for `turns` and `sessions`. */
  panes: SearchPane[];
  /** Panes this caller may attach to, for `scrollback`. */
  scrollbackPanes: SearchPane[];
  allowTranscript: boolean;
  history?: () => HistoryEntry[];
  turns?: (sessionId: string) => Promise<TurnSource>;
  scrollback?: ScrollbackReader;
  now: () => number;
  /** The caller hung up: stop reading. */
  stopped?: () => boolean;
  limits?: SearchLimits;
}

export interface SearchResult {
  kind: SearchKind;
  sessionId: string;
  workspaceId?: string;
  title: string;
  surfaceTitle?: string;
  alive?: boolean;
  snippet: string;
  matchRanges: Array<[number, number]>;
  at?: number;
  turnEventId?: string;
  turnCursor?: string;
}

export interface SkippedSession { sessionId: string; scope: SearchScope; reason: string }

export interface SearchResponse {
  results: SearchResult[];
  coverage: { searchedSessions: number; skippedSessions: SkippedSession[] };
  truncated: boolean;
  nextCursor: string | null;
}

interface Candidate {
  key: SortKey;
  text: string;
  folded: string;
  match: number;
  pane?: SearchPane;
  history?: HistoryEntry;
  turnEventId?: string;
  turnCursor?: () => string | undefined;
  /** Scrollback only: the anchor a cursor after this hit carries. */
  anchor?: () => string;
}

/** Keeps only the best `keep` candidates past the cursor, so a common word costs no snippet per hit. */
class TopHits {
  private items: Candidate[] = [];
  constructor(private readonly keep: number, private readonly after: SortKey | null) {}
  offer(candidate: Candidate): void {
    if (this.after && compareKeys(candidate.key, this.after) <= 0) return;
    this.items.push(candidate);
    if (this.items.length >= this.keep * 4 + 64) this.trim();
  }
  take(): Candidate[] {
    this.trim();
    return this.items;
  }
  private trim(): void {
    this.items.sort((a, b) => compareKeys(a.key, b.key));
    if (this.items.length > this.keep) this.items.length = this.keep;
  }
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** `work`, or `undefined` once `ms` has passed. The work itself is not cancelled. */
async function beforeDeadline<T>(work: Promise<T>, ms: number): Promise<{ value: T } | undefined> {
  if (ms <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.then((value) => ({ value })), late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runSearch(
  request: SearchRequest,
  after: SearchAfter | null,
  sources: SearchSources,
  codec: SearchCursorCodec,
): Promise<SearchResponse> {
  const limits = sources.limits ?? SEARCH_LIMITS;
  const deadline = sources.now() + limits.budgetMs;
  const remaining = () => deadline - sources.now();
  const outOfBudget = () => remaining() <= 0 || sources.stopped?.() === true;
  const needle = foldCase(request.query);
  const hits = new TopHits(request.limit + 1, after?.key ?? null);
  const searched = new Set<string>();
  const skipped: SkippedSession[] = [];
  let truncated = false;
  /**
   * A conversation the clock or the request-wide byte bound left unread: its
   * hits could sit anywhere in the `at` order, including before this page's
   * last hit, so no cursor can promise the next page continues exactly.
   */
  let unpageable = false;
  /** The first place in the order a scrollback pane left unread would occupy; the page ends before it. */
  let pageEnd: SortKey | null = null;
  const skip = (sessionId: string, scope: SearchScope, reason: string) => {
    skipped.push({ sessionId, scope, reason });
    if (reason === 'budget') truncated = true;
  };
  /** Offer `text` if it matches; true when it did. */
  const consider = (text: string, key: SortKey, extra: Omit<Candidate, 'key' | 'text' | 'folded' | 'match'>): boolean => {
    const folded = foldCase(text);
    const match = folded.indexOf(needle);
    if (match !== -1) hits.offer({ key, text, folded, match, ...extra });
    return match !== -1;
  };

  for (const scope of request.scopes) {
    const gated = TRANSCRIPT_SCOPES.has(scope) && !sources.allowTranscript;
    const panes = scope === 'scrollback' ? sources.scrollbackPanes : sources.panes;
    if (gated) {
      for (const pane of panes) skip(pane.sessionId, scope, 'transcript-disabled');
      continue;
    }
    if (scope === 'sessions') {
      for (const pane of panes) {
        searched.add(pane.sessionId);
        const title = composeTitle(pane, pane.sessionId);
        const fields: Array<[string, string | undefined]> = [
          ['title', title], ['surfaceTitle', pane.surfaceTitle], ['agent', pane.agent], ['workspace', pane.workspace], ['cwd', pane.cwd],
        ];
        // One hit per pane: the first field that matches speaks for it.
        for (const [field, value] of fields) {
          if (value && consider(displayText(value), { at: null, order: pane.createdAt, sessionId: pane.sessionId, kind: 'session', pos: 0, id: `pane:${field}` }, { pane })) break;
        }
      }
      let entries: HistoryEntry[] = [];
      try { entries = sources.history?.() ?? []; } catch { entries = []; }
      const byId = new Map(sources.panes.map((p) => [p.sessionId, p]));
      for (const entry of entries) {
        const pane = byId.get(entry.sessionId);
        for (const value of [entry.summary, entry.workspace, entry.agent]) {
          if (consider(displayText(value), { at: entry.at, order: pane?.createdAt ?? entry.at, sessionId: entry.sessionId, kind: 'session', pos: 0, id: `run:${entry.id}` },
            { history: entry, ...(pane ? { pane } : {}) })) break;
        }
      }
      continue;
    }
    if (scope === 'turns') {
      let totalBytes = 0;
      for (const pane of panes) {
        if (outOfBudget() || totalBytes >= limits.totalBytes) { skip(pane.sessionId, scope, 'budget'); unpageable = true; continue; }
        if (!sources.turns) { skip(pane.sessionId, scope, 'unavailable'); continue; }
        const resolved = await beforeDeadline(
          sources.turns(pane.sessionId).catch((): TurnSource => ({ kind: 'skip', reason: 'unreadable' })),
          remaining(),
        );
        if (!resolved) { skip(pane.sessionId, scope, 'budget'); unpageable = true; continue; }
        const source = resolved.value;
        if (source.kind === 'skip') { skip(pane.sessionId, scope, source.reason); continue; }
        const offerTurn = (event: TurnEvent, pos: number, cursor?: () => string | undefined) => {
          const text = turnText(event);
          if (text === null) return;
          consider(text, { at: typeof event.ts === 'number' ? event.ts : null, order: pane.createdAt, sessionId: pane.sessionId, kind: 'turn', pos, id: event.id },
            { pane, turnEventId: event.id, ...(cursor ? { turnCursor: cursor } : {}) });
        };
        if (source.kind === 'page') {
          searched.add(pane.sessionId);
          source.events.forEach((event, i) => offerTurn(event, i));
          continue;
        }
        let read = 0;
        let complete = false;
        let failed = false;
        for (let first = true; ; first = false) {
          if (!first) {
            await yieldToLoop();
            // The per-session window cuts a transcript at the same place on
            // every page; the clock and the request-wide bytes do not.
            if (outOfBudget() || totalBytes >= limits.totalBytes) { unpageable = true; break; }
            if (read >= limits.sessionBytes) break;
          }
          let page: TurnPage | null;
          try { page = await source.next(); } catch { page = null; }
          if (!page) { failed = true; break; }
          read += page.bytes;
          totalBytes += page.bytes;
          const cursorFor = source.cursorFor;
          page.events.forEach((event, i) => {
            const lineEnd = page.lineEnds[i];
            offerTurn(event, lineEnd ?? 0, cursorFor && lineEnd !== undefined ? () => cursorFor(lineEnd) : undefined);
          });
          if (page.done) { complete = true; break; }
        }
        if (read > 0) searched.add(pane.sessionId);
        // A file that failed partway keeps the hits it gave.
        if (failed) skip(pane.sessionId, scope, 'unreadable');
        else if (!complete) skip(pane.sessionId, scope, 'budget');
      }
      continue;
    }
    // scrollback — cached panes first, then fresh reads in recency order. A
    // fresh read fills the LRU cache and evicts its oldest entry; reading in
    // plain recency order made that the very pane the scan was about to reach,
    // so a host with a few more panes than the cache holds came back truncated
    // on every other search while nothing changed. Hits are sorted afterwards,
    // so the order panes are visited in does not reach the response.
    //
    // Every hit of a pane's scrollback sorts in one block (no `at`, the pane's
    // creation time, its id). A pane whose block lies wholly before the cursor
    // was served by an earlier page and is not read again.
    const blockEdge = (pane: SearchPane, pos: number): SortKey =>
      ({ at: null, order: pane.createdAt, sessionId: pane.sessionId, kind: 'scrollback', pos, id: '' });
    const behindCursor = (pane: SearchPane) => after !== null && compareKeys(blockEdge(pane, -Infinity), after.key) <= 0;
    /** An unread pane ends the page before its block, so the next page reads it instead of stepping past it. */
    const unread = (pane: SearchPane) => {
      skip(pane.sessionId, scope, 'budget');
      const start = blockEdge(pane, Infinity);
      if (pageEnd === null || compareKeys(start, pageEnd) < 0) pageEnd = start;
    };
    const ahead = panes.filter((p) => !behindCursor(p));
    const cachedLines = new Map<string, string[]>();
    if (sources.scrollback) {
      for (const pane of ahead) {
        const lines = sources.scrollback.cached(pane.sessionId);
        if (lines) cachedLines.set(pane.sessionId, lines);
      }
    }
    const visitOrder = [...ahead.filter((p) => cachedLines.has(p.sessionId)), ...ahead.filter((p) => !cachedLines.has(p.sessionId))];
    let fresh = 0;
    for (const pane of visitOrder) {
      if (sources.stopped?.() === true) { unread(pane); continue; }
      if (!sources.scrollback) { skip(pane.sessionId, scope, 'unavailable'); continue; }
      let lines = cachedLines.get(pane.sessionId) ?? sources.scrollback.cached(pane.sessionId);
      if (!lines) {
        if (outOfBudget() || fresh >= limits.scrollbackPanes) { unread(pane); continue; }
        fresh += 1;
        // A late extraction is not cancelled — it cannot be, it is queued
        // behind attach snapshots — but it keeps its daemon-wide slot, still
        // fills the cache for the next search, and this one moves on.
        const read = await beforeDeadline(sources.scrollback.read(pane.sessionId).catch(() => null), remaining());
        if (!read || read.value === 'busy') { unread(pane); continue; }
        if (!read.value) { skip(pane.sessionId, scope, 'unavailable'); continue; }
        lines = read.value;
      }
      const text = lines;
      // Line numbers shift when the ring evicts old output. On the cursor's
      // own pane, find the cursor's line again and renumber to match; when it
      // has left the ring, so has everything older, and nothing is left here.
      let shift = 0;
      if (after?.key.kind === 'scrollback' && after.key.at === null && after.key.sessionId === pane.sessionId && after.anchor !== undefined) {
        const found = findAnchor(text, after.anchor, after.key.pos);
        if (found === null) { searched.add(pane.sessionId); continue; }
        shift = after.key.pos - found;
      }
      searched.add(pane.sessionId);
      text.forEach((line, i) => {
        const pos = i + shift;
        consider(displayText(line), { at: null, order: pane.createdAt, sessionId: pane.sessionId, kind: 'scrollback', pos, id: String(pos) },
          { pane, anchor: () => scrollbackAnchor(text, i) });
      });
    }
  }

  const end: SortKey | null = pageEnd;
  const kept = end === null ? hits.take() : hits.take().filter((hit) => compareKeys(hit.key, end) < 0);
  const page = kept.slice(0, request.limit);
  const last = page[page.length - 1];
  const more = kept.length > request.limit || end !== null;
  return {
    results: page.map(toResult),
    coverage: { searchedSessions: searched.size, skippedSessions: skipped },
    truncated,
    nextCursor: more && last && !unpageable ? codec.encode(request, last.key, last.anchor?.()) : null,
  };

  function toResult(hit: Candidate): SearchResult {
    const { snippet, matchRanges } = buildSnippet(hit.text, hit.folded, needle, hit.match);
    const pane = hit.pane;
    const history = hit.history;
    const title = pane
      ? composeTitle(pane, pane.sessionId)
      : composeTitle({ workspace: history?.workspace, agent: history?.agent }, hit.key.sessionId);
    const turnCursor = hit.turnCursor?.();
    return {
      kind: hit.key.kind,
      sessionId: hit.key.sessionId,
      ...(pane?.workspaceId ? { workspaceId: pane.workspaceId } : {}),
      title,
      ...(pane?.surfaceTitle ? { surfaceTitle: pane.surfaceTitle } : {}),
      ...(pane ? { alive: pane.alive } : {}),
      snippet,
      matchRanges,
      ...(hit.key.at !== null ? { at: hit.key.at } : {}),
      ...(hit.turnEventId !== undefined ? { turnEventId: hit.turnEventId } : {}),
      ...(turnCursor ? { turnCursor } : {}),
    };
  }
}
