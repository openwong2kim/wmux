// Claude's AskUserQuestion answered through a `decision-v2` `questions` form
// (#1649): the record, and the stepwise driver against a fake pane that
// replays the measured screens (fixtures/terminal-prompts/claude-ask-*.json).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ApprovalRegistry,
  ASK_CONFIRM_WAIT_MS,
  TERMINAL_PROMPT_MIN_ANSWER_AGE_MS,
  type ApprovalRegistryDeps,
} from '../ApprovalRegistry';
import { DECISION_V2_WEB_ANSWER, type ApprovalEvent, type ApprovalRequest, type DecisionAnswer } from '../types';
import { claudeQuestionsForm, extractAskUserQuestion } from '../askUserQuestion';
import { ASK_KEY_DOWN, ASK_KEY_ENTER } from '../askPicker';

const DIR = path.join(__dirname, 'fixtures', 'terminal-prompts');
// Read with fs, not a JSON import: a JSON import breaks the daemon build.
const screen = (name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as { screen: string[] }).screen;

const MULTI = {
  q1: screen('claude-ask-multi-01-q1.json'),
  q2: screen('claude-ask-multi-02-q2.json'),
  toggle1: screen('claude-ask-multi-03-toggle1.json'),
  cheeseBasil: screen('claude-ask-multi-04-cheese-basil.json'),
  otherToggled: screen('claude-ask-multi-06-other-toggled.json'),
  otherText: screen('claude-ask-multi-07-other-text.json'),
  submitRow: screen('claude-ask-multi-08-submit-row.json'),
  review: screen('claude-ask-multi-09-review.json'),
  answered: screen('claude-ask-multi-10-answered.json'),
};
const SINGLE = {
  initial: screen('claude-ask-single-01-initial.json'),
  down: screen('claude-ask-single-02-after-down.json'),
  answered: screen('claude-ask-single-03-after-digit3.json'),
  otherField: screen('claude-ask-other-01-after-digit4.json'),
  otherPasted: screen('claude-ask-other-02-after-paste.json'),
};

/** Move the picker's `❯` from the row starting `from` to the row starting `to` (both without their 2-column prefix). */
function moveCursor(rows: readonly string[], from: string, to: string): string[] {
  return rows.map((row) => {
    if (row.startsWith(`❯ ${from}`)) return `  ${row.slice(2)}`;
    if (row.startsWith(`  ${to}`)) return `❯ ${row.slice(2)}`;
    return row;
  });
}
const replaceRow = (rows: readonly string[], from: string, to: string): string[] => rows.map((row) => (row === from ? to : row));

// The multi-select screens between the measured ones: the cursor walked down
// one row at a time (measured as one batch of three `↓` in multi-07).
const ON_OLIVES = moveCursor(MULTI.otherToggled, '1. [✔] Cheese', '2. [ ] Olives');
const ON_BASIL = moveCursor(ON_OLIVES, '2. [ ] Olives', '3. [✔] Basil');
const ON_OTHER = moveCursor(ON_BASIL, '3. [✔] Basil', '4. [✔] Type something');

// The color prompt again, untouched, under an OLD answer to the same question
// (claude-ask-other-01 shows one on screen).
const COLOR_AGAIN = replaceRow(
  moveCursor(SINGLE.otherField, '4. Type something.', '1. Red'),
  'Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
);
/** The screen once a color answer lands under the old one: a second block. */
const colorAnswered = (answer: string): string[] => [
  ...SINGLE.otherField.slice(0, 20),
  '',
  '⏺ User answered Claude\'s questions:',
  `  ⎿  · Which color should the button be? → ${answer}`,
  '',
  ...Array.from({ length: 16 }, () => ''),
];
/** The picker gone, and nothing drawn yet about its answer. */
const BLANK_AFTER = [...MULTI.answered.slice(0, 13), ...Array.from({ length: 27 }, () => '')];

// ONE multi-select question — NOT measured. Assumed drawn like the measured
// multi-select tab under a one-tab bar with no Submit tab (as the measured
// single-select question is), so both of its possible endings are covered.
/** multi-02 with its tab bar replaced by `bar`. */
const oneTab = (rows: readonly string[], bar: string): string[] => {
  const at = rows.findIndex((row) => row.startsWith('←  ☒ Size'));
  if (at < 0) throw new Error('no tab bar');
  return rows.map((row, i) => (i === at ? bar : row));
};
const TOPPINGS = {
  initial: oneTab(MULTI.q2, ' ☐ Toppings'),
  cheese: oneTab(MULTI.toggle1, ' ☒ Toppings'),
};
const TOPPINGS_ON_OLIVES = moveCursor(TOPPINGS.cheese, '1. [✔] Cheese', '2. [ ] Olives');
const TOPPINGS_ON_BASIL = moveCursor(TOPPINGS_ON_OLIVES, '2. [ ] Olives', '3. [ ] Basil');
const TOPPINGS_ON_OTHER = moveCursor(TOPPINGS_ON_BASIL, '3. [ ] Basil', '4. [ ] Type something');
const TOPPINGS_ON_SUBMIT = TOPPINGS_ON_OTHER.map((row) =>
  row === '❯ 4. [ ] Type something' ? '  4. [ ] Type something' : row === '     Submit' ? '❯    Submit' : row);
