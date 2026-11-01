// M2 — keystroke map v1 and the pre-write screen check.
//
// These two pieces are what stand between "a phone tapped Approve" and "bytes
// entered someone's terminal", so both are deliberately narrow and both fail
// toward doing nothing.
//
// ── What a hook-sourced awaiting_input ACTUALLY is (read this before editing
//    the bytes below) ──────────────────────────────────────────────────────
// The registry only ever acts on `source:'hook'` + `agent.awaiting_input`. For
// Claude Code that signal has two origins, and only ONE of them reaches here:
//   - the PreToolUse hook wired to the `AskUserQuestion` matcher
//     (integrations/claude/hooks/hooks.json), which the bridge re-checks by
//     tool name before sending (integrations/claude/bin/wmux-bridge.mjs —
//     `tool_name === 'AskUserQuestion'`, every other PreToolUse is dropped);
//   - the PermissionRequest hook behind Claude's PERMISSION prompts ("Do you
//     want to proceed?"). HookIngest.noteAwaitingInput refuses to create a
//     record for it (`hook_event_name === 'PermissionRequest'`): it carries no
//     question, and the mapping below is built for a select. It is pane status
//     only. Without that hook installed the prompt is detector-only, which is
//     why HookIngest.arbitrateDetector exempts awaiting_input from the
//     hook-authority veto, and why M2 refuses to act on detector-sourced
//     signals.
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
// DEFAULT MAPPING + per-option override. For a yes/no question '1' is the
// affirmative answer, but AskUserQuestion options are agent-authored, so on a
// question whose first option is not the affirmative one, "approve" means
// "pick the first option" rather than "say yes". Nothing on the wire tells us
// which is which at the default-mapping layer.
//
// Per-option press is now supported: the registry extracts structured
// `choices` (key = the original 1-based digit, label) from the hook payload,
// and a resolver may send `choiceKey` to select a SPECIFIC option rather than
// the default first. The registry validates the key belongs to the request,
// re-verifies the option row is visible, then sends exactly that digit — no CR.
// Omitting `choiceKey` preserves the default mapping byte-for-byte, so old
// clients keep working. See ApprovalRegistry.resolve and the phone-client
// contract (`docs/phone-client-contract.md`, "choices" / "choiceKey").

import { agentRow, type AgentDialogFamily } from '../../shared/agentIdentity';
import { ESCAPE_WIN32 } from '../../shared/win32InputKeys';
import { CODEX_TRUST_HEADLINE, TRUST_HEADLINE } from '../../shared/folderTrustWording';
import { screenReaderKeyRow } from './screenReaderKeyRow';

/** The two byte sequences for one agent. Single presses — never a CR chaser. */
export interface ApprovalKeystrokes {
  approve: string;
  deny: string;
}

/**
 * Keystroke map v1 — the Claude Code family ONLY. openclaude is a fork of
 * Claude Code that draws the same AskUserQuestion select, so it shares the map:
 * the map is keyed by dialog family, and an agent's family is `dialogs` on its
 * registry row (the same field `isClaudeFamilyAgent` reads). Every other slug
 * is `unsupported-agent` rather than a guess: pressing the wrong byte into a
 * TUI is not a recoverable error, and a codex/gemini/opencode pane has neither
 * the same prompt shape nor the same hook wiring. Measured key semantics per
 * TUI: `__tests__/fixtures/terminal-prompts/KEYS.md`.
 */
const KEYSTROKES_BY_DIALOG_FAMILY = {
  claude: { approve: '1', deny: '\x1b' },
} as const satisfies Record<AgentDialogFamily, ApprovalKeystrokes>;

export function keystrokesForAgent(agentSlug: string): ApprovalKeystrokes | null {
  const family = agentRow(agentSlug)?.dialogs;
  return family ? KEYSTROKES_BY_DIALOG_FAMILY[family] : null;
}

