// Claude's AskUserQuestion picker in a pane too short for all of it (live
// captures on Claude Code 2.1.296, fixtures/terminal-prompts/claude-2.1.296/
// claude-ask-short-*): a phone sizes the pane to its own view, and below 17
// rows at 44 columns the picker's top scrolls off. The parse wanted the `────`
// rule over the tab bar, so every phone answer to such a question came back
// `409 prompt-changed` ("nothing was typed") for as long as the pane stayed
// that size — and at 12 rows the live question was even expired as gone.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ApprovalRegistry, QUESTION_DISMISS_CHECK_MS, TERMINAL_PROMPT_MIN_ANSWER_AGE_MS } from '../ApprovalRegistry';
import { DECISION_V2_WEB_ANSWER, type ApprovalRequest } from '../types';
import { claudeQuestionsForm, extractAskUserQuestion } from '../askUserQuestion';
import { askDeclinedOnScreen, askPickerOnScreen, askPickerUntouched, parseAskPicker } from '../askPicker';

const DIR = path.join(__dirname, 'fixtures', 'terminal-prompts', 'claude-2.1.296');
const screen = (name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as { screen: string[] }).screen;

const WHOLE = screen('claude-ask-short-01-whole-44x17-2.1.296.json');
const RULE_CUT = screen('claude-ask-short-02-rule-cut-44x16-2.1.296.json');
const TABS_CUT = screen('claude-ask-short-03-tabs-cut-44x15-2.1.296.json');
const QUESTION_FIRST = screen('claude-ask-short-04-question-first-44x14-2.1.296.json');
const SCROLLED = screen('claude-ask-short-05-options-scrolled-44x13-2.1.296.json');
const QUESTION_CUT = screen('claude-ask-short-06-question-cut-44x12-2.1.296.json');
const FULL = screen('claude-ask-single-01-whole-100x30-2.1.296.json');
const DISMISSED = screen('claude-ask-dismissed-01-esc-80x24-2.1.296.json');
/**
 * The same dismissal as Windows and Linux draw it: Claude Code marks its reply
 * rows with `●` there and `⏺` only on macOS (#3001).
 */
const DISMISSED_NON_MAC = DISMISSED.map((r) => r.replace(/^⏺/, '●'));
/** A session named with `/rename`: its name rides a rule under the picker's hint. */
const NAMED = screen('claude-ask-named-01-session-label-80x24-2.1.296.json');
const LABEL_ROW = '───────────────────────────────────────────────── workspace-identity-card-plan ─';
/** Claude Code 2.1.283's review screen of a two-question prompt (no hint row). */
const REVIEW = (JSON.parse(fs.readFileSync(path.join(DIR, '..', 'claude-ask-multi-09-review.json'), 'utf8')) as { screen: string[] }).screen;
/** The same question answered at the desk with a digit: Claude reports it answered, not declined. */
const ANSWERED_AT_DESK = DISMISSED.map((r) => r
  .replace('User declined to answer questions', "User answered Claude's questions")
  .replace('· The build failed on the lint step, how should I proceed? (Fix the lint', '· The build failed on the lint step, how should I proceed? → Fix the lint')
  .replace('     errors / Skip lint for now)', '     errors'));

const QUESTION = {
  question: 'The build failed on the lint step, how should I proceed?',
  header: 'Approach',
  multiSelect: false,
  options: [
    { label: 'Fix the lint errors', description: 'Edit the files the linter flagged' },
    { label: 'Skip lint for now', description: 'Commit with the lint step disabled' },
  ],
};
const payload = (questions: unknown[]) => ({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions } });
const PAYLOAD = payload([QUESTION]);
const questionsOf = (p: unknown) => claudeQuestionsForm(p)!.questions!;

