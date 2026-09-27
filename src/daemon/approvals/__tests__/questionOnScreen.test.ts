// The own-dialog proof every awaiting_input press is gated on: is THIS
// question, with every one of its options, the dialog on screen?

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { questionOnScreen } from '../approvalKeystrokes';

const fixture = (name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'terminal-prompts', `${name}.json`), 'utf8')) as {
    screen: string[];
  }).screen;

const SIZE = {
  question: 'Which size?',
  choices: [{ key: '1', label: 'Small' }, { key: '2', label: 'Medium' }, { key: '3', label: 'Large' }],
};

/** A Claude Code 2.1.283 permission dialog, as the next thing after an Esc'd question. */
const PERMISSION = [
  ' Bash command',
  '',
  '   touch stale-test.txt',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel · Tab to amend',
];

describe('questionOnScreen', () => {
  it('matches a measured single-select question and its multi-question first tab', () => {
    expect(questionOnScreen(fixture('claude-ask-multi-01-q1'), SIZE)).toBe('match');
  });

  it('reads multi-select rows past their checkbox', () => {
    expect(questionOnScreen(fixture('claude-ask-multi-02-q2'), {
      question: 'Which toppings?',
      choices: [{ key: '1', label: 'Cheese' }, { key: '2', label: 'Olives' }, { key: '3', label: 'Basil' }],
    })).toBe('match');
  });

  it('is unprovable without question text or without choices', () => {
    expect(questionOnScreen(fixture('claude-ask-multi-01-q1'), { choices: SIZE.choices })).toBe('unprovable');
    expect(questionOnScreen(fixture('claude-ask-multi-01-q1'), { question: 'Which size?' })).toBe('unprovable');
    expect(questionOnScreen(fixture('claude-ask-multi-01-q1'), { question: 'Which size?', choices: [] })).toBe('unprovable');
  });

  it('a "Yes" option never matches the permission dialog that replaced its question', () => {
    const yesNo = { question: 'Ship it?', choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }] };
    expect(questionOnScreen(PERMISSION, yesNo)).toBe('absent');
    // Even a question worded exactly like the dialog is not proven by it: the
    // permission prompt has no free-text row.
    expect(questionOnScreen(PERMISSION, { ...yesNo, question: 'Do you want to proceed?' })).toBe('changed');
  });

  it('a label is never read off a longer option that merely starts with it', () => {
    const rows = ['Proceed?', '❯ 1. Yes, and always allow access', '  2. No', '  3. Type something.'];
    expect(questionOnScreen(rows, {
      question: 'Proceed?', choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }],
    })).toBe('changed');
  });

  it('key 1 is not read off an `11.` row', () => {
    const rows = ['Pick one?', '  11. Kale', '  2. Leek', '  3. Type something.'];
    expect(questionOnScreen(rows, {
      question: 'Pick one?', choices: [{ key: '1', label: 'Kale' }, { key: '2', label: 'Leek' }],
    })).toBe('changed');
  });

  it('a prompt echo or a transcript line quoting the question does not count as the question', () => {
    const rows = [
      '❯ Call AskUserQuestion once: question "Pick a fruit?", options Apple, Pear.',
      '  ⎿ · Pick a fruit? → Apple',
      '❯ 1. Apple',
      '  2. Pear',
      '  3. Type something.',
    ];
    expect(questionOnScreen(rows, {
      question: 'Pick a fruit?', choices: [{ key: '1', label: 'Apple' }, { key: '2', label: 'Pear' }],
    })).toBe('absent');
  });

  it('a label cut at the pane width still reads back; a different label does not', () => {
    const q = { question: 'Which approach?', choices: [{ key: '1', label: 'Rewrite the parser from scratch' }] };
    expect(questionOnScreen(['Which approach?', '❯ 1. Rewrite the pars', '  2. Type something.'], q)).toBe('match');
    expect(questionOnScreen(['Which approach?', '❯ 1. Patch it', '  2. Type something.'], q)).toBe('changed');
  });

  it('options must read back in key order below the question', () => {
    const rows = ['  2. Leek', 'Pick one?', '❯ 1. Kale', '  3. Type something.'];
    expect(questionOnScreen(rows, {
      question: 'Pick one?', choices: [{ key: '1', label: 'Kale' }, { key: '2', label: 'Leek' }],
    })).toBe('changed');
  });
});
