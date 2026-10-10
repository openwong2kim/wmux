import { describe, expect, it } from 'vitest';
import { counterpartyFromQuery, membersFromReply } from '../moaGoalHost';

describe('counterpartyFromQuery', () => {
  const task = (from: unknown, to: unknown) => ({ id: 't1', metadata: { from, to } });
  it('names the side that is not the HQ', () => {
    expect(counterpartyFromQuery({ tasks: [task({ workspaceId: 'ws-hq' }, { workspaceId: 'ws-ops' })] }, 'ws-hq', 't1')).toBe('ws-ops');
    expect(counterpartyFromQuery({ ok: true, tasks: [task({ workspaceId: 'ws-task' }, { workspaceId: 'ws-hq' })] }, 'ws-hq', 't1')).toBe('ws-task');
  });
  it('is null when the task is missing, the HQ is not a party, or the reply is an error', () => {
    expect(counterpartyFromQuery({ tasks: [] }, 'ws-hq', 't1')).toBeNull();
    expect(counterpartyFromQuery({ tasks: [task({ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' })] }, 'ws-hq', 't1')).toBeNull();
    expect(counterpartyFromQuery({ error: 'nope' }, 'ws-hq', 't1')).toBeNull();
    expect(counterpartyFromQuery(null, 'ws-hq', 't1')).toBeNull();
  });
});

describe('membersFromReply', () => {
  it('reads member workspace ids, and is null for an error or a malformed member', () => {
    expect(membersFromReply({ ok: true, members: [{ workspaceId: 'ws-hq', memberId: 'm1' }, { workspaceId: 'ws-a', memberId: 'm2' }, { workspaceId: 'ws-a', memberId: 'm3' }] })).toEqual(['ws-hq', 'ws-a']);
    expect(membersFromReply({ ok: true, members: [] })).toEqual([]);
    expect(membersFromReply({ ok: false, error: { code: 'NOT_AUTHORIZED' } })).toBeNull();
    expect(membersFromReply({ ok: true, members: [{ memberId: 'm1' }] })).toBeNull();
    expect(membersFromReply(null)).toBeNull();
  });
});
