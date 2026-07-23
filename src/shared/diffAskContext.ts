// diff → orchestrator question context block assembly (pure function).
//
// Design rationale (plan): composePrompt seam is ambient-state-only; putting context there
// hides it from the transcript, breaking the "every claim 1-click from evidence" contract.
// Channel routing adds coalescer delay. So a single deck:send message with a structured
// block prepended to the user question is correct — this function builds that block.
//
// Hunk body is wrapped in ``` fences: orchestrator grounding convention treats terminal/diff
// text as data (not instructions). When total cap (8KB) is exceeded, omit hunk
// body entirely and keep path+header only — partial truncated diffs mislead worse
// (looks complete but content is cut).

export const DIFF_ASK_CONTEXT_CAP = 8 * 1024;

export interface DiffAskInput {
  /** Repo identity label — workspace mode: repoPath; task mode: worktreePath. */
  readonly repoLabel: string;
  readonly branch: string;
  readonly file: string;
  /** Empty string when not a per-hunk question (file-level question). */
  readonly hunkHeader: string;
  /** Hunk body (joined line array). Omitted when cap exceeded. */
  readonly hunkBody: string;
  readonly question: string;
}

const byteLen = (s: string): number => new TextEncoder().encode(s).length;

// Safe truncate at UTF-8 byte cap — never split multibyte characters.
function truncateBytes(s: string, cap: number): string {
  if (byteLen(s) <= cap) return s;
  let out = s;
  // Shrink by character until under byte cap (display/prompt; no precision tuning needed).
  while (out.length > 0 && byteLen(out) > cap) {
    out = out.slice(0, Math.max(0, Math.floor(out.length * 0.95)) || out.length - 1);
  }
  return out;
}

// Fence length for hunk body — one longer than longest backtick run in body (CommonMark
// rule). So a ``` line in the body does not terminate the fence early (Codex P2).
function fenceFor(body: string): string {
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

export function buildDiffAskContext(input: DiffAskInput): string {
  const { repoLabel, branch, file, hunkHeader, hunkBody, question } = input;
  const head = [
    '[diff question]',
    `repo: ${repoLabel}`,
    branch ? `branch: ${branch}` : null,
    `file: ${file}`,
    hunkHeader ? `hunk: ${hunkHeader}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');

  const fence = fenceFor(hunkBody);
  const fenced = hunkBody ? `\n${fence}diff\n${hunkBody}\n${fence}` : '';
  const full = `${head}${fenced}\n\n${question}`;
  if (byteLen(full) <= DIFF_ASK_CONTEXT_CAP) return full;
  // Cap exceeded — omit hunk body (keep path+header; orchestrator reads pane/file directly).
  // Still over cap (large path/question) — final byte-cap truncate (Codex P3).
  const fallback = `${head}\n(hunk body omitted — over ${DIFF_ASK_CONTEXT_CAP / 1024}KB; read the file directly)\n\n${question}`;
  return truncateBytes(fallback, DIFF_ASK_CONTEXT_CAP);
}
