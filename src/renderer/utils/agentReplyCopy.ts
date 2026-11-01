// ─── Clean copy from a terminal agent's reply ────────────────────────────────
//
// A terminal agent's TUI prints its reply with a margin, its own hard wraps
// at the pane width and padding, so a selection copied from the terminal
// carries all three (a wrapped URL breaks, a code block keeps the margin).
// The transcript holds the reply as the agent wrote it. When a selection is
// exactly one span of one reply, the copy is that span as the user sees it:
// no margin, wraps or padding, no markdown markers the TUI hides (**, `,
// fences), and code block bodies verbatim. Anything uncertain copies the
// selection as it is. Pure; utils/cleanCopyResolve.ts feeds it the replies.

/** One part of a reply, in order: prose as the agent wrote it (markdown), or
 *  one fenced code block's body. */
export type ReplyPart =
  | { kind: 'prose'; text: string }
  | { kind: 'code'; body: string; lang?: string };

/** One agent reply as the transcript recorded it. */
export type AgentReply = readonly ReplyPart[];

/**
 * The text to copy for `selection` (xterm's selection text in the pane whose
 * agent wrote `replies`, oldest first), or null when the selection is not
 * exactly one span of one reply: no match, more than one, a partial overlap
 * with other output, or markdown this module does not know how the TUI shows.
 * Null means "copy the selection as it is".
 */
export function cleanCopyText(selection: string, replies: readonly AgentReply[]): string | null {
  void selection;
  void replies;
  return null;
}
