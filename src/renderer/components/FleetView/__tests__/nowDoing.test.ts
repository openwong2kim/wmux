import { describe, expect, it } from 'vitest';
import { fleetRow, type FleetPane } from '../../../stores/selectors/fleet';
import { t } from '../../../i18n';
import { nowDoingLine } from '../nowDoing';

function pane(overrides: Partial<FleetPane> = {}): FleetPane {
  return {
    workspaceId: 'ws-1', workspaceName: 'alpha', paneId: 'p1', surfaceId: 's1', ptyId: 'pty-1',
    agentStatus: 'running', title: 'claude', surfaceType: 'terminal', isActivePane: true, unverifiable: false,
    ...overrides,
  };
}

describe('nowDoingLine', () => {
  it('turns the running tool into a sentence', () => {
    const line = nowDoingLine(fleetRow(pane({ activity: '✎ foo.ts' })), undefined, t);
    expect(line).toEqual({ text: 'Edited foo.ts', kind: 'now' });
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

  it('a pane asking for input with no question (a permission prompt) keeps saying so', () => {
    const line = nowDoingLine(fleetRow(pane({ agentStatus: 'awaiting_input' })), '$ npm test', t);
    expect(line).toEqual({ text: 'Needs your input', kind: 'status' });
  });
});