describe('the picker in a short pane', () => {
  it.each([
    ['whole (44x17)', WHOLE, false],
    ['the top rule scrolled off (44x16)', RULE_CUT, false],
    ['the tab bar scrolled off (44x15)', TABS_CUT, true],
    ['the question on the first row (44x14)', QUESTION_FIRST, true],
    ['a full-size pane (100x30)', FULL, false],
  ])('%s: still the untouched picker of a one-question single-select form', (_label, rows, topCut) => {
    const picker = parseAskPicker(rows);
    expect(picker).toMatchObject({ view: 'question', question: QUESTION.question });
    expect(picker && 'topCut' in picker).toBe(topCut);
    if (!topCut) expect(picker!.tabs).toEqual([{ label: 'Approach', answered: false }]);
    expect(askPickerUntouched(picker, questionsOf(PAYLOAD))).toBe(true);
  });

  it.each([
    ['the option list scrolled (44x13: "↓ 2.", no free-text row)', SCROLLED],
    ['the question\'s first row scrolled off too (44x12)', QUESTION_CUT],
  ])('%s: not read as the picker, but a picker is known to be up', (_label, rows) => {
    expect(askPickerUntouched(parseAskPicker(rows), questionsOf(PAYLOAD))).toBe(false);
    expect(askPickerOnScreen(rows)).toBe(true);
  });

  it('a hint a narrow pane wraps over three rows, and a review screen with no hint, still count as a picker up', () => {
    const narrow = [...QUESTION_CUT.slice(0, -4), 'Enter to select ·', '↑/↓ to navigate ·', 'Esc to cancel', ''];
    expect(askPickerOnScreen(narrow)).toBe(true);
    expect(askPickerOnScreen(REVIEW)).toBe(true);
    // The hint quoted in the scrollback, with Claude's prompt box under it, is no picker.
    const quoted = ['  Enter to select · ↑/↓ to navigate · Esc to cancel', '', ...DISMISSED.slice(-6)];
    expect(askPickerOnScreen(quoted)).toBe(false);
  });

  it('without its tab bar it matches only one single-select question', () => {
    const picker = parseAskPicker(QUESTION_FIRST);
    // The same question first, then another: which tab is up cannot be seen.
    const two = payload([QUESTION, { ...QUESTION, question: 'And the tests?', header: 'Tests' }]);
    expect(askPickerUntouched(picker, questionsOf(two))).toBe(false);
    // The same rows asked as a multi-select (its Submit tab and review need the bar).
    expect(askPickerUntouched(picker, questionsOf(payload([{ ...QUESTION, multiSelect: true }])))).toBe(false);
    // With the bar on screen, the same two-question form is still told apart by its tabs.
    expect(askPickerUntouched(parseAskPicker(RULE_CUT), questionsOf(two))).toBe(false);
    // A bar-less picker holding several questions says so in its hint: not read at all.
    const severalHint = QUESTION_FIRST.map((r) => r.replace('↑/↓ to navigate', 'Tab/Arrow keys to navigate'));
    expect(parseAskPicker(severalHint)).toBeNull();
  });

  it('rows above a bar-less view are read as its question, so anything else there fails the match', () => {
    const behind = ['⏺ Running the lint step', ...QUESTION_FIRST.slice(1)];
    expect(askPickerUntouched(parseAskPicker(behind), questionsOf(PAYLOAD))).toBe(false);
    const otherQuestion = QUESTION_FIRST.map((r) => r.replace('The build failed on the lint step, how', 'The build failed on the test step, how'));
    expect(askPickerUntouched(parseAskPicker(otherQuestion), questionsOf(PAYLOAD))).toBe(false);
  });

  it('a dismissed question shows no picker', () => {
    expect(parseAskPicker(DISMISSED)).toBeNull();
    expect(askPickerOnScreen(DISMISSED)).toBe(false);
  });
});

