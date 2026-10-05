import { describe, expect, it, vi } from 'vitest';

vi.mock('../../workspace/ptyOwnership', () => ({ resolvePtyOwnerWorkspace: vi.fn(async () => 'ws-seal') }));
vi.mock('../../workspace/WorkspaceMirror', () => ({
  getWorkspaceMirror: () => ({ getEntries: () => [{ id: 'ws-seal', name: 'wseal' }] }),
}));

import { paneRows, resolveTarget } from '../moaHandoffHost';

// The answer the operator lane really gives for pane.list (pane.rpc.ts).
const envelope = {
  id: 'r1',
  ok: true,
  result: {
    asOfSeq: 13,
    bootId: 'boot',
    panes: [
      { id: 'pane-a', agents: [{ ptyId: 'daemon-1', surfaceId: 'surface-1', agentName: 'Claude Code', agentStatus: 'idle' }] },
    ],
  },
};

describe('moa hand-off host — target resolution', () => {
  it('reads the panes out of the real pane.list envelope', () => {
    expect(paneRows(envelope)).toHaveLength(1);
    expect(paneRows({ ok: true, result: [] })).toEqual([]);
    expect(paneRows(null)).toEqual([]);
  });

  it('resolves a ptyId and a paneId to the pane and its agent', async () => {
    const invoke = vi.fn(async () => envelope);
    const want = { workspaceId: 'ws-seal', paneId: 'pane-a', ptyId: 'daemon-1', surfaceId: 'surface-1', agentName: 'Claude Code', agentStatus: 'idle' };
    expect(await resolveTarget(invoke, () => null, { ptyId: 'daemon-1' })).toEqual(want);
    expect(await resolveTarget(invoke, () => null, { paneId: 'pane-a' })).toEqual(want);
    expect(await resolveTarget(invoke, () => null, { ptyId: 'daemon-9' })).toBeNull();
  });
});
