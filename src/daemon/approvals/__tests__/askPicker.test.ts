// Claude Code's AskUserQuestion picker read off the measured screens
// (fixtures/terminal-prompts/claude-ask-*.json), the keys a decision-v2
// answer takes, and the strict form producer (#1649).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ASK_KEY_DOWN,
  ASK_KEY_ENTER,
  answerListMatches,
  answersConfirmed,
  askAnswerSteps,
  askOtherMaxWidth,
  askPickerUntouched,
  askScreenMeets,
  countAnsweredBlocks,
  isFreeTextPlaceholder,
  lastAnsweredBlock,
  parseAskPicker,
  type AskAnswer,
  type AskFormQuestion,
} from '../askPicker';
import { CLAUDE_FORM_MAX_OPTIONS, claudeQuestionsForm } from '../askUserQuestion';

const DIR = path.join(__dirname, 'fixtures', 'terminal-prompts');
// Read with fs, not a JSON import: a JSON import breaks the daemon build.
const screen = (name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as { screen: string[] }).screen;

const MULTI = {
  q1: screen('claude-ask-multi-01-q1.json'),
  q2: screen('claude-ask-multi-02-q2.json'),
  toggle1: screen('claude-ask-multi-03-toggle1.json'),
  cheeseBasil: screen('claude-ask-multi-04-cheese-basil.json'),
  review: screen('claude-ask-multi-05-submit-screen.json'),
  otherToggled: screen('claude-ask-multi-06-other-toggled.json'),
  otherText: screen('claude-ask-multi-07-other-text.json'),
  submitRow: screen('claude-ask-multi-08-submit-row.json'),
  reviewOther: screen('claude-ask-multi-09-review.json'),
  answered: screen('claude-ask-multi-10-answered.json'),
};
const SINGLE = {
  initial: screen('claude-ask-single-01-initial.json'),
  down: screen('claude-ask-single-02-after-down.json'),
  answered: screen('claude-ask-single-03-after-digit3.json'),
  otherField: screen('claude-ask-other-01-after-digit4.json'),
  otherPasted: screen('claude-ask-other-02-after-paste.json'),
};

/** The tool_input the multi fixtures were captured with (KEYS.md, multi-01's prompt). */
const MULTI_PAYLOAD = {
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [
      {
        question: 'Which size?',
        header: 'Size',
        multiSelect: false,
        options: [
          { label: 'Small', description: 'Small size' },
          { label: 'Medium', description: 'Medium size' },
          { label: 'Large', description: 'Large size' },
        ],
      },
      {
        question: 'Which toppings?',
        header: 'Toppings',
        multiSelect: true,
        options: [
          { label: 'Cheese', description: 'Add cheese' },
          { label: 'Olives', description: 'Add olives' },
          { label: 'Basil', description: 'Add basil' },
        ],
      },
    ],
  },
};
const MULTI_QUESTIONS = claudeQuestionsForm(MULTI_PAYLOAD)!.questions! as AskFormQuestion[];

const COLOR_PAYLOAD = {
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [{
      question: 'Which color should the button be?',
      header: 'Color',
      multiSelect: false,
      options: [
        { label: 'Red', description: 'warm' },
        { label: 'Green', description: 'calm' },
        { label: 'Blue', description: 'cool' },
      ],
    }],
  },
};
const COLOR_QUESTIONS = claudeQuestionsForm(COLOR_PAYLOAD)!.questions! as AskFormQuestion[];

