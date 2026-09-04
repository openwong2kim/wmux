import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inheritTaskAutonomy } from '../taskAutonomy';
import { loadDeckAutonomy, setWorkspaceMode } from '../../deck/deckAutonomyStore';
import { buildWorkspaceFacts } from '../../workspace/workspaceFactsFeed';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-autonomy-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('inheritTaskAutonomy (A-2 precondition)', () => {
  it('gives a danger owner\'s task workspace press-capable autonomy', async () => {
    await setWorkspaceMode('ws-owner', 'danger', dir);

    const res = await inheritTaskAutonomy('ws-owner', 'ws-task', dir);

    expect(res).toEqual({ mode: 'danger', written: true });
    expect(loadDeckAutonomy(dir)['ws-task']).toMatchObject({
      mode: 'danger',
      approvalPress: true,
    });
  });

  it('passes assist through as assist — press stays OFF, as the mode says', async () => {
    await setWorkspaceMode('ws-owner', 'assist', dir);

    const res = await inheritTaskAutonomy('ws-owner', 'ws-task', dir);

    expect(res).toEqual({ mode: 'assist', written: true });
    expect(loadDeckAutonomy(dir)['ws-task']).toMatchObject({
      mode: 'assist',
      approvalPress: false,
    });
  });

  it('writes nothing for an owner with no autonomy', async () => {
    const res = await inheritTaskAutonomy('ws-owner', 'ws-task', dir);

    expect(res).toEqual({ mode: 'off', written: false });
    expect(loadDeckAutonomy(dir)['ws-task']).toBeUndefined();
  });

  it('is what makes the pushed fact table authorize a press at all', async () => {
    // The end the precondition exists for: `decideApprovalPress` reads this row.
    await setWorkspaceMode('ws-owner', 'danger', dir);
    await inheritTaskAutonomy('ws-owner', 'ws-task', dir);

    const rows = buildWorkspaceFacts({
      push: async () => undefined,
      ledger: () =>
        ({
          list: () => [{ taskWorkspaceId: 'ws-task' }],
        }) as never,
      autonomy: () => loadDeckAutonomy(dir),
    });

    expect(rows.find((r) => r.workspaceId === 'ws-task')).toEqual({
      workspaceId: 'ws-task',
      isTaskWorkspace: true,
      autonomyMode: 'danger',
      approvalPress: true,
    });
  });
});
