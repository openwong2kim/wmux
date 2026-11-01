// ─── Clean copy: the replies a selection is matched against ──────────────────
//
// Feeds agentReplyCopy.cleanCopyText the pane agent's recent replies from the
// transcript tail, with every code block body fetched. Anything that fails,
// is cut or takes too long copies the selection as it is.

import type { AssistantTextEvent, ChatBridgeApi } from '../../shared/transcript/turnEvents';
import { cleanCopyText, type AgentReply, type ReplyPart } from './agentReplyCopy';

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

/** Test seam: forget which panes had no transcript. */
export function forgetNoTranscript(): void {
  noTranscriptAt.clear();
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
 *  unfetchable, or the copy stopped waiting (`live` false): no more fetches. */
async function replyOf(ptyId: string, event: AssistantTextEvent, deps: CleanCopyDeps, live: () => boolean): Promise<AgentReply | null> {
  // split with a capture group: odd indexes are the block numbers.
  const pieces = event.text.split(CODE_MARKER);
  try {
    const parts = await Promise.all(pieces.map(async (piece, i): Promise<ReplyPart | null> => {
      if (i % 2 === 0) return piece ? { kind: 'prose', text: piece } : null;
      const block = event.codeBlocks?.find((b) => b.n === Number(piece));
      if (!block || block.truncated || block.srcOffset === undefined) throw new Error('body incomplete');
      if (!live()) throw new Error('copy no longer waiting');
      const result = await deps.codeBlock({ ptyId, srcOffset: block.srcOffset, n: block.n, eventId: event.id });
      if (!result) throw new Error('body unavailable');
      return block.lang ? { kind: 'code', body: result.body, lang: block.lang } : { kind: 'code', body: result.body };
    }));
    return parts.filter((p): p is ReplyPart => p !== null);
  } catch {
    return null;
  }
}

async function cleanOrRaw(ptyId: string, selection: string, deps: CleanCopyDeps, live: () => boolean): Promise<string> {
  const page = await deps.snapshot(ptyId);
  if (!page) {
    noTranscriptAt.set(ptyId, Date.now());
    return selection;
  }
  noTranscriptAt.delete(ptyId);
  if (!live()) return selection;
  const events = page.events
    .filter((e): e is AssistantTextEvent => e.kind === 'assistant_text' && !e.thinking && !e.folded)
    .slice(-MAX_REPLIES);
  const replies = await Promise.all(events.map((e) => replyOf(ptyId, e, deps, live)));
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
  if (!ptyId || !deps || !selection || selection.length > MAX_SELECTION_CHARS) return selection;
  const none = noTranscriptAt.get(ptyId);
  if (none !== undefined && Date.now() - none < NO_TRANSCRIPT_MS) return selection;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Past the cap the copy writes the selection; the reads still running
  // start no more fetches.
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

/** The one sequence every copy shares (the explicit copies, copy-on-select,
 *  every pane): a copy that resolves after any newer copy started writes
 *  nothing, so the clipboard ends with the newest. */
export const startCopy = createCopySequence();