/**
 * The bytes that press one answer key in a pane, at write time.
 *
 * On a pane whose input conhost parses as win32-input-mode records (every
 * ConPTY pane on Windows) Esc goes out as its key record pair (#1915,
 * measured on Claude Code 2.1.293: the bare byte left the AskUserQuestion
 * picker and the Bash permission dialog up, the record closed both; see
 * shared/win32InputKeys.ts for the likely reason). Everything else is
 * unchanged, also measured on that pane: a digit, a lone `\r` and the VT arrow
 * `ESC [ B` each pressed their key as plain bytes, because none of them is
 * ambiguous to conhost's input parser. The keys the registry reasons about
 * (step lists, `expect` screens) stay in their plain form; only the write
 * encodes.
 *
 * The desktop's own Escape key (renderer `encodeEscape`) is a separate case
 * and stays a bare byte: it was measured interrupting a RUNNING turn (#1373),
 * not dismissing a dialog. Changing either one does not settle the other.
 */
export function encodeAnswerKey(key: string, win32Input: boolean): string {
  return win32Input && key === '\x1b' ? ESCAPE_WIN32 : key;
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

/** How a label may go on: a folder name in brackets, Qwen Code's "(esc)", or the place "Back to" returns to. */
type TrustSuffix = 'name' | 'esc' | 'place';
/**
 * The trust dialogs' choices, granting or declining, in one table: the whole-
 * row patterns and the reading of a choice a narrow pane cut with "…" both
 * come from it.
 */
const TRUST_LABELS: readonly { label: string; grants: boolean; suffix?: TrustSuffix }[] = [
  { label: 'Yes, I trust this folder', grants: true },
  { label: 'Yes, proceed', grants: true },
  { label: 'Trust and continue', grants: true },
  { label: 'Yes, continue', grants: true },
  // Gemini CLI and Qwen Code name the folder: "Trust folder (<dir>)".
  { label: 'Trust folder', grants: true, suffix: 'name' },
  { label: 'Trust parent folder', grants: true, suffix: 'name' },
  { label: 'No, exit', grants: false },
  { label: 'No, quit', grants: false },
  { label: 'Quit', grants: false },
  { label: 'Back to', grants: false, suffix: 'place' },
  { label: "Don't trust", grants: false, suffix: 'esc' },
];
/** A suffix whole (optional unless it is the place; a folder name is any
 *  bracketed text to the end of the row), and a suffix cut part way. */
const SUFFIX_WHOLE: Record<TrustSuffix, string> = { name: '(?: \\(.*\\))?', esc: '(?: \\(esc\\))?', place: ' [A-Za-z ]+' };
const SUFFIX_CUT: Record<TrustSuffix, (rest: string) => boolean> = {
  name: (rest) => rest.startsWith(' ('),
  esc: (rest) => ' (esc)'.startsWith(rest),
  place: (rest) => /^ [a-z ]*$/.test(rest),
};
const escapeLabel = (label: string): string => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const labelsPattern = (grants: boolean): RegExp => new RegExp(`^(?:${TRUST_LABELS
  .filter((entry) => entry.grants === grants)
  .map(({ label, suffix }) => escapeLabel(label) + (suffix ? SUFFIX_WHOLE[suffix] : ''))
  .join('|')})$`, 'i');
const TRUST_GRANT_LABEL = labelsPattern(true);
const TRUST_DECLINE_LABEL = labelsPattern(false);
/** Shortest visible text of a cut label that still names one ("Trust f", "Don't t"). */
const MIN_CUT_TEXT = 7;

/** A choice row split: the selection cursor, its digit, then the label. */
const CHOICE_PARTS = /^(?:([❯›>»])\s*)?(?:(\d{1,2})[.)]\s*)?(.*)$/;
/** The key hint under the choices ("Enter to confirm · Esc to cancel", "enter continue · esc back"). */
const TRUST_FOOTER = /^(?:press\s+)?(?:↑\/↓|↑↓)?.{0,24}\benter\b.{0,30}\b(?:cancel|back|continue|confirm)$/i;
/** Where a choice starts even when a narrow pane wrapped its label: the cursor, or its digit. */
const CHOICE_START = /^(?:[❯›>»]\s*\S|\d{1,2}[.)]\s)/;
/** Gemini CLI's selection cursor. It counts only inside a box drawn round the
 *  question and the choices: elsewhere a dot is a reply's bullet. */
