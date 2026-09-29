// Claude Code's AskUserQuestion picker, read off the pane's visible grid, and
// the keys that answer it from a `decision-v2` `questions` form (#1649).
//
// Pure: the registry reads the screen and writes the keys (see
// ApprovalRegistry.driveQuestions); this module only says what is on screen,
// which keys an answer takes, and what the screen must show after each one.
//
// Everything here follows the screens measured on Claude Code 2.1.283
// (fixtures/terminal-prompts/claude-ask-*.json, KEYS.md):
//
//    ────────────────────────────────────────────
//    ←  ☒ Size  ☐ Toppings  ✔ Submit  →          tab bar (one tab per question)
//
//    Which toppings?
//
//    ❯ 1. [✔] Cheese                             multi-select rows carry a box
//             Add cheese
//      2. [ ] Olives
//             Add olives
//      3. [ ] Basil
//             Add basil
//      4. [ ] Type something                      the free-text ("Other") row
//         Submit                                  multi-select only
//    ────────────────────────────────────────────
//      5. Chat about this
//
//    Enter to select · Tab/Arrow keys to navigate · Esc to cancel
//
// and, once every question is answered, the review screen ("Review your
// answers", `● question` / `→ answer` pairs, `1. Submit answers`,
// `2. Cancel`). A single question draws a one-tab bar (` ☐ Color`) with no
// Submit tab; its single-select digit submits at once.
//
// Measured key effects (KEYS.md): on a single-select question a digit selects
// and moves to the next tab (or, alone, submits); on a multi-select question a
// digit only toggles its row and the cursor stays put; the free-text row of a
// multi-select takes typing only with the cursor on it (`↓`); `↓` past it lands
// on the in-question Submit row, where Enter moves on; on the review screen `1`
// submits. Anything this module cannot read as exactly what a key should have
// drawn is a mismatch, and the driver stops rather than guess.

import type { DecisionForm } from './types';

export type AskFormQuestion = NonNullable<DecisionForm['questions']>[number];

/** One numbered row of the picker (an option, the free-text row, or a review row). */
export interface AskPickerRow {
  /** The digit drawn before the row ('1', '2', …). */
  key: string;
  /** The row's text, whitespace runs collapsed, without its checkbox. */
  label: string;
  /** Multi-select rows only: the box is ticked. */
  checked?: boolean;
  /** The `❯` cursor is on this row. */
  cursor: boolean;
}

interface AskPickerTabs {
  /** One per question, in order; `answered` is a `☒` (else `☐`). */
  tabs: Array<{ label: string; answered: boolean }>;
  /** The trailing `✔ Submit` tab (drawn when there are several questions). */
  submitTab: boolean;
}

export interface AskPickerQuestionView extends AskPickerTabs {
  view: 'question';
  /** The question text, wrapped rows joined with one space. */
  question: string;
  /** Every numbered row above the bottom rule; the free-text row is the last. */
  options: AskPickerRow[];
  /** Whether the rows carry checkboxes. */
  multiSelect: boolean;
  /** Multi-select: the in-question Submit row under the free-text row. */
  submitRow?: { cursor: boolean };
}

export interface AskPickerReviewView extends AskPickerTabs {
  view: 'review';
  /** `● question` / `→ answer` pairs, wrapped rows joined with one space. */
  entries: Array<{ question: string; answer: string }>;
  /** `1. Submit answers`, `2. Cancel`. */
  rows: AskPickerRow[];
}

export type AskPickerScreen = AskPickerQuestionView | AskPickerReviewView;

/** What the screen must show once a key has drawn. */
export type AskExpectation =
  /** Question `q` on screen: the cursor on option `cursor` (or the Submit row), exactly `checked` ticked, the free-text row showing `other` (null: its placeholder). */
  | { view: 'question'; q: number; cursor: string | 'submit'; checked: readonly string[]; other: string | null }
  /** The review screen, listing every question with the answer given. */
  | { view: 'review' }
  /** The picker is gone and Claude's transcript shows the answers (the last key). */
  | { view: 'closed' }
  /** A single multi-select question: its review screen, or — unmeasured — the picker already closed. */
  | { view: 'review-or-closed' };

export interface AskStep {
  /** The bytes of one key (a bracketed paste counts as one). */
  key: string;
  expect: AskExpectation;
}

/** One question's answer: the chosen option keys, and the free text typed into its "Other" row. */
export interface AskAnswer {
  keys: readonly string[];
  other?: string;
}

