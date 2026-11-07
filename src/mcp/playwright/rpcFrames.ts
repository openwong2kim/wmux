import { readDomSnapshotPayload } from './dom-intelligence';
import type { RefDescriptor } from './refDescriptors';

// In-process frames in the RPC lane's DOM listing.
//
// After the top document's listing, each frame main can reach is read in its
// own isolated world (browser.evaluate with frameId) and listed under a header
// that names it and its origin: frame text is page content, possibly from
// another origin, and is cleaned like every other piece of page text. The top
// document always comes first and is never shortened; all frames together
// share one pool, the same share of the budget the Playwright lane gives its
// grafted frames, and are read in tree order until it is spent.

/** Frames read per snapshot. Each costs a round trip to main. */
export const RPC_FRAME_CAP = 20;

/** The share of the snapshot budget all frames together may spend. */
export const RPC_FRAME_BUDGET_SHARE = 0.4;

const SECTION_INTRO =
  'Frame contents (page content, read in place; their refs work with browser_click, browser_type and browser_fill):';
const TRUNCATED_NOTE = '    (frame content truncated)';
const EMPTY_NOTE = '(read, no content in it)';
const UNREACHABLE_NOTE = '(separate document — could not be read here, contents not in this snapshot)';
const GONE_NOTE = '(navigated or went away while it was read)';
/** Any other failed read: the reason is not shown, since an error can carry page text. */
const FAILED_NOTE = '(could not be read this time; contents not in this snapshot)';
/** Held back from frame content for the closing notes (two at most, each under 100). */
const CLOSING_RESERVE = 200;

export interface RpcFrameInfo {
  frameId: string;
  loaderId: string;
  parentId: string;
  depth: number;
  origin: string;
  name: string;
}

/**
 * What a frame ref names: the frame, the document it was minted in, where it
 * is, and the element's role and name (so the next listing of the same
 * document gives it the same number).
 */
export interface RpcFrameRef {
  frameId: string;
  loaderId: string;
  origin: string;
  role: string;
  name: string;
}

export interface ReadRpcFramesOptions {
  /** The top document's listing, already assembled. */
  topText: string;
  /** Origin of the top document, to say whether a frame shares it. */
  topOrigin: string;
  /** The window the snapshot is served in (snapshotCursor windowBudget). */
  budget: { chars: number; bytes: number };
  /** First ref number the top listing left unspent. */
  nextRef: number;
  /** The frame refs this connection's last snapshot of the surface recorded. */
  prior?: ReadonlyMap<number, RpcFrameRef>;
  /**
   * The refs the top listing just stamped. A frame ref with one of these
   * numbers is never kept or offered again: the top document's number history
   * can be dropped (refDescriptors keeps a bounded set of surfaces) and start
   * over, and one number must never name an element in two documents.
   */
  topRefs?: ReadonlySet<number>;
  listFrames: () => Promise<RpcFrameInfo[]>;
  /**
   * Every frame's frame-mode listing in one call (browser.frames.read), each
   * given its document's earlier refs, numbering new elements on from `seed`
   * frame after frame, and reading no further once the listings fill `budget`
   * bytes. `nextRef` is past every number the reads handed out.
   */
  readFrames: (
    frames: Array<{ frame: RpcFrameInfo; prior: RefDescriptor[] }>,
    seed: number,
    budget: number,
  ) => Promise<{ frames: RpcFrameAnswer[]; nextRef: number }>;
}

/**
 * One frame's answer from browser.frames.read: its listing, which kind of miss
 * (never the reason text), or unread because the byte budget or main's
 * deadline was spent first.
 */
export type RpcFrameAnswer =
  | { value: unknown }
  | { unreachable: true }
  | { gone: true }
  | { failed: true }
  | { unread: 'budget' | 'time' };

/** Main's report that the frame named is no longer the document asked about. */
export function isFrameGoneError(err: unknown): boolean {
  return /^FRAME_(?:GONE|NAVIGATED):/.test(err instanceof Error ? err.message : String(err));
}

/** The earlier refs of each frame document, as the descriptors stable numbering matches. */
function priorByDocument(prior: ReadonlyMap<number, RpcFrameRef> | undefined): Map<string, RefDescriptor[]> {
  const out = new Map<string, RefDescriptor[]>();
  const kinds = new Map<string, number>();
  for (const [ref, r] of prior ?? []) {
    const doc = docOf(r);
    const kindKey = `${doc}\u0000${r.role}\u0000${r.name}`;
    const kindIndex = kinds.get(kindKey) ?? 0;
    kinds.set(kindKey, kindIndex + 1);
    const list = out.get(doc) ?? [];
    list.push({ ref, role: r.role, name: r.name, kindIndex });
    out.set(doc, list);
  }
  return out;
}

