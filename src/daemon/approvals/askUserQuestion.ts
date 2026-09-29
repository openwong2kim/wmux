// A4 — pull the QUESTION and its OPTION LABELS out of a PreToolUse envelope.
//
// Why this exists: approve is encoded as "press the first option" (see
// approvalKeystrokes.ts), and a pending request that does not say WHAT is being
// asked makes that press blind. "Approve" is a safe word for a consent-shaped
// question and a dangerous one for "which file should I delete?" — the phone
// has to show the question text and the options it is choosing between, or the
// operator is answering a question they cannot read.
//
// The input is the raw Claude Code hook payload, forwarded verbatim by the
// bridge (`payload: {...(payload ?? {})}` in wmux-bridge.mjs). It is
// AGENT-AUTHORED and therefore untrusted in both senses that matter here:
//   - shape: any field may be missing or any type. Every access is guarded and
//     an unrecognized shape yields absent fields, never a throw and never a
//     blocked request creation. A request with no question text is still worth
//     far more than no request at all.
//   - content: these strings land in approvals.json, in an HTTP body, and on a
//     phone screen. They are cleaned of control characters (an agent can put
//     ANSI escapes in an option label) and hard-truncated before any of that.
//
// The sanitising follows src/shared/activitySummary.ts, which solves the same
// problem for the Fleet activity line: cap the raw string BEFORE any regex work
// so a multi-MB field cannot make the control-char scan do O(n) work, then
// strip, collapse, trim, and truncate to the display cap.

import type { DecisionForm } from './types';

/** Cap applied BEFORE any regex work on an untrusted string (activitySummary's MAX_RAW_LEN). */
const MAX_RAW_LEN = 1024;

/** Display caps. A phone renders these; anything longer is noise. */
export const MAX_QUESTION_CHARS = 200;
export const MAX_OPTION_LABEL_CHARS = 80;
/** Claude's own permission prompts offer 2-3 options; 8 is slack, not a target. */
export const MAX_OPTIONS = 8;

/**
 * How many raw array entries we will even LOOK at while collecting labels.
 *
 * Separate from MAX_OPTIONS because the two bound different things: that one
 * caps what we keep, this one caps the work. A payload whose entries are all
 * unusable never reaches the MAX_OPTIONS break, so without this the loop runs
 * to the end of an array chosen by whoever wrote the payload.
 */
export const MAX_INSPECTED_OPTIONS = 64;

// C0 controls, DEL, and C1 controls — the same class activitySummary strips.
// Written with hex escapes so the source file stays pure ASCII: a literal
// control byte embedded in a source file is invisible in review and easy for a
// tool to mangle.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * Why one keystroke cannot answer this AskUserQuestion. Absent for the only
 * shape a single press answers whole: ONE single-select question.
 *
 * Measured on Claude Code 2.1.283 (fixtures/terminal-prompts/KEYS.md): on a
 * multi-select question a digit only TOGGLES that row's checkbox, and on the
 * first of several questions a digit selects and moves to the next tab. Either
 * way the tool is still waiting after the press, so reporting it answered
 * would be wrong.
 */
export type QuestionShape = 'multi-select' | 'multi-question';

export interface ExtractedQuestion {
  question?: string;
  options?: string[];
  /** Structured choices preserving the original 1-based index as key. */
  choices?: Array<{ key: string; label: string }>;
  questionShape?: QuestionShape;
}

/**
 * Extract `{question, options, choices}` from a PreToolUse hook payload.
 *
 * The canonical Claude Code `AskUserQuestion` tool_input is
 * `{questions: [{question, header, multiSelect, options: [{label, description}]}]}`.
 * A flatter `{question, options}` and bare-string options are both tolerated,
 * because this runs against whatever a future Claude Code build sends and the
 * cost of guessing wrong is a missing label, not a wrong keystroke.
 *
 * ONLY THE FIRST QUESTION is extracted. AskUserQuestion may carry several, but
 * the keystroke map presses one option on whatever the TUI is showing, which is
 * the first question — surfacing options from a later one would describe a
 * choice the press cannot make. A multi-question prompt is answered whole only
 * through its `decision-v2` form (claudeQuestionsForm, below).
 *
 * `choices` preserves the ORIGINAL 1-based index of each option in the payload
 * array as the `key`. When a label is blank/unusable the entry is dropped from
 * `options` (the legacy array), but the next entry's key still reflects its
 * real position. This is critical: the digit that selects an option in the TUI
 * is its 1-based position in the original array, not its position in the
 * filtered list.
 *
 * Never throws. Any field it cannot make sense of is simply absent.
 */