const RULE = /^─{10,}$/;
const OPTION_ROW = /^(❯ | {2})(\d{1,2})\. (.*)$/;
const CHECKBOX = /^\[( |✔)\] ?(.*)$/;
const SUBMIT_ROW = /^(❯| ) {4}Submit$/;
const FREE_TEXT_PLACEHOLDER = /^Type something\.?$/;
const ANSWERED_HEADER = "User answered Claude's questions:";
const ANSWERED_ENTRY = /^(?:⎿\s+)?·\s+(.*)$/;

export const ASK_KEY_DOWN = '\x1b[B';
export const ASK_KEY_ENTER = '\r';
/** The review screen's "Submit answers" row (measured: `1`). */
export const ASK_KEY_REVIEW_SUBMIT = '1';
/** The other-text width allowed when the pane's width is unknown (fits one row of an 80-column pane). */
export const ASK_OTHER_FALLBACK_WIDTH = 68;
/** Bound on the answer-list matcher's work: labels are agent-authored. */
const LIST_MATCH_BUDGET = 10_000;

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
const compact = (text: string): string => text.replace(/\s+/g, '');

/**
 * The widest free text the "Other" row can show on one row of a `cols`-wide
 * pane (a wide character counts two), so the driver can read it back whole
 * before it moves on: the grid less the row's `❯ N. [✔] ` prefix and a margin.
 */
export function askOtherMaxWidth(cols: number | undefined): number {
  if (!cols) return ASK_OTHER_FALLBACK_WIDTH;
  return Math.min(2000, Math.max(0, cols - 12));
}

/** Free text whose echo could not be told apart from the empty row. */
export function isFreeTextPlaceholder(text: string): boolean {
  return FREE_TEXT_PLACEHOLDER.test(normalize(text));
}

function parseTabBar(row: string): AskPickerTabs | null {
  let text = row.trim();
  if (text.startsWith('←')) text = text.slice(1).trim();
  if (text.endsWith('→')) text = text.slice(0, -1).trim();
  if (!/^[☐☒✔] /.test(text)) return null;
  // [mark, label, mark, label, …]
  const parts = text.split(/([☐☒✔])/).slice(1);
  const tabs: AskPickerTabs['tabs'] = [];
  let submitTab = false;
  for (let k = 0; k < parts.length; k += 2) {
    const mark = parts[k]!;
    const label = normalize(parts[k + 1] ?? '');
    if (!label || submitTab) return null;
    if (mark === '✔') {
      if (label !== 'Submit') return null;
      submitTab = true;
    } else {
      tabs.push({ label, answered: mark === '☒' });
    }
  }
  return tabs.length > 0 ? { tabs, submitTab } : null;
}

function parseQuestionView(rows: readonly string[], start: number, bar: AskPickerTabs): AskPickerQuestionView | null {
  const text: string[] = [];
  let i = start;
  for (; i < rows.length && !OPTION_ROW.test(rows[i]!); i++) {
    if (RULE.test(rows[i]!.trim())) return null;
    if (rows[i]!.trim()) text.push(rows[i]!.trim());
  }
  if (text.length === 0) return null;
  const options: AskPickerRow[] = [];
  let multiSelect: boolean | undefined;
  let submitRow: { cursor: boolean } | undefined;
  let lastOption = -1;
  for (; i < rows.length; i++) {
    const row = rows[i]!;
    if (RULE.test(row.trim())) break;
    const m = OPTION_ROW.exec(row);
    if (m) {
      if (submitRow) return null;
      const box = CHECKBOX.exec(m[3]!);
      if (multiSelect === undefined) multiSelect = !!box;
      else if (multiSelect !== !!box) return null;
      options.push({
        key: m[2]!,
        label: normalize(box ? box[2]! : m[3]!),
        cursor: m[1] === '❯ ',
        ...(box ? { checked: box[1] === '✔' } : {}),
      });
      lastOption = i;
      continue;
    }
    // The Submit row sits right under the free-text row, and only on a
    // multi-select (a single-select description row may read "Submit" too).
    const s = SUBMIT_ROW.exec(row);
    if (s && multiSelect && !submitRow && lastOption === i - 1) {
      submitRow = { cursor: s[1] === '❯' };
      continue;
    }
    // Anything else is an option's description row.
  }
  // No bottom rule: not a whole picker.
  if (i >= rows.length || options.length === 0) return null;
  if (options.filter((o) => o.cursor).length + (submitRow?.cursor ? 1 : 0) > 1) return null;
  return {
    view: 'question',
    ...bar,
    question: normalize(text.join(' ')),
    options,
    multiSelect: multiSelect === true,
    ...(submitRow ? { submitRow } : {}),
  };
}