const DOT_CURSOR = /^●\s*(?=\S)/;
/** The bottom edge of the box Gemini CLI and Qwen Code draw the dialog in. */
const FRAME_BOTTOM = /^╰─+╯?$/;
/** What a live boxed dialog may have under its bottom edge, its rows joined:
 *  Gemini CLI's notice after a first Ctrl+C (measured; two rows at 22 columns). */
const FRAME_TRAILER = /^Press Ctrl\+C again to exit\.$/;
/** Rows a wrapped question may span: one or two at 60 columns (measured), four at about 14; six leaves room. */
const TRUST_QUESTION_ROWS = 6;

/**
 * One row under the trust question, read once:
 *   - grant / decline: a choice, whole or cut with "…" part way into a label
 *     or its suffix (`cut`); `open` when its label is whole but may go on
 *     (it has a suffix), so a row indented under the label may continue it;
 *   - short: a numbered choice cut too early to say which label it is;
 *   - footer: the key hint; other: anything else.
 */
interface TrustRow {
  text: string;
  kind: 'grant' | 'decline' | 'short' | 'footer' | 'other';
  cursor: boolean;
  cut: boolean;
  open: boolean;
  /** Screen column of the row's text, and of its label after any cursor and digit. */
  indent: number;
  labelAt: number;
}

function cutLabelKind(text: string): TrustRow['kind'] {
  const lower = text.toLowerCase();
  if (!lower) return 'other';
  let grant = false;
  let decline = false;
  let short = false;
  for (const { label, grants, suffix } of TRUST_LABELS) {
    const whole = label.toLowerCase();
    let fits = false;
    if (whole.startsWith(lower)) {
      if (lower.length >= MIN_CUT_TEXT) fits = true;
      else short = true;
    } else if (suffix && lower.startsWith(whole)) {
      fits = SUFFIX_CUT[suffix](lower.slice(whole.length));
    }
    if (fits && grants) grant = true;
    if (fits && !grants) decline = true;
  }
  if (grant !== decline) return grant ? 'grant' : 'decline';
  return !grant && short ? 'short' : 'other';
}

function readTrustRow(text: string, indent: number): TrustRow {
  const [, cursor, digit, label = ''] = CHOICE_PARTS.exec(text) ?? [];
  const row = { text, cursor: cursor !== undefined, cut: false, open: false, indent, labelAt: indent + text.length - label.length };
  if (label.endsWith('…')) {
    const kind = cutLabelKind(label.slice(0, -1).trimEnd());
    if (kind === 'short' && digit === undefined) return { ...row, kind: 'other' };
    return { ...row, kind, cut: kind !== 'other' };
  }
  const kind = TRUST_GRANT_LABEL.test(label) ? 'grant' : TRUST_DECLINE_LABEL.test(label) ? 'decline' : null;
  if (kind) {
    const lower = label.toLowerCase();
    const open = TRUST_LABELS.some((entry) => entry.suffix !== undefined && lower.startsWith(entry.label.toLowerCase()));
    return { ...row, kind, open };
  }
  return { ...row, kind: TRUST_FOOTER.test(text) ? 'footer' : 'other' };
}

const isChoice = (row: TrustRow): boolean => row.kind === 'grant' || row.kind === 'decline';
const isDialogRow = (row: TrustRow): boolean => isChoice(row) || row.kind === 'footer';

/**
 * The rows from the first choice under the newest trust question, each read
 * once and rejoined where a narrow pane wrapped it, with a boxed dialog's
 * bottom edge (and the notices measured under it) dropped. Null when no trust
 * question with a choice under it is on screen.
 */