export function extractAskUserQuestion(payload: unknown): ExtractedQuestion {
  const toolInput = readObject(payload, 'tool_input');
  if (!toolInput) return {};

  // Canonical shape first: questions[0]. Fall back to the flat shape on the
  // tool_input itself.
  const questions = readArray(toolInput, 'questions');
  const source = (questions && isObject(questions[0]) ? questions[0] : toolInput) as Record<
    string,
    unknown
  >;

  const out: ExtractedQuestion = {};
  // Judged on the WHOLE payload, not only the question surfaced below: a
  // second question is exactly what the single press cannot reach.
  if (questions && questions.length > 1) out.questionShape = 'multi-question';
  // Fail closed: anything but an absent or literal-false multiSelect (a string
  // "true", a 1, a future object) is treated as multi-select, which refuses a
  // one-key approve rather than pressing a digit that might only toggle.
  else if (source['multiSelect'] !== undefined && source['multiSelect'] !== null && source['multiSelect'] !== false) {
    out.questionShape = 'multi-select';
  }
  const question = clean(readString(source, 'question'), MAX_QUESTION_CHARS);
  if (question) out.question = question;

  const { options, choices } = readOptionLabelsWithChoices(source);
  if (options.length > 0) out.options = options;
  if (choices.length > 0) out.choices = choices;

  return out;
}

/** Claude Code's AskUserQuestion asks at most this many questions at once. */
export const CLAUDE_FORM_MAX_QUESTIONS = 4;
/**
 * Most options a question may have for a form: with the free-text row after
 * them, every row the driver presses keeps a one-digit number.
 */
export const CLAUDE_FORM_MAX_OPTIONS = 8;
/** The limits `boundDecisionForm` puts on question text and labels. */
const FORM_TEXT_MAX = 500;
const FORM_LABEL_MAX = 200;
// Text that would not reach the screen as it is: C0/C1 controls, DEL, the
// Unicode line and paragraph separators, or a run of whitespace the TUI
// could collapse.
// eslint-disable-next-line no-control-regex -- refusing them is the point
const FORM_UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\s{2,}|^\s|\s$/;

/**
 * The `decision-v2` `questions` form for a Claude Code AskUserQuestion
 * PreToolUse payload (#1649), or null when the payload is not one the
 * stepwise driver can answer whole. Strict where `extractAskUserQuestion` is
 * lenient: only the canonical `{questions: [{question, header, multiSelect,
 * options: [{label}]}]}` shape, 1–4 questions whose texts differ even with
 * every space removed, each with a header (its tab), a literal boolean
 * `multiSelect` and 1–8 options, every string short enough and clean enough
 * to be shown and read back exactly as it is. A string that would be cut or
 * cleaned gets no form: the screen could not be matched against it.
 *
 * Option keys are their 1-based positions, the digit Claude draws. Every
 * question allows free text: Claude appends its "Type something" row to each.
 */
export function claudeQuestionsForm(payload: unknown): DecisionForm | null {
  const raw = readArray(readObject(payload, 'tool_input'), 'questions');
  if (!raw || raw.length === 0 || raw.length > CLAUDE_FORM_MAX_QUESTIONS) return null;
  const showable = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max && !FORM_UNSHOWABLE.test(value);
  const questions: NonNullable<DecisionForm['questions']> = [];
  for (const [i, entry] of raw.entries()) {
    if (!isObject(entry)) return null;
    const { question, header, multiSelect, options } = entry;
    if (!showable(question, FORM_TEXT_MAX) || !showable(header, FORM_LABEL_MAX) || typeof multiSelect !== 'boolean') return null;
    if (!Array.isArray(options) || options.length === 0 || options.length > CLAUDE_FORM_MAX_OPTIONS) return null;
    const labels = options.map((o) => (isObject(o) ? o['label'] : undefined));
    if (!labels.every((label) => showable(label, FORM_LABEL_MAX))) return null;
    // The screen tells questions apart by their text with every space removed
    // (sameQuestionText): two that read the same that way cannot be.
    const compactText = (text: string): string => text.replace(/\s+/g, '');
    if (questions.some((q) => compactText(q.text) === compactText(question))) return null;
    questions.push({
      id: `q${i}`,
      header,
      text: question,
      multiSelect,
      allowOther: true,
      options: (labels as string[]).map((label, j) => ({ key: String(j + 1), label })),
    });
  }
  return { v: 1, kind: 'questions', questions, actions: [{ id: 'submit', label: 'Submit' }, { id: 'deny', label: 'Cancel' }] };
}

/**
 * Option labels, from either `[{label}]` or `['label']`. Entries that yield no
 * usable label are DROPPED rather than kept as empty strings — a blank row on a
 * phone is worse than a shorter list — which is why the index of an option here
 * is not promised to match the digit that selects it. Per-option press (via
 * `choiceKey`) does NOT index into this array: it uses the authoritative key on
 * the parallel `choices` array (see readOptionLabelsWithChoices below). The
 * legacy `options` array is display-only.
 *
 * `choices` preserves the original 1-based index: each entry is `{key, label}`
 * where `key` is the TUI digit (e.g. '1', '2', '3'). Dropped entries still
 * advance the counter so subsequent keys are correct.
 */
