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
  askConfirmBaseline,
  readsAsCheckbox,
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

/** Claude Code 2.1.288, measured live through the phone routes (KEYS.md). */
const V288_DIR = path.join(DIR, 'claude-2.1.288');
const screen288 = (name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(V288_DIR, `claude-ask-${name}-2.1.288.json`), 'utf8')) as { screen: string[] }).screen;
const V288 = {
  nextQ1: screen288('next-01-q1'),
  nextToggle1: screen288('next-02-toggle1'),
  nextOnNext: screen288('next-03-on-next'),
  nextQ2: screen288('next-04-q2'),
  nextReview: screen288('next-05-review'),
  nextAnswered: screen288('next-06-answered'),
  oneInitial: screen288('one-multi-01-initial'),
  oneToggle2: screen288('one-multi-02-toggle2'),
  oneOnSubmit: screen288('one-multi-03-on-submit'),
  oneReview: screen288('one-multi-04-review'),
  oneAnswered: screen288('one-multi-05-answered'),
};
const NEXT_QUESTIONS = claudeQuestionsForm({
  tool_input: {
    questions: [
      {
        question: 'Which platforms?',
        header: 'Targets',
        multiSelect: true,
        options: [
          { label: 'macOS', description: 'Apple desktop' },
          { label: 'Linux', description: 'Open source' },
          { label: 'Windows', description: 'Microsoft desktop' },
        ],
      },
      {
        question: 'Which license?',
        header: 'License',
        multiSelect: false,
        options: [{ label: 'MIT', description: 'Permissive' }, { label: 'Apache-2.0', description: 'Patent grant' }],
      },
    ],
  },
})!.questions! as AskFormQuestion[];
const FRUIT_QUESTIONS = claudeQuestionsForm({
  tool_input: {
    questions: [{
      question: 'Which fruits?',
      header: 'Fruit',
      multiSelect: true,
      options: [
        { label: 'Apple', description: 'Crisp' },
        { label: 'Banana', description: 'Soft' },
        { label: 'Cherry', description: 'Tart' },
      ],
    }],
  },
})!.questions! as AskFormQuestion[];

describe('parseAskPicker on the measured screens', () => {
  it('reads the first of two questions, as drawn before any key', () => {
    expect(parseAskPicker(MULTI.q1)).toEqual({
      view: 'question',
      tabs: [{ label: 'Size', answered: false }, { label: 'Toppings', answered: false }],
      submitTab: true,
      question: 'Which size?',
      options: [
        { key: '1', label: 'Small', cursor: true, more: ['Small size'] },
        { key: '2', label: 'Medium', cursor: false, more: ['Medium size'] },
        { key: '3', label: 'Large', cursor: false, more: ['Large size'] },
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
        { key: '1', label: 'Cheese', cursor: true, checked: false, more: ['Add cheese'] },
        { key: '2', label: 'Olives', cursor: false, checked: false, more: ['Add olives'] },
        { key: '3', label: 'Basil', cursor: false, checked: false, more: ['Add basil'] },
        { key: '4', label: 'Type something', cursor: false, checked: false },
      ],
      multiSelect: true,
      submitRow: { cursor: false, next: false },
    });
    const ticked = parseAskPicker(MULTI.otherToggled);
    expect(ticked?.view === 'question' && ticked.options.filter((o) => o.checked).map((o) => o.key)).toEqual(['1', '3', '4']);
  });

  it('reads the typed free text on its row and the cursor on the Submit row', () => {
    const typed = parseAskPicker(MULTI.otherText);
    expect(typed?.view === 'question' && typed.options[3]).toEqual({ key: '4', label: 'anchovy', cursor: true, checked: true });
    const onSubmit = parseAskPicker(MULTI.submitRow);
    expect(onSubmit?.view === 'question' && onSubmit.submitRow).toEqual({ cursor: true, next: false });
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
    expect(answersConfirmed(MULTI.answered, { anchor: [], blocks: 0 }, MULTI_QUESTIONS, answers)).toBe(true);
    // No new block since the screen the last key was typed over.
    expect(answersConfirmed(MULTI.answered, { anchor: [], blocks: 1 }, MULTI_QUESTIONS, answers)).toBe(false);
    // Another answer.
    expect(answersConfirmed(MULTI.answered, { anchor: [], blocks: 0 }, MULTI_QUESTIONS, [{ keys: ['2'] }, { keys: ['1', '3'] }])).toBe(false);
    expect(answersConfirmed(SINGLE.answered, { anchor: [], blocks: 0 }, COLOR_QUESTIONS, [{ keys: ['3'] }])).toBe(true);
    // The picker still up is never confirmed.
    expect(answersConfirmed(MULTI.reviewOther, { anchor: [], blocks: 0 }, MULTI_QUESTIONS, answers)).toBe(false);
  });

  it('confirms under a follow-up question\'s picker, never under this prompt\'s own', () => {
    const answers: AskAnswer[] = [{ keys: ['2'] }, { keys: ['1', '3'], other: 'anchovy' }];
    const block = MULTI.answered.slice(0, 18);
    // Claude asked about the color right after.
    const followUp = [...block, ...SINGLE.initial.slice(11, 27)];
    expect(parseAskPicker(followUp)).toMatchObject({ view: 'question', question: 'Which color should the button be?' });
    expect(answersConfirmed(followUp, { anchor: [], blocks: 0 }, MULTI_QUESTIONS, answers)).toBe(true);
    // The same prompt's picker drawn again under the block: not this answer's proof.
    const same = [...block, ...MULTI.q1.slice(13, 29)];
    expect(parseAskPicker(same)).toMatchObject({ view: 'question', question: 'Which size?' });
    expect(answersConfirmed(same, { anchor: [], blocks: 0 }, MULTI_QUESTIONS, answers)).toBe(false);
  });
});

