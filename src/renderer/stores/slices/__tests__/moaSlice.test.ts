// @vitest-environment jsdom
// The Moa slice: the remembered HQ id that stands in before main answers, the
// switch-off hand-back when the HQ is on screen, and setup's two failure
// branches (committed by main vs not).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pane, Workspace } from '../../../../shared/types';
import type { MoaSetupResult, MoaState } from '../../../../shared/moa';
import { useStore } from '../../index';
import { MOA_HQ_SEED_KEY, isMoaHqWorkspace, moaHqId, readMoaHqSeed, writeMoaHqSeed } from '../moaSlice';

function ws(id: string): Workspace {
  const rootPane: Pane = { id: `${id}-p`, type: 'leaf', activeSurfaceId: '', surfaces: [] };
  return { id, name: id, rootPane, activePaneId: `${id}-p` };
}
function moa(hq: string | null, enabled = true): MoaState {
  return {
    config: { enabled, onboarded: true, level: 1, maxTurnsPerHour: 20, bubbles: true, reduceMotion: false, defaultReason: null },
    hq: { workspaceId: hq, state: hq ? 'ok' : 'unset' },
    archive: { unacked: 0, total: 0 },
  };
}

let mainState: MoaState;
let setup: ReturnType<typeof vi.fn<(id: string) => Promise<MoaSetupResult>>>;
beforeEach(() => {
  localStorage.clear();
  mainState = moa(null);
  setup = vi.fn<(id: string) => Promise<MoaSetupResult>>();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    deck: { moa: { state: vi.fn(async () => mainState), setup } },
  };
  useStore.setState({
    workspaces: [ws('a'), ws('b')], activeWorkspaceId: 'a', activeRemoteKey: null,
    moa: null, moaHqSeed: null, moaHqPendingId: null,
  } as never);
});

describe('the remembered HQ id', () => {
  it('stands in only while main has not answered', () => {
    expect(moaHqId({ moa: null, moaHqSeed: 'hq' })).toBe('hq');
    expect(isMoaHqWorkspace({ moa: null, moaHqSeed: 'hq' }, 'hq')).toBe(true);
    // Main's answer wins, even when it says there is no HQ any more.
    expect(isMoaHqWorkspace({ moa: moa(null), moaHqSeed: 'hq' }, 'hq')).toBe(false);
    expect(moaHqId({ moa: moa('other'), moaHqSeed: 'hq' })).toBe('other');
  });

  it('is written on every state main reports, and forgotten when there is no HQ', async () => {
    mainState = moa('hq');
    await useStore.getState().refreshMoa();
    expect(localStorage.getItem(MOA_HQ_SEED_KEY)).toBe('hq');
    expect(readMoaHqSeed()).toBe('hq');
    mainState = moa(null);
    await useStore.getState().refreshMoa();
    expect(localStorage.getItem(MOA_HQ_SEED_KEY)).toBeNull();
  });

  it('ignores an answer that is not Moa\'s state and keeps what it had', async () => {
    mainState = moa('hq');
    await useStore.getState().refreshMoa();
    mainState = {} as never;
    await expect(useStore.getState().refreshMoa()).resolves.toBeUndefined();
    expect(useStore.getState().moa?.hq.workspaceId).toBe('hq');
  });

  it('survives storage that throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const put = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readMoaHqSeed()).toBeNull();
    expect(() => writeMoaHqSeed('hq')).not.toThrow();
    get.mockRestore();
    put.mockRestore();
  });
});

describe('Moa turned off while its workspace is on screen', () => {
  beforeEach(() => {
    useStore.setState({ workspaces: [ws('hq'), ws('a'), ws('b')], activeWorkspaceId: 'hq', moa: moa('hq', true) } as never);
  });

  it('moves to the first listed workspace', async () => {
    mainState = moa('hq', false);
    await useStore.getState().refreshMoa();
    expect(useStore.getState().activeWorkspaceId).toBe('a');
  });

  it('stays put when another workspace is active, or when Moa was already off', async () => {
    useStore.setState({ activeWorkspaceId: 'b' });
    mainState = moa('hq', false);
    await useStore.getState().refreshMoa();
    expect(useStore.getState().activeWorkspaceId).toBe('b');

    useStore.setState({ activeWorkspaceId: 'hq' });
    await useStore.getState().refreshMoa(); // off → off
    expect(useStore.getState().activeWorkspaceId).toBe('hq');
  });
});

describe('createMoaHq failures', () => {
  it('not committed: the new workspace is rolled back', async () => {
    setup.mockResolvedValue({ ok: false, code: 'failed' });
    const r = await useStore.getState().createMoaHq();
    expect(r.ok).toBe(false);
    expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['a', 'b']);
    expect(useStore.getState().moaHqPendingId).toBeNull();
  });

  it('a throw counts as not committed and is rolled back too', async () => {
    setup.mockRejectedValue(new Error('ipc'));
    await useStore.getState().createMoaHq();
    expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('committed: the workspace stays, and the retry finishes setup on the same id', async () => {
    setup.mockResolvedValueOnce({ ok: false, code: 'failed', committed: true });
    const first = await useStore.getState().createMoaHq();
    expect(first.committed).toBe(true);
    const ids = useStore.getState().workspaces.map((w) => w.id);
    expect(ids).toHaveLength(3);
    const created = setup.mock.calls[0][0];
    expect(ids).toContain(created);
    expect(useStore.getState().moaHqPendingId).toBe(created);

    // A retry that fails without committing must not remove the committed HQ.
    setup.mockResolvedValueOnce({ ok: false, code: 'failed' });
    await useStore.getState().createMoaHq();
    expect(setup.mock.calls[1][0]).toBe(created);
    expect(useStore.getState().workspaces.map((w) => w.id)).toContain(created);
    expect(useStore.getState().moaHqPendingId).toBe(created);

    setup.mockResolvedValueOnce({ ok: true });
    const done = await useStore.getState().createMoaHq();
    expect(done.ok).toBe(true);
    expect(setup.mock.calls[2][0]).toBe(created);
    expect(useStore.getState().workspaces).toHaveLength(3);
    expect(useStore.getState().moaHqPendingId).toBeNull();
  });
});

describe('a Diff question still queued when Moa cannot take it', () => {
  const hqState = (state: MoaState['hq']['state'], enabled = true): MoaState => ({
    ...moa('hq', enabled),
    hq: { workspaceId: 'hq', state },
  });

  beforeEach(() => {
    useStore.setState({ pendingBrainPrompt: 'old hunk question', toasts: [] } as never);
  });

  it('is dropped with a toast when Moa turns off', async () => {
    mainState = hqState('ok', false);
    await useStore.getState().refreshMoa();
    expect(useStore.getState().pendingBrainPrompt).toBeNull();
    const toasts = useStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain('Moa is off');
  });

  it('is dropped when Moa\'s HQ goes missing', async () => {
    mainState = hqState('hq-missing');
    await useStore.getState().refreshMoa();
    expect(useStore.getState().pendingBrainPrompt).toBeNull();
    expect(useStore.getState().toasts).toHaveLength(1);
  });

  it('is kept while Moa runs', async () => {
    mainState = hqState('ok');
    await useStore.getState().refreshMoa();
    expect(useStore.getState().pendingBrainPrompt).toBe('old hunk question');
    expect(useStore.getState().toasts).toHaveLength(0);
  });
});