function readOptionLabelsWithChoices(source: Record<string, unknown>): {
  options: string[];
  choices: Array<{ key: string; label: string }>;
} {
  const raw = readArray(source, 'options');
  if (!raw) return { options: [], choices: [] };
  const options: string[] = [];
  const choices: Array<{ key: string; label: string }> = [];
  // Bound the entries INSPECTED, not just the labels accepted. Breaking only on
  // `options.length` meant an array of a million nulls yielded nothing and was
  // walked in full, on the daemon's event loop, driven by a hook payload the
  // agent authors. `MAX_INSPECTED_OPTIONS` gives a malformed-but-honest payload
  // some slack while keeping the work constant.
  let inspected = 0;
  for (let i = 0; i < raw.length && inspected < MAX_INSPECTED_OPTIONS; i++) {
    inspected++;
    if (options.length >= MAX_OPTIONS) break;
    const entry = raw[i];
    const label = typeof entry === 'string'
      ? clean(entry, MAX_OPTION_LABEL_CHARS)
      : clean(readString(entry, 'label'), MAX_OPTION_LABEL_CHARS);
    if (label) {
      options.push(label);
      // Key is the 1-based position in the ORIGINAL array — the digit Claude's
      // TUI uses to select this option, regardless of how many prior entries
      // were dropped for being unlabeled.
      choices.push({ key: String(i + 1), label });
    }
  }
  return { options, choices };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readObject(source: unknown, key: string): Record<string, unknown> | null {
  if (!isObject(source)) return null;
  const v = source[key];
  return isObject(v) ? v : null;
}

function readArray(source: unknown, key: string): unknown[] | null {
  if (!isObject(source)) return null;
  const v = source[key];
  return Array.isArray(v) ? v : null;
}

function readString(source: unknown, key: string): string {
  if (!isObject(source)) return '';
  const v = source[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Cap → strip control chars → collapse whitespace → trim → truncate to the
 * display cap. The pre-regex cap is the load-bearing one: without it a
 * multi-megabyte label would make the control-char scan and whitespace collapse
 * do O(n) work on the daemon's event loop, on a path an agent controls.
 */
function clean(s: string, max: number): string {
  if (!s) return '';
  const capped = s.length > MAX_RAW_LEN ? s.slice(0, MAX_RAW_LEN) : s;
  const normalized = capped.replace(CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? normalized.slice(0, max) : normalized;
}

/**
 * Re-apply the caps to values read back from disk. approvals.json is a plain
 * file: a hand-edit (or a record written by an older build with looser caps)
 * must not put an unbounded string into an HTTP response.
 */
export function sanitizeQuestion(value: unknown): string | undefined {
  const out = clean(typeof value === 'string' ? value : '', MAX_QUESTION_CHARS);
  return out || undefined;
}

export function sanitizeOptions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const labels: string[] = [];
  // Same inspected-entry cap as readOptionLabels: this one reads a file on disk,
  // which a hand-edit can make just as large.
  for (const entry of value.slice(0, MAX_INSPECTED_OPTIONS)) {
    if (labels.length >= MAX_OPTIONS) break;
    const label = clean(typeof entry === 'string' ? entry : '', MAX_OPTION_LABEL_CHARS);
    if (label) labels.push(label);
  }
  return labels.length > 0 ? labels : undefined;
}

/**
 * Re-apply caps to `choices` read back from disk. Each entry must have a
 * valid `key` (1-2 digit string) and a non-empty `label`. Entries that fail
 * are dropped.
 */
export function sanitizeChoices(
  value: unknown,
): Array<{ key: string; label: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Array<{ key: string; label: string }> = [];
  for (const entry of value.slice(0, MAX_INSPECTED_OPTIONS)) {
    if (out.length >= MAX_OPTIONS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const key = typeof e['key'] === 'string' ? e['key'] : '';
    const label = clean(typeof e['label'] === 'string' ? e['label'] : '', MAX_OPTION_LABEL_CHARS);
    // Key must be a 1-2 digit string (e.g. '1', '12') — reject the original,
    // do not truncate. A key that does not match is a corrupt or hand-edited
    // record and must be dropped.
    if (/^\d{1,2}$/.test(key) && label) {
      out.push({ key, label });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Re-apply the closed set to a `questionShape` read back from disk. */
export function sanitizeQuestionShape(value: unknown): QuestionShape | undefined {
  return value === 'multi-select' || value === 'multi-question' ? value : undefined;
}