function trustDialogBlock(rows: readonly string[]): TrustRow[] | null {
  const tail = rows
    .map((row) => ({
      text: row.replace(/^[\s│║┃]+|[\s│║┃]+$/g, '').replace(/\s+/g, ' '),
      framed: /^\s*│/.test(row),
      indent: /^[\s│║┃]*/.exec(row)?.[0].length ?? 0,
    }))
    .filter((row) => row.text);
  for (let q = tail.length - 1; q >= 0; q--) {
    const question = tail.slice(q, q + TRUST_QUESTION_ROWS).map((row) => row.text).join(' ');
    if (!TRUST_HEADLINE.test(question) && !CODEX_TRUST_HEADLINE.test(question)) continue;
    const below = tail.slice(q + 1);
    const first = below.findIndex((row) =>
      CHOICE_START.test(row.text) || (row.framed && DOT_CURSOR.test(row.text)) || isChoice(readTrustRow(row.text, row.indent)));
    if (first < 0) return null;
    const rest = below.slice(first);
    let edge = rest.length - 1;
    while (edge >= 0 && !FRAME_BOTTOM.test(rest[edge].text)) edge--;
    const trailer = rest.slice(edge + 1).map((row) => row.text).join(' ');
    if (edge > 0 && (trailer === '' || FRAME_TRAILER.test(trailer))) rest.length = edge;
    // Inside a box round the question and every choice, Gemini CLI's dot is the cursor.
    const boxed = tail[q].framed && rest.every((row) => row.framed);
    // Rejoin what a narrow pane wrapped: "Yes, I trust this" + "folder",
    // "› 1. Trust and" + "continue", "Enter to confirm · Esc to" + "cancel":
    // a row that does not read whole yet takes the rows under it, and a whole
    // label that may go on ("Back to Agent") takes a row indented under its
    // label ("Command Center"). A row cut with "…" is whole as it stands.
    const block: TrustRow[] = [];
    for (const { text: raw, indent } of rest) {
      const text = boxed ? raw.replace(DOT_CURSOR, '› ') : raw;
      const row = readTrustRow(text, indent);
      const last = block.at(-1);
      if (last !== undefined) {
        const incomplete = !isDialogRow(last) && !last.text.endsWith('…');
        if (incomplete || (last.open && !isDialogRow(row) && indent >= last.labelAt)) {
          const joined = readTrustRow(`${last.text} ${text}`, last.indent);
          if (incomplete || isDialogRow(joined)) {
            block[block.length - 1] = joined;
            continue;
          }
        }
      }
      block.push(row);
    }
    return block;
  }
  return null;
}

/** A choice in Claude Code's screen-reader layout: its key letter, a dot, the label; no cursor. */
const SR_TRUST_CHOICE = /^([a-z])\. (.+)$/;
/** The title row over Claude Code's screen-reader trust dialog. */
const SR_TRUST_TITLE = /^Permission Required: Accessing workspace:$/;
/** How the screen-reader trust dialog's key row starts, typed key or not. */
const SR_YES_NO_START = /^Enter y\/n:/;

/** Does a trust question start above row `end`, joined over up to TRUST_QUESTION_ROWS rows before it? */
function trustQuestionAbove(texts: readonly string[], end: number): boolean {
  for (let q = end - 1; q >= 0; q--) {
    const question = texts.slice(q, Math.min(q + TRUST_QUESTION_ROWS, end)).join(' ');
    if (TRUST_HEADLINE.test(question) || CODEX_TRUST_HEADLINE.test(question)) return true;
  }
  return false;
}

/**
 * Claude Code's screen-reader trust dialog (fixtures/screen-reader/): 'trust'
 * when it reads whole, 'unreadable' when its question or title is on screen
 * over an `Enter y/n:` row but it does not, null when neither is on screen.
 */
function readScreenReaderTrust(rows: readonly string[]): 'trust' | 'unreadable' | null {
  const texts = rows.map((row) => row.trim());
  let keyAt = texts.length - 1;
  while (keyAt >= 0 && !SR_YES_NO_START.test(texts[keyAt] ?? '')) keyAt--;
  if (keyAt < 0) return null;
  if (!texts.slice(0, keyAt).some((text) => SR_TRUST_TITLE.test(text)) && !trustQuestionAbove(texts, keyAt)) return null;
  const key = screenReaderKeyRow(rows);
  if (key?.keys !== 'y/n') return 'unreadable';
  const lines = key.lines.map((line) => line.trim());
  const choices: { key: string; label: string }[] = [];
  let first = key.at;
  for (; first > 0; first--) {
    const [, letter, label] = SR_TRUST_CHOICE.exec(lines[first - 1] ?? '') ?? [];
    if (letter === undefined || label === undefined) break;
    choices.push({ key: letter, label });
  }
  const keys = choices.map((choice) => choice.key).sort().join('');
  return keys === 'ny'
    && choices.filter((choice) => TRUST_GRANT_LABEL.test(choice.label)).length === 1
    && choices.filter((choice) => TRUST_DECLINE_LABEL.test(choice.label)).length === 1
    && trustQuestionAbove(lines, first) ? 'trust' : 'unreadable';
}