function parseReviewView(rows: readonly string[], start: number, bar: AskPickerTabs): AskPickerReviewView | null {
  const entries: Array<{ question: string[]; answer: string[] }> = [];
  let mode: 'question' | 'answer' | null = null;
  let i = start;
  for (; i < rows.length; i++) {
    const text = rows[i]!.trim();
    if (text === 'Ready to submit your answers?') break;
    if (!text) {
      mode = null;
      continue;
    }
    const current = entries[entries.length - 1];
    if (text.startsWith('● ')) {
      entries.push({ question: [text.slice(2)], answer: [] });
      mode = 'question';
    } else if (text.startsWith('→ ')) {
      if (!current || current.answer.length > 0) return null;
      current.answer.push(text.slice(2));
      mode = 'answer';
    } else if (current && mode) {
      current[mode].push(text);
    } else {
      return null;
    }
  }
  if (i >= rows.length || entries.length === 0 || entries.some((e) => e.answer.length === 0)) return null;
  const choiceRows: AskPickerRow[] = [];
  for (i++; i < rows.length; i++) {
    const row = rows[i]!;
    if (!row.trim()) continue;
    const m = OPTION_ROW.exec(row);
    if (!m) return null;
    choiceRows.push({ key: m[2]!, label: normalize(m[3]!), cursor: m[1] === '❯ ' });
  }
  if (choiceRows.length === 0) return null;
  return {
    view: 'review',
    ...bar,
    entries: entries.map((e) => ({ question: normalize(e.question.join(' ')), answer: normalize(e.answer.join(' ')) })),
    rows: choiceRows,
  };
}

/**
 * The AskUserQuestion picker at the bottom of the grid, or null. The picker is
 * the LAST tab bar drawn right under a `────` rule; a question view must end
 * at its bottom rule, a review view with its numbered rows.
 */
export function parseAskPicker(rawRows: readonly string[]): AskPickerScreen | null {
  const rows = rawRows.map((row) => row.replace(/\s+$/, ''));
  for (let bar = rows.length - 1; bar > 0; bar--) {
    if (!RULE.test(rows[bar - 1]!.trim())) continue;
    const tabs = parseTabBar(rows[bar]!);
    if (!tabs) continue;
    let i = bar + 1;
    while (i < rows.length && !rows[i]!.trim()) i++;
    if (i >= rows.length) return null;
    return rows[i]!.trim() === 'Review your answers'
      ? parseReviewView(rows, i + 1, tabs)
      : parseQuestionView(rows, i, tabs);
  }
  return null;
}

/** How many "User answered Claude's questions:" blocks the grid shows. */
export function countAnsweredBlocks(rows: readonly string[]): number {
  return rows.filter((row) => row.trim().endsWith(ANSWERED_HEADER)).length;
}

/**
 * The entries of the LAST "User answered Claude's questions:" block
 * (`· question → answer`, wrapped rows joined with one space), or null.
 */
export function lastAnsweredBlock(rows: readonly string[]): string[] | null {
  let at = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.trim().endsWith(ANSWERED_HEADER)) { at = i; break; }
  }
  if (at < 0) return null;
  const entries: string[][] = [];
  for (let i = at + 1; i < rows.length; i++) {
    const text = rows[i]!.trim();
    if (!text) break;
    const m = ANSWERED_ENTRY.exec(text);
    if (m) entries.push([m[1]!]);
    else if (entries.length > 0) entries[entries.length - 1]!.push(text);
    else return null;
  }
  return entries.length > 0 ? entries.map((e) => normalize(e.join(' '))) : null;
}

/**
 * Whether `text` lists exactly `labels`, each once, joined by commas, in any
 * order (Claude lists a multi-select answer in an order not measured apart
 * from sorted). Compared with every space removed, so a row that wrapped
 * reads the same. Null-safe against pathological labels by a work budget.
 */
