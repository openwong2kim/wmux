import { describe, expect, it, vi } from 'vitest';
import type { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { buildWorkspaceFacts, publishWorkspaceFacts } from '../workspaceFactsFeed';

function fakeLedger(entries: { taskWorkspaceId: string }[]): () => TaskLedger {
  return () => ({ list: () => entries }) as unknown as TaskLedger;
}

describe('buildWorkspaceFacts', () => {
  it('marks open task workspaces and carries each workspace\'s autonomy mode', () => {
    const rows = buildWorkspaceFacts({
      push: async () => undefined,
      ledger: fakeLedger([{ taskWorkspaceId: 'ws-task' }]),
      autonomy: () => ({ 'ws-task': { mode: 'assist' }, 'ws-human': { mode: 'danger' } }),
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        { workspaceId: 'ws-task', isTaskWorkspace: true, autonomyMode: 'assist' },
        // A hand-opened workspace with autonomy on is still NOT a task
        // workspace — that is the row the press scope refuses on.
        { workspaceId: 'ws-human', isTaskWorkspace: false, autonomyMode: 'danger' },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it('lists a task workspace with no stored autonomy at the product default', () => {
    const rows = buildWorkspaceFacts({
      push: async () => undefined,
      ledger: fakeLedger([{ taskWorkspaceId: 'ws-task' }]),
      autonomy: () => ({}),
    });
    expect(rows).toEqual([{ workspaceId: 'ws-task', isTaskWorkspace: true, autonomyMode: 'off' }]);
  });

  it('publishes no task workspaces when the ledger cannot be read (refuse, not assume)', () => {
    const rows = buildWorkspaceFacts({
      push: async () => undefined,
      ledger: () => {
        throw new Error('ledger file is torn');
      },
      autonomy: () => ({ 'ws-task': { mode: 'assist' } }),
    });
    expect(rows).toEqual([{ workspaceId: 'ws-task', isTaskWorkspace: false, autonomyMode: 'assist' }]);
  });
});

describe('publishWorkspaceFacts', () => {
  it('swallows a failed push so a disconnected daemon never breaks the caller', async () => {
    const push = vi.fn(async () => {
      throw new Error('Daemon not connected');
    });
    await expect(
      publishWorkspaceFacts({ push, ledger: fakeLedger([]), autonomy: () => ({}) }),
    ).resolves.toBeUndefined();
    expect(push).toHaveBeenCalledTimes(1);
  });
});
