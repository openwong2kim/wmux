// The permission dialog in Claude Code's screen-reader layout
// (fixtures/screen-reader/, measured on 2.1.316): read up from its key row,
// never by the cursor-based parser, and never answerable.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseTerminalPrompt, PROMPT_MAX_OPTIONS, terminalPromptAnswerability } from '../terminalPromptParse';

const screen = (name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'screen-reader', `${name}.json`), 'utf8')) as {
    screen: string[];
  }).screen;

const BASH_OPTIONS = [
  ['1', 'Yes'],
  ['2', 'Yes, and don’t ask again for'],
  ['3', 'Yes, and switch to auto mode — · auto mode handles these prompts for you'],
  ['4', 'No'],
];
const FILE_OPTIONS = [
  ['1', 'Yes'],
  ['2', 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)'],
  ['3', 'No'],
];
const BASH_COMMAND = ['Remove the build output', 'npm run clean', 'This command requires approval'];

/** The fixture's rows with the row starting `prefix` replaced by `rows`. */
const replaceRow = (rows: string[], prefix: string, ...with_: string[]): string[] => {
  const at = rows.findIndex((row) => row.startsWith(prefix));
  expect(at).toBeGreaterThanOrEqual(0);
  return [...rows.slice(0, at), ...with_, ...rows.slice(at + 1)];
};

describe('parseTerminalPrompt — screen-reader layout', () => {
  it.each([
    ['claude-sr-bash-100x30', 'Bash command', 'Do you want to proceed?', BASH_COMMAND, BASH_OPTIONS],
    // The tip, option 3 and the key row each take two rows at 60 columns.
    ['claude-sr-bash-60x30', 'Bash command', 'Do you want to proceed?', BASH_COMMAND, BASH_OPTIONS],
    // A typed digit shows after the key row's colon.
    ['claude-sr-bash-typed1-100x30', 'Bash command', 'Do you want to proceed?', BASH_COMMAND, BASH_OPTIONS],
    ['claude-sr-write-100x30', 'Create file', 'Do you want to create new.txt?',
      ['new.txt', '1 first line', '2 second line'], FILE_OPTIONS],
    ['claude-sr-edit-100x30', 'Edit file', 'Do you want to make this edit to notes.txt?',
      ['notes.txt', '1 first line', '2 - second line', '2 + second line, edited'], FILE_OPTIONS],
  ])('reads %s', (name, title, question, command, options) => {
    const parsed = parseTerminalPrompt(screen(name));
    expect(parsed).toMatchObject({
      title,
      question,
      commandRows: command,
      commandLines: command,
      commandText: command.join(' · '),
      commandFull: command.join(' '),
      descriptionRows: [],
      topRuleFound: true,
      truncated: false,
      cut: false,
      bodyCut: false,
      active: true,
      screenReader: true,
    });
    expect(parsed?.reason).toBeUndefined();
    expect(parsed?.options).toEqual(options.map(([key, label]) => ({ key, label, selected: false })));
    expect(terminalPromptAnswerability(parsed!)).toEqual({ answerable: false, choices: [] });
  });

  it('hashes the dialog the same however it is wrapped or what is typed', () => {
    const wide = parseTerminalPrompt(screen('claude-sr-bash-100x30'))!.fingerprint;
    expect(parseTerminalPrompt(screen('claude-sr-bash-60x30'))!.fingerprint).toBe(wide);
    expect(parseTerminalPrompt(screen('claude-sr-bash-typed1-100x30'))!.fingerprint).toBe(wide);
    expect(parseTerminalPrompt(screen('claude-sr-write-100x30'))!.fingerprint).not.toBe(wide);
  });

  it.each([
    // AskUserQuestion: its question is not a permission question.
    'claude-sr-ask-100x30',
    'claude-sr-ask-typed2-100x30',
    'claude-sr-askmulti-100x30',
    // Folder trust: a y/n key row.
    'claude-sr-trust-100x30',
    'claude-sr-trust-60x30',
    'claude-sr-trust-typed-y-100x30',
    // An answered dialog is erased.
    'claude-sr-bash-answered-100x30',
    'claude-sr-trust-answered-100x30',
    'claude-sr-ask-answered-100x30',
  ])('reads no permission dialog in %s', (name) => {
    expect(parseTerminalPrompt(screen(name))).toBeNull();
  });

  it('reads a y/n key row as no permission dialog, whatever is above it', () => {
    expect(parseTerminalPrompt(replaceRow(screen('claude-sr-bash-100x30'), 'Select with', 'Enter y/n:'))).toBeNull();
  });

  it('reads a question that does not start the row as no permission question', () => {
    const rows = replaceRow(screen('claude-sr-ask-100x30'), '> Which database', '> Do you want to proceed?');
    expect(parseTerminalPrompt(rows)).toBeNull();
  });

  it("leaves Claude's tip out of a body without `> ` rows", () => {
    const rows = replaceRow(screen('claude-sr-write-100x30'), 'new.txt', 'Tip: use accept edits', 'new.txt');
    expect(parseTerminalPrompt(rows)?.commandRows).toEqual(['new.txt', '1 first line', '2 second line']);
  });

  it('refuses options that are not 1..max in order', () => {
    const rows = screen('claude-sr-bash-100x30');
    const keyRow = 'Select with numbers [1-4]. Then Enter to submit or Escape to cancel:';
    expect(parseTerminalPrompt(replaceRow(rows, 'Select with', keyRow.replace('[1-4]', '[1-5]')))).toBeNull();
    expect(parseTerminalPrompt(replaceRow(rows, '4. No'))).toBeNull();
    expect(parseTerminalPrompt(replaceRow(rows, '2. Yes', '3. Yes, and don’t ask again for'))).toBeNull();
    const swapped = replaceRow(replaceRow(rows, '2. Yes', '3. Yes, and don’t ask again for'), '3. Yes, and switch', '2. Yes, and switch');
    expect(parseTerminalPrompt(swapped)).toBeNull();
  });

  it('refuses more than PROMPT_MAX_OPTIONS options', () => {
    const n = PROMPT_MAX_OPTIONS + 1;
    const rows = replaceRow(
      screen('claude-sr-bash-100x30'),
      'Select with',
      ...Array.from({ length: n - 4 }, (_, i) => `${i + 5}. Option ${i + 5}`),
      `Select with numbers [1-${n}]. Then Enter to submit or Escape to cancel:`,
    );
    expect(parseTerminalPrompt(rows)).toBeNull();
  });

  it('joins a last option broken onto the row above the key row', () => {
    const rows = replaceRow(screen('claude-sr-write-100x30'), '3. No', '3. No, and tell Claude what', 'to do differently');
    expect(parseTerminalPrompt(rows)?.options[2]).toEqual({ key: '3', label: 'No, and tell Claude what to do differently', selected: false });
  });

  it('reads a dialog whose title row scrolled off without a title', () => {
    const parsed = parseTerminalPrompt(replaceRow(screen('claude-sr-bash-100x30'), 'Permission Required:'));
    expect(parsed).toMatchObject({ commandRows: BASH_COMMAND, topRuleFound: false, screenReader: true });
    expect(parsed?.title).toBeUndefined();
  });

  it('does not read the same screen without its key row as the screen-reader layout', () => {
    const parsed = parseTerminalPrompt(replaceRow(screen('claude-sr-bash-100x30'), 'Select with'));
    expect(parsed).not.toBeNull();
    expect(parsed?.screenReader).toBeUndefined();
    expect(parsed?.active).toBe(false);
  });
});
