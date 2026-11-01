// ─── Clean copy: the replies a selection is matched against ──────────────────
//
// Feeds agentReplyCopy.cleanCopyText the pane agent's recent replies from the
// transcript tail, with every code block body fetched. Anything that fails,
// is cut or takes too long copies the selection as it is.

import type { AssistantTextEvent, ChatBridgeApi } from '../../shared/transcript/turnEvents';
import { cleanAsIs, cleanCopyText, type AgentReply, type ReplyPart } from './agentReplyCopy';

/** The most a copy waits for the snapshot and the code bodies together. */
export const CLEAN_COPY_TIMEOUT_MS = 300;
/** Longer selections are never one reply span worth the IPC: copied as they are. */
const MAX_SELECTION_CHARS = 64 * 1024;
/** Only the latest replies: a selection is almost always from the screen. */
const MAX_REPLIES = 20;
/** A pane whose transcript read came back empty is not asked again this soon,
 *  so copying from a plain shell costs no IPC. */
const NO_TRANSCRIPT_MS = 10_000;
const noTranscriptAt = new Map<string, number>();
/** Code bodies already read, by pane, event and block: a transcript entry
 *  never changes, so a body is read once however often its reply is copied
 *  from. The oldest go first past the cap. */
const BODY_CACHE_MAX = 200;
const bodyCache = new Map<string, string>();

/** Test seam: forget which panes had no transcript, and the bodies read. */
export function forgetNoTranscript(): void {
  noTranscriptAt.clear();
  bodyCache.clear();
}

async function bodyOf(deps: CleanCopyDeps, args: { ptyId: string; srcOffset: number; n: number; eventId: string }): Promise<string | null> {
  const key = `${args.ptyId}\u0000${args.eventId}\u0000${args.n}`;
  const cached = bodyCache.get(key);
  if (cached !== undefined) return cached;
  const result = await deps.codeBlock(args);
  if (!result) return null;
  bodyCache.set(key, result.body);
  if (bodyCache.size > BODY_CACHE_MAX) bodyCache.delete(bodyCache.keys().next().value as string);
  return result.body;
}
// eslint-disable-next-line no-control-regex -- a code block's inline marker is NUL-delimited
const CODE_MARKER = /\u0000code:(\d+)\u0000/;

export interface CleanCopyDeps {
  snapshot: ChatBridgeApi['snapshot'];
  codeBlock: ChatBridgeApi['codeBlock'];
}

function defaultDeps(): CleanCopyDeps | null {
  const chat = typeof window === 'undefined' ? undefined : window.electronAPI?.chat;
  if (!chat?.snapshot || !chat.codeBlock) return null;
  return { snapshot: (id, before) => chat.snapshot(id, before), codeBlock: (args) => chat.codeBlock(args) };
}

/** One reply's parts, or null when a code body is cut, unaddressable or
 *  unfetchable. Prose that is only the space between two blocks is no part:
 *  the TUI draws the blocks one blank line apart. */
async function replyOf(ptyId: string, event: AssistantTextEvent, deps: CleanCopyDeps): Promise<AgentReply | null> {
  // split with a capture group: odd indexes are the block numbers.
  const pieces = event.text.split(CODE_MARKER);
  try {
    const parts = await Promise.all(pieces.map(async (piece, i): Promise<ReplyPart | null> => {
      if (i % 2 === 0) return piece.trim() ? { kind: 'prose', text: piece } : null;
      const block = event.codeBlocks?.find((b) => b.n === Number(piece));
      if (!block || block.truncated || block.srcOffset === undefined) throw new Error('body incomplete');
      const body = await bodyOf(deps, { ptyId, srcOffset: block.srcOffset, n: block.n, eventId: event.id });
      if (body === null) throw new Error('body unavailable');
      return block.lang ? { kind: 'code', body, lang: block.lang } : { kind: 'code', body };
    }));
    return parts.filter((p): p is ReplyPart => p !== null);
  } catch {
    return null;
  }
}

async function cleanOrRaw(ptyId: string, selection: string, deps: CleanCopyDeps, live: () => boolean): Promise<string> {
  const page = await deps.snapshot(ptyId);
  if (!page) {
    const now = Date.now();
    for (const [id, at] of noTranscriptAt) if (now - at >= NO_TRANSCRIPT_MS) noTranscriptAt.delete(id);
    noTranscriptAt.set(ptyId, now);
    return selection;
  }
  noTranscriptAt.delete(ptyId);
  if (!live()) return selection;
  const events = page.events
    .filter((e): e is AssistantTextEvent => e.kind === 'assistant_text' && !e.thinking && !e.folded)
    .slice(-MAX_REPLIES);
  const replies = await Promise.all(events.map((e) => replyOf(ptyId, e, deps)));
  return cleanCopyText(selection, replies.filter((r): r is AgentReply => r !== null)) ?? selection;
}

/**
 * The text a copy of `selection` from `ptyId`'s terminal writes: the clean
 * span of the agent reply it is exactly one span of, else `selection`. Never
 * throws, and answers within CLEAN_COPY_TIMEOUT_MS.
 */
export async function resolveCopyText(
  ptyId: string | null | undefined,
  selection: string,
  deps: CleanCopyDeps | null = defaultDeps(),
): Promise<string> {
  // Already clean (one row, nothing the TUI added at its ends): no IPC.
  if (!ptyId || !deps || !selection || cleanAsIs(selection) || selection.length > MAX_SELECTION_CHARS) return selection;
  const none = noTranscriptAt.get(ptyId);
  if (none !== undefined && Date.now() - none < NO_TRANSCRIPT_MS) return selection;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Past the cap the copy writes the selection; a snapshot that answers
  // later starts no code-body fetches.
  let waiting = true;
  const timeout = new Promise<string>((resolve) => { timer = setTimeout(() => { waiting = false; resolve(selection); }, CLEAN_COPY_TIMEOUT_MS); });
  try {
    return await Promise.race([cleanOrRaw(ptyId, selection, deps, () => waiting), timeout]);
  } catch {
    return selection;
  } finally {
    waiting = false;
    clearTimeout(timer);
  }
}

/**
 * Newest copy wins: each call starts a copy and returns its `isCurrent`,
 * which turns false once a later copy starts, so a slow resolution never
 * writes over a newer one.
 */
export function createCopySequence(): () => () => boolean {
  let latest = 0;
  return () => {
    const mine = ++latest;
    return () => mine === latest;
  };
}

const sharedSequence = createCopySequence();
let copiesStarted = 0;

/** The one sequence every copy shares (the explicit copies, copy-on-select,
 *  every pane): a copy that resolves after any newer copy started writes
 *  nothing, so the clipboard ends with the newest. */
export function startCopy(): () => boolean {
  copiesStarted += 1;
  return sharedSequence();
}

/** How many copies have started so far: a copy-on-select still in its
 *  debounce skips its write when another copy started after its selection. */
export function copiesStartedSoFar(): number {
  return copiesStarted;
}