export function answerListMatches(text: string, labels: readonly string[]): boolean {
  const target = compact(text);
  const wanted = labels.map(compact);
  if (wanted.length === 0 || wanted.some((label) => !label)) return false;
  const used = wanted.map(() => false);
  let budget = LIST_MATCH_BUDGET;
  const match = (pos: number, left: number): boolean => {
    if (--budget < 0) return false;
    if (left === 0) return pos === target.length;
    for (let k = 0; k < wanted.length; k++) {
      if (used[k] || !target.startsWith(wanted[k]!, pos)) continue;
      const end = pos + wanted[k]!.length;
      if (left > 1 ? target[end] !== ',' : end !== target.length) continue;
      used[k] = true;
      if (match(left > 1 ? end + 1 : end, left - 1)) return true;
      used[k] = false;
    }
    return false;
  };
  return match(0, wanted.length);
}

/** `text` equals `full`, or is a prefix of it at least `min` characters long (all of a shorter `full`). */
function isCutOf(text: string, full: string, min: number): boolean {
  const cut = normalize(text).replace(/…$/, '').trimEnd();
  const whole = normalize(full);
  if (!cut) return false;
  if (cut === whole) return true;
  return whole.startsWith(cut) && cut.length >= Math.min(whole.length, min);
}

/** The labels an answer shows as: the chosen options' labels, then the free text. */
export function answerLabels(question: AskFormQuestion, answer: AskAnswer): string[] {
  return [
    ...question.options.filter((o) => answer.keys.includes(o.key)).map((o) => o.label),
    ...(answer.other !== undefined ? [answer.other] : []),
  ];
}

/** Tab `j` of `screen` is question `j` of the form. */
function tabsMatch(screen: AskPickerTabs, questions: readonly AskFormQuestion[]): boolean {
  return screen.tabs.length === questions.length
    && screen.tabs.every((tab, j) => tab.label === normalize(questions[j]!.header ?? ''))
    && screen.submitTab === questions.length > 1;
}

/**
 * Does the screen show exactly what `expect` says? `closed` and
 * `review-or-closed` are judged by `answersConfirmed` instead (never here).
 *
 * A question view must be question `q` (its text, and its options by key and
 * label, the free-text row last), the tabs before it answered and the ones
 * after it not (the current tab's own mark is not checked: when it turns is
 * not measured for every shape), the cursor where `expect` puts it, exactly
 * the expected boxes ticked, and the free-text row showing its placeholder or
 * exactly the typed text. A review view must list every question with the
 * answer given, and offer `1. Submit answers` / `2. Cancel`.
 */
export function askScreenMeets(
  screen: AskPickerScreen | null,
  expect: AskExpectation,
  questions: readonly AskFormQuestion[],
  answers: readonly AskAnswer[],
): boolean {
  if (!screen || !tabsMatch(screen, questions)) return false;
  if (expect.view === 'review') {
    if (screen.view !== 'review' || screen.entries.length !== questions.length) return false;
    if (!screen.tabs.every((tab) => tab.answered)) return false;
    const [submit, cancel] = screen.rows;
    if (screen.rows.length !== 2 || submit?.key !== ASK_KEY_REVIEW_SUBMIT || submit.label !== 'Submit answers'
      || cancel?.key !== '2' || cancel.label !== 'Cancel') {
      return false;
    }
    return questions.every((q, j) => isCutOf(screen.entries[j]!.question, q.text, 8)
      && answerListMatches(screen.entries[j]!.answer, answerLabels(q, answers[j]!)));
  }
  if (expect.view !== 'question' || screen.view !== 'question') return false;
  const question = questions[expect.q];
  if (!question || !isCutOf(screen.question, question.text, 8)) return false;
  if (!screen.tabs.every((tab, j) => j === expect.q || tab.answered === j < expect.q)) return false;
  if (screen.multiSelect !== question.multiSelect) return false;
  if (question.multiSelect ? !screen.submitRow : !!screen.submitRow) return false;
  const otherKey = String(question.options.length + 1);
  if (screen.options.length !== question.options.length + 1) return false;
  const rowsMatch = question.options.every((o, j) => {
    const row = screen.options[j]!;
    return row.key === o.key && isCutOf(row.label, o.label, 3);
  });
  if (!rowsMatch) return false;
  const free = screen.options[screen.options.length - 1]!;
  if (free.key !== otherKey) return false;
  if (expect.other === null ? !FREE_TEXT_PLACEHOLDER.test(free.label) : compact(free.label) !== compact(expect.other)) return false;
  if (question.multiSelect) {
    const ticked = screen.options.filter((o) => o.checked).map((o) => o.key).sort();
    if (ticked.join(',') !== [...expect.checked].sort().join(',')) return false;
  } else if (expect.checked.length > 0) {
    return false;
  }
  return expect.cursor === 'submit'
    ? screen.submitRow?.cursor === true
    : screen.options.find((o) => o.cursor)?.key === expect.cursor;
}

