// Claude Code's screen-reader layout ends every dialog with a key row
// (fixtures/screen-reader/, measured on 2.1.316): read only at the bottom of
// the grid by screenReaderKeyRow, anywhere by showsScreenReaderKeyRow.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { screenReaderKeyRow, showsScreenReaderKeyRow } from '../screenReaderKeyRow';

const screen = (dir: string, name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', dir, `${name}.json`), 'utf8')) as {
    screen: string[];
  }).screen;

const keyRowOf = (rows: Parameters<typeof screenReaderKeyRow>[0]) => {
  const key = screenReaderKeyRow(rows);
  return key && { keys: key.keys, max: key.max, multi: key.multi, row: key.lines[key.at] };
};

describe('screenReaderKeyRow', () => {
  it.each([
    ['claude-sr-bash-100x30', 'numbers', 4, false],
    ['claude-sr-bash-typed1-100x30', 'numbers', 4, false],
    // The key row takes two rows at 60 columns.
    ['claude-sr-bash-60x30', 'numbers', 4, false],
    ['claude-sr-write-100x30', 'numbers', 3, false],
    ['claude-sr-edit-100x30', 'numbers', 3, false],
    // No key hint under an AskUserQuestion.
    ['claude-sr-ask-100x30', 'numbers', 4, false],
    ['claude-sr-ask-typed2-100x30', 'numbers', 4, false],
    ['claude-sr-askmulti-100x30', 'numbers', 4, true],
    ['claude-sr-trust-100x30', 'y/n', undefined, false],
    ['claude-sr-trust-60x30', 'y/n', undefined, false],
    ['claude-sr-trust-typed-y-100x30', 'y/n', undefined, false],
  ] as const)('reads the key row of %s', (name, keys, max, multi) => {
    const rows = screen('screen-reader', name);
    expect(keyRowOf(rows)).toMatchObject({ keys, max, multi });
    expect(keyRowOf(rows)?.row).toMatch(/^(?:Select with numbers|Enter y\/n:)/);
    expect(showsScreenReaderKeyRow(rows)).toBe(true);
  });

  it.each([
    ['screen-reader', 'claude-sr-bash-answered-100x30'],
    ['screen-reader', 'claude-sr-trust-answered-100x30'],
    ['screen-reader', 'claude-sr-ask-answered-100x30'],
    ['folder-trust', 'claude-folder-trust-120x40'],
    ['terminal-prompts', 'claude-bash-boxed-01'],
    ['terminal-prompts', 'claude-ask-single-01-initial'],
  ])('finds none in %s/%s', (dir, name) => {
    const rows = screen(dir, name);
    expect(screenReaderKeyRow(rows)).toBeNull();
    expect(showsScreenReaderKeyRow(rows)).toBe(false);
  });

  it('reads the bottom of the grid only', () => {
    const rows = screen('screen-reader', 'claude-sr-bash-100x30');
    const at = rows.findIndex((row) => row.startsWith('Select with numbers'));
    // Output under the key row: it is not the live dialog's.
    expect(screenReaderKeyRow([...rows.slice(0, at + 2), 'tool: Bash (npm run clean)'])).toBeNull();
    expect(screenReaderKeyRow([...rows.slice(0, at + 1), 'Select the build target'])).toBeNull();
    // Still shown, for a check that must not read the dialog as gone.
    expect(showsScreenReaderKeyRow([...rows.slice(0, at + 2), 'tool: Bash (npm run clean)'])).toBe(true);
  });

  it('reads a key row that does not read whole as none', () => {
    const rows = screen('screen-reader', 'claude-sr-bash-100x30');
    const at = rows.findIndex((row) => row.startsWith('Select with numbers'));
    const withRow = (row: string) => [...rows.slice(0, at), row, 'Esc to cancel'];
    expect(keyRowOf(withRow('Select with numbers [1-4]. Then Enter to submit or Escape to cancel: 1, 3'))).toMatchObject({ max: 4 });
    expect(screenReaderKeyRow(withRow('Select with numbers [1-4]. Then Enter to submit or Escape to cancel: yes please'))).toBeNull();
    expect(screenReaderKeyRow(withRow('Select with numbers [1-4]. Then press Enter'))).toBeNull();
    expect(screenReaderKeyRow([...rows.slice(0, at), 'Enter y/n: yes', 'Esc to cancel'])).toBeNull();
  });

  it('joins a key row broken over rows, with or without the soft-wrap flag', () => {
    const head = 'Select with numbers [1-4]. Then Enter to submit or Escape to';
    expect(keyRowOf([head, ' cancel:', 'Esc to cancel'])).toMatchObject({ keys: 'numbers', max: 4, row: head });
    expect(keyRowOf([{ text: head }, { text: ' cancel:', wrapped: true }])).toMatchObject({ keys: 'numbers', max: 4 });
    // Broken right after a space: the space is cut off the first row.
    expect(keyRowOf([{ text: head }, { text: 'cancel:', wrapped: true }])).toMatchObject({ keys: 'numbers', max: 4 });
    // Under 26 columns the first row ends before `[1-4]`.
    expect(keyRowOf(['Select with numbers', '[1-4]. Then Enter to', 'submit or Escape to', 'cancel:'])).toMatchObject({ keys: 'numbers', max: 4, row: 'Select with numbers' });
    expect(showsScreenReaderKeyRow(['1. PostgreSQL', 'Select with numbers', '[1-4]. Then Enter to'])).toBe(true);
    // A blank row inside it breaks it.
    expect(screenReaderKeyRow([head, '', ' cancel:'])).toBeNull();
  });
});
