// Shared by the channel wake worker (daemon) and the A2A task nudge (renderer):
// both TYPE another workspace's text into a live agent pane.

/** Longest body excerpt carried in a nudge. */
export const BODY_PREVIEW_MAX_LEN = 200;

/**
 * The first line of a message body, safe to TYPE INTO A LIVE PANE and commit
 * with an Enter.
 *
 * That last clause is the whole problem. This text is written by another
 * workspace, and it is submitted, not merely displayed. Two escapes matter:
 * `lastDetectedAgent` can be stale, so the pane may really be a shell, where
 * `$(…)` and backticks EXECUTE; and a quote can close the agent's own framing.
 * So the preview keeps letters and punctuation and drops the characters that
 * change how the line is interpreted — control characters (the newlines that
 * would submit early included), `$`, backtick, backslash, and both quote
 * marks. Blank in, blank out, so the caller can drop the segment entirely
 * instead of appending a dangling separator.
 */
export function bodyPreview(body: string | undefined): string {
  if (!body) return '';
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const clean = firstLine
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    // Shell/agent metacharacters. Dropped rather than escaped: an escape is
    // only correct for the interpreter you assumed, and the point here is that
    // we do not reliably know which one is on the other end.
    .replace(/[$`\\"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= BODY_PREVIEW_MAX_LEN) return clean;
  return `${clean.slice(0, BODY_PREVIEW_MAX_LEN - 1)}…`;
}