describe('parseAskPicker on the measured screens', () => {
  it('reads the first of two questions, as drawn before any key', () => {
    expect(parseAskPicker(MULTI.q1)).toEqual({
      view: 'question',
      tabs: [{ label: 'Size', answered: false }, { label: 'Toppings', answered: false }],
      submitTab: true,
      question: 'Which size?',
      options: [
        { key: '1', label: 'Small', cursor: true },
        { key: '2', label: 'Medium', cursor: false },
        { key: '3', label: 'Large', cursor: false },
        { key: '4', label: 'Type something.', cursor: false },
      ],
      multiSelect: false,
    });
  });

  it('reads a multi-select question: boxes, the in-question Submit row, the answered tab', () => {
    expect(parseAskPicker(MULTI.q2)).toEqual({
      view: 'question',
      tabs: [{ label: 'Size', answered: true }, { label: 'Toppings', answered: false }],
      submitTab: true,
      question: 'Which toppings?',
      options: [
        { key: '1', label: 'Cheese', cursor: true, checked: false },
        { key: '2', label: 'Olives', cursor: false, checked: false },
        { key: '3', label: 'Basil', cursor: false, checked: false },
        { key: '4', label: 'Type something', cursor: false, checked: false },
      ],
      multiSelect: true,
      submitRow: { cursor: false },
    });
    const ticked = parseAskPicker(MULTI.otherToggled);
    expect(ticked?.view === 'question' && ticked.options.filter((o) => o.checked).map((o) => o.key)).toEqual(['1', '3', '4']);
  });

  it('reads the typed free text on its row and the cursor on the Submit row', () => {
    const typed = parseAskPicker(MULTI.otherText);
    expect(typed?.view === 'question' && typed.options[3]).toEqual({ key: '4', label: 'anchovy', cursor: true, checked: true });
    const onSubmit = parseAskPicker(MULTI.submitRow);
    expect(onSubmit?.view === 'question' && onSubmit.submitRow).toEqual({ cursor: true });
    expect(onSubmit?.view === 'question' && onSubmit.options.some((o) => o.cursor)).toBe(false);
  });

  it('reads the review screen', () => {
    expect(parseAskPicker(MULTI.reviewOther)).toEqual({
      view: 'review',
      tabs: [{ label: 'Size', answered: true }, { label: 'Toppings', answered: true }],
      submitTab: true,
      entries: [
        { question: 'Which size?', answer: 'Medium' },
        { question: 'Which toppings?', answer: 'Basil, Cheese, anchovy' },
      ],
      rows: [
        { key: '1', label: 'Submit answers', cursor: true },
        { key: '2', label: 'Cancel', cursor: false },
      ],
    });
  });

  it('reads a single question: a one-tab bar and no Submit tab', () => {
    const initial = parseAskPicker(SINGLE.initial);
    expect(initial).toMatchObject({ view: 'question', tabs: [{ label: 'Color', answered: false }], submitTab: false });
    const field = parseAskPicker(SINGLE.otherField);
    expect(field?.view === 'question' && field.options[3]).toEqual({ key: '4', label: 'Type something.', cursor: true });
    const pasted = parseAskPicker(SINGLE.otherPasted);
    expect(pasted?.view === 'question' && pasted.options[3]).toEqual({ key: '4', label: 'teal please', cursor: true });
  });

  it('finds no picker once it is answered, and none in text that is not a picker', () => {
    expect(parseAskPicker(MULTI.answered)).toBeNull();
    expect(parseAskPicker(SINGLE.answered)).toBeNull();
    expect(parseAskPicker([])).toBeNull();
    // A picker whose bottom rule is not drawn is not a whole picker.
    expect(parseAskPicker(MULTI.q1.slice(0, 25))).toBeNull();
  });
});