describe('the picker in a named session', () => {
  it('reads with the session-name rule under the hint', () => {
    expect(NAMED.filter((r) => r.trim()).at(-1)).toBe(LABEL_ROW);
    const picker = parseAskPicker(NAMED);
    expect(picker).toMatchObject({ view: 'question', tabs: [{ label: 'Approach', answered: false }] });
    expect(askPickerUntouched(picker, questionsOf(PAYLOAD))).toBe(true);
    expect(askPickerOnScreen(NAMED)).toBe(true);
  });

  it.each([
    ['narrower than the picker\'s rules', (rows: string[]) => rows.map((r) => (r === LABEL_ROW ? r.slice(4) : r))],
    ['indented', (rows: string[]) => rows.map((r) => (r === LABEL_ROW ? `  ${r.slice(2)}` : r))],
    ['not the last row', (rows: string[]) => [...rows.filter((r) => r.trim()), 'something else']],
    ['without the closing rule glyph', (rows: string[]) => rows.map((r) => (r === LABEL_ROW ? `${r.slice(0, -2)}  ` : r))],
  ])('only that exact row is dropped: a label row %s still stops the read', (_label, change) => {
    expect(parseAskPicker(change(NAMED))).toBeNull();
  });
});

// ── Through the registry ────────────────────────────────────────────────────

/** Constructed from the 44-column layout Claude draws once the digit lands (the live tail ends `     errors`). */
const ANSWERED_44X14 = [
  '  one short sentence and stop.',
  '',
  '⏺ User answered Claude\'s questions:',
  '  ⎿  · The build failed on the lint step,',
  '     how should I proceed? → Fix the lint',
  '     errors',
  '',
  '',
  '',
  '────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · …',
  '',
];

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ask-short-test-')); });
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function makeRegistry(initial: readonly string[]) {
  const pane = { rows: initial as readonly string[], bytes: 100, keyInputRevision: 3, incarnation: 'inc-1', cols: 44 };
  const stepKeys: string[] = [];
  const scheduled: Array<{ fn: () => Promise<void>; ms: number }> = [];
  const clock = { now: 10_000 };
  let afterKey: readonly string[] | null = null;
  let next = 1;
  const registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => [...pane.rows],
    writeToSession: () => true,
    writeStepKey: (_id, data) => {
      stepKeys.push(data);
      pane.keyInputRevision += 1;
      pane.bytes += 50;
      if (afterKey) pane.rows = afterKey;
      return pane.keyInputRevision;
    },
    noteSubmitted: () => undefined,
    readPromptScreen: async () => ({ rows: pane.rows, mark: { bytes: pane.bytes, keyInputRevision: pane.keyInputRevision, incarnation: pane.incarnation }, cols: pane.cols }),
    promptScreenMark: () => ({ bytes: pane.bytes, keyInputRevision: pane.keyInputRevision, incarnation: pane.incarnation }),
    pendingToolUse: () => null,
    promptReadDelay: async (ms) => { clock.now += ms; },
    schedule: (fn, ms) => { scheduled.push({ fn, ms }); return () => undefined; },
    now: () => clock.now,
    newId: () => `req-${next++}`,
  });
  return { registry, pane, stepKeys, scheduled, clock, drawAfterKey: (rows: readonly string[]) => { afterKey = rows; } };
}

async function create(h: ReturnType<typeof makeRegistry>): Promise<ApprovalRequest> {
  const asked = extractAskUserQuestion(PAYLOAD);
  await h.registry.noteHookAwaitingInput({
    sessionId: 'pty-a',
    agent: 'claude',
    ...(asked.question ? { question: asked.question } : {}),
    ...(asked.options ? { options: asked.options } : {}),
    ...(asked.choices ? { choices: asked.choices } : {}),
    form: claudeQuestionsForm(PAYLOAD)!,
  });
  const [record] = h.registry.list().pending;
  if (!record) throw new Error('no record');
  h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
  return record;
}

const answer = (h: ReturnType<typeof makeRegistry>, record: ApprovalRequest) => h.registry.resolve({
  id: record.id,
  decision: 'approve',
  resolvedBy: 'device Test phone (dev-1)',
  decisionV2Answer: DECISION_V2_WEB_ANSWER,
  decisionAnswer: { formFingerprint: record.formFingerprint!, clientAnswerId: 'answer-00000000001', answers: [{ questionId: 'q0', keys: ['1'] }] },
});