/**
 * The picker as it is drawn before anyone touched it: the first question,
 * no tab answered, the cursor on its first option, nothing ticked, the
 * free-text row empty.
 */
export function askPickerUntouched(screen: AskPickerScreen | null, questions: readonly AskFormQuestion[]): boolean {
  return !!screen
    && screen.tabs.every((tab) => !tab.answered)
    && askScreenMeets(screen, { view: 'question', q: 0, cursor: '1', checked: [], other: null }, questions, []);
}

/**
 * Has the answer landed, as far as the screen can tell? The picker is gone, a
 * new "User answered Claude's questions:" block appeared (more of them than
 * `blocksBefore`, the count on the last screen read before the final key — an
 * older block for the same question can still be on screen), and that last
 * block lists every question with exactly the answer given.
 */
export function answersConfirmed(
  rows: readonly string[],
  blocksBefore: number,
  questions: readonly AskFormQuestion[],
  answers: readonly AskAnswer[],
): boolean {
  if (parseAskPicker(rows)) return false;
  if (countAnsweredBlocks(rows) <= blocksBefore) return false;
  const block = lastAnsweredBlock(rows);
  if (!block || block.length !== questions.length) return false;
  return questions.every((q, j) => {
    const entry = block[j]!;
    const head = `${normalize(q.text)} → `;
    return entry.startsWith(head) && answerListMatches(entry.slice(head.length), answerLabels(q, answers[j]!));
  });
}

/**
 * The keys that put `answers` into the untouched picker, each with what the
 * screen must show once it has drawn. Follows the measured order: on a
 * multi-select, the chosen options' digits (the cursor stays on row 1), then
 * for free text the free-text row's digit (ticks it), `↓` one row at a time
 * onto it, the text as one bracketed paste, `↓` onto the Submit row and Enter;
 * without free text `↓` through the rows onto the Submit row and Enter. On a
 * single-select, the option's digit, or the free-text row's digit (the
 * cursor moves into its field), the paste and Enter. Several questions end on
 * the review screen and its `1`.
 */
export function askAnswerSteps(questions: readonly AskFormQuestion[], answers: readonly AskAnswer[]): AskStep[] {
  const steps: AskStep[] = [];
  const count = questions.length;
  const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`;
  // What the screen shows once question `i` is answered and the picker moves on.
  const next = (i: number): AskExpectation => {
    if (i < count - 1) return { view: 'question', q: i + 1, cursor: '1', checked: [], other: null };
    if (count > 1) return { view: 'review' };
    return questions[i]!.multiSelect ? { view: 'review-or-closed' } : { view: 'closed' };
  };
  questions.forEach((question, i) => {
    const answer = answers[i]!;
    const otherKey = String(question.options.length + 1);
    const keys = [...answer.keys].sort((a, b) => Number(a) - Number(b));
    const at = (cursor: string, checked: readonly string[], other: string | null): AskExpectation =>
      ({ view: 'question', q: i, cursor, checked: [...checked], other });
    if (question.multiSelect) {
      const checked: string[] = [];
      for (const key of keys) {
        checked.push(key);
        steps.push({ key, expect: at('1', checked, null) });
      }
      if (answer.other !== undefined) {
        checked.push(otherKey);
        steps.push({ key: otherKey, expect: at('1', checked, null) });
      }
      for (let row = 2; row <= question.options.length + 1; row++) {
        steps.push({ key: ASK_KEY_DOWN, expect: at(String(row), checked, null) });
      }
      if (answer.other !== undefined) steps.push({ key: paste(answer.other), expect: at(otherKey, checked, answer.other) });
      steps.push({ key: ASK_KEY_DOWN, expect: at('submit', checked, answer.other ?? null) });
      steps.push({ key: ASK_KEY_ENTER, expect: next(i) });
    } else if (answer.other !== undefined) {
      steps.push({ key: otherKey, expect: at(otherKey, [], null) });
      steps.push({ key: paste(answer.other), expect: at(otherKey, [], answer.other) });
      steps.push({ key: ASK_KEY_ENTER, expect: next(i) });
    } else {
      steps.push({ key: keys[0]!, expect: next(i) });
    }
  });
  const last = steps[steps.length - 1]!.expect.view;
  if (last === 'review' || last === 'review-or-closed') {
    steps.push({ key: ASK_KEY_REVIEW_SUBMIT, expect: { view: 'closed' } });
  }
  return steps;
}
