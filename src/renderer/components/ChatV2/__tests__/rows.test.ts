import { describe, expect, it } from 'vitest';
import { applyHarnessEvents } from '../../../../shared/chatv2/apply';
import type { HarnessEvent } from '../../../../shared/chatv2/harnessEvents';
import { newChatSession } from '../../../../shared/chatv2/session';
import { pendingRequests, sessionRows } from '../rows';
import { formatElapsed, formatWorkingDuration, turnModelLabel } from '../format';

function fold(events: HarnessEvent[], model = 'claude-opus-5-5') {
  let at = 10_000;
  return applyHarnessEvents(
    newChatSession({ id: 's', harness: 'claude', cwd: '/repo', model }),
    events.map((event, index) => ({ seq: index + 1, at: (at += event.type === 'turn.ended' ? 125_000 : 1_000), event })),
  );
}

describe('sessionRows (fold-to-view mapping)', () => {
  it('maps a finished turn to user, assistant, tool, subagent rows and a footer', () => {
    const session = fold([
      { type: 'user.message', text: 'fix it', clientMessageId: 'c-00000001' },
      { type: 'reasoning.delta', text: 'hmm' },
      { type: 'message.delta', text: 'Looking.' },
      { type: 'tool.started', callId: 't1', title: 'Read', kind: 'read', status: 'in_progress', preview: { kind: 'read', path: '/repo/a.ts' } },
      { type: 'tool.updated', callId: 't1', status: 'completed' },
      { type: 'tool.started', callId: 't2', title: 'Agent', kind: 'agent', agentModel: 'claude-haiku-4-5-20251001', status: 'in_progress' },
      { type: 'agent.step', callId: 't2', stepId: 's1', kind: 'tool', text: 'Grep foo', status: 'completed', agentName: 'Review' },
      { type: 'tool.started', callId: 't3', title: 'Bash', kind: 'execute', status: 'in_progress' },
      { type: 'tool.updated', callId: 't3', status: 'failed' },
      { type: 'turn.ended', outcome: 'completed' },
    ]);
    const rows = sessionRows(session);
    expect(rows.map((row) => row.kind)).toEqual(['user', 'reasoning', 'assistant', 'tool', 'subagent', 'tool', 'footer']);
    const tools = rows.filter((row) => row.kind === 'tool' || row.kind === 'subagent');
    expect(tools.map((row) => 'state' in row && row.state)).toEqual(['done', 'done', 'failed']);
    const footer = rows[rows.length - 1];
    expect(footer).toMatchObject({ kind: 'footer', live: false, model: 'Opus 5.5', outcome: 'completed' });
    if (footer.kind !== 'footer') throw new Error();
    expect(formatWorkingDuration(footer.durationMs ?? null, footer.model, true)).toMatch(/^Opus 5\.5 worked for 2m \d+s$/);
  });

  it('keeps an attached approval on its tool row and lists it as pending', () => {
    const session = fold([
      { type: 'user.message', text: 'write', clientMessageId: 'c-00000001' },
      { type: 'tool.started', callId: 't1', title: 'Write', kind: 'edit', status: 'pending' },
      { type: 'approval.requested', requestId: 'r1', title: 'Write', callId: 't1' },
    ]);
    const rows = sessionRows(session);
    const tool = rows.find((row) => row.kind === 'tool');
    expect(tool && 'block' in tool && tool.block.approval).toMatchObject({ requestId: 'r1' });
    expect(tool && 'state' in tool && tool.state).toBe('running');
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'footer', live: true });
    expect(pendingRequests(session)).toEqual(['r1']);
  });

  it('puts a live question before the live footer, and notices as their own rows', () => {
    const session = fold([
      { type: 'user.message', text: 'go', clientMessageId: 'c-00000001' },
      { type: 'session.error', message: 'boom' },
      { type: 'question.asked', requestId: 'q1', questions: [{ id: 'q0', prompt: 'Which?', multiSelect: false, allowCustom: true, options: [{ id: 'a', label: 'A' }] }] },
    ]);
    const kinds = sessionRows(session).map((row) => row.kind);
    expect(kinds.slice(-2)).toEqual(['question', 'footer']);
    expect(kinds).toContain('notice');
  });

  it('labels the default model by the agent name, and an interrupted turn by its outcome', () => {
    const session = fold([
      { type: 'user.message', text: 'go', clientMessageId: 'c-00000001' },
      { type: 'turn.ended', outcome: 'interrupted' },
    ], '');
    expect(sessionRows(session).at(-1)).toMatchObject({ kind: 'footer', model: 'Claude Code', outcome: 'interrupted' });
    expect(turnModelLabel('claude', 'claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(formatElapsed(65_000)).toBe('1m 5s');
    expect(formatElapsed(400)).toBe('1s');
  });
});
