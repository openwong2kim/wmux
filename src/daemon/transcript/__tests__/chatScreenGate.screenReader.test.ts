// Claude Code's screen-reader layout draws no selection cursor and, under an
// AskUserQuestion, no `Esc to …` footer: its dialogs show by their key row
// (fixtures/screen-reader/, measured on 2.1.316).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { screenBlocksChatSend, screenShowsActiveDialog, screenShowsAgentDialog } from '../chatScreenGate';

const screen = (name: string): string[] =>
  (JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../approvals/__tests__/fixtures/screen-reader', `${name}.json`), 'utf8',
  )) as { screen: string[] }).screen;

const DIALOGS = [
  'claude-sr-bash-100x30',
  'claude-sr-bash-60x30',
  'claude-sr-bash-typed1-100x30',
  'claude-sr-write-100x30',
  'claude-sr-edit-100x30',
  'claude-sr-ask-100x30',
  'claude-sr-ask-typed2-100x30',
  'claude-sr-askmulti-100x30',
  'claude-sr-trust-100x30',
  'claude-sr-trust-60x30',
  'claude-sr-trust-typed-y-100x30',
];

const ASKS = ['claude-sr-ask-100x30', 'claude-sr-ask-typed2-100x30', 'claude-sr-askmulti-100x30'];

const keyRowAt = (rows: readonly string[]) => rows.findIndex((row) => /^(?:Select with numbers|Enter y\/n:)/.test(row));

describe('dialog gates in the screen-reader layout', () => {
  it.each(DIALOGS)('reads %s as an active dialog that blocks a chat send', (name) => {
    const rows = screen(name);
    expect(screenBlocksChatSend(rows)).toBe(true);
    expect(screenShowsAgentDialog(rows)).toBe(true);
    expect(screenShowsActiveDialog(rows)).toBe(true);
  });

  it.each([
    'claude-sr-bash-answered-100x30',
    'claude-sr-trust-answered-100x30',
    'claude-sr-ask-answered-100x30',
  ])('reads the erased dialog of %s as gone', (name) => {
    expect(screenShowsActiveDialog(screen(name))).toBe(false);
  });

  // Without its key row an AskUserQuestion has nothing the other rules read,
  // so the key row is what blocks it.
  it.each(ASKS)('reads %s as no dialog once its key row is gone', (name) => {
    const rows = screen(name);
    const at = keyRowAt(rows);
    const withoutKeyRow = [...rows.slice(0, at), ...rows.slice(at + 1)];
    expect(screenBlocksChatSend(withoutKeyRow)).toBe(false);
    expect(screenShowsAgentDialog(withoutKeyRow)).toBe(false);
    expect(screenShowsActiveDialog(withoutKeyRow)).toBe(false);
  });

  it('blocks a chat send at a key row with output under it, but does not read it as active', () => {
    const rows = screen('claude-sr-ask-100x30');
    const withOutput = [...rows.slice(0, keyRowAt(rows) + 1), 'claude: ok'];
    expect(screenShowsActiveDialog(withOutput)).toBe(false);
    expect(screenShowsAgentDialog(withOutput)).toBe(true);
    expect(screenBlocksChatSend(withOutput)).toBe(true);
  });
});
