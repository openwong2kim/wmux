// The GUI's fan-outs (the dialog, the Git page's hand-off, hand out) go
// through startGuiFanOut: each one hands the service the pool's account pick,
// for Claude workers only.
import { afterEach, describe, expect, it, vi } from 'vitest';

const pick = { prepare: async () => undefined, pick: () => null };
const guiFanOutAccountPick = vi.fn((_ws: string, _claude: (k: number) => boolean) => pick);
vi.mock('../../../worktask/fanoutAccountPool', async (actual) => ({
  ...(await actual<typeof import('../../../worktask/fanoutAccountPool')>()),
  guiFanOutAccountPick: (ws: string, claude: (k: number) => boolean) => guiFanOutAccountPick(ws, claude),
}));

import { startGuiFanOut } from '../fanout.handler';
import { FanOutGuards, setFanOutGuardsForTests } from '../../../worktask/fanoutGuards';
import type { FanOutRequest, FanOutService } from '../../../worktask/FanOutService';
import { trackedTempDir } from '../../../../test-utils/trackedTempDir';

afterEach(() => setFanOutGuardsForTests(null));

describe('a GUI fan-out and the account pool', () => {
  it('hands the service the pool\'s pick for the caller\'s workspace, Claude workers only', async () => {
    setFanOutGuardsForTests(new FanOutGuards({ dir: trackedTempDir('wmux-fanout-gui-pool-'), countLiveTasks: () => 0, ledgerTaskOwner: () => null }));
    const start = vi.fn(async (_req: FanOutRequest) => ({ ok: true, tasks: [] }));
    const req = {
      idempotencyKey: 'gui-pool-1', prompt: 'p', titles: ['a', 'b'], repoPath: 'D:\\repo', agentCmd: 'claude',
      agents: [{ agent: 'claude' }, { agent: 'codex' }], verifiedWorkspaceId: 'ws-1',
    } as FanOutRequest;
    await startGuiFanOut({ start } as unknown as FanOutService, req);
    expect(start.mock.calls[0]?.[0].accountPick).toBe(pick);
    const [ws, claude] = guiFanOutAccountPick.mock.calls[0]!;
    expect(ws).toBe('ws-1');
    expect([claude(0), claude(1)]).toEqual([true, false]);
  });
});