describe('the answered transcript block', () => {
  it('lists each question with its answer', () => {
    expect(countAnsweredBlocks(MULTI.answered)).toBe(1);
    expect(lastAnsweredBlock(MULTI.answered)).toEqual([
      'Which size? → Medium',
      'Which toppings? → Basil, Cheese, anchovy',
    ]);
    expect(countAnsweredBlocks(MULTI.reviewOther)).toBe(0);
    // An older block for the same question can still be on screen.
    expect(countAnsweredBlocks(SINGLE.otherField)).toBe(1);
  });

  it('confirms an answer only from a NEW block that lists exactly it', () => {
    const answers: AskAnswer[] = [{ keys: ['2'] }, { keys: ['1', '3'], other: 'anchovy' }];
    expect(answersConfirmed(MULTI.answered, 0, MULTI_QUESTIONS, answers)).toBe(true);
    // No new block since the screen the last key was typed over.
    expect(answersConfirmed(MULTI.answered, 1, MULTI_QUESTIONS, answers)).toBe(false);
    // Another answer.
    expect(answersConfirmed(MULTI.answered, 0, MULTI_QUESTIONS, [{ keys: ['2'] }, { keys: ['1', '3'] }])).toBe(false);
    expect(answersConfirmed(SINGLE.answered, 0, COLOR_QUESTIONS, [{ keys: ['3'] }])).toBe(true);
    // The picker still up is never confirmed.
    expect(answersConfirmed(MULTI.reviewOther, 0, MULTI_QUESTIONS, answers)).toBe(false);
  });

  it('confirms under a follow-up question\'s picker, never under this prompt\'s own', () => {
    const answers: AskAnswer[] = [{ keys: ['2'] }, { keys: ['1', '3'], other: 'anchovy' }];
    const block = MULTI.answered.slice(0, 18);
    // Claude asked about the color right after.
    const followUp = [...block, ...SINGLE.initial.slice(11, 27)];
    expect(parseAskPicker(followUp)).toMatchObject({ view: 'question', question: 'Which color should the button be?' });
    expect(answersConfirmed(followUp, 0, MULTI_QUESTIONS, answers)).toBe(true);
    // The same prompt's picker drawn again under the block: not this answer's proof.
    const same = [...block, ...MULTI.q1.slice(13, 29)];
    expect(parseAskPicker(same)).toMatchObject({ view: 'question', question: 'Which size?' });
    expect(answersConfirmed(same, 0, MULTI_QUESTIONS, answers)).toBe(false);
  });
});

describe('answerListMatches', () => {
  it('matches the labels in any order, joined by commas, across a wrap', () => {
    expect(answerListMatches('Basil, Cheese, anchovy', ['Cheese', 'Basil', 'anchovy'])).toBe(true);
    expect(answerListMatches('Cheese, Basil', ['Basil', 'Cheese'])).toBe(true);
    expect(answerListMatches('Extra cheese, Basil', ['Basil', 'Extra cheese'])).toBe(true);
    expect(answerListMatches('Extra   cheese,  Basil', ['Basil', 'Extra cheese'])).toBe(true);
  });

  it('refuses a missing, extra or repeated label', () => {
    expect(answerListMatches('Basil', ['Basil', 'Cheese'])).toBe(false);
    expect(answerListMatches('Basil, Cheese, Olives', ['Basil', 'Cheese'])).toBe(false);
    expect(answerListMatches('Basil, Basil', ['Basil'])).toBe(false);
    expect(answerListMatches('', [])).toBe(false);
  });

  it('handles a label that contains a comma', () => {
    expect(answerListMatches('Salt, pepper, Basil', ['Basil', 'Salt, pepper'])).toBe(true);
  });
});

