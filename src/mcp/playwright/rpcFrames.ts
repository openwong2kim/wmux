import { readDomSnapshotPayload, type DomSnapshotEntry } from './dom-intelligence';

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

/** What a frame ref names: the frame, the document it was minted in, and where it is. */
export interface RpcFrameRef {
  frameId: string;
  loaderId: string;
  origin: string;
}

export interface ReadRpcFramesOptions {
  /** The top document's listing, already assembled. */
  topText: string;
  /** Origin of the top document, to say whether a frame shares it. */
  topOrigin: string;
  /** The snapshot's character budget. */
  budget: number;
  /** First ref number the top listing left unspent. */
  nextRef: number;
  listFrames: () => Promise<RpcFrameInfo[]>;
  /** One frame's frame-mode listing (or why it cannot be read). */
  readFrame: (frame: RpcFrameInfo, seed: number) => Promise<{ value: unknown } | { unreachable: string }>;
}

export interface ReadRpcFramesResult {
  /** To append to the top listing; empty when there is nothing to add. */
  text: string;
  /** Entries for the refs whose lines were shown. */
  entries: DomSnapshotEntry[];
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

const EMPTY: (nextRef: number) => ReadRpcFramesResult = (nextRef) => ({ text: '', entries: [], refs: new Map(), nextRef });

export async function readRpcFrames(opts: ReadRpcFramesOptions): Promise<ReadRpcFramesResult> {
  let frames: RpcFrameInfo[];
  try {
    frames = await opts.listFrames();
  } catch {
    // An app that cannot list frames (an older main) leaves the listing as it was.
    return EMPTY(opts.nextRef);
  }
  if (frames.length === 0) return EMPTY(opts.nextRef);

  const pool = Math.max(0, Math.min(Math.floor(opts.budget * RPC_FRAME_BUDGET_SHARE), opts.budget - opts.topText.length));
  const lines: string[] = ['', '', SECTION_INTRO];
  let used = SECTION_INTRO.length + 2;
  if (used > pool) return EMPTY(opts.nextRef);
  // Content and headers leave room for the closing notes; the notes may use it.
  const fits = (line: string, reserve = CLOSING_RESERVE) => used + line.length + 1 + reserve <= pool;
  const push = (line: string) => {
    lines.push(line);
    used += line.length + 1;
  };

  const result = { entries: [] as DomSnapshotEntry[], refs: new Map<number, RpcFrameRef>(), nextRef: opts.nextRef };
  const read = frames.slice(0, RPC_FRAME_CAP);
  const indexById = new Map<string, number>();
  let unread = 0;
  for (let i = 0; i < read.length; i++) {
    const f = read[i];
    const head = header(f, i + 1, opts.topOrigin, indexById);
    if (!fits(head)) {
      unread = read.length - i;
      break;
    }
    indexById.set(f.frameId, i + 1);
    let answer: { value: unknown } | { unreachable: string } | 'gone';
    try {
      answer = await opts.readFrame(f, result.nextRef);
    } catch {
      answer = 'gone';
    }
    if (answer === 'gone' || 'unreachable' in answer) {
      const line = `${head} ${answer === 'gone' ? GONE_NOTE : UNREACHABLE_NOTE}`;
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
    const target: RpcFrameRef = { frameId: f.frameId, loaderId: f.loaderId, origin: f.origin };
    for (let j = 0; j < content.length; j++) {
      const line = `  ${content[j]}`;
      const more = j < content.length - 1;
      if (!fits(line, CLOSING_RESERVE + (more ? TRUNCATED_NOTE.length + 1 : 0))) {
        if (fits(TRUNCATED_NOTE)) push(TRUNCATED_NOTE);
        break;
      }
      push(line);
      const ref = /\[ref=(\d+)\]/.exec(line);
      const entry = ref ? byRef.get(Number(ref[1])) : undefined;
      if (entry) {
        result.entries.push(entry);
        result.refs.set(entry.ref, target);
      }
    }
  }
  const notes = [
    unread > 0 ? `(+${unread} more frames not read: the snapshot's frame budget is spent)` : '',
    frames.length > RPC_FRAME_CAP ? `(+${frames.length - RPC_FRAME_CAP} more frames not read: past the ${RPC_FRAME_CAP}-frame limit for one snapshot)` : '',
  ];
  for (const note of notes) if (note && fits(note, 0)) push(note);
  return { text: lines.join('\n'), ...result };
}
