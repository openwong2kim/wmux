import fs from 'node:fs';

/**
 * Read the tail of a Claude Code transcript and extract the final assistant
 * message, plus whether that message ends by asking the human something.
 *
 * Why this exists: an `agent.stop` wake used to reach the orchestrator with no
 * content at all — just "this pane stopped". The orchestrator's only way to
 * learn WHY it stopped was to `terminal_read` and read the rendered screen,
 * which is ambiguous: a proposal the agent printed ("shall I merge?") looks
 * exactly like text sitting in the input box. Orchestrators mis-read that twice
 * in one session, reported "still running" for a pane that was actually blocked
 * on a question, and pressed Enter expecting to submit a line that was never
 * there.
 *
 * The Stop hook already hands us `transcript_path` (hooks.rpc.ts stores it on
 * the resume binding), so the agent's own last words are available as
 * structured data. Reading them here means the wake event can carry the
 * question itself — the same treatment `pr.review_comment` already gives
 * reviewer text.
 */

/** Cap the tail we read. Transcripts grow to megabytes; the last message is at
 *  the end, and a bounded read keeps a stop-hook off the slow path. */
const TAIL_BYTES = 256 * 1024;
/** Cap what we hand to the orchestrator — enough to convey a question, not so
 *  much that one pane's essay dominates the wake prompt. */
const MAX_TEXT = 600;

export interface LastAssistantMessage {
  /** Trailing slice of the final assistant message, whitespace-collapsed. */
  text: string;
  /** True when the message reads as a question aimed at the human. */
  endsWithQuestion: boolean;
}

/**
 * Does this message end by asking the human something?
 *
 * Deliberately conservative: it looks only at the LAST non-empty line, because
 * an agent that asks mid-report and then keeps working is not blocked, while an
 * agent whose final line is a question is waiting on an answer. Korean question
 * endings are included — this repo's agents are routinely driven in Korean, and
 * a Korean question mostly ends in `-kka/-na/-ji` with no `?` at all.
 */
export function endsWithQuestion(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return false;
  // Strip trailing markdown emphasis/quotes so bold-wrapped questions still match.
  const tail = last.replace(/[*_`"')\]]+$/, '').trim();
  if (tail.endsWith('?') || tail.endsWith('？')) return true;
  // A Korean question may still be punctuated with a period; strip it before
  // testing the ending so trailing-period forms match the same as bare endings.
  const bare = tail.replace(/[.!。]+$/, '');
  // Korean interrogative endings, which routinely carry no '?' at all.
  //
  // Deliberately narrow. -yo and -ni endings were removed after review: ordinary
  // declaratives end in them constantly and a false positive is worse than a miss —
  // it makes the orchestrator announce a block that does not exist and "answer" a
  // statement. -kka-yo is listed explicitly because -kka alone misses the most
  // common polite proposal form, which was the exact bug class this function exists to catch.
  return /(까|까요|나요|는지|을지|ㄹ지)$/.test(bare);
}

/** Collapse runs of blank lines and trim to MAX_TEXT from the END (the tail of
 *  a message carries the ask; the head is usually recap). */
function condense(raw: string): string {
  const cleaned = raw.replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length <= MAX_TEXT) return cleaned;
  // The ellipsis counts against the cap — `text` is documented as <= MAX_TEXT
  // and a consumer sizing a buffer off that number should not be surprised.
  return `…${cleaned.slice(-(MAX_TEXT - 1))}`;
}

/**
 * True when a `user` entry is real human input rather than a tool result.
 *
 * Claude Code records tool results as `user` entries too (content blocks of
 * type `tool_result`), so entry type alone cannot mark a human turn boundary.
 * Only an entry carrying actual text does.
 */
function isHumanTurn(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text',
  );
}

/** Pull the text out of one transcript entry's `message.content`. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: unknown }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('\n');
}

/**
 * Best-effort — every failure resolves to null and the caller falls back to the
 * old contentless event. A stop hook must never break because a transcript was
 * rotated, truncated mid-write, or written by an agent whose format we don't
 * know.
 */
export function readLastAssistantMessage(transcriptPath: string): LastAssistantMessage | null {
  let raw: string;
  try {
    // lstat, and only a regular file: `transcript_path` arrives from a hook
    // payload, and openSync on a FIFO blocks the MAIN process indefinitely —
    // there is no timeout to save us, the hook's budget cannot cancel a blocked
    // syscall, and the whole app stalls with it.
    const st = fs.lstatSync(transcriptPath);
    if (!st.isFile()) return null;
    const start = Math.max(0, st.size - TAIL_BYTES);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      // Decode ONLY what was actually read. A transcript being truncated or
      // rotated concurrently would otherwise leave zero-fill in the tail and
      // corrupt the very last record — the one we came here for.
      const read = fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = raw.split('\n');
  // A partial first line is expected whenever we seeked into the middle of the
  // file; JSON.parse rejects it and the loop moves on.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // Stop at the last HUMAN turn. Walking past it would resurrect a question
    // the human has already answered: assistant asks -> human answers ->
    // assistant does tool-only work -> turn ends. Without this boundary the
    // reader walks back over the tool-only turns AND the answer, and
    // republishes the settled question as a fresh block.
    if (entry.type === 'user' || entry.message?.role === 'user') {
      if (isHumanTurn(entry.message?.content)) return null;
      continue; // tool_result — part of the assistant's own turn
    }
    if (entry.type !== 'assistant' && entry.message?.role !== 'assistant') continue;
    const text = textOf(entry.message?.content);
    // Tool-only assistant turns carry no text — keep walking back to the last
    // turn that actually said something to the human (bounded by the human
    // turn boundary above).
    if (!text.trim()) continue;
    return { text: condense(text), endsWithQuestion: endsWithQuestion(text) };
  }
  return null;
}
