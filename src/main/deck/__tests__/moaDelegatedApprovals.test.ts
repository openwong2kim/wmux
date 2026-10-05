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
