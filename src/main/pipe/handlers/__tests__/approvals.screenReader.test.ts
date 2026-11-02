// Claude Code's screen-reader layout draws no selection cursor: its dialogs
// show by their key row (fixtures/screen-reader/, measured on 2.1.316).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { approvalOnScreen } from '../approvals.rpc';

const screenText = (name: string): string =>
  (JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../../../daemon/approvals/__tests__/fixtures/screen-reader', `${name}.json`), 'utf8',
  )) as { screen: string[] }).screen.join('\n');

describe('approvalOnScreen in the screen-reader layout', () => {
  it.each([
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
  ])('finds the dialog of %s', (name) => {
    expect(approvalOnScreen(screenText(name))).toBe(true);
  });

  it.each([
    'claude-sr-bash-answered-100x30',
    'claude-sr-trust-answered-100x30',
    'claude-sr-ask-answered-100x30',
  ])('finds none in %s', (name) => {
    expect(approvalOnScreen(screenText(name))).toBe(false);
  });

  // Nothing but the key row reads an AskUserQuestion as a dialog.
  it('finds none once the key row is gone', () => {
    const text = screenText('claude-sr-ask-100x30');
    expect(approvalOnScreen(text.replace(/^Select with numbers.*$/m, ''))).toBe(false);
  });
});
