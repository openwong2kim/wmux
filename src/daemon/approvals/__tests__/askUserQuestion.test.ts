// A4 — extraction of the question + option labels from a PreToolUse envelope.
//
// The input is agent-authored and reaches approvals.json, an HTTP body, and a
// phone screen, so the tests below care about two things in equal measure: that
// a well-formed payload yields readable text, and that a hostile or broken one
// yields ABSENCE rather than a throw, an unbounded string, or a control
// sequence.

import { describe, it, expect } from 'vitest';
import {
  extractAskUserQuestion,
  sanitizeOptions,
  sanitizeQuestion,
  MAX_OPTIONS,
  MAX_OPTION_LABEL_CHARS,
  MAX_QUESTION_CHARS,
} from '../askUserQuestion';

/** The canonical Claude Code AskUserQuestion tool_input. */
function canonical(overrides: Record<string, unknown> = {}) {
  return {
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        {
          question: 'Which approach should I take?',
          header: 'Approach',
          multiSelect: false,
          options: [
            { label: 'Rewrite the parser', description: 'Slower but cleaner' },
            { label: 'Patch the existing one', description: 'Faster' },
          ],
        },
      ],
    },
    ...overrides,
  };
}

describe('extractAskUserQuestion — normal extraction', () => {
  it('pulls the question and the option labels from the canonical shape', () => {
    expect(extractAskUserQuestion(canonical())).toEqual({
      question: 'Which approach should I take?',
      options: ['Rewrite the parser', 'Patch the existing one'],
    });
  });

  it('drops the option descriptions — labels are what a button shows', () => {
    const out = extractAskUserQuestion(canonical());
    expect(out.options?.join(' ')).not.toContain('Slower but cleaner');
  });

  it('tolerates the flat {question, options} shape', () => {
    const out = extractAskUserQuestion({
      tool_input: { question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] },
    });
    expect(out).toEqual({ question: 'Proceed?', options: ['Yes', 'No'] });
  });

  it('tolerates bare-string options', () => {
    const out = extractAskUserQuestion({
      tool_input: { questions: [{ question: 'Proceed?', options: ['Yes', 'No'] }] },
    });
    expect(out).toEqual({ question: 'Proceed?', options: ['Yes', 'No'] });
  });

  it('reads only the FIRST question — the keystroke can only answer that one', () => {
    const out = extractAskUserQuestion({
      tool_input: {
        questions: [
          { question: 'First?', options: [{ label: 'A' }] },
          { question: 'Second?', options: [{ label: 'B' }] },
        ],
      },
    });
    expect(out.question).toBe('First?');
    expect(out.options).toEqual(['A']);
  });

  it('keeps a question with no options, and options with no question', () => {
    expect(extractAskUserQuestion({ tool_input: { question: 'Proceed?' } })).toEqual({
      question: 'Proceed?',
    });
    expect(extractAskUserQuestion({ tool_input: { options: ['Yes'] } })).toEqual({
      options: ['Yes'],
    });
  });
});