describe('a phone answer in a short pane', () => {
  it('in a named session: one digit, confirmed, resolved', async () => {
    const h = makeRegistry(NAMED);
    h.pane.cols = 80;
    const record = await create(h);
    h.drawAfterKey([
      ...NAMED.slice(0, 9),
      '⏺ User answered Claude\'s questions:',
      '  ⎿  · The build failed on the lint step, how should I proceed? → Fix the lint errors',
      ...Array.from({ length: 13 }, () => ''),
    ]);
    expect(await answer(h, record)).toMatchObject({ ok: true });
    expect(h.stepKeys).toEqual(['1']);
  });

  it('with the tab bar scrolled off: one digit, confirmed on screen, resolved', async () => {
    const h = makeRegistry(QUESTION_FIRST);
    const record = await create(h);
    h.drawAfterKey(ANSWERED_44X14);
    expect(await answer(h, record)).toMatchObject({ ok: true });
    expect(h.stepKeys).toEqual(['1']);
    expect(h.registry.list().pending).toEqual([]);
  });

  it('with the question cut too: nothing typed, and the live question stays pending (not expired as gone)', async () => {
    const h = makeRegistry(QUESTION_CUT);
    const record = await create(h);
    expect(await answer(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.stepKeys).toEqual([]);
    expect(h.registry.list().pending.map((r) => r.id)).toEqual([record.id]);
  });
});

describe('a question dismissed at the desk', () => {
  it.each([
    ['macOS', DISMISSED],
    ['Windows and Linux', DISMISSED_NON_MAC],
  ])('is retired once the screen shows it gone (Esc sends no hook), as %s draws it', async (_platform, dismissed) => {
    expect(askDeclinedOnScreen(dismissed)).toBe(true);
    const h = makeRegistry(FULL);
    const record = await create(h);
    h.pane.rows = dismissed;
    h.registry.noteDialogKey('pty-a');
    expect(h.scheduled.map((s) => s.ms)).toEqual([QUESTION_DISMISS_CHECK_MS]);
    await h.scheduled[0]!.fn();
    expect(h.registry.list().pending).toEqual([]);
    expect(h.registry.list().recentlyResolved.find((r) => r.id === record.id)).toMatchObject({ state: 'expired' });
  });

  it.each([
    ['a picker a short pane scrolled', QUESTION_CUT],
    ['a review screen (several questions answered at the desk, not submitted yet)', REVIEW],
    ['an answer at the desk (its PostToolUse settles it)', ANSWERED_AT_DESK],
  ])('stays while the screen shows %s', async (_label, rows) => {
    const h = makeRegistry(FULL);
    const record = await create(h);
    h.pane.rows = rows;
    h.registry.noteDialogKey('pty-a');
    await h.scheduled[0]!.fn();
    expect(h.registry.list().pending.map((r) => r.id)).toEqual([record.id]);
  });

  it('a phone answer started meanwhile owns the record', async () => {
    const h = makeRegistry(QUESTION_FIRST);
    const record = await create(h);
    h.registry.noteDialogKey('pty-a');
    h.drawAfterKey(DISMISSED);
    // The driver types its digit; the screen then reads as dismissed (it is not).
    await answer(h, record);
    await h.scheduled[0]!.fn();
    expect(h.registry.list().recentlyResolved.find((r) => r.id === record.id)?.state).not.toBe('expired');
  });

  it('only the question pending when the key arrived: a newer one is left alone', async () => {
    const h = makeRegistry(FULL);
    const first = await create(h);
    h.registry.noteDialogKey('pty-a');
    const second = await create(h);
    expect(second.id).not.toBe(first.id);
    h.pane.rows = DISMISSED;
    await h.scheduled[0]!.fn();
    expect(h.registry.list().pending.map((r) => r.id)).toEqual([second.id]);
  });

  it('nothing is scheduled for a pane with no pending question', () => {
    const h = makeRegistry(FULL);
    h.registry.noteDialogKey('pty-a');
    expect(h.scheduled).toEqual([]);
  });
});