/**
 * Is an agent's folder-trust dialog the live dialog at the bottom of the
 * screen? Answering it decides whether the agent may read, edit and run files
 * in that folder, so it is left to the person in every policy.
 *
 *   trust       the dialog, recognised by its own shape rather than by a
 *               loosened option-row pattern, so an ordinary unnumbered menu
 *               (a theme picker, a warning with "❯ No, exit") stays answerable:
 *               - a trust question, in the wordings the first-run screens
 *                 share (shared/agentFirstRun), joined over up to six rows for
 *                 a pane narrow enough to wrap it;
 *               - below it, the choice that grants trust and exactly one row
 *                 under the selection cursor, numbered or not;
 *               - after the first choice, only choices and the key hint, each
 *                 rejoined when a narrow pane wrapped it, and for a boxed
 *                 dialog its bottom edge and the notices measured under it: a
 *                 dialog with anything else under it (agent output, a shell
 *                 prompt) has already been answered;
 *               - a choice a narrow pane cut with "…" counts only as the start
 *                 of a known label or of its suffix, and only beside at least
 *                 one other choice.
 *               Read first, Claude Code's screen-reader layout, which has no
 *               cursor (screenReaderKeyRow):
 *               - an `Enter y/n:` key row at the bottom of the grid, with a
 *                 typed key after its colon or none (the dialog stays up until
 *                 Enter);
 *               - directly above it the choices `y.` and `n.`, one granting
 *                 and one declining, each whole on its row;
 *               - above them the trust question, with any rows between.
 *   unreadable  a trust question over numbered choices all cut with "…", at
 *               least one too early to say which label it is (Gemini CLI and
 *               Qwen Code at 18 columns: "› 1. Trus…"); or a trust question, or
 *               the screen-reader title `Permission Required: Accessing
 *               workspace:`, over an `Enter y/n:` row, in a screen that does
 *               not read as that layout: a label unknown, cut or broken onto
 *               two rows, keys other than y and n, output under the key row,
 *               more typed than one key. Not a recognisable dialog, but not
 *               proof of its absence either.
 *   null        neither.
 */
export function readFolderTrustScreen(rows: readonly string[]): 'trust' | 'unreadable' | null {
  const screenReader = readScreenReaderTrust(rows);
  if (screenReader) return screenReader;
  const block = trustDialogBlock(rows);
  if (!block) return null;
  const choices = block.filter(isChoice);
  if (choices.some((row) => row.kind === 'grant')
    && choices.filter((row) => row.cursor).length === 1
    && block.every(isDialogRow)
    && (choices.length >= 2 || !choices.some((row) => row.cut))) return 'trust';
  if (block.length >= 2
    && block.every((row) => row.cut || row.kind === 'short')
    && block.some((row) => row.kind === 'short')) return 'unreadable';
  return null;
}

