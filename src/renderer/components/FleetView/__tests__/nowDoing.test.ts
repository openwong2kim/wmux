import { describe, expect, it } from 'vitest';
import { fleetRow, type FleetPane } from '../../../stores/selectors/fleet';
import { t } from '../../../i18n';
import { fleetAskOf, lastErrorLine, lastErrorLineIndex, nowDoingLine, promptChoices } from '../nowDoing';

function pane(overrides: Partial<FleetPane> = {}): FleetPane {
  return {
    workspaceId: 'ws-1', workspaceName: 'alpha', paneId: 'p1', surfaceId: 's1', ptyId: 'pty-1',
    agentStatus: 'running', title: 'claude', surfaceType: 'terminal', isActivePane: true, unverifiable: false,
    ...overrides,
  };
}

describe('nowDoingLine', () => {
  it('turns the running tool into a present-tense sentence', () => {
    expect(nowDoingLine(fleetRow(pane({ activity: '✎ foo.ts' })), undefined, t)).toEqual({ text: 'Editing foo.ts', kind: 'now' });
    expect(nowDoingLine(fleetRow(pane({ activity: '$ npm test' })), undefined, t)).toEqual({ text: 'Running npm test', kind: 'now' });
  });

  it('says what a finished or idle agent did last', () => {
    const done = nowDoingLine(fleetRow(pane({ agentStatus: 'complete' }), { surfaceLastMessage: { 'pty-1': 'All green.' } }), '$ npm test', t);
    expect(done).toEqual({ text: 'Last: Ran npm test', kind: 'last' });
    const idle = nowDoingLine(fleetRow(pane({ agentStatus: 'idle' })), '⌕ pattern', t);
    expect(idle).toEqual({ text: 'Last: Searched pattern', kind: 'last' });
  });

  it('falls back to the last reply when the agent sends no tool activity', () => {
    const row = fleetRow(pane({ agentStatus: 'complete' }), { surfaceLastMessage: { 'pty-1': 'Refactor done.' } });
    expect(nowDoingLine(row, undefined, t)).toEqual({ text: 'Refactor done.', kind: 'reply' });
  });

  it('a question and an error outrank the last activity', () => {
    const asking = fleetRow(pane({ agentStatus: 'awaiting_input' }), { surfacePendingQuestion: { 'pty-1': 'Ship it?' } });
    expect(nowDoingLine(asking, '✎ foo.ts', t)).toEqual({ text: 'Ship it?', kind: 'question' });
    const failed = nowDoingLine(fleetRow(pane({ agentStatus: 'error' })), '✎ foo.ts', t);
    expect(failed.kind).toBe('status');
  });

  it('an error row with an error line from its terminal shows that line', () => {
    const line = nowDoingLine(fleetRow(pane({ agentStatus: 'error' })), '✎ foo.ts', t, 'Error: ENOENT: no such file');
    expect(line).toEqual({ text: 'Error: ENOENT: no such file', kind: 'error' });
    // Only an error row: a running row ignores a stray error line.
    expect(nowDoingLine(fleetRow(pane({ activity: '✎ foo.ts' })), undefined, t, 'Error: x').kind).toBe('now');
  });

  it('a pane asking for input with no question (a permission prompt) keeps saying so', () => {
    const line = nowDoingLine(fleetRow(pane({ agentStatus: 'awaiting_input' })), '$ npm test', t);
    expect(line).toEqual({ text: 'Needs your input', kind: 'status' });
  });
});

describe('lastErrorLine', () => {
  it('finds the last line that reads as an error, not prose that mentions one', () => {
    const tail = [
      '> vitest run',
      'We handle the error case below.',
      'TypeError: cannot read properties of undefined',
      '    at foo (src/a.ts:3:1)',
      'npm ERR! code ELIFECYCLE',
      '',
    ];
    expect(lastErrorLine(tail)).toBe('npm ERR! code ELIFECYCLE');
    expect(lastErrorLineIndex(tail)).toBe(4);
    expect(lastErrorLine(['error[E0308]: mismatched types', 'done'])).toBe('error[E0308]: mismatched types');
    expect(lastErrorLine(['all good', 'the error rate is 0'])).toBeUndefined();
  });
});

describe('promptChoices', () => {
  it('reads the numbered choices of the prompt at the bottom, cursor marked', () => {
    const tail = [
      'Do you want to make this edit to fleet.ts?',
      '❯ 1. Yes',
      '  2. Yes, allow all edits during this session',
      '  3. No, and tell Claude what to do differently',
      '',
      'Esc to cancel',
    ];
    expect(promptChoices(tail)).toEqual([
      { number: '1', label: 'Yes', current: true },
      { number: '2', label: 'Yes, allow all edits during this session', current: false },
      { number: '3', label: 'No, and tell Claude what to do differently', current: false },
    ]);
  });

  it('offers nothing for a single numbered line or a broken sequence', () => {
    expect(promptChoices(['1. only one'])).toEqual([]);
    expect(promptChoices(['1. a', '3. c'])).toEqual([]);
    expect(promptChoices(['plain output'])).toEqual([]);
  });
});

describe('fleetAskOf', () => {
  const needsYou = (overrides: Partial<FleetPane>) => ({ ...fleetRow(pane(overrides)), section: 'needsYou' as const });

  it('treats waiting like awaiting_input, with or without question text', () => {
    expect(fleetAskOf(needsYou({ agentStatus: 'waiting' }))).toBe('input');
    expect(fleetAskOf(needsYou({ agentStatus: 'awaiting_input' }))).toBe('input');
  });

  it('checks errors, stopped supervision and unconfirmed panes; nothing outside Needs you', () => {
    expect(fleetAskOf(needsYou({ agentStatus: 'error' }))).toBe('check');
    expect(fleetAskOf(needsYou({ agentStatus: 'waiting', supervision: { status: 'stopped', restartCount: 1 } }))).toBe('check');
    expect(fleetAskOf(needsYou({ agentStatus: 'running', unverifiable: true }))).toBe('check');
    expect(fleetAskOf(fleetRow(pane({ agentStatus: 'running' })))).toBeUndefined();
    expect(fleetAskOf(undefined)).toBeUndefined();
  });
});
