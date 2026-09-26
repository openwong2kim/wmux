// Shared facts about the agent's OWN terminal dialog — the permission prompt
// Claude Code draws itself ("Do you want to proceed?"), as opposed to the
// AskUserQuestion select wmux can answer.
//
// Two consumers read these: the approval registry, which records such a
// dialog as a `terminal_prompt` (answerable from a capable phone only under the
// fences in ApprovalRegistry.resolveTerminalPrompt), and the daemon's
// awaiting-state screen verifier, which releases a pane once the dialog has
// gone from its screen.

/**
 * The agents whose dialog shape the screen predicates and the
 * `terminal_prompt` record are built for. Codex and OpenCode draw different
 * dialogs and are out of scope until their shapes are captured from a live TUI.
 */
const CLAUDE_FAMILY: ReadonlySet<string> = new Set(['claude', 'openclaude']);

export function isClaudeFamilyAgent(slug: string | null | undefined): boolean {
  return typeof slug === 'string' && CLAUDE_FAMILY.has(slug);
}

/**
 * After the screen verifier releases a pane, no new `terminal_prompt` record
 * (and so no push) is minted for that pane for this long. A dialog the detector
 * keeps finding and the verifier keeps clearing would otherwise loop a card
 * and a push per cycle.
 */
export const TERMINAL_PROMPT_COOLDOWN_MS = 30_000;

/** Longest `summary` a record carries — the same cap as a gate's input summary. */
export const TERMINAL_PROMPT_SUMMARY_MAX = 200;

/** Longest `toolName` a record carries. Tool names are short identifiers. */
export const TERMINAL_PROMPT_TOOL_NAME_MAX = 64;

/**
 * Bound and clean an untrusted string for a record: control characters
 * stripped, trimmed, capped with an ellipsis. Returns undefined for nothing
 * usable. The same shape `summarizeToolInput` applies to a gate's summary.
 */
export function boundRecordText(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  const clean = raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!clean) return undefined;
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}