describe('askScreenMeets / askPickerUntouched', () => {
  const answers: AskAnswer[] = [{ keys: ['2'] }, { keys: ['1', '3'], other: 'anchovy' }];

  it('knows the untouched picker, and nothing else', () => {
    expect(askPickerUntouched(parseAskPicker(MULTI.q1), MULTI_QUESTIONS)).toBe(true);
    expect(askPickerUntouched(parseAskPicker(SINGLE.initial), COLOR_QUESTIONS)).toBe(true);
    // The cursor moved.
    expect(askPickerUntouched(parseAskPicker(SINGLE.down), COLOR_QUESTIONS)).toBe(false);
    // The first question was answered.
    expect(askPickerUntouched(parseAskPicker(MULTI.q2), MULTI_QUESTIONS)).toBe(false);
    // Another prompt's picker.
    expect(askPickerUntouched(parseAskPicker(MULTI.q1), COLOR_QUESTIONS)).toBe(false);
    expect(askPickerUntouched(parseAskPicker(SINGLE.initial), MULTI_QUESTIONS)).toBe(false);
  });

  it('checks every measured step of the two-question answer', () => {
    const q = (cursor: string, checked: string[], other: string | null) =>
      ({ view: 'question' as const, q: 1, cursor, checked, other });
    const meets = (rows: string[], expect: Parameters<typeof askScreenMeets>[1]) =>
      askScreenMeets(parseAskPicker(rows), expect, MULTI_QUESTIONS, answers);
    expect(meets(MULTI.q2, q('1', [], null))).toBe(true);
    expect(meets(MULTI.toggle1, q('1', ['1'], null))).toBe(true);
    expect(meets(MULTI.cheeseBasil, q('1', ['1', '3'], null))).toBe(true);
    expect(meets(MULTI.otherToggled, q('1', ['1', '3', '4'], null))).toBe(true);
    expect(meets(MULTI.otherText, q('4', ['1', '3', '4'], 'anchovy'))).toBe(true);
    expect(meets(MULTI.submitRow, q('submit', ['1', '3', '4'], 'anchovy'))).toBe(true);
    expect(meets(MULTI.reviewOther, { view: 'review' })).toBe(true);
    // One box off, the cursor elsewhere, other text, the wrong question: no.
    expect(meets(MULTI.toggle1, q('1', ['1', '3'], null))).toBe(false);
    expect(meets(MULTI.otherText, q('1', ['1', '3', '4'], 'anchovy'))).toBe(false);
    expect(meets(MULTI.otherText, q('4', ['1', '3', '4'], 'anchovies'))).toBe(false);
    expect(meets(MULTI.q2, { view: 'question', q: 0, cursor: '1', checked: [], other: null })).toBe(false);
    // The review of another answer.
    expect(askScreenMeets(parseAskPicker(MULTI.review), { view: 'review' }, MULTI_QUESTIONS, answers)).toBe(false);
    expect(askScreenMeets(parseAskPicker(MULTI.review), { view: 'review' }, MULTI_QUESTIONS, [{ keys: ['2'] }, { keys: ['1', '3'] }])).toBe(true);
  });
});

describe('askAnswerSteps', () => {
  it('replays the measured order for the two-question prompt', () => {
    const steps = askAnswerSteps(MULTI_QUESTIONS, [{ keys: ['2'] }, { keys: ['3', '1'], other: 'anchovy' }]);
    expect(steps.map((s) => s.key)).toEqual([
      '2',
      '1', '3', '4',
      ASK_KEY_DOWN, ASK_KEY_DOWN, ASK_KEY_DOWN,
      '\x1b[200~anchovy\x1b[201~',
      ASK_KEY_DOWN, ASK_KEY_ENTER,
      '1',
    ]);
    expect(steps.map((s) => s.expect.view)).toEqual([
      'question', 'question', 'question', 'question', 'question', 'question', 'question', 'question', 'question',
      'review', 'closed',
    ]);
  });

  it('walks a multi-select with no free text down onto its Submit row', () => {
    const steps = askAnswerSteps(MULTI_QUESTIONS, [{ keys: ['1'] }, { keys: ['2'] }]);
    expect(steps.map((s) => s.key)).toEqual(['1', '2', ASK_KEY_DOWN, ASK_KEY_DOWN, ASK_KEY_DOWN, ASK_KEY_DOWN, ASK_KEY_ENTER, '1']);
  });

  it('submits a single single-select question with its digit, or its free text with Enter', () => {
    expect(askAnswerSteps(COLOR_QUESTIONS, [{ keys: ['3'] }])).toEqual([{ key: '3', expect: { view: 'closed' } }]);
    expect(askAnswerSteps(COLOR_QUESTIONS, [{ keys: [], other: 'teal please' }]).map((s) => [s.key, s.expect.view])).toEqual([
      ['4', 'question'],
      ['\x1b[200~teal please\x1b[201~', 'question'],
      [ASK_KEY_ENTER, 'closed'],
    ]);
  });

  it('lets a single multi-select question end on a review screen or close at once', () => {
    const form = claudeQuestionsForm({
      tool_input: { questions: [{ ...MULTI_PAYLOAD.tool_input.questions[1] }] },
    })!;
    const steps = askAnswerSteps(form.questions!, [{ keys: ['1'] }]);
    expect(steps.map((s) => s.expect.view).slice(-2)).toEqual(['review-or-closed', 'closed']);
  });
});

