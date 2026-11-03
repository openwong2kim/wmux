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

describe('AgentDetector — a screen-reader dialog while Claude runs', () => {
  /** The rows as the layout prints them: plain rows, the last one left unfinished. */
  const stream = (rows: readonly string[]): string => {
    let end = rows.length;
    while (end > 0 && !rows[end - 1]?.trim()) end--;
    return rows.slice(0, end).join('\r\n');
  };
  /** A Claude pane past its launch: identity seeded, banner drawn, no question yet. */
  function running() {
    const det = new AgentDetector();
    const events = vi.fn();
    det.onEvent(events);
    det.feed('[Screen Reader Mode: on via flag]\r\nClaude Code v2.1.316\r\n');
    det.seedTrustedIdentity('claude', det.getIdentityEpoch());
    return { det, events };
  }
  /** What the host does after a batch: read the screen when asked. */
  async function hostRead(det: AgentDetector, rows: readonly string[]): Promise<boolean> {
    return det.takeApprovalRecheckRequest() && det.revalidateApprovalScreen(async () => ({ rows, isCurrent: () => true }));
  }

  it.each([
    'claude-sr-write-100x30',
    'claude-sr-write-60x30',
    'claude-sr-edit-100x30',
    'claude-sr-edit-60x30',
    'claude-sr-bash-100x30',
    'claude-sr-bash-60x30',
    'claude-sr-ask-100x30',
    'claude-sr-ask-60x30',
    'claude-sr-askmulti-100x30',
  ])('reports %s as needs-you once its key row is drawn', async (name) => {
    const { det, events } = running();
    const rows = screen(name);
    det.feed(stream(rows));
    expect(await hostRead(det, rows)).toBe(true);
    expect(events.mock.calls.map(([event]) => event)).toEqual([{ agent: 'Claude Code', status: 'awaiting_input', message: 'Approval requested' }]);
  });

  it('reads a key row the renderer drew around cells it skipped', async () => {
    const { det, events } = running();
    const rows = screen('claude-sr-bash-100x30');
    det.feed(stream(rows).replace('Select with numbers', 'Select\u001b[1Cwith numbers'));
    expect(await hostRead(det, rows)).toBe(true);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it('reads again when the rest of the key row arrives after a read', async () => {
    const { det, events } = running();
    const rows = screen('claude-sr-bash-100x30');
    const text = stream(rows);
    const cut = text.indexOf('Then En');
    det.feed(text.slice(0, cut));
    // The first read sees the key row cut short: no dialog yet.
    expect(await hostRead(det, text.slice(0, cut).split('\r\n'))).toBe(false);
    det.feed(text.slice(cut));
    expect(await hostRead(det, rows)).toBe(true);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it('reads again when the key hint under the key row arrives after a read', async () => {
    const { det, events } = running();
    const rows = screen('claude-sr-bash-100x30');
    const text = stream(rows);
    const cut = text.lastIndexOf('Esc to cancel') + 'Esc'.length;
    det.feed(text.slice(0, cut));
    // The first read sees the key hint cut short: no dialog yet.
    expect(await hostRead(det, text.slice(0, cut).split('\r\n'))).toBe(false);
    det.feed(text.slice(cut));
    expect(await hostRead(det, rows)).toBe(true);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it('does not read again for a key typed into the key row', async () => {
    const { det } = running();
    const rows = screen('claude-sr-ask-100x30');
    det.feed(stream(rows));
    expect(await hostRead(det, rows)).toBe(true);
    det.feed('2');
    expect(det.takeApprovalRecheckRequest()).toBe(false);
  });

  it('reads a dialog after output that quoted the trust question was read', async () => {
    const { det, events } = running();
    // The trust question's own rows, read once from a screen that holds no dialog.
    const quoted = ['tool: Bash (cat notes.md)', 'Is this a project you created or one you trust?', 'Enter to confirm · Esc to cancel', 'claude: done'];
    det.feed(`${stream(quoted)}\r\n`);
    expect(await hostRead(det, quoted)).toBe(false);
    const rows = screen('claude-sr-bash-100x30');
    det.feed(stream(rows));
    expect(await hostRead(det, rows)).toBe(true);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['in the pane', true],
    // A press the daemon makes, or an answer from the phone: no input here.
    ['away from the pane', false],
  ] as const)('reports the next dialog of the same session too, the first answered %s', async (_where, typedHere) => {
    const { det, events } = running();
    const first = screen('claude-sr-bash-100x30');
    det.feed(stream(first));
    expect(await hostRead(det, first)).toBe(true);
    // Typed in the pane, the key press clears what the screen showed.
    if (typedHere) det.invalidateApprovalScreen();
    det.feed('\r\nclaude: ok\r\n');
    const second = screen('claude-sr-write-100x30');
    det.feed(stream(second));
    expect(await hostRead(det, second)).toBe(true);
    expect(events.mock.calls.map(([event]) => event.status)).toEqual(['awaiting_input', 'awaiting_input']);
  });

  it('reports nothing for an answered dialog left above newer output', async () => {
    const { det, events } = running();
    const dialog = screen('claude-sr-write-60x30').filter((row) => row.trim()).slice(5);
    const answered = screen('claude-sr-bash-answered-100x30').filter((row) => row.trim()).slice(8);
    const rows = [...dialog, ...answered];
    // A resize redraws the old dialog over the transcript, key row and all.
    det.feed(stream(rows));
    expect(await hostRead(det, rows)).toBe(false);
    expect(events).not.toHaveBeenCalled();
  });
});
