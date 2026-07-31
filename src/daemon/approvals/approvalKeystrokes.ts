// M2 — keystroke map v1 and the pre-write screen check.
//
// These two pieces are what stand between "a phone tapped Approve" and "bytes
// entered someone's terminal", so both are deliberately narrow and both fail
// toward doing nothing.
//
// ── What a hook-sourced awaiting_input ACTUALLY is (read this before editing
//    the bytes below) ──────────────────────────────────────────────────────
// The registry only ever acts on `source:'hook'` + `agent.awaiting_input`. For
// Claude Code that signal has exactly ONE origin: the PreToolUse hook wired to
// the `AskUserQuestion` matcher (integrations/claude/hooks/hooks.json), which
// the bridge additionally re-checks by tool name before sending
// (integrations/claude/bin/wmux-bridge.mjs — `tool_name === 'AskUserQuestion'`,
// everything else is dropped). Claude's PERMISSION prompts ("Do you want to
// proceed?", the tool-approval gate) have no hook at all — they are detector-
// only, which is exactly why HookIngest.arbitrateDetector exempts
// awaiting_input from the hook-authority veto, and why M2 refuses to act on
// detector-sourced signals.
//
// So the prompt on screen when we press is an AskUserQuestion SELECT: a
// question with the agent's own numbered options, rendered by Claude's TUI with
// a `❯` cursor on the highlighted row. It is NOT a y/N prompt. That rules out
// the obvious-looking `y` + CR: `y` is not a shortcut on a select, it would be
// typed into the composer as literal text, and the CR would then submit that
// text as a chat message — a silent, wrong, unrecoverable action.
//
// Sources consulted for the mapping:
//   - src/main/deck/deckAutonomyStore.ts — the `approvalPress` capability is
//     documented as "the brain may press y/1/2/3 on an approval prompt", i.e.
//     the option DIGIT is the press wmux already reasons about.
//   - src/mcp/index.ts `terminal_send_key` — reserved for "real key presses:
//     ctrl+c, escape, arrow keys, and y/N approval prompts".
//   - src/main/pty/AgentDetector.ts — the claude approval-prompt regexes are
//     anchored to whole boxed lines, which is where the option list renders.
//
// ── The mapping ───────────────────────────────────────────────────────────
// approve → '1'   the FIRST offered option. On a select, the digit both moves
//                 the selection and confirms it, so no CR is appended: an extra
//                 CR would land on whatever the TUI renders NEXT (often the
//                 composer, sometimes a fresh prompt) and press it blind. One
//                 byte, one effect.
// deny    → ESC   cancels the tool call; Claude receives the rejection and
//                 continues its turn. This is the same escape hatch the prompt
//                 itself advertises, and it is the only mapping here that is
//                 unambiguous for ANY question shape.
//
// KNOWN LIMITATION, deliberately shipped: for a yes/no question '1' is the
// affirmative answer, but AskUserQuestion options are agent-authored, so on a
// question whose first option is not the affirmative one, "approve" means
// "pick the first option" rather than "say yes". Nothing on the wire tells us
// which is which. The honest surface for a phone is therefore Deny (exact) +
// Approve (first option); a richer per-option press belongs with the option
// list in the phone UI, which is M5/M6 scope, not here.

/** The two byte sequences for one agent. Single presses — never a CR chaser. */
export interface ApprovalKeystrokes {
  approve: string;
  deny: string;
}

/**
 * Keystroke map v1 — Claude Code ONLY. Every other slug is `unsupported-agent`
 * rather than a guess: pressing the wrong byte into a TUI is not a recoverable
 * error, and a codex/gemini/opencode pane has neither the same prompt shape nor
 * the same hook wiring.
 */
const KEYSTROKES_BY_AGENT: Readonly<Record<string, ApprovalKeystrokes>> = {
  claude: { approve: '1', deny: '\x1b' },
};

export function keystrokesForAgent(agentSlug: string): ApprovalKeystrokes | null {
  return KEYSTROKES_BY_AGENT[agentSlug] ?? null;
}

/**
 * One selectable option row of Claude's TUI select, with the selection cursor
 * on it: optional box framing, the `❯` (or a plain `>`) cursor, then a small
 * number, then `.` or `)`, then actual text.
 *
 * The leading character class is the same box-glyph set AgentDetector uses for
 * claude's boxed prompt lines — Claude frames prompts, so an option row inside
 * the frame reads `│ ❯ 1. Yes …`.
 */
const CURSOR_OPTION_ROW =
  /^[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*[❯>›»][ \t]*\d{1,2}[.)]\s+\S/;

/**
 * Is an answerable prompt still plausibly on screen?
 *
 * Deliberately BIASED TO FALSE NEGATIVES. The failure modes are not symmetric:
 * refusing a real prompt costs the operator a walk to the desktop, while
 * pressing into a prompt that has already gone costs a stray digit in an agent's
 * composer — or, if the pane moved on to something else entirely, a keystroke
 * delivered to a program nobody meant to talk to. So the check demands an
 * option row rather than merely "the screen looks busy".
 *
 * Be precise about what that buys, because the bias is not symmetric in both
 * directions: this answers "is something option-row-shaped on screen", NOT "is
 * the prompt on screen". A quoted markdown list, a diff hunk, or another CLI's
 * own help output satisfies it — the acceptance harness proved that by passing
 * a bare `echo`. Containment comes from upstream, not from here: a request only
 * exists because a hook fired for that pane, and the request expires when the
 * pane finishes or dies. Tightening the pattern would trade that bounded false
 * positive for false negatives that make approving unusable, and the real
 * cursor glyph only passes at the current width.
 *
 * What this REJECTS on purpose:
 *   - a bare numbered list with no cursor. Agents print numbered lists
 *     constantly; without the selection cursor there is no select on screen.
 *   - an empty/unreadable grid. A tail we could not read is not evidence.
 *
 * What it may still miss (accepted, and the reason refusal is cheap): a build
 * that renders the cursor with a glyph outside the set above, or a prompt that
 * has scrolled out of the visible grid.
 */
export function looksLikeApprovalPrompt(rows: readonly string[]): boolean {
  return rows.some((row) => CURSOR_OPTION_ROW.test(row));
}

/**
 * Is a SPECIFIC option (identified by its digit and label) visible on screen?
 *
 * Looks for any row containing `<digit>.` or `<digit>)` followed (after some
 * whitespace) by at least the first 20 characters of the label. We require only
 * a prefix because the TUI may truncate long labels at the terminal width.
 *
 * Does NOT require the selection cursor — the option may not be highlighted,
 * but it must be rendered. The cursor check is already done by
 * `looksLikeApprovalPrompt` (which is called before this).
 *
 * Biased to refuse: a false negative costs the caller a fallback to the default
 * approve/deny, not a lost answer. A false positive would type the wrong digit.
 */
export function looksLikeChoiceOnScreen(
  rows: readonly string[],
  digit: string,
  label: string,
): boolean {
  // Use enough of the label to be distinctive but not so much that a TUI
  // line-wrap causes a miss. 20 chars is ~3 words, well above ambiguity.
  const labelPrefix = label.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match: optional framing, the digit followed by . or ), whitespace, then
  // the label prefix.
  const pattern = new RegExp(
    `${escapeDigit(digit)}[.)][\\s]+${labelPrefix}`,
  );
  return rows.some((row) => pattern.test(row));
}

function escapeDigit(d: string): string {
  // Digits are regex-safe, but be explicit for safety.
  return d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