const TOPPINGS_REVIEW = [
  ...MULTI.review.slice(0, 15),
  ' ☒ Toppings',
  '',
  'Review your answers',
  '',
  ' ● Which toppings?',
  '   → Cheese',
  '',
  'Ready to submit your answers?',
  '',
  '❯ 1. Submit answers',
  '  2. Cancel',
  ...Array.from({ length: 14 }, () => ''),
];
const TOPPINGS_ANSWERED = [
  ...MULTI.answered.slice(0, 14),
  '⏺ User answered Claude\'s questions:',
  '  ⎿  · Which toppings? → Cheese',
  ...Array.from({ length: 24 }, () => ''),
];

const MULTI_PAYLOAD = {
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [
      {
        question: 'Which size?',
        header: 'Size',
        multiSelect: false,
        options: [{ label: 'Small' }, { label: 'Medium' }, { label: 'Large' }],
      },
      {
        question: 'Which toppings?',
        header: 'Toppings',
        multiSelect: true,
        options: [{ label: 'Cheese' }, { label: 'Olives' }, { label: 'Basil' }],
      },
    ],
  },
};
const COLOR_PAYLOAD = {
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [{
      question: 'Which color should the button be?',
      header: 'Color',
      multiSelect: false,
      options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
    }],
  },
};

const TOPPINGS_PAYLOAD = {
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_input: { questions: [MULTI_PAYLOAD.tool_input.questions[1]!] },
};

