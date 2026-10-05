import { describe, expect, it } from 'vitest';
import { selectDelegatedApprovals, type DelegatedScope } from '../moaDelegatedApprovals';

const scope: DelegatedScope = {
  handoffPtys: new Map([['pty-h', { workspaceId: 'ws-wmux', agentName: 'Claude Code' }]]),
  taskWorkspaces: new Set(['ws-task']),
  workspaceName: (id) => ({ 'ws-wmux': 'wmux', 'ws-task': 'fix tests' } as Record<string, string>)[id],
};

describe('selectDelegatedApprovals', () => {
  it('keeps prompts of hand-off panes and of the HQ\'s fan-out tasks, oldest first, and nothing else', () => {
    const rows = selectDelegatedApprovals([
      { id: 'a3', sessionId: 'pty-t', workspaceId: 'ws-task', agent: 'codex', state: 'pending', toolInputSummary: 'npm test', createdAt: 30 },
      { id: 'a1', sessionId: 'pty-h', workspaceId: 'ws-wmux', agent: 'claude', state: 'pending', toolName: 'Bash', summary: 'git push', createdAt: 10 },
      { id: 'a2', sessionId: 'pty-other', workspaceId: 'ws-mine', agent: 'claude', state: 'pending', summary: 'rm x', createdAt: 20 },
      { id: 'a4', sessionId: 'pty-h', workspaceId: 'ws-wmux', agent: 'claude', state: 'resolved', summary: 'old', createdAt: 5 },
    ], scope);
    expect(rows).toEqual([
      { id: 'a1', ptyId: 'pty-h', workspaceId: 'ws-wmux', workspaceName: 'wmux', agentName: 'Claude Code', toolName: 'Bash', what: 'git push', createdAt: 10 },
      { id: 'a3', ptyId: 'pty-t', workspaceId: 'ws-task', workspaceName: 'fix tests', agentName: 'codex', what: 'npm test', createdAt: 30 },
    ]);
  });
});

describe('selectDelegatedApprovals — answerable in place', () => {
  const base = { id: 'a1', sessionId: 'pty-h', workspaceId: 'ws-wmux', agent: 'claude', state: 'pending', toolName: 'Bash', summary: 'node test.js', createdAt: 10 };

  it('a bound dialog carries its Yes and No, tagged, and its fingerprint', () => {
    const [row] = selectDelegatedApprovals([{ ...base, choices: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }], promptFingerprint: 'f'.repeat(32) }], scope);
    expect(row).toMatchObject({
      choices: [{ key: '1', label: 'Yes', decision: 'approve' }, { key: '3', label: 'No', decision: 'deny' }],
      promptFingerprint: 'f'.repeat(32),
    });
  });

  it('no fingerprint, a press already made, or only one of Yes/No: no in-place answer', () => {
    const rows = selectDelegatedApprovals([
      { ...base, id: 'x1', choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }] },
      { ...base, id: 'x2', choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }], promptFingerprint: 'f'.repeat(32), pressedAt: 5 },
      { ...base, id: 'x3', choices: [{ key: '1', label: 'Yes' }], promptFingerprint: 'f'.repeat(32) },
    ], scope);
    for (const row of rows) expect(row.choices).toBeUndefined();
  });
});