/** Is an agent's folder-trust dialog the live dialog on screen (readFolderTrustScreen)? */
export function looksLikeFolderTrustDialog(rows: readonly string[]): boolean {
  return readFolderTrustScreen(rows) === 'trust';
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

/**
 * Is THIS AskUserQuestion — the record's own question and every one of its
 * options — the dialog on screen right now?
 *
 *   unprovable  the record carries no question text or no choices, so there
 *               is nothing to identify its dialog by. Never pressed into.
 *   absent      no row shows the question: the dialog is gone (answered,
 *               cancelled with Esc, replaced by another dialog).
 *   changed     the question row is there but the option rows do not all
 *               match (a re-render, a wrap the prefix rule cannot bridge).
 *   match       the question row, then each option row in key order below it,
 *               then Claude's own free-text row (`N. Type something.`).
 *
 * Identity is the whole dialog, not one label: a question whose option 1 is
 * "Yes" must not match a permission prompt's `❯ 1. Yes`. Each option row is
 * anchored (optional frame, optional cursor, the exact key, `.`) so `11. Yes`
 * cannot stand in for key 1, and its text must EQUAL the label or be a prefix
 * of it (a label cut at the pane's width) — never the other way round, which
 * is how `Yes` would match `Yes, and always allow …`. A multi-select row's
 * `[ ]` / `[✔]` checkbox is skipped. The question row matches the same way:
 * equal to the question, or a prefix of it at least 8 characters long (or the
 * whole question when shorter), so a prompt echo such as
 * `❯ Call AskUserQuestion … "Pick a fruit?"` does not count.
 *
 * The trailing `Type something` row is what makes it an AskUserQuestion at
 * all: Claude Code (2.1.283, measured) appends it to every question, single-
 * and multi-select, and draws it on no permission dialog. Without it a
 * question that happens to read "Do you want to proceed?" with options Yes/No
 * would be indistinguishable from the permission prompt of the same words.
 */
export type QuestionScreenProof = 'unprovable' | 'absent' | 'changed' | 'match';

const FRAME_EDGE = /^[\s│║┃]*|[\s│║┃]*$/g;
const MIN_QUESTION_PREFIX = 8;
const MIN_LABEL_PREFIX = 3;
const FREE_TEXT_ROW = /^(?:❯\s*)?\d{1,2}\.\s+(?:\[[^\]]*\]\s*)?Type something\.?$/;

const normalizeText = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** `text` equals `full`, or is a prefix of it at least `min` characters long (the whole of a shorter `full`). */
function isCutOf(text: string, full: string, min: number): boolean {
  const cut = text.replace(/…$/, '').trimEnd();
  if (!cut) return false;
  if (cut === full) return true;
  return full.startsWith(cut) && cut.length >= Math.min(full.length, min);
}

export function questionOnScreen(
  rows: readonly string[],
  record: { question?: string; choices?: ReadonlyArray<{ key: string; label: string }> },
): QuestionScreenProof {
  const question = record.question ? normalizeText(record.question) : '';
  const choices = record.choices ?? [];
  if (!question || choices.length === 0) return 'unprovable';
  const lines = rows.map((row) => normalizeText(row.replace(FRAME_EDGE, '')));
  const questionAt = lines.findIndex((line) => isCutOf(line, question, MIN_QUESTION_PREFIX));
  if (questionAt < 0) return 'absent';
  let from = questionAt + 1;
  for (const choice of choices) {
    const label = normalizeText(choice.label);
    const row = new RegExp(`^(?:❯\\s*)?${escapeDigit(choice.key)}\\.\\s+(?:\\[[^\\]]*\\]\\s*)?(.*)$`);
    let found = -1;
    for (let i = from; i < lines.length; i++) {
      const m = row.exec(lines[i]);
      if (m && isCutOf(m[1], label, MIN_LABEL_PREFIX)) { found = i; break; }
    }
    if (found < 0) return 'changed';
    from = found + 1;
  }
  return lines.slice(from).some((line) => FREE_TEXT_ROW.test(line)) ? 'match' : 'changed';
}

