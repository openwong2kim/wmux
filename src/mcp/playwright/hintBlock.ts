/**
 * The marker that says a content block is a lease hint rather than tool output.
 *
 * `browser_repl` has to tell the two apart: hint blocks are advice for whoever
 * wrote the snippet, tool output is data the snippet parses. Telling them apart
 * by text prefix would let a page decide — `browser_extract_text` returns page
 * text as its first block, so a page whose text starts with `[skill] ` would
 * both empty the script's value and write its own string into the run's trusted
 * hint block. Only the lease can set this marker, so only the lease's own
 * blocks are ever classified as hints.
 */
export const HINT_BLOCK_META_KEY = 'wmux/leaseHint';

/** Stamp a content block the lease is prepending as a hint. */
export function hintBlockMeta(): Record<string, unknown> {
  return { [HINT_BLOCK_META_KEY]: true };
}

/** True when this content block was stamped by the lease as a hint. */
export function isHintBlock(block: { _meta?: Record<string, unknown> } | null | undefined): boolean {
  return block?._meta?.[HINT_BLOCK_META_KEY] === true;
}
