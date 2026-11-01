// A GUI fan-out has no calling pane, so nothing is inherited: its workers
// launch in the operator's setting whatever the request carries.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../worktask/fanoutWorkerPolicy', async (actual) => ({
  ...(await actual<typeof import('../../../worktask/fanoutWorkerPolicy')>()),
  loadFanoutWorkerPermissionMode: () => 'auto',
}));

import { startGuiFanOut } from '../../../ipc/handlers/fanout.handler';
import { FanOutGuards, setFanOutGuardsForTests } from '../../../worktask/fanoutGuards';
import type { FanOutRequest, FanOutService } from '../../../worktask/FanOutService';
import { trackedTempDir } from '../../../../test-utils/trackedTempDir';

afterEach(() => setFanOutGuardsForTests(null));

describe('a GUI fan-out', () => {
  it('launches in the setting, even with a bypass mode on the request', async () => {
    const guards = new FanOutGuards({ dir: trackedTempDir('wmux-fanout-gui-'), countLiveTasks: () => 0, ledgerTaskOwner: () => null });
    setFanOutGuardsForTests(guards);
    const start = vi.fn(async () => ({ ok: true, tasks: [] }));
    const req = {
      idempotencyKey: 'gui-1',
      prompt: 'p',
      titles: ['a'],
      repoPath: '/repo',
      agentCmd: 'claude',
      verifiedWorkspaceId: 'ws-1',
      workerPermissionMode: 'bypassPermissions',
    } as FanOutRequest;
    await startGuiFanOut({ start } as unknown as FanOutService, req);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ workerPermissionMode: 'auto', caller: { kind: 'gui' } }));
    const records = guards.recentAudit(2);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.workerPermissionMode === 'auto' && r.workerPermissionModeSource === undefined)).toBe(true);
  });
});
