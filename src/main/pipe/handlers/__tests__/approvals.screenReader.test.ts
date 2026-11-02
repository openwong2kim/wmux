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

describe('approvalOnScreen — a screen-reader dialog left above newer output', () => {
  const rows = (name: string): string[] => screenText(name).split('\n').filter((row) => row.trim());

  it.each(['claude-sr-write-60x30', 'claude-sr-edit-60x30', 'claude-sr-ask-60x30'])('finds the dialog of %s', (name) => {
    expect(approvalOnScreen(screenText(name))).toBe(true);
  });

  it('finds none once Claude printed under it', () => {
    // A resize redrew the dialog without clearing the old copy, then Escape
    // answered it: the narrow copy stays above what Claude printed next.
    const stale = [...rows('claude-sr-write-60x30').slice(5), ...rows('claude-sr-write-declined-100x30').slice(4)];
    expect(approvalOnScreen(stale.join('\n'))).toBe(false);
    expect(approvalOnScreen([...rows('claude-sr-write-60x30').slice(5), ...rows('claude-sr-bash-answered-100x30').slice(8)].join('\n'))).toBe(false);
  });

  it('still finds a dialog drawn under an answered one', () => {
    const answered = [...rows('claude-sr-write-60x30').slice(5), 'claude: ok'];
    // Read before its key row (or, in the plain layout, its cursor) was drawn.
    const next = ['Do you want to proceed?', '1. Yes', '2. No'];
    expect(approvalOnScreen([...answered, 'tool: Bash (npm test)', ...next].join('\n'))).toBe(true);
  });

  it('still finds a dialog that does not end the way the measured ones do', () => {
    const bash = rows('claude-sr-bash-100x30');
    // Another key hint, a key typed after the colon, a row drawn under it.
    expect(approvalOnScreen(bash.map((row) => (row === 'Esc to cancel' ? 'Esc to cancel · Tab to amend' : row)).join('\n'))).toBe(true);
    expect(approvalOnScreen(bash.map((row) => (row.startsWith('Select with numbers') ? `${row} y` : row)).join('\n'))).toBe(true);
    expect(approvalOnScreen([...bash, 'Update available: run claude update'].join('\n'))).toBe(true);
  });
});