const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`;

interface Pane {
  rows: readonly string[] | null;
  bytes: number;
  keyInputRevision: number;
  incarnation: string;
  cols: number;
}

interface Harness {
  registry: ApprovalRegistry;
  pane: Pane;
  /** The keys the fake TUI expects, in order, and the screen each one draws. */
  script: Array<[key: string, rows: readonly string[]]>;
  stepKeys: string[];
  writes: string[];
  /** Driver keys the script did not expect (drawn as nothing). */
  unexpected: string[];
  submitted: number;
  events: ApprovalEvent[];
  clock: { now: number };
  afterStepKey: { fn: ((index: number) => void) | null };
  /** Runs at each read of the pane's screen, before it is taken. */
  onRead: { fn: (() => void) | null };
}

let tmpDir: string;

function makeRegistry(overrides: Partial<ApprovalRegistryDeps> = {}, initial: readonly string[] = MULTI.q1): Harness {
  const h: Harness = {
    registry: null as unknown as ApprovalRegistry,
    pane: { rows: initial, bytes: 100, keyInputRevision: 3, incarnation: 'inc-1', cols: 100 },
    script: [],
    stepKeys: [],
    writes: [],
    unexpected: [],
    submitted: 0,
    events: [],
    clock: { now: 10_000 },
    afterStepKey: { fn: null },
    onRead: { fn: null },
  };
  // The fake TUI: a key moves the pane's revision by one and draws the next scripted screen.
  const draw = (data: string): void => {
    h.pane.keyInputRevision += 1;
    h.pane.bytes += 50;
    const next = h.script[0];
    if (next && next[0] === data) {
      h.script.shift();
      h.pane.rows = next[1];
    } else {
      h.unexpected.push(data);
    }
  };
  let next = 1;
  h.registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => (h.pane.rows ? [...h.pane.rows] : null),
    writeToSession: (_id, data) => {
      h.writes.push(data);
      h.pane.keyInputRevision += 1;
      h.pane.bytes += 50;
      return true;
    },
    writeStepKey: (_id, data) => {
      h.stepKeys.push(data);
      draw(data);
      const revision = h.pane.keyInputRevision;
      h.afterStepKey.fn?.(h.stepKeys.length - 1);
      return revision;
    },
    noteSubmitted: () => { h.submitted += 1; },
    readPromptScreen: async () => {
      h.onRead.fn?.();
      const rows = h.pane.rows;
      const mark = { bytes: h.pane.bytes, keyInputRevision: h.pane.keyInputRevision, incarnation: h.pane.incarnation };
      return rows ? { rows, mark, cols: h.pane.cols } : null;
    },
    promptScreenMark: () => ({ bytes: h.pane.bytes, keyInputRevision: h.pane.keyInputRevision, incarnation: h.pane.incarnation }),
    pendingToolUse: () => null,
    // Waiting advances the fake clock, so the driver's time bounds are exercised.
    promptReadDelay: async (ms) => { h.clock.now += ms; },
    schedule: () => () => undefined,
    now: () => h.clock.now,
    newId: () => `req-${next++}`,
    ...overrides,
  });
  h.registry.onEvent((e) => h.events.push(e));
  return h;
}

async function create(h: Harness, payload: unknown = MULTI_PAYLOAD, agent = 'claude'): Promise<ApprovalRequest> {
  const asked = extractAskUserQuestion(payload);
  const form = claudeQuestionsForm(payload);
  await h.registry.noteHookAwaitingInput({
    sessionId: 'pty-a',
    agent,
    workspaceId: 'ws-1',
    ...(asked.question ? { question: asked.question } : {}),
    ...(asked.options ? { options: asked.options } : {}),
    ...(asked.choices ? { choices: asked.choices } : {}),
    ...(asked.questionShape ? { questionShape: asked.questionShape } : {}),
    ...(form ? { form } : {}),
  });
  const [record] = h.registry.list().pending;
  if (!record) throw new Error('no record');
  h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
  return record;
}

let answerSeq = 0;
function answer(h: Harness, record: ApprovalRequest, body: Partial<DecisionAnswer> = {}) {
  return h.registry.resolve({
    id: record.id,
    decision: 'approve',
    resolvedBy: 'device Test phone (dev-1)',
    decisionV2Answer: DECISION_V2_WEB_ANSWER,
    decisionAnswer: {
      formFingerprint: record.formFingerprint!,
      clientAnswerId: `answer-0000000000${++answerSeq}`,
      ...body,
    },
  });
}

const MULTI_ANSWER: Partial<DecisionAnswer> = {
  answers: [{ questionId: 'q0', keys: ['2'] }, { questionId: 'q1', keys: ['3', '1'], other: 'anchovy' }],
};
/** The measured sequence multi-01 → multi-10, one key per screen. */
const MULTI_SCRIPT: Array<[string, readonly string[]]> = [
  ['2', MULTI.q2],
  ['1', MULTI.toggle1],
  ['3', MULTI.cheeseBasil],
  ['4', MULTI.otherToggled],
  [ASK_KEY_DOWN, ON_OLIVES],
  [ASK_KEY_DOWN, ON_BASIL],
  [ASK_KEY_DOWN, ON_OTHER],
  [paste('anchovy'), MULTI.otherText],
  [ASK_KEY_DOWN, MULTI.submitRow],
  [ASK_KEY_ENTER, MULTI.review],
  ['1', MULTI.answered],
];

const stored = (h: Harness, id: string): ApprovalRequest => {
  const listed = h.registry.list();
  return [...listed.pending, ...listed.recentlyResolved].find((r) => r.id === id)!;
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ask-answer-test-'));
});
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('the AskUserQuestion record', () => {
  it('carries the whole prompt as a questions form, next to the unchanged v1 fields', async () => {
    const h = makeRegistry();
    const record = await create(h);
    expect(record).toMatchObject({
      kind: 'awaiting_input',
      question: 'Which size?',
      choices: [{ key: '1', label: 'Small' }, { key: '2', label: 'Medium' }, { key: '3', label: 'Large' }],
      questionShape: 'multi-question',
      channel: 'fenced-keys',
      form: { v: 1, kind: 'questions', questions: [{ id: 'q0', header: 'Size' }, { id: 'q1', header: 'Toppings', multiSelect: true }] },
    });
    expect(record.formFingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gets a new fingerprint when the same prompt is asked again', async () => {
    const h = makeRegistry();
    const first = await create(h);
    const second = await create(h);
    expect(stored(h, first.id).state).toBe('superseded');
    expect(second.formFingerprint).not.toBe(first.formFingerprint);
  });

  it('has no form with the stepwise switch off, or with no driver key to type', async () => {
    const off = makeRegistry({ phoneDecisions: () => ({ native: true, stepwise: false }) });
    const record = await create(off);
    expect(record.form).toBeUndefined();
    expect(record.channel).toBeUndefined();
    expect(record.questionShape).toBe('multi-question');
    const noKeys = makeRegistry({ writeStepKey: undefined });
    expect((await create(noKeys)).form).toBeUndefined();
  });

  it('still refuses a v1 approve of a multi-question prompt with needs-v2', async () => {
    const h = makeRegistry();
    const record = await create(h);
    const result = await h.registry.resolve({ id: record.id, decision: 'approve', resolvedBy: 'phone' });
    expect(result).toMatchObject({ ok: false, reason: 'needs-v2' });
    expect(h.writes).toEqual([]);
  });

  it('still answers a single single-select question with one v1 key', async () => {
    const h = makeRegistry({}, SINGLE.initial);
    const record = await create(h, COLOR_PAYLOAD);
    expect(record.form?.questions).toHaveLength(1);
    const result = await h.registry.resolve({ id: record.id, decision: 'approve', choiceKey: '3', resolvedBy: 'phone' });
    expect(result).toMatchObject({ ok: true, request: { state: 'resolved', selectedChoiceKey: '3' } });
    expect(h.writes).toEqual(['3']);
    expect(h.stepKeys).toEqual([]);
  });
});

describe('answering the picker', () => {
  it('types the measured sequence, checks the review, submits and confirms the answer on screen', async () => {
    const h = makeRegistry();
    const record = await create(h);
    h.script = [...MULTI_SCRIPT];
    const result = await answer(h, record, MULTI_ANSWER);
    expect(h.unexpected).toEqual([]);
    expect(h.stepKeys).toEqual(MULTI_SCRIPT.map(([key]) => key));
    expect(h.writes).toEqual([]);
    expect(result).toMatchObject({ ok: true, request: { state: 'resolved', decision: 'approve' } });
    const done = stored(h, record.id);
    expect(done.step).toMatchObject({ index: 11, total: 11, status: 'done' });
    expect(done.answerDigest?.textBytes).toBe(7);
    expect(JSON.stringify(done)).not.toContain('anchovy');
    expect(h.submitted).toBe(1);
    expect(h.events.map((e) => e.type)).toEqual(['create', 'press', 'resolve']);
  });

  it('answers a single question with one digit and confirms it', async () => {
    const h = makeRegistry({}, SINGLE.initial);
    const record = await create(h, COLOR_PAYLOAD);
    h.script = [['3', SINGLE.answered]];
    const result = await answer(h, record, { answers: [{ questionId: 'q0', keys: ['3'] }] });
    expect(result).toMatchObject({ ok: true, request: { state: 'resolved' } });
    expect(h.stepKeys).toEqual(['3']);
  });

  it('types free text into a single question: its digit, the paste, Enter', async () => {
    const h = makeRegistry({}, COLOR_AGAIN);
    const record = await create(h, COLOR_PAYLOAD);
    h.script = [
      ['4', SINGLE.otherField],
      [paste('teal please'), SINGLE.otherPasted],
      [ASK_KEY_ENTER, colorAnswered('teal please')],
    ];
    const result = await answer(h, record, { answers: [{ questionId: 'q0', keys: [], other: 'teal please' }] });
    expect(h.unexpected).toEqual([]);
    expect(result).toMatchObject({ ok: true, request: { state: 'resolved' } });
    expect(stored(h, record.id).answerDigest?.textBytes).toBe(11);
  });

  describe('one multi-select question (its ending is not measured)', () => {
    const upToEnter: Array<[string, readonly string[]]> = [
      ['1', TOPPINGS.cheese],
      [ASK_KEY_DOWN, TOPPINGS_ON_OLIVES],
      [ASK_KEY_DOWN, TOPPINGS_ON_BASIL],
      [ASK_KEY_DOWN, TOPPINGS_ON_OTHER],
      [ASK_KEY_DOWN, TOPPINGS_ON_SUBMIT],
    ];
    const toppings = { answers: [{ questionId: 'q0', keys: ['1'] }] };

    it('resolves when Enter on the Submit row closes the picker at once', async () => {
      const h = makeRegistry({}, TOPPINGS.initial);
      const record = await create(h, TOPPINGS_PAYLOAD);
      expect(record.questionShape).toBe('multi-select');
      h.script = [...upToEnter, [ASK_KEY_ENTER, TOPPINGS_ANSWERED]];
      const result = await answer(h, record, toppings);
      expect(h.unexpected).toEqual([]);
      expect(result).toMatchObject({ ok: true, request: { state: 'resolved', decision: 'approve' } });
      // The review's `1` was never needed.
      expect(stored(h, record.id).step).toMatchObject({ index: 6, total: 6, status: 'done' });
      expect(h.stepKeys.at(-1)).toBe(ASK_KEY_ENTER);
      expect(h.submitted).toBe(1);
    });

    it('checks and submits a review screen when Enter draws one', async () => {
      const h = makeRegistry({}, TOPPINGS.initial);
      const record = await create(h, TOPPINGS_PAYLOAD);
      h.script = [...upToEnter, [ASK_KEY_ENTER, TOPPINGS_REVIEW], ['1', TOPPINGS_ANSWERED]];
      const result = await answer(h, record, toppings);
      expect(h.unexpected).toEqual([]);
      expect(result).toMatchObject({ ok: true, request: { state: 'resolved' } });
      expect(stored(h, record.id).step).toMatchObject({ index: 7, total: 7, status: 'done' });
      expect(h.submitted).toBe(1);
    });

    it('is answer-uncertain when Enter leads to neither', async () => {
      const h = makeRegistry({}, TOPPINGS.initial);
      const record = await create(h, TOPPINGS_PAYLOAD);
      h.script = [...upToEnter, [ASK_KEY_ENTER, BLANK_AFTER]];
      const result = await answer(h, record, toppings);
      expect(result).toMatchObject({ ok: false, reason: 'answer-uncertain' });
      expect(stored(h, record.id)).toMatchObject({ state: 'pending', step: { index: 6, total: 7, status: 'partial' } });
    });

    it('settles an unconfirmed Enter on Claude\'s own answered report, and on nothing else', async () => {
      for (const [reason, state] of [['answered-locally', 'resolved'], ['turn-ended', 'expired']] as const) {
        const h = makeRegistry({}, TOPPINGS.initial);
        const record = await create(h, TOPPINGS_PAYLOAD);
        h.script = [...upToEnter, [ASK_KEY_ENTER, BLANK_AFTER]];
        expect(await answer(h, record, toppings)).toMatchObject({ reason: 'answer-uncertain' });
        await h.registry.expireForSession('pty-a', reason);
        expect(stored(h, record.id).state).toBe(state);
      }
    });

    it('lets another tool\'s dialog in once Enter may have submitted it, although its review key is still planned', async () => {
      const h = makeRegistry({}, TOPPINGS.initial);
      const record = await create(h, TOPPINGS_PAYLOAD);
      h.script = [...upToEnter, [ASK_KEY_ENTER, BLANK_AFTER]];
      let fired = false;
      let noted: Promise<void> | undefined;
      h.onRead.fn = () => {
        if (fired || h.stepKeys.length !== 6) return;
        fired = true;
        noted = h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', toolName: 'Bash', source: 'hook' });
        h.pane.rows = TOPPINGS_ANSWERED;
      };
      const result = await answer(h, record, toppings);
      await noted;
      expect(result).toMatchObject({ ok: true });
      expect(h.registry.list().pending).toEqual([expect.objectContaining({ kind: 'terminal_prompt', toolName: 'Bash' })]);
    });

    it('refuses a picker that draws a Submit tab for one question, before any key', async () => {
      const h = makeRegistry({}, oneTab(MULTI.q2, '←  ☐ Toppings  ✔ Submit  →'));
      const record = await create(h, TOPPINGS_PAYLOAD);
      expect(await answer(h, record, toppings)).toMatchObject({ ok: false, reason: 'prompt-changed' });
      expect(h.stepKeys).toEqual([]);
    });
  });

  it('never takes an older answer block for this one: unconfirmed is answer-uncertain', async () => {
    const h = makeRegistry({}, COLOR_AGAIN);
    const record = await create(h, COLOR_PAYLOAD);
    // The picker closes, but the only block on screen is the old "→ Blue".
    h.script = [['3', [...SINGLE.otherField.slice(0, 20), ...Array.from({ length: 20 }, () => '')]]];
    const result = await answer(h, record, { answers: [{ questionId: 'q0', keys: ['3'] }] });
    expect(result).toMatchObject({ ok: false, reason: 'answer-uncertain' });
    expect(result.ok === false && result.effect).toBeUndefined();
    const after = stored(h, record.id);
    expect(after).toMatchObject({ state: 'pending', step: { index: 1, total: 1, status: 'partial' } });
    // Unconfirmed: no decision on the record, in the list or in any event a
    // shipped phone reads, and the pane is still blocked on its question.
    expect(after.decision).toBeUndefined();
    expect(h.events.some((e) => e.request.decision !== undefined)).toBe(false);
    expect(h.submitted).toBe(0);
    // Waited out its confirmation window.
    expect(h.clock.now).toBeGreaterThanOrEqual(10_000 + TERMINAL_PROMPT_MIN_ANSWER_AGE_MS + ASK_CONFIRM_WAIT_MS);
    // Nothing more is typed for it, from any path.
    expect(await answer(h, record, { answers: [{ questionId: 'q0', keys: ['3'] }] })).toMatchObject({ reason: 'already-answered' });
    expect(await h.registry.resolve({ id: record.id, decision: 'deny', resolvedBy: 'phone' })).toMatchObject({ reason: 'already-answered' });
    expect(h.writes).toEqual([]);
    // Claude's own word that the question was answered settles it, as this answer.
    await h.registry.expireForSession('pty-a', 'answered-locally', 'awaiting_input');
    expect(stored(h, record.id)).toMatchObject({ state: 'resolved', decision: 'approve', resolvedBy: 'device Test phone (dev-1)' });
  });

  it('is answer-uncertain when the last key closes the picker with nothing drawn about it', async () => {
    const h = makeRegistry();
    const record = await create(h);
    h.script = [...MULTI_SCRIPT.slice(0, -1), ['1', BLANK_AFTER]];
    const result = await answer(h, record, MULTI_ANSWER);
    expect(result).toMatchObject({ ok: false, reason: 'answer-uncertain' });
    expect(h.stepKeys).toHaveLength(11);
    // The pane's turn resumes only on a confirmed answer.
    expect(h.submitted).toBe(0);
  });

  it('does not press Submit on a review that lists another answer', async () => {
    const h = makeRegistry();
    const record = await create(h);
    const wrongReview = replaceRow(MULTI.review, '   → Basil, Cheese, anchovy', '   → Basil, Olives, anchovy');
    h.script = [...MULTI_SCRIPT.slice(0, 9), [ASK_KEY_ENTER, wrongReview]];
    const result = await answer(h, record, MULTI_ANSWER);
    expect(result).toMatchObject({ ok: false, reason: 'prompt-changed', effect: 'partial' });
    // Everything up to the review's Enter; never its `1`.
    expect(h.stepKeys).toEqual(MULTI_SCRIPT.slice(0, 10).map(([key]) => key));
    expect(stored(h, record.id)).toMatchObject({ state: 'pending', step: { index: 10, total: 11, status: 'partial' } });
    expect(h.submitted).toBe(0);
    // A partial answer is never resolved by a sweep: the prompt was not submitted.
    await h.registry.expireForSession('pty-a', 'answered-locally', 'awaiting_input');
    expect(stored(h, record.id).state).toBe('expired');
  });

  it('stops partial when a key does not draw what it should', async () => {
    const h = makeRegistry();
    const record = await create(h);
    // The toggle never shows.
    h.script = [['2', MULTI.q2], ['1', MULTI.q2]];
    const result = await answer(h, record, MULTI_ANSWER);
    expect(result).toMatchObject({ ok: false, reason: 'prompt-changed', effect: 'partial', request: { step: { index: 2, status: 'partial' } } });
    expect(h.stepKeys).toEqual(['2', '1']);
  });

  it('stops partial when a human key lands mid-answer', async () => {
    const h = makeRegistry();
    const record = await create(h);
    h.script = [...MULTI_SCRIPT];
    h.afterStepKey.fn = (index) => { if (index === 2) h.pane.keyInputRevision += 1; };
    const result = await answer(h, record, MULTI_ANSWER);
    expect(result).toMatchObject({ ok: false, reason: 'prompt-changed', effect: 'partial' });
    expect(h.stepKeys).toHaveLength(3);
  });

  it('holds a screen-inferred sweep while it runs, and resolves through it', async () => {
    const h = makeRegistry();
    const record = await create(h);
    h.script = [...MULTI_SCRIPT];
    h.afterStepKey.fn = (index) => {
      // The review screen takes the question row off the screen; a PostToolUse
      // may land before the driver has confirmed.
      if (index === 9) void h.registry.retireStaleQuestion('pty-a');
      if (index === 10) void h.registry.expireForSession('pty-a', 'answered-locally', 'awaiting_input');
    };
    const result = await answer(h, record, MULTI_ANSWER);
    expect(result).toMatchObject({ ok: true, request: { state: 'resolved' } });
  });

  it('is not superseded by another tool\'s dialog while it runs', async () => {
    const h = makeRegistry();
    const record = await create(h);
    h.script = [...MULTI_SCRIPT];
    let noted: Promise<void> | undefined;
    h.afterStepKey.fn = (index) => {
      if (index === 9) noted = h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', toolName: 'Bash', source: 'hook' });
    };
    const result = await answer(h, record, MULTI_ANSWER);
    await noted;
    expect(result).toMatchObject({ ok: true });
    expect(stored(h, record.id).state).toBe('resolved');
  });
});

describe('an answer the screen never confirmed (answer-uncertain)', () => {
  /** The color prompt answered with `3`; the picker closes, but only the OLD block is on screen. */
  async function colorUncertain(onConfirmRead?: (h: Harness) => void) {
    const h = makeRegistry({}, COLOR_AGAIN);
    const record = await create(h, COLOR_PAYLOAD);
    h.script = [['3', [...SINGLE.otherField.slice(0, 20), ...Array.from({ length: 20 }, () => '')]]];
    let fired = false;
    h.onRead.fn = () => {
      if (!onConfirmRead || fired || h.stepKeys.length !== 1) return;
      fired = true;
      onConfirmRead(h);
    };
    expect(await answer(h, record, { answers: [{ questionId: 'q0', keys: ['3'] }] })).toMatchObject({ ok: false, reason: 'answer-uncertain' });
    return { h, record };
  }

  it.each(['prompt-submitted', 'turn-ended', 'pane-gone', 'session-start', 'prompt-gone', 'screen-cleared'] as const)(
    'is expired, never resolved, by %s',
    async (reason) => {
      const { h, record } = await colorUncertain();
      await h.registry.expireForSession('pty-a', reason);
      const after = stored(h, record.id);
      expect(after.state).toBe('expired');
      expect(after.decision).toBeUndefined();
      expect(after.resolvedBy).toBeUndefined();
    },
  );

  it('settles a sweep held while it was confirming by the same rules', async () => {
    // The question dismissed at the terminal while the driver was still looking.
    const dismissed = await colorUncertain((h) => {
      void h.registry.expireForSession('pty-a', 'prompt-submitted', 'awaiting_input');
    });
    expect(stored(dismissed.h, dismissed.record.id)).toMatchObject({ state: 'expired' });
    expect(stored(dismissed.h, dismissed.record.id).decision).toBeUndefined();
    // A stale-question check first, then Claude's own report: the report wins.
    const answered = await colorUncertain((h) => {
      void h.registry.expireForSession('pty-a', 'prompt-gone', 'awaiting_input');
      void h.registry.expireForSession('pty-a', 'answered-locally', 'awaiting_input');
    });
    expect(stored(answered.h, answered.record.id)).toMatchObject({
      state: 'resolved',
      decision: 'approve',
      resolvedBy: 'device Test phone (dev-1)',
    });
  });
});

describe('other prompts on the pane while the answer runs', () => {
  it('holds a gate that lands while keys are typed, and the answer still lands', async () => {
    const h = makeRegistry();
    const record = await create(h);
    h.script = [...MULTI_SCRIPT];
    let gateId = '';
    h.afterStepKey.fn = (index) => {
      if (index === 3) gateId = h.registry.noteGateAwaiting({ sessionId: 'pty-a', agent: 'claude', toolName: 'Bash' });
    };
    const result = await answer(h, record, MULTI_ANSWER);
    expect(result).toMatchObject({ ok: true, request: { state: 'resolved' } });
    expect(stored(h, gateId)).toMatchObject({ kind: 'awaiting_permission', state: 'pending' });
  });

  it('holds a newer question that lands while keys are typed', async () => {
    const h = makeRegistry();
    const record = await create(h);
    h.script = [...MULTI_SCRIPT];
    h.afterStepKey.fn = (index) => {
      if (index === 3) void h.registry.noteHookAwaitingInput({ sessionId: 'pty-a', agent: 'claude', question: 'And a drink?' });
    };
    const result = await answer(h, record, MULTI_ANSWER);
    expect(result).toMatchObject({ ok: true, request: { state: 'resolved' } });
    expect(h.registry.list().pending).toEqual([expect.objectContaining({ question: 'And a drink?' })]);
  });

  it('holds only the typing answer: a second newer question still replaces the first', async () => {
    const h = makeRegistry();
    const record = await create(h);
    h.script = [...MULTI_SCRIPT];
    h.afterStepKey.fn = (index) => {
      if (index === 3) void h.registry.noteHookAwaitingInput({ sessionId: 'pty-a', agent: 'claude', question: 'And a drink?' });
      if (index === 4) void h.registry.noteHookAwaitingInput({ sessionId: 'pty-a', agent: 'claude', question: 'And dessert?' });
    };
    const result = await answer(h, record, MULTI_ANSWER);
    expect(result).toMatchObject({ ok: true, request: { state: 'resolved' } });
    // One card per pane again: the first newer question was replaced by the second.
    expect(h.registry.list().pending).toEqual([expect.objectContaining({ question: 'And dessert?' })]);
    expect(h.registry.list().recentlyResolved).toContainEqual(expect.objectContaining({ question: 'And a drink?', state: 'superseded' }));
  });

  it('applies a held supersede when the answer stops', async () => {
    const h = makeRegistry();
    const record = await create(h);
    // The toggle never shows.
    h.script = [['2', MULTI.q2], ['1', MULTI.q2]];
    h.afterStepKey.fn = (index) => {
      if (index === 0) h.registry.noteGateAwaiting({ sessionId: 'pty-a', agent: 'claude', toolName: 'Bash' });
    };
    const result = await answer(h, record, MULTI_ANSWER);
    expect(result).toMatchObject({ ok: false, reason: 'prompt-changed', effect: 'partial' });
    expect(stored(h, record.id).state).toBe('superseded');
  });

  it('lets another tool\'s dialog in once every key is typed', async () => {
    const h = makeRegistry();
    const record = await create(h);
    h.script = [...MULTI_SCRIPT.slice(0, -1), ['1', BLANK_AFTER]];
    let fired = false;
    let noted: Promise<void> | undefined;
    h.onRead.fn = () => {
      if (fired || h.stepKeys.length !== 11) return;
      fired = true;
      // The next tool's PermissionRequest, while the driver confirms the answer.
      noted = h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', toolName: 'Bash', source: 'hook' });
      h.pane.rows = MULTI.answered;
    };
    const result = await answer(h, record, MULTI_ANSWER);
    await noted;
    expect(result).toMatchObject({ ok: true });
    expect(h.registry.list().pending).toEqual([expect.objectContaining({ kind: 'terminal_prompt', toolName: 'Bash' })]);
  });

  it('is replaced by a follow-up question while it confirms, and leaves the pane to it', async () => {
    const h = makeRegistry();
    const record = await create(h);
    h.script = [...MULTI_SCRIPT.slice(0, -1), ['1', BLANK_AFTER]];
    let fired = false;
    h.onRead.fn = () => {
      if (h.stepKeys.length !== 11) return;
      if (!fired) {
        fired = true;
        void h.registry.noteHookAwaitingInput({ sessionId: 'pty-a', agent: 'claude', question: 'And a drink?' });
        return;
      }
      // The answered block shows on the next look.
      h.pane.rows = MULTI.answered;
    };
    const result = await answer(h, record, MULTI_ANSWER);
    expect(result).toMatchObject({ ok: true, request: { state: 'superseded' } });
    // The newer question holds the pane now: its wait is not released.
    expect(h.submitted).toBe(0);
    expect(h.registry.list().pending).toEqual([expect.objectContaining({ question: 'And a drink?' })]);
  });
});

describe('what is refused before any key', () => {
  it('a picker someone already touched', async () => {
    const h = makeRegistry({}, SINGLE.down);
    const record = await create(h, COLOR_PAYLOAD);
    const result = await answer(h, record, { answers: [{ questionId: 'q0', keys: ['3'] }] });
    expect(result).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(result.ok === false && result.effect).toBeUndefined();
    expect(h.stepKeys).toEqual([]);
    expect(stored(h, record.id).state).toBe('pending');
  });

  it('a question gone from the screen, which expires the record', async () => {
    const h = makeRegistry({}, SINGLE.answered);
    const record = await create(h, MULTI_PAYLOAD);
    const result = await answer(h, record, MULTI_ANSWER);
    expect(result).toMatchObject({ ok: false, reason: 'prompt-gone' });
    expect(stored(h, record.id).state).toBe('expired');
    expect(h.stepKeys).toEqual([]);
  });

  it('an answer that does not fit the form', async () => {
    const h = makeRegistry();
    const record = await create(h);
    const cases: Array<Partial<DecisionAnswer>> = [
      { answers: [{ questionId: 'q0', keys: ['2'] }] },
      { answers: [{ questionId: 'q0', keys: ['1', '2'] }, { questionId: 'q1', keys: ['1'] }] },
      { answers: [{ questionId: 'q0', keys: ['9'] }, { questionId: 'q1', keys: ['1'] }] },
      { action: 'submit', text: 'hi', answers: [{ questionId: 'q0', keys: ['2'] }, { questionId: 'q1', keys: ['1'] }] },
    ];
    for (const body of cases) expect(await answer(h, record, body)).toMatchObject({ ok: false, reason: 'invalid-choice' });
    expect(h.stepKeys).toEqual([]);
  });

  it('free text that cannot be pasted and read back', async () => {
    const h = makeRegistry();
    const record = await create(h);
    const withOther = (other: string): Partial<DecisionAnswer> =>
      ({ answers: [{ questionId: 'q0', keys: ['2'] }, { questionId: 'q1', keys: [], other }] });
    expect(await answer(h, record, withOther('a\x1b[201~b'))).toMatchObject({ reason: 'invalid-text' });
    expect(await answer(h, record, withOther('Type something'))).toMatchObject({ reason: 'invalid-text' });
    // Read back with its spaces removed, as the echo check does: still the placeholder.
    expect(await answer(h, record, withOther('Type some thing'))).toMatchObject({ reason: 'invalid-text' });
    // One row of a 100-column pane holds 88 columns; a wide character counts two.
    expect(await answer(h, record, withOther('x'.repeat(89)))).toMatchObject({ reason: 'invalid-text' });
    expect(await answer(h, record, withOther('漢'.repeat(45)))).toMatchObject({ reason: 'invalid-text' });
    expect(h.stepKeys).toEqual([]);
  });

  it('a stale fingerprint, a too-early answer, a caller without the web marker', async () => {
    const h = makeRegistry();
    const record = await create(h);
    expect(await answer(h, record, { ...MULTI_ANSWER, formFingerprint: 'f'.repeat(32) })).toMatchObject({ reason: 'prompt-changed' });
    expect(await h.registry.resolve({
      id: record.id,
      decision: 'approve',
      resolvedBy: 'pipe',
      decisionAnswer: { formFingerprint: record.formFingerprint!, clientAnswerId: 'answer-00000000009999', ...MULTI_ANSWER },
    })).toMatchObject({ reason: 'answer-in-terminal', answerRefusal: 'no-capability' });
    const early = makeRegistry();
    await early.registry.noteHookAwaitingInput({ sessionId: 'pty-a', agent: 'claude', form: claudeQuestionsForm(MULTI_PAYLOAD)! });
    const [fresh] = early.registry.list().pending;
    expect(await answer(early, fresh!, MULTI_ANSWER)).toMatchObject({ reason: 'answer-too-soon' });
    expect([...h.stepKeys, ...early.stepKeys]).toEqual([]);
  });

  it('an answer once the stepwise switch is turned off', async () => {
    let stepwise = true;
    const h = makeRegistry({ phoneDecisions: () => ({ native: true, stepwise }) });
    const record = await create(h);
    stepwise = false;
    expect(await answer(h, record, MULTI_ANSWER)).toMatchObject({ reason: 'answer-in-terminal', answerRefusal: 'unsupported-shape' });
  });

  it('an answer longer than the driver will type', async () => {
    const h = makeRegistry();
    const many = {
      tool_input: {
        questions: [0, 1, 2, 3].map((i) => ({
          question: `Question ${i}?`,
          header: `H${i}`,
          multiSelect: true,
          options: [1, 2, 3, 4, 5, 6, 7, 8].map((j) => ({ label: `Option ${j}` })),
        })),
      },
    };
    const record = await create(h, many);
    const result = await answer(h, record, {
      answers: [0, 1, 2, 3].map((i) => ({ questionId: `q${i}`, keys: ['1'] })),
    });
    expect(result).toMatchObject({ reason: 'answer-in-terminal', answerRefusal: 'unsupported-shape' });
    expect(h.stepKeys).toEqual([]);
  });
});

describe('Cancel', () => {
  it('is the v1 path\'s one Esc, behind its own screen proof', async () => {
    const h = makeRegistry();
    const record = await create(h);
    const result = await answer(h, record, { action: 'deny' });
    expect(result).toMatchObject({ ok: true, request: { state: 'resolved', decision: 'deny' } });
    expect(h.writes).toEqual(['\x1b']);
    expect(h.stepKeys).toEqual([]);
  });
});
