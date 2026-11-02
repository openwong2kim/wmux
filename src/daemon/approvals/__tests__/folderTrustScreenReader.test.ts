// Claude Code's folder-trust dialog in its screen-reader layout
// (fixtures/screen-reader/, measured on 2.1.316): letter-keyed choices with no
// cursor over an `Enter y/n:` key row.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { looksLikeFolderTrustDialog, readFolderTrustScreen } from '../approvalKeystrokes';

const screen = (dir: string, name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', dir, `${name}.json`), 'utf8')) as {
    screen: string[];
  }).screen;

const trust = (): string[] => screen('screen-reader', 'claude-sr-trust-100x30');
/** The trust dialog with the rows from `from` to `to` (exclusive) replaced. */
const edited = (from: string, to: string, replacement: string[]): string[] => {
  const rows = trust();
  const at = rows.indexOf(from);
  const end = rows.indexOf(to);
  return [...rows.slice(0, at), ...replacement, ...rows.slice(end)];
};

describe('readFolderTrustScreen in the screen-reader layout', () => {
  it.each([
    'claude-sr-trust-100x30',
    // The question wraps at 60 columns, the choices do not.
    'claude-sr-trust-60x30',
    // A typed key shows after the colon; the dialog is up until Enter.
    'claude-sr-trust-typed-y-100x30',
  ])('reads %s as the trust dialog', (name) => {
    const rows = screen('screen-reader', name);
    expect(readFolderTrustScreen(rows)).toBe('trust');
    expect(looksLikeFolderTrustDialog(rows)).toBe(true);
  });

  it.each([
    'claude-sr-trust-answered-100x30',
    'claude-sr-bash-100x30',
    'claude-sr-bash-60x30',
    'claude-sr-bash-typed1-100x30',
    'claude-sr-bash-answered-100x30',
    'claude-sr-write-100x30',
    'claude-sr-edit-100x30',
    'claude-sr-ask-100x30',
    'claude-sr-ask-typed2-100x30',
    'claude-sr-askmulti-100x30',
    'claude-sr-ask-answered-100x30',
  ])('reads no trust dialog in %s', (name) => {
    expect(readFolderTrustScreen(screen('screen-reader', name))).toBeNull();
  });

  it('needs the trust question, not the title row', () => {
    expect(readFolderTrustScreen(trust().filter((row) => !row.startsWith('Permission Required')))).toBe('trust');
  });

  it.each([
    ['an unknown granting label', ['y. Sure', 'n. No, exit']],
    ['an unknown declining label', ['y. Yes, I trust this folder', 'n. Not now']],
    ['two granting labels', ['y. Yes, I trust this folder', 'n. Yes, proceed']],
    ['a label cut with an ellipsis', ['y. Yes, I trust th…', 'n. No, exit']],
    ['a choice broken over two rows', ['y. Yes, I trust this', 'folder', 'n. No, exit']],
    ['the last choice broken over two rows', ['y. Yes, I trust this folder', 'n. No,', 'exit']],
    ['keys other than y and n', ['a. Yes, I trust this folder', 'b. No, exit']],
    ['a third choice', ['y. Yes, I trust this folder', 'n. No, exit', 'q. Quit']],
    ['a selection cursor', ['❯ y. Yes, I trust this folder', 'n. No, exit']],
  ])('reads %s as unreadable', (_, choices) => {
    const rows = edited('y. Yes, I trust this folder', 'Enter y/n:', choices);
    expect(readFolderTrustScreen(rows)).toBe('unreadable');
    expect(looksLikeFolderTrustDialog(rows)).toBe(false);
  });

  it('reads output under the key row as unreadable', () => {
    const rows = trust();
    const hint = rows.indexOf('Enter to confirm · Esc to cancel');
    expect(readFolderTrustScreen([...rows.slice(0, hint + 1), 'tool: Bash (npm test)'])).toBe('unreadable');
  });

  it('reads more typed than one key as unreadable', () => {
    expect(readFolderTrustScreen(edited('Enter y/n:', 'Enter to confirm · Esc to cancel', ['Enter y/n: yes']))).toBe('unreadable');
  });

  it('reads the title over a key row with no question as unreadable', () => {
    const rows = trust().filter((row) => !/trust\?|well-known|this folder first/.test(row));
    expect(readFolderTrustScreen(rows)).toBe('unreadable');
  });

  it('reads another y/n dialog, its choices whole and none a trust choice, as no dialog', () => {
    expect(readFolderTrustScreen([
      'Overwrite the existing config?',
      'y. Yes, overwrite it',
      'n. No, keep it',
      'Enter y/n:',
      'Enter to confirm · Esc to cancel',
    ])).toBeNull();
  });

  it('reads the dialog whose question and title a short pane scrolled off as unreadable', () => {
    const rows = screen('screen-reader', 'claude-sr-trust-100x30');
    const key = rows.findIndex((row) => row.startsWith('Enter y/n:'));
    // The choices, the key row and the hint are all a 4-row pane shows.
    expect(readFolderTrustScreen(rows.slice(key - 2, key + 2))).toBe('unreadable');
    // Only the key row and the hint.
    expect(readFolderTrustScreen(rows.slice(key, key + 2))).toBe('unreadable');
    // Trust choices under another question still say which dialog this is.
    expect(readFolderTrustScreen(['Overwrite the existing config?', ...rows.slice(key - 2, key + 2)])).toBe('unreadable');
  });
});
