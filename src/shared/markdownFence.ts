// ─── Fenced code blocks in the markdown wmux renders ────────────────────────
//
// A fence opens with a run of three or more backticks and closes on a line
// that is only a backtick run at least as long (CommonMark). A writer that
// fences text holding backticks of its own uses a longer run, so nothing
// inside the block can close it (approvals.ts skillCardLines).

/** The backtick run that opens a fence on `line`, or 0. Pure. */
export function fenceOpenLength(line: string): number {
  const m = /^`{3,}/.exec(line.trimStart());
  return m ? m[0].length : 0;
}

/** `line` closes a fence opened with `open` backticks. Pure. */
export function closesFence(line: string, open: number): boolean {
  const m = /^(`{3,})\s*$/.exec(line.trimStart());
  return !!m && m[1].length >= open;
}

/** A fence that no backtick run inside `text` can close. Pure. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}
