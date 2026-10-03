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
// `2. Cancel`). A single single-select question draws a one-tab bar
// (` ☐ Color`) with no Submit tab; its digit submits at once. A single
// multi-select question draws the Submit tab too on Claude Code 2.1.288
// (`←  ☐ Fruit  ✔ Submit  →`), and Enter on its Submit row draws the review.
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
  /** Question view: the rows under it up to the next one (its wrapped label, then its description), trimmed. */
  more?: string[];
}

interface AskPickerTabs {
  /** One per question, in order; `answered` is a `☒` (else `☐`). */
  tabs: Array<{ label: string; answered: boolean }>;
  /** The trailing `✔ Submit` tab (drawn for several questions, or one multi-select). */
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
  /**
   * Multi-select: the in-question Submit row under the free-text row. Claude
   * Code 2.1.288 labels it `Next` on a question that is not the last one.
   */
  submitRow?: { cursor: boolean; next: boolean };
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
const SUBMIT_ROW = /^(❯| ) {4}(Submit|Next)$/;
const FREE_TEXT_PLACEHOLDER = /^Type something\.?$/;
const ANSWERED_HEADER = "User answered Claude's questions:";
const ANSWERED_ENTRY = /^(?:⎿\s+)?·\s+(.*)$/;
const CHAT_ROW_LABEL = 'Chat about this';
/** The key hint under a question view (its rows joined with one space). */
const HINT = /^Enter to select · .+ · Esc to cancel$/;

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

/**
 * Free text whose echo could not be told apart from the empty row: the echo
 * check compares texts with every space removed, so `Type some thing` reads
 * as the placeholder too.
 */
export function isFreeTextPlaceholder(text: string): boolean {
  return /^Typesomething\.?$/.test(compact(text));
}

/**
 * Free text that, typed into the "Other" row, starts the row like a checkbox
 * (`[ ] `, `[✔] `): the row would no longer read as the free-text row.
 */
export function readsAsCheckbox(text: string): boolean {
  return /^\s*\[( |✔)\]/.test(text);
}

/**
 * The same question text: compared with every space removed, because Claude
 * wraps a text with no spaces (CJK, a long path) inside a word, and the review
 * and answered-block rows are narrower than the picker's. The whole text, never
 * a prefix: two questions may start alike.
 */
export function sameQuestionText(screen: string, form: string): boolean {
  const text = compact(screen);
  return text.length > 0 && text === compact(form);
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
  let submitRow: { cursor: boolean; next: boolean } | undefined;
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
      submitRow = { cursor: s[1] === '❯', next: s[2] === 'Next' };
      continue;
    }
    // Anything else continues the option above it: its wrapped label, then
    // its description.
    if (row.trim()) {
      if (submitRow || options.length === 0) return null;
      (options[options.length - 1]!.more ??= []).push(row.trim());
    }
  }
  // No bottom rule: not a whole picker.
  if (i >= rows.length || options.length === 0) return null;
  if (!onlyHintBelow(rows, i + 1, String(options.length + 1))) return null;
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

/**
 * Under a question view's bottom rule Claude draws its `N. Chat about this`
 * row and the key hint, nothing else. Any other row (another menu, an input
 * prompt) means this is not the question that is up.
 */