describe('extractAskUserQuestion — sanitising and truncation', () => {
  it('truncates an oversized question to the display cap', () => {
    const out = extractAskUserQuestion({ tool_input: { question: 'x'.repeat(5_000) } });
    expect(out.question).toHaveLength(MAX_QUESTION_CHARS);
  });

  it('truncates an oversized option label', () => {
    const out = extractAskUserQuestion({
      tool_input: { options: [{ label: 'y'.repeat(5_000) }] },
    });
    expect(out.options?.[0]).toHaveLength(MAX_OPTION_LABEL_CHARS);
  });

  it('caps the number of options', () => {
    const out = extractAskUserQuestion({
      tool_input: { options: Array.from({ length: 100 }, (_, i) => `opt-${i}`) },
    });
    expect(out.options).toHaveLength(MAX_OPTIONS);
    expect(out.options?.[0]).toBe('opt-0');
  });

  it('survives a multi-megabyte label without hanging', () => {
    // The pre-regex cap is what makes this fast; without it the control-char
    // scan and whitespace collapse run over the whole string on the daemon's
    // event loop, on a path an agent controls.
    const started = Date.now();
    const out = extractAskUserQuestion({
      tool_input: { question: 'a'.repeat(5_000_000), options: [{ label: 'b'.repeat(5_000_000) }] },
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out.question).toHaveLength(MAX_QUESTION_CHARS);
    expect(out.options?.[0]).toHaveLength(MAX_OPTION_LABEL_CHARS);
  });

  it('strips ANSI escapes and control characters an agent put in a label', () => {
    const out = extractAskUserQuestion({
      tool_input: {
        question: 'Delete\x07 everything?\x1b[31m',
        options: [{ label: 'Yes\x00 really' }],
      },
    });
    expect(out.question).toBe('Delete everything? [31m');
    expect(out.options?.[0]).toBe('Yes really');
    // Whatever survives, no C0/C1 control character does.
    // eslint-disable-next-line no-control-regex
    const controls = /[\x00-\x1f\x7f-\x9f]/;
    expect(controls.test(out.question ?? '')).toBe(false);
    expect(controls.test(out.options?.[0] ?? '')).toBe(false);
  });

  it('collapses newlines so a label cannot fake extra rows on a phone', () => {
    const out = extractAskUserQuestion({
      tool_input: { options: [{ label: 'Yes\n\n\nApprove everything' }] },
    });
    expect(out.options?.[0]).toBe('Yes Approve everything');
  });

  it('drops whitespace-only labels rather than rendering blank rows', () => {
    const out = extractAskUserQuestion({
      tool_input: { options: [{ label: '   ' }, { label: 'Yes' }, { label: '\n' }] },
    });
    expect(out.options).toEqual(['Yes']);
  });
});

describe('extractAskUserQuestion — malformed payloads yield absence, never a throw', () => {
  const malformed: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not an object'],
    ['a number', 42],
    ['an array', [1, 2, 3]],
    ['no tool_input', { tool_name: 'AskUserQuestion' }],
    ['tool_input null', { tool_input: null }],
    ['tool_input a string', { tool_input: 'nope' }],
    ['tool_input an array', { tool_input: [] }],
    ['questions not an array', { tool_input: { questions: 'nope' } }],
    ['questions empty', { tool_input: { questions: [] } }],
    ['questions[0] null', { tool_input: { questions: [null] } }],
    ['question not a string', { tool_input: { question: { nested: true } } }],
    ['options not an array', { tool_input: { options: 'yes,no' } }],
    ['options of nulls', { tool_input: { options: [null, undefined] } }],
    ['options of numbers', { tool_input: { options: [1, 2] } }],
    ['option objects with no label', { tool_input: { options: [{ description: 'x' }] } }],
  ];

  for (const [name, payload] of malformed) {
    it(`${name} → {} and no throw`, () => {
      expect(() => extractAskUserQuestion(payload)).not.toThrow();
      expect(extractAskUserQuestion(payload)).toEqual({});
    });
  }

  it('a prototype-pollution shaped payload extracts nothing dangerous', () => {
    const out = extractAskUserQuestion(
      JSON.parse('{"tool_input":{"__proto__":{"polluted":true},"question":"ok"}}'),
    );
    expect(out.question).toBe('ok');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('read-back sanitisers (a hand-edited approvals.json)', () => {
  it('re-truncates an oversized stored question', () => {
    expect(sanitizeQuestion('q'.repeat(9_999))).toHaveLength(MAX_QUESTION_CHARS);
  });

  it('re-caps and re-cleans stored options', () => {
    const out = sanitizeOptions([...Array(50).keys()].map(() => 'a\x1b[0m'.repeat(200)));
    expect(out).toHaveLength(MAX_OPTIONS);
    expect(out?.[0]).toHaveLength(MAX_OPTION_LABEL_CHARS);
  });

  it('non-string / empty inputs come back undefined, not empty containers', () => {
    expect(sanitizeQuestion(undefined)).toBeUndefined();
    expect(sanitizeQuestion(42)).toBeUndefined();
    expect(sanitizeQuestion('   ')).toBeUndefined();
    expect(sanitizeOptions(undefined)).toBeUndefined();
    expect(sanitizeOptions('nope')).toBeUndefined();
    expect(sanitizeOptions([])).toBeUndefined();
    expect(sanitizeOptions(['  ', null])).toBeUndefined();
  });
});
