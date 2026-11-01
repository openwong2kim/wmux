// Quiet recovery on Claude Code's screen-reader layout (live captures in
// daemon/approvals/__tests__/fixtures/screen-reader/, Claude Code 2.1.316).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { claudeScreenApproval } from '../approvalScreen';

const screen = (name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'daemon', 'approvals', '__tests__', 'fixtures', 'screen-reader', `${name}.json`), 'utf8')) as {
    screen: string[];
  }).screen;

describe('claudeScreenApproval — screen-reader layout', () => {
  it.each([
    ['claude-sr-bash-100x30', 'Doyouwanttoproceed?'],
    ['claude-sr-bash-60x30', 'Doyouwanttoproceed?'],
    ['claude-sr-bash-typed1-100x30', 'Doyouwanttoproceed?'],
    ['claude-sr-write-100x30', 'Doyouwanttocreatenew.txt?'],
    ['claude-sr-edit-100x30', 'Doyouwanttomakethisedittonotes.txt?'],
    ['claude-sr-ask-100x30', 'Whichdatabaseshouldweuse?'],
    ['claude-sr-ask-typed2-100x30', 'Whichdatabaseshouldweuse?'],
    ['claude-sr-askmulti-100x30', 'Whichtoppingsdoyouwant?'],
  ])('reads %s as an approval, named by its question', (name, text) => {
    expect(claudeScreenApproval(screen(name))).toEqual({ text, message: 'Approval requested' });
  });

  it.each(['claude-sr-trust-100x30', 'claude-sr-trust-60x30', 'claude-sr-trust-typed-y-100x30'])(
    'reads %s as the project trust prompt, with the plain layout\'s text',
    (name) => {
      expect(claudeScreenApproval(screen(name))).toEqual({ text: 'Quick safety check:', message: 'Project trust prompt' });
    },
  );

  it.each(['claude-sr-bash-answered-100x30', 'claude-sr-trust-answered-100x30', 'claude-sr-ask-answered-100x30'])(
    'reads %s, where the dialog is gone, as none',
    (name) => {
      expect(claudeScreenApproval(screen(name))).toBeNull();
    },
  );

  it('reads a dialog no reader names as an approval when its key row owns the bottom', () => {
    expect(claudeScreenApproval([
      'Permission Required: Network request',
      '> curl https://example.com',
      'Allow this request?',
      '1. Allow',
      '2. Deny',
      'Select with numbers [1-2]. Then Enter to submit or Escape to cancel:',
      'Esc to cancel',
    ])).toEqual({ text: 'Allowthisrequest?', message: 'Approval requested' });
    expect(claudeScreenApproval([
      'Something new',
      'Enter y/n:',
    ])).toEqual({ text: 'Entery/n:', message: 'Approval requested' });
    // Output under the key row: not the live dialog's.
    expect(claudeScreenApproval([
      'Do you want to proceed?',
      '1. Yes',
      '2. No',
      'Select with numbers [1-2]. Then Enter to submit or Escape to cancel:',
      'tool: Bash (npm test)',
    ])).toBeNull();
  });
});