function onlyHintBelow(rows: readonly string[], from: number, chatKey: string): boolean {
  const hint: string[] = [];
  let chat = false;
  for (let i = from; i < rows.length; i++) {
    const text = rows[i]!.trim();
    if (!text) continue;
    const m = OPTION_ROW.exec(rows[i]!);
    if (m && !chat && hint.length === 0 && m[2] === chatKey && normalize(m[3]!) === CHAT_ROW_LABEL) {
      chat = true;
      continue;
    }
    hint.push(text);
  }
  return HINT.test(normalize(hint.join(' ')));
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

/** The row of the LAST tab bar drawn right under a `────` rule, or -1. Rows are right-trimmed. */
function lastTabBar(rows: readonly string[]): number {
  for (let bar = rows.length - 1; bar > 0; bar--) {
    if (RULE.test(rows[bar - 1]!.trim()) && parseTabBar(rows[bar]!)) return bar;
  }
  return -1;
}

/**
 * The AskUserQuestion picker at the bottom of the grid, or null. The picker is
 * the LAST tab bar drawn right under a `────` rule; a question view must end
 * at its bottom rule, a review view with its numbered rows.
 */
export function parseAskPicker(rawRows: readonly string[]): AskPickerScreen | null {
  const rows = rawRows.map((row) => row.replace(/\s+$/, ''));
  const bar = lastTabBar(rows);
  if (bar >= 0) {
    const tabs = parseTabBar(rows[bar]!)!;
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
 * What the screen showed right before the key that may close the picker:
 * the last rows drawn above the picker (`anchor`, at most three non-empty
 * rows) and how many answered blocks were on screen. Claude draws the new
 * answered block where the picker was, below the anchor.
 */
export interface AskConfirmBaseline {
  anchor: string[];
  blocks: number;
}

export function askConfirmBaseline(rawRows: readonly string[]): AskConfirmBaseline {
  const rows = rawRows.map((row) => row.replace(/\s+$/, ''));
  const bar = lastTabBar(rows);
  const above = bar > 0 ? rows.slice(0, bar - 1).filter((row) => row.trim()) : [];
  return { anchor: above.slice(-3), blocks: countAnsweredBlocks(rows) };
}

/** The row after the last place the anchor's rows appear in order (blank rows between them skipped), or -1. */
function afterAnchor(rows: readonly string[], anchor: readonly string[]): number {
  if (anchor.length === 0) return -1;
  const filled: number[] = [];
  rows.forEach((row, i) => { if (row.trim()) filled.push(i); });
  for (let k = filled.length - anchor.length; k >= 0; k--) {
    if (anchor.every((text, j) => rows[filled[k + j]!]!.replace(/\s+$/, '') === text)) {
      return filled[k + anchor.length - 1]! + 1;
    }
  }
  return -1;
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

/**
 * An option row and the rows under it read as exactly this option: whole rows
 * that are its whole label (Claude wraps a long label onto the description's
 * indent), then rows that are its whole description, compared with every
 * space removed. A label Claude cut short does not match.
 */
function sameOption(row: AskPickerRow, option: AskFormQuestion['options'][number]): boolean {
  const rows = [row.label, ...(row.more ?? [])].map(compact);
  const label = compact(option.label);
  const description = compact(option.description ?? '');
  for (let k = 1; k <= rows.length; k++) {
    if (rows.slice(0, k).join('') === label) return rows.slice(k).join('') === description;
  }
  return false;
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
    && (questions.length > 1
      ? screen.submitTab
      // One question: a multi-select draws the Submit tab (measured on 2.1.288);
      // the bar without it is still read as the same picker.
      : !screen.submitTab || questions[0]!.multiSelect === true);
}

/**
 * Does the screen show exactly what `expect` says? `closed` and
 * `review-or-closed` are judged by `answersConfirmed` instead (never here).
 *
 * A question view must be question `q` (its whole text, and its options by key
 * and label, the free-text row last), the tabs before it answered and the ones
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
    return questions.every((q, j) => sameQuestionText(screen.entries[j]!.question, q.text)
      && answerListMatches(screen.entries[j]!.answer, answerLabels(q, answers[j]!)));
  }
  if (expect.view !== 'question' || screen.view !== 'question') return false;
  const question = questions[expect.q];
  if (!question || !sameQuestionText(screen.question, question.text)) return false;
  if (!screen.tabs.every((tab, j) => j === expect.q || tab.answered === j < expect.q)) return false;
  if (screen.multiSelect !== question.multiSelect) return false;
  if (question.multiSelect ? !screen.submitRow : !!screen.submitRow) return false;
  // The row reads `Next` where another question follows and `Submit` on the
  // last one (measured on 2.1.288).
  if (screen.submitRow && screen.submitRow.next !== expect.q < questions.length - 1) return false;
  const otherKey = String(question.options.length + 1);
  if (screen.options.length !== question.options.length + 1) return false;
  const rowsMatch = question.options.every((o, j) => {
    const row = screen.options[j]!;
    return row.key === o.key && sameOption(row, o);
  });
  if (!rowsMatch) return false;
  const free = screen.options[screen.options.length - 1]!;
  if (free.key !== otherKey || (free.more ?? []).length > 0) return false;
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

/** The screen is this prompt's review (its tabs, every one answered), whatever answers it lists. */
export function askReviewOf(screen: AskPickerScreen | null, questions: readonly AskFormQuestion[]): boolean {
  return !!screen && screen.view === 'review' && tabsMatch(screen, questions) && screen.tabs.every((tab) => tab.answered);
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
 * Has the answer landed, as far as the screen can tell? This prompt's picker
 * is gone (another prompt's may already be up: Claude can ask a follow-up at
 * once), and a "User answered Claude's questions:" block drawn after the
 * last key lists every question with exactly the answer given. A block
 * counts as new when it is below the baseline's anchor (the rows that were
 * above the picker); when the anchor is no longer on screen, only when there
 * are more blocks than before. An older block for the same question can
 * still be on screen, above the anchor.
 */
export function answersConfirmed(
  rows: readonly string[],
  baseline: AskConfirmBaseline,
  questions: readonly AskFormQuestion[],
  answers: readonly AskAnswer[],
): boolean {
  const picker = parseAskPicker(rows);
  if (picker && tabsMatch(picker, questions)) return false;
  const from = afterAnchor(rows, baseline.anchor);
  if (from < 0 && countAnsweredBlocks(rows) <= baseline.blocks) return false;
  const block = lastAnsweredBlock(from < 0 ? rows : rows.slice(from));
  if (!block || block.length !== questions.length) return false;
  return questions.every((q, j) => {
    // `question → answer`, compared with every space removed (see sameQuestionText).
    const entry = compact(block[j]!);
    const head = `${compact(q.text)}→`;
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
