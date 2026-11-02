// Quiet recovery on Claude Code's screen-reader layout (live captures in
// daemon/approvals/__tests__/fixtures/screen-reader/, Claude Code 2.1.316).

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { claudeScreenApproval } from '../approvalScreen';
import { AgentDetector } from '../AgentDetector';

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
      'Overwrite the existing config?',
      'y. Yes, overwrite it',
      'n. No, keep it',
      'Enter y/n:',
    ])).toEqual({ text: 'Overwritetheexistingconfig?y.Yes,overwriteitn.No,keepit', message: 'Approval requested' });
    // A bare y/n key row may be the trust dialog scrolled off a short pane.
    expect(claudeScreenApproval(['Enter y/n:', 'Enter to confirm · Esc to cancel'])).toEqual({ text: 'Quick safety check:', message: 'Project trust prompt' });
    // An option that asks, and a question broken over two rows: the text is the question.
    expect(claudeScreenApproval([
      'Question: Team',
      '> Which of these should we pick for the',
      'release?',
      '1. Ship now',
      '2. Should we ask the team?',
      'Select with numbers [1-2]. Then Enter to submit or Escape to cancel:',
    ])).toEqual({ text: 'Whichoftheseshouldwepickfortherelease?', message: 'Approval requested' });
    // Output under the key row: not the live dialog's.
    expect(claudeScreenApproval([
      'Do you want to proceed?',
      '1. Yes',
      '2. No',
      'Select with numbers [1-2]. Then Enter to submit or Escape to cancel:',
      'tool: Bash (npm test)',
    ])).toBeNull();
  });

  it('names a dialog no question row names by its own rows, so two of them never share a value', () => {
    const dialog = (question: string, key = 'Enter y/n:') => [
      'you: tidy the repo',
      'tool: Bash (git clean)',
      'Permission Required: Confirm',
      question,
      'y. Yes',
      'n. No',
      key,
      'Esc to cancel',
    ];
    const first = claudeScreenApproval(dialog('Delete the untracked files?'));
    const second = claudeScreenApproval(dialog('Delete the ignored files?'));
    expect(first?.text).toBe('PermissionRequired:ConfirmDeletetheuntrackedfiles?y.Yesn.No');
    expect(second?.text).toBe('PermissionRequired:ConfirmDeletetheignoredfiles?y.Yesn.No');
    // A typed key is the same dialog.
    expect(claudeScreenApproval(dialog('Delete the untracked files?', 'Enter y/n: y'))).toEqual(first);
    // Broken over other rows at another width: the same dialog.
    expect(claudeScreenApproval([
      'Permission Required:',
      'Confirm Delete the untracked',
      'files?',
      'y. Yes',
      'n. No',
      'Enter y/n:',
    ])).toEqual(first);
    // A numbered dialog whose question scrolled off: its rows from the top.
    expect(claudeScreenApproval([
      '1. Allow',
      '2. Deny',
      'Select with numbers [1-2]. Then Enter to submit or Escape to cancel:',
    ])).toEqual({ text: '1.Allow2.Deny', message: 'Approval requested' });
  });

  it('is asked for once the screen-reader AskUserQuestion is drawn on a quiet screen', async () => {
    const rows = screen('claude-sr-ask-100x30');
    const det = new AgentDetector();
    const events = vi.fn();
    det.onEvent(events);
    det.feed(rows.join('\r\n'));
    det.seedTrustedIdentity('claude', det.getIdentityEpoch());
    expect(await det.revalidateApprovalScreen(async () => ({ rows, isCurrent: () => true }))).toBe(true);
    expect(events.mock.calls.map(([event]) => event.status)).toEqual(['awaiting_input']);
  });
});