function escapeDigit(d: string): string {
  // Digits are regex-safe, but be explicit for safety.
  return d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Press scope (orchestrator track, 2026-09-04)
// ---------------------------------------------------------------------------
//
// The checks above answer "can these bytes be pressed". This one answers the
// prior question: "may this pane be pressed AT ALL". They are different, and
// conflating them is how an AUTOMATED approve reaches a pane a human opened
// for themselves — a keystroke into a session nobody delegated.
//
// WHAT THIS DOES NOT GOVERN, and must not:
//   - a HUMAN answering from the phone or the web UI. They are looking at the
//     prompt; a scope check that refuses them is just a broken button, and a
//     refused deny would leave the record alive to be re-tapped forever.
//   - a DENY, from any caller. Denying is the safe direction: it cancels the
//     tool call and hands the turn back. Refusing a deny keeps a pane blocked
//     to protect it from being unblocked.
//
// Four conditions, all required (for an automated APPROVE):
//   1. the target pane's workspace is a WorkTask TASK workspace. A pane the
//      human opened by hand, and the PARENT workspace a fan-out was launched
//      from, are both refused: neither was delegated to an agent;
//   2. that workspace's EFFECTIVE approvalPress capability is on. Not the mode:
//      main composes the stored capability as `modeCeiling AND loop tier`
//      (deck.handler applyTierCaps), so a `danger` workspace running a `report`
//      loop has press OFF while its mode still reads 'danger'. Reading the mode
//      here would press in a workspace whose own UI says it may not;
//   3. the pending approval came from a HOOK. The screen-regex detector is a
//      suspicion — it fires on a numbered list in a diff — and this surface
//      writes bytes;
//   4. a re-read taken NOW still shows the prompt (looksLikeApprovalPrompt).
//      Everything upstream is a fact about when the hook fired, which is not
//      a fact about the screen a press is about to land on.
//
// Two more, added with the HQ approval lane (C2 v2, 2026-10-04), for every
// automated approve whichever process relays it:
//   5. the task's single open OWNER is in `danger` right now. The task
//      workspace's own mode is a copy taken at fan-out; the owner's live mode
//      is the operator's current word, so a downgrade after the fan-out stops
//      presses at once instead of when the copy catches up;
//   6. the record is not flagged `risk: 'critical'`. The flag is a regex hint
//      (shared/criticalPatterns), so it misses and over-fires — but it only
//      ever withholds an AUTOMATED approve. The human still answers it.
//      Checked FIRST, before any workspace fact;
//   7. the record's hook named this pane exactly (`attribution: 'exact'`);
//   8. a caller that declared the HQ lane finds main's lane policy still open
//      at the generation it checked.
//
// UNKNOWN IS A REFUSAL. Each fact is optional in the input because the daemon
// cannot see all of them yet (task-workspace membership and autonomy mode live
// in the main process), and a fact we cannot establish must never be assumed
// favourable: the cost of a wrong refusal is a human walking to the desktop,
// the cost of a wrong press is a keystroke in someone else's terminal.

/** Where the pending approval came from. */
export type ApprovalPromptOrigin = 'hook' | 'detector';

/**
 * The facts a press decision needs. Every field is optional and `undefined`
 * means "not established" — never "fine". See the fail-closed note above.
 */
export interface ApprovalPressFacts {
  /**
   * Who is answering. A human at the phone or the web UI is looking at the
   * prompt and is not subject to any of this; only an automated resolver is.
   */
  resolver?: ApprovalResolverKind;
  /** approve or deny. A deny is always permitted — see the header. */
  decision?: 'approve' | 'deny';
  /**
   * Whether the workspace-shaped facts could be looked up at all. False means
   * the lookup itself is missing (main never wired it), which is a different
   * problem from a workspace that answered "no" — and it must be visible, not
   * silently indistinguishable.
   */
  scopeAvailable?: boolean;
  /** The target pane's workspace is a WorkTask task workspace. */
  isTaskWorkspace?: boolean;
  /** The target workspace's deck autonomy mode ('off' | 'assist' | 'danger').
   *  Reported for the refusal message and for the mode-level floor; the
   *  capability below is what actually authorizes. */
  autonomyMode?: string;
  /**
   * The workspace's EFFECTIVE `approvalPress` capability, as main stores it —
   * the mode ceiling already narrowed by any running loop's tier. This is the
   * authorization; `autonomyMode` is context. Undefined = not established.
   */
  approvalPress?: boolean;
  /** Which signal created the pending approval. */
  origin?: ApprovalPromptOrigin;
  /** A re-read taken now still shows an answerable prompt. */
  stillOnScreen?: boolean;
  /**
   * The LIVE mode of the task's one open owner workspace. Undefined when the
   * task has no single open owner (none, or several) — never "fine".
   */
  ownerMode?: string;
  /** The record's own risk flag (see ApprovalRequest.risk). */
  risk?: 'critical';
  /** How the record was tied to its pane (see ApprovalRequest.attribution). */
  attribution?: 'exact' | 'inexact';
  /** The caller declared the HQ lane; `laneOpen` is main's published policy,
   *  re-read at release and matched against the caller's generation. */
  lane?: 'hq';
  laneOpen?: boolean;
}

/** Who is answering the prompt. */
export type ApprovalResolverKind = 'human' | 'automated';

export type ApprovalPressRefusal =
  | 'scope-unavailable'
  | 'workspace-unknown'
  | 'not-a-task-workspace'
  | 'autonomy-unknown'
  | 'autonomy-off'
  | 'unknown-autonomy-mode'
  | 'press-capability-unknown'
  | 'press-capability-off'
  | 'origin-unknown'
  | 'detector-only'
  | 'prompt-gone'
  | 'owner-mode-unknown'
  | 'owner-autonomy-off'
  | 'owner-not-danger'
  | 'critical-risk'
  | 'attribution-inexact'
  | 'hq-lane-closed';

export type ApprovalPressDecision =
  | { press: true }
  | { press: false; reason: ApprovalPressRefusal };

/**
 * Deck autonomy modes that mean "an agent may act here". Whitelisted, not
 * blacklisted: matching only the literal 'off' meant a mode this daemon has
 * never heard of — a typo in the store, a newer main writing a name we predate
 * — read as permission. An unrecognised setting is not consent.
 *
 * These are the REAL modes main writes (`AgentMode` in deck/deckAutonomyStore:
 * 'off' | 'assist' | 'danger'). An earlier list carried 'manual', which no
 * store has ever produced — a whitelist entry that can never match is not
 * dangerous, but it made the vocabulary look like something it is not.
 */
const AUTONOMY_ON_MODES: ReadonlySet<string> = new Set(['assist', 'danger']);

/**
 * May an approval be pressed into this pane? Pure — the caller gathers the
 * facts, this decides. Order is narrowest-blame-first so the reported reason
 * names the condition an operator can actually act on.
 */
export function decideApprovalPress(facts: ApprovalPressFacts): ApprovalPressDecision {
  // A human is looking at the prompt they are answering. Nothing below applies.
  if (facts.resolver === 'human') return { press: true };
  // Denying is the safe direction — it cancels the tool call and gives the turn
  // back. A refused deny would keep a pane blocked in the name of safety.
  if (facts.decision === 'deny') return { press: true };
  // Critical first: whatever else is true of this pane, a machine never says
  // yes to it, and the refusal must say so rather than name a policy the
  // caller would escalate as a decision (the approval is already the human's).
  if (facts.risk === 'critical') return { press: false, reason: 'critical-risk' };
  // A record tied to its pane by a guess (workspace or cwd) may belong to an
  // agent wmux did not launch.
  if (facts.attribution !== 'exact') return { press: false, reason: 'attribution-inexact' };
  if (facts.lane === 'hq' && facts.laneOpen !== true) return { press: false, reason: 'hq-lane-closed' };
  if (facts.scopeAvailable === false) return { press: false, reason: 'scope-unavailable' };
  if (facts.isTaskWorkspace === undefined) return { press: false, reason: 'workspace-unknown' };
  if (!facts.isTaskWorkspace) return { press: false, reason: 'not-a-task-workspace' };
  if (facts.autonomyMode === undefined) return { press: false, reason: 'autonomy-unknown' };
  if (facts.autonomyMode === 'off') return { press: false, reason: 'autonomy-off' };
  if (!AUTONOMY_ON_MODES.has(facts.autonomyMode)) {
    return { press: false, reason: 'unknown-autonomy-mode' };
  }
  // The capability, not the mode, is what the operator's own UI shows as
  // "approval-press". A running `report` loop narrows it to false inside a
  // 'danger' workspace, and pressing there would contradict the readout the
  // brain itself is given (CommanderEventCoalescer's autonomy line).
  if (facts.approvalPress === undefined) return { press: false, reason: 'press-capability-unknown' };
  if (!facts.approvalPress) return { press: false, reason: 'press-capability-off' };
  if (facts.origin === undefined) return { press: false, reason: 'origin-unknown' };
  if (facts.origin !== 'hook') return { press: false, reason: 'detector-only' };
  // The owner's live word beats the task workspace's copy of it. Only `danger`
  // means "nothing prompts", so only `danger` lets an automated approve through.
  if (facts.ownerMode === undefined) return { press: false, reason: 'owner-mode-unknown' };
  if (facts.ownerMode === 'off') return { press: false, reason: 'owner-autonomy-off' };
  if (facts.ownerMode !== 'danger') return { press: false, reason: 'owner-not-danger' };
  if (facts.stillOnScreen !== true) return { press: false, reason: 'prompt-gone' };
  return { press: true };
}