describe('free-text limits', () => {
  it('fits one row of the pane', () => {
    expect(askOtherMaxWidth(100)).toBe(88);
    expect(askOtherMaxWidth(undefined)).toBe(68);
  });

  it('knows the free-text row placeholder', () => {
    expect(isFreeTextPlaceholder('Type something.')).toBe(true);
    expect(isFreeTextPlaceholder('Type  something')).toBe(true);
    expect(isFreeTextPlaceholder('Type something else')).toBe(false);
  });
});

describe('claudeQuestionsForm', () => {
  it('builds the whole prompt as a questions form', () => {
    expect(claudeQuestionsForm(MULTI_PAYLOAD)).toEqual({
      v: 1,
      kind: 'questions',
      questions: [
        {
          id: 'q0',
          header: 'Size',
          text: 'Which size?',
          multiSelect: false,
          allowOther: true,
          options: [{ key: '1', label: 'Small' }, { key: '2', label: 'Medium' }, { key: '3', label: 'Large' }],
        },
        {
          id: 'q1',
          header: 'Toppings',
          text: 'Which toppings?',
          multiSelect: true,
          allowOther: true,
          options: [{ key: '1', label: 'Cheese' }, { key: '2', label: 'Olives' }, { key: '3', label: 'Basil' }],
        },
      ],
      actions: [{ id: 'submit', label: 'Submit' }, { id: 'deny', label: 'Cancel' }],
    });
  });

  it('gives no form for anything the driver could not match on screen', () => {
    const one = MULTI_PAYLOAD.tool_input.questions[0]!;
    const withQuestion = (q: Record<string, unknown>) => claudeQuestionsForm({ tool_input: { questions: [q] } });
    expect(claudeQuestionsForm({ tool_input: { question: 'Flat?', options: ['a'] } })).toBeNull();
    expect(claudeQuestionsForm({})).toBeNull();
    expect(withQuestion({ ...one, header: undefined })).toBeNull();
    expect(withQuestion({ ...one, multiSelect: 'false' })).toBeNull();
    expect(withQuestion({ ...one, question: 'Which\nsize?' })).toBeNull();
    expect(withQuestion({ ...one, question: 'Which  size?' })).toBeNull();
    expect(withQuestion({ ...one, options: [{ label: 'Small\u0085' }] })).toBeNull();
    expect(withQuestion({ ...one, options: [{ label: '' }] })).toBeNull();
    expect(withQuestion({ ...one, options: ['Small'] })).toBeNull();
    expect(withQuestion({ ...one, options: [] })).toBeNull();
    expect(withQuestion({ ...one, options: Array.from({ length: CLAUDE_FORM_MAX_OPTIONS + 1 }, (_, i) => ({ label: `o${i}` })) })).toBeNull();
    expect(withQuestion({ ...one, options: [{ label: 'x'.repeat(201) }] })).toBeNull();
    // Two questions with the same text cannot be told apart on screen.
    expect(claudeQuestionsForm({ tool_input: { questions: [one, { ...one, header: 'Other' }] } })).toBeNull();
    expect(claudeQuestionsForm({ tool_input: { questions: [one, one, one, one, one].map((q, i) => ({ ...q, question: `Q${i}?` })) } })).toBeNull();
  });
});