describe('Claude Code 2.1.288 screens', () => {
  it('answers one multi-select question through its Submit tab and review', () => {
    const answers: AskAnswer[] = [{ keys: ['2'] }];
    expect(askPickerUntouched(parseAskPicker(V288.oneInitial), FRUIT_QUESTIONS)).toBe(true);
    const at = (cursor: string) => ({ view: 'question' as const, q: 0, cursor, checked: ['2'], other: null });
    expect(askScreenMeets(parseAskPicker(V288.oneToggle2), at('1'), FRUIT_QUESTIONS, answers)).toBe(true);
    expect(askScreenMeets(parseAskPicker(V288.oneOnSubmit), at('submit'), FRUIT_QUESTIONS, answers)).toBe(true);
    expect(askScreenMeets(parseAskPicker(V288.oneReview), { view: 'review' }, FRUIT_QUESTIONS, answers)).toBe(true);
    expect(answersConfirmed(V288.oneAnswered, askConfirmBaseline(V288.oneReview), FRUIT_QUESTIONS, answers)).toBe(true);
  });

  it('answers a multi-select followed by another question through its Next row', () => {
    const answers: AskAnswer[] = [{ keys: ['1', '3'] }, { keys: ['2'] }];
    expect(askPickerUntouched(parseAskPicker(V288.nextQ1), NEXT_QUESTIONS)).toBe(true);
    const at = (cursor: string, checked: string[]) => ({ view: 'question' as const, q: 0, cursor, checked, other: null });
    expect(askScreenMeets(parseAskPicker(V288.nextToggle1), at('1', ['1']), NEXT_QUESTIONS, answers)).toBe(true);
    expect(askScreenMeets(parseAskPicker(V288.nextOnNext), at('submit', ['1', '3']), NEXT_QUESTIONS, answers)).toBe(true);
    expect(askScreenMeets(parseAskPicker(V288.nextQ2), { view: 'question', q: 1, cursor: '1', checked: [], other: null }, NEXT_QUESTIONS, answers)).toBe(true);
    expect(askScreenMeets(parseAskPicker(V288.nextReview), { view: 'review' }, NEXT_QUESTIONS, answers)).toBe(true);
    expect(answersConfirmed(V288.nextAnswered, askConfirmBaseline(V288.nextReview), NEXT_QUESTIONS, answers)).toBe(true);
  });

  it('matches an option by its whole label and description, wrapped or not', () => {
    const fruit = (label: string, description?: string) => claudeQuestionsForm({
      tool_input: {
        questions: [{
          question: 'Which fruits?',
          header: 'Fruit',
          multiSelect: true,
          options: [
            { label, ...(description !== undefined ? { description } : {}) },
            { label: 'Banana', description: 'Soft' },
            { label: 'Cherry', description: 'Tart' },
          ],
        }],
      },
    })!.questions! as AskFormQuestion[];
    expect(askPickerUntouched(parseAskPicker(V288.oneInitial), fruit('Apple', 'Crisp'))).toBe(true);
    // The screen shows only the start of the form's label, or another description.
    expect(askPickerUntouched(parseAskPicker(V288.oneInitial), fruit('Apple only for preview', 'Crisp'))).toBe(false);
    // The label ends where a row ends.
    expect(askPickerUntouched(parseAskPicker(V288.oneInitial), fruit('App', 'leCrisp'))).toBe(false);
    expect(askPickerUntouched(parseAskPicker(V288.oneInitial), fruit('Apple', 'Crisp and red'))).toBe(false);
    expect(askPickerUntouched(parseAskPicker(V288.oneInitial), fruit('Apple'))).toBe(false);
    // A long label wraps onto the description's indent (measured on 2.1.288).
    const RULE80 = '─'.repeat(80);
    const wrapped = [
      RULE80,
      ' ☐ Plan ',
      '',
      'Which plan?',
      '',
      '❯ 1. Keep the current layout and only adjust the spacing between the sidebar ',
      '     items today',
      '     This changes nothing else in the window; the sidebar keeps its width, its ',
      '     order and its colors exactly as they are now.',
      '  2. Short',
      '     Tiny.',
      '  3. Type something.',
      RULE80,
      '  4. Chat about this',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ];
    const plan = claudeQuestionsForm({
      tool_input: {
        questions: [{
          question: 'Which plan?',
          header: 'Plan',
          multiSelect: false,
          options: [
            {
              label: 'Keep the current layout and only adjust the spacing between the sidebar items today',
              description: 'This changes nothing else in the window; the sidebar keeps its width, its order and its colors exactly as they are now.',
            },
            { label: 'Short', description: 'Tiny.' },
          ],
        }],
      },
    })!.questions! as AskFormQuestion[];
    expect(askPickerUntouched(parseAskPicker(wrapped), plan)).toBe(true);
  });

  it('is not the question that is up when another menu or prompt is drawn under it', () => {
    expect(parseAskPicker(V288.oneInitial)).not.toBeNull();
    const withMenu = [...V288.oneInitial, '', 'Do you want to proceed?', '❯ 1. Yes', '  2. No'];
    expect(parseAskPicker(withMenu)).toBeNull();
    expect(askPickerUntouched(parseAskPicker(withMenu), FRUIT_QUESTIONS)).toBe(false);
    const hintReplaced = V288.oneInitial.map((row) => (row.startsWith('Enter to select') ? '> type here' : row));
    expect(parseAskPicker(hintReplaced)).toBeNull();
    const extraRow = V288.oneInitial.map((row) => (row.trim() === '5. Chat about this' ? '  5. Something else' : row));
    expect(parseAskPicker(extraRow)).toBeNull();
  });

  it('takes only an answered block drawn below the rows that were above the picker', () => {
    const answers: AskAnswer[] = [{ keys: ['1', '3'] }, { keys: ['2'] }];
    const baseline = askConfirmBaseline(V288.nextReview);
    expect(baseline.anchor.length).toBeGreaterThan(0);
    const at = V288.nextAnswered.findIndex((row) => row.includes("User answered Claude's questions:"));
    const block = V288.nextAnswered.slice(at, at + 3);
    // An older identical block shown again above the anchor, nothing new below it.
    const resurfaced = [...block, '', ...baseline.anchor, '', '', ''];
    expect(answersConfirmed(resurfaced, baseline, NEXT_QUESTIONS, answers)).toBe(false);
    // Counting alone would have taken it.
    expect(answersConfirmed(resurfaced, { anchor: [], blocks: 0 }, NEXT_QUESTIONS, answers)).toBe(true);
    // An older block that scrolled away while the new one was drawn below the anchor.
    expect(answersConfirmed(V288.nextAnswered, { anchor: baseline.anchor, blocks: 1 }, NEXT_QUESTIONS, answers)).toBe(true);
  });

  it('refuses free text that reads as a checkbox', () => {
    expect(readsAsCheckbox('[ ] later')).toBe(true);
    expect(readsAsCheckbox('[✔] done')).toBe(true);
    expect(readsAsCheckbox('  [ ]x')).toBe(true);
    expect(readsAsCheckbox('see [ ] here')).toBe(false);
    expect(readsAsCheckbox('[x] done')).toBe(false);
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

  it('reads the in-question row as Next only where another question follows', () => {
    // A `Submit` row on a question that is not the last is not the measured picker.
    const asSubmit = V288.nextOnNext.map((row) => (row === '❯    Next' ? '❯    Submit' : row));
    expect(asSubmit).not.toEqual(V288.nextOnNext);
    const onRow = { view: 'question' as const, q: 0, cursor: 'submit', checked: ['1', '3'], other: null };
    const answers = [{ keys: ['1', '3'] }, { keys: ['2'] }];
    expect(askScreenMeets(parseAskPicker(V288.nextOnNext), onRow, NEXT_QUESTIONS, answers)).toBe(true);
    expect(askScreenMeets(parseAskPicker(asSubmit), onRow, NEXT_QUESTIONS, answers)).toBe(false);
    // On the last question a `Next` row is not the picker either.
    const lastAsNext = MULTI.submitRow.map((row) => (row === '❯    Submit' ? '❯    Next' : row));
    const lastRow = { view: 'question' as const, q: 1, cursor: 'submit', checked: ['1', '3', '4'], other: 'anchovy' };
    expect(askScreenMeets(parseAskPicker(lastAsNext), lastRow, MULTI_QUESTIONS, [{ keys: ['2'] }, { keys: ['1', '3'], other: 'anchovy' }])).toBe(false);
  });
});

describe('question texts', () => {
  const RULE = '─'.repeat(100);
  /** A two-question picker drawn from scratch: `bar`, question `text` (rows), options Yes/No. */
  const picker = (bar: string, text: readonly string[]): string[] => [
    RULE,
    bar,
    '',
    ...text,
    '',
    '❯ 1. Yes',
    '  2. No',
    '  3. Type something.',
    RULE,
    '  4. Chat about this',
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ];
  const two = (a: string, b: string): AskFormQuestion[] => claudeQuestionsForm({
    tool_input: {
      questions: [
        { question: a, header: 'First', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] },
        { question: b, header: 'Second', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] },
      ],
    },
  })!.questions! as AskFormQuestion[];

  it('match a text Claude wrapped inside a word, in the picker, the review and the answered block', () => {
    // No spaces to wrap at: the row breaks inside a word.
    const questions = two('日本語の長い質問文です', 'Second?');
    const onFirst = parseAskPicker(picker('←  ☐ First  ☐ Second  ✔ Submit  →', ['日本語の長い', '質問文です']));
    expect(askPickerUntouched(onFirst, questions)).toBe(true);
    const answers: AskAnswer[] = [{ keys: ['1'] }, { keys: ['2'] }];
    const review = [
      RULE,
      '←  ☒ First  ☒ Second  ✔ Submit  →',
      '',
      'Review your answers',
      '',
      ' ● 日本語の長い質',
      '   問文です',
      '   → Yes',
      ' ● Second?',
      '   → No',
      '',
      'Ready to submit your answers?',
      '',
      '❯ 1. Submit answers',
      '  2. Cancel',
    ];
    expect(askScreenMeets(parseAskPicker(review), { view: 'review' }, questions, answers)).toBe(true);
    const answered = [
      '⏺ User answered Claude\'s questions:',
      '  ⎿  · 日本語の長い質問',
      '     文です → Yes',
      '     · Second? → No',
      '',
    ];
    expect(answersConfirmed(answered, { anchor: [], blocks: 0 }, questions, answers)).toBe(true);
  });

  it('never take a question for another that starts the same', () => {
    const questions = two('Enable caching', 'Enable caching for tests');
    // Still on the first question after its digit (a build whose digit does not move on).
    const stuck = parseAskPicker(picker('←  ☒ First  ☐ Second  ✔ Submit  →', ['Enable caching']));
    expect(askScreenMeets(stuck, { view: 'question', q: 1, cursor: '1', checked: [], other: null }, questions, [])).toBe(false);
    const moved = parseAskPicker(picker('←  ☒ First  ☐ Second  ✔ Submit  →', ['Enable caching for tests']));
    expect(askScreenMeets(moved, { view: 'question', q: 1, cursor: '1', checked: [], other: null }, questions, [])).toBe(true);
  });

  it('give no form when two questions read the same without spaces', () => {
    const payload = (a: string, b: string) => ({
      tool_input: {
        questions: [
          { question: a, header: 'First', multiSelect: false, options: [{ label: 'Yes' }] },
          { question: b, header: 'Second', multiSelect: false, options: [{ label: 'Yes' }] },
        ],
      },
    });
    expect(claudeQuestionsForm(payload('Pick one', 'Pickone'))).toBeNull();
    expect(claudeQuestionsForm(payload('Pick one', 'Pick one more'))).not.toBeNull();
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

  it('knows the free-text row placeholder, read with its spaces removed as the echo check does', () => {
    expect(isFreeTextPlaceholder('Type something.')).toBe(true);
    expect(isFreeTextPlaceholder('Type  something')).toBe(true);
    expect(isFreeTextPlaceholder('Type some thing')).toBe(true);
    expect(isFreeTextPlaceholder('Typesomething')).toBe(true);
    expect(isFreeTextPlaceholder('Type some thing.')).toBe(true);
    expect(isFreeTextPlaceholder('Type something else')).toBe(false);
    expect(isFreeTextPlaceholder('type something')).toBe(false);
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
          options: [
            { key: '1', label: 'Small', description: 'Small size' },
            { key: '2', label: 'Medium', description: 'Medium size' },
            { key: '3', label: 'Large', description: 'Large size' },
          ],
        },
        {
          id: 'q1',
          header: 'Toppings',
          text: 'Which toppings?',
          multiSelect: true,
          allowOther: true,
          options: [
            { key: '1', label: 'Cheese', description: 'Add cheese' },
            { key: '2', label: 'Olives', description: 'Add olives' },
            { key: '3', label: 'Basil', description: 'Add basil' },
          ],
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