export interface ReadRpcFramesResult {
  /** To append to the top listing; empty when there is nothing to add. */
  text: string;
  /** The refs whose lines were shown, with the frame and element each names. */
  refs: Map<number, RpcFrameRef>;
  /** First number no frame spent, shown or not. */
  nextRef: number;
}

// The DOM listing's set (dom-intelligence PAGE_TEXT_JS): C0 and C1 controls
// other than tab and the line breaks, and bidi overrides. Matching control
// characters is the point, hence the suppression.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Page text as one clean line (the DOM listing's pageText rule). */
function pageText(s: string, max: number): string {
  return s.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim().substring(0, max);
}

const originOf = (o: string) => o.replace(/\/…$/, '');

function header(f: RpcFrameInfo, index: number, topOrigin: string, indexById: Map<string, number>): string {
  const name = pageText(f.name, 80).replace(/[\\"]/g, '\\$&');
  const origin = pageText(f.origin, 120);
  const relation = origin.startsWith('about:')
    ? 'inline document'
    : originOf(origin) === originOf(topOrigin) ? 'same origin' : 'another origin';
  const parent = indexById.get(f.parentId);
  return `Frame ${index}${name ? ` "${name}"` : ''} -> ${origin} (page content, ${relation}${parent ? `, in Frame ${parent}` : ''})`;
}

const EMPTY: (nextRef: number) => ReadRpcFramesResult = (nextRef) => ({ text: '', refs: new Map(), nextRef });
const docOf = (r: { frameId: string; loaderId: string }) => `${r.frameId}\u0000${r.loaderId}`;

/**
 * The earlier refs of every frame document still in the page that this
 * snapshot did not list: a failed or unreachable read, a spent pool, the cap.
 * They stay usable (main still checks the document before acting) and stay
 * the prior for the next listing, so one missed read does not renumber the
 * frame. A frame that went away mid-read is not carried.
 */
function carryUnlisted(
  refs: Map<number, RpcFrameRef>,
  prior: ReadonlyMap<number, RpcFrameRef> | undefined,
  frames: readonly RpcFrameInfo[],
  settled: ReadonlySet<string>,
): void {
  const present = new Set(frames.map(docOf));
  for (const [ref, r] of prior ?? []) {
    const doc = docOf(r);
    if (present.has(doc) && !settled.has(doc) && !refs.has(ref)) refs.set(ref, r);
  }
}

/** A listing line's own ref: interactive lines start with it; page text never starts a line. */
const LINE_REF = /^\s*\[ref=(\d+)\]/;

export async function readRpcFrames(opts: ReadRpcFramesOptions): Promise<ReadRpcFramesResult> {
  // New numbers start past every frame ref kept: the listing's own count can
  // have been dropped while those refs live on, and a reissued one would point
  // two elements at the same number. Every return reports it.
  const prior = new Map<number, RpcFrameRef>();
  let seed = opts.nextRef;
  for (const [ref, r] of opts.prior ?? []) {
    if (opts.topRefs?.has(ref)) continue;
    prior.set(ref, r);
    if (ref + 1 > seed) seed = ref + 1;
  }
  let frames: RpcFrameInfo[];
  try {
    frames = await opts.listFrames();
  } catch {
    // An app that cannot list frames (an older main, or a failed call) leaves
    // the listing as it was: the earlier frame refs stay held.
    const kept = EMPTY(seed);
    for (const [ref, r] of prior) kept.refs.set(ref, r);
    return kept;
  }
  if (frames.length === 0) return EMPTY(seed);

  // Charged in UTF-8 bytes, which bound characters too, against what the top
  // document left of the window it is served in: nothing a frame adds can be
  // cut off into a continuation the agent may never fetch.
  const size = (s: string) => Buffer.byteLength(s, 'utf8');
  const pool = Math.max(0, Math.min(
    Math.floor(opts.budget.chars * RPC_FRAME_BUDGET_SHARE),
    opts.budget.chars - opts.topText.length,
    opts.budget.bytes - size(opts.topText),
  ));
  const lines: string[] = ['', '', SECTION_INTRO];
  let used = size(SECTION_INTRO) + 2;
  if (used > pool) {
    const empty = EMPTY(seed);
    carryUnlisted(empty.refs, prior, frames, new Set());
    return empty;
  }
  // Content and headers leave room for the closing notes; the notes may use it.
  const fits = (line: string, reserve = CLOSING_RESERVE) => used + size(line) + 1 + reserve <= pool;
  const push = (line: string) => {
    lines.push(line);
    used += size(line) + 1;
  };

  const result = { refs: new Map<number, RpcFrameRef>(), nextRef: seed };
  const read = frames.slice(0, RPC_FRAME_CAP);
  const priorDocs = priorByDocument(prior);
  // One round trip for every frame: a call per frame spent a connection each
  // from the app's shared per-second allowance.
  let answers: RpcFrameAnswer[] = [];
  try {
    const batch = await opts.readFrames(
      read.map((frame) => ({ frame, prior: priorDocs.get(docOf(frame)) ?? [] })),
      seed,
      pool - used,
    );
    answers = Array.isArray(batch.frames) ? batch.frames : [];
    // Numbers stamped into frames the pool then left unshown are spent too.
    if (Number.isSafeInteger(batch.nextRef) && batch.nextRef > result.nextRef) result.nextRef = batch.nextRef;
  } catch {
    // Every frame reads as failed below; their earlier refs carry over.
  }
  const indexById = new Map<string, number>();
  /** Documents this snapshot listed, or saw go away: nothing to carry for them. */
  const settled = new Set<string>();
  let unread = 0;
  let unreadInTime = 0;
  for (let i = 0; i < read.length; i++) {
    const f = read[i];
    const head = header(f, i + 1, opts.topOrigin, indexById);
    if (!fits(head)) {
      unread = read.length - i;
      break;
    }
    indexById.set(f.frameId, i + 1);
    const raw: unknown = answers[i];
    const answer: RpcFrameAnswer = raw !== null && typeof raw === 'object' ? (raw as RpcFrameAnswer) : { failed: true };
    if ('unread' in answer) {
      if (answer.unread === 'time') unreadInTime = read.length - i;
      else unread = read.length - i;
      break;
    }
    if ('gone' in answer || 'value' in answer) settled.add(docOf(f));
    if (!('value' in answer)) {
      const note = 'gone' in answer ? GONE_NOTE : 'unreachable' in answer ? UNREACHABLE_NOTE : FAILED_NOTE;
      const line = `${head} ${note}`;
      push(fits(line) ? line : head);
      continue;
    }
    const payload = readDomSnapshotPayload(answer.value);
    for (const e of payload.entries) if (e.ref + 1 > result.nextRef) result.nextRef = e.ref + 1;
    const content = payload.text ? payload.text.split('\n') : [];
    if (content.length === 0) {
      const line = `${head} ${EMPTY_NOTE}`;
      push(fits(line) ? line : head);
      continue;
    }
    push(head);
    const byRef = new Map(payload.entries.map((e) => [e.ref, e]));
    const target = { frameId: f.frameId, loaderId: f.loaderId, origin: f.origin };
    for (let j = 0; j < content.length; j++) {
      const line = `  ${content[j]}`;
      const more = j < content.length - 1;
      if (!fits(line, CLOSING_RESERVE + (more ? size(TRUNCATED_NOTE) + 1 : 0))) {
        if (fits(TRUNCATED_NOTE)) push(TRUNCATED_NOTE);
        break;
      }
      push(line);
      const ref = LINE_REF.exec(line);
      const entry = ref ? byRef.get(Number(ref[1])) : undefined;
      if (entry) result.refs.set(entry.ref, { ...target, role: entry.role, name: entry.name });
    }
  }
  const notes = [
    unread > 0 ? `(+${unread} more frames not read: the snapshot's frame budget is spent)` : '',
    unreadInTime > 0 ? `(+${unreadInTime} more frames not read: reading them took too long this time)` : '',
    frames.length > RPC_FRAME_CAP ? `(+${frames.length - RPC_FRAME_CAP} more frames not read: past the ${RPC_FRAME_CAP}-frame limit for one snapshot)` : '',
  ];
  for (const note of notes) if (note && fits(note, 0)) push(note);
  carryUnlisted(result.refs, prior, frames, settled);
  return { text: lines.join('\n'), ...result };
}
