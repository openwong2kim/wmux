// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import { createWorkspace } from '../../../../shared/types';
import { getWorkspacePtyIds } from '../../../../shared/paneUtils';
import { openAutomationRun } from '../openRun';
import { automation, run } from './fixtures';

const list = vi.fn();

beforeEach(() => {
  list.mockReset();
  vi.stubGlobal('electronAPI', { pty: { list } });
  const ws = createWorkspace('Main');
  useStore.setState({
    workspaces: [ws],
    activeWorkspaceId: ws.id,
    automations: [automation({ name: 'Morning report' })],
    automationRuns: [run({ id: 'r1', ptyId: 'auto-1', state: 'awaiting' })],
    appRoute: 'schedules', schedulesViewOpen: true,
    schedulesSelectedId: null,
  });
});
afterEach(() => vi.unstubAllGlobals());

const owners = (ptyId: string) =>
  useStore.getState().workspaces.filter((w) => getWorkspacePtyIds(w).includes(ptyId));

describe('openAutomationRun', () => {
  it('binds a live run to a new workspace named after the schedule, once', async () => {
    list.mockResolvedValue([{ id: 'auto-1', shell: '/bin/zsh', cwd: '/work/repo', state: 'detached' }]);
    await expect(openAutomationRun('r1')).resolves.toBe('adopted');
    const st = useStore.getState();
    const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId)!;
    expect(ws.name).toBe('Morning report');
    expect(owners('auto-1')).toHaveLength(1);
    expect(st.schedulesViewOpen).toBe(false);

    // A second open focuses the pane that already shows it — never a second binding.
    useStore.setState({ appRoute: 'schedules', schedulesViewOpen: true });
    await expect(openAutomationRun('r1')).resolves.toBe('focused');
    expect(owners('auto-1')).toHaveLength(1);
    expect(useStore.getState().workspaces).toHaveLength(2);
  });

  it('opens the details instead when the session is gone or the run finished', async () => {
    list.mockResolvedValue([]);
    await expect(openAutomationRun('r1')).resolves.toBe('gone');
    expect(useStore.getState().workspaces).toHaveLength(1);
    expect(useStore.getState().schedulesSelectedId).toBe('a1');

    useStore.setState({ automationRuns: [run({ id: 'r2', ptyId: 'auto-2', state: 'completed' })] });
    await expect(openAutomationRun('r2')).resolves.toBe('details');
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('openAutomationRun for a run the store has not seen', () => {
  it('refreshes, then falls back to the schedule named by the toast', async () => {
    const runs = vi.fn(async () => ({ runs: [] }));
    vi.stubGlobal('electronAPI', {
      pty: { list },
      automation: { list: vi.fn(async () => ({ automations: [automation()], available: true })), runs },
    });
    useStore.setState({ schedulesViewOpen: false });
    await expect(openAutomationRun('unknown-run', 'a1')).resolves.toBe('details');
    expect(runs).toHaveBeenCalled();
    expect(useStore.getState().schedulesViewOpen).toBe(true);
    expect(useStore.getState().schedulesSelectedId).toBe('a1');
  });
});

describe('schedules slice pushes', () => {
  it('drops a stale refresh and keeps runs that changed while it was in flight', async () => {
    let release!: (v: { runs: ReturnType<typeof run>[] }) => void;
    vi.stubGlobal('electronAPI', {
      automation: {
        list: vi.fn(async () => ({ automations: [automation()], available: true })),
        runs: vi.fn(() => new Promise((r) => { release = r; })),
      },
    });
    useStore.setState({ automationRuns: [] });
    const pending = useStore.getState().refreshSchedules();
    await Promise.resolve();
    useStore.getState().applyAutomationPush({
      kind: 'event', event: { type: 'run-changed', run: run({ id: 'r1', state: 'completed' }), automationName: 'x' },
    });
    release({ runs: [run({ id: 'r1', state: 'running' })] });
    await pending;
    expect(useStore.getState().automationRuns.map((r) => r.state)).toEqual(['completed']);
  });

  it('keeps what is shown when the list read fails transiently', async () => {
    vi.stubGlobal('electronAPI', {
      automation: {
        list: vi.fn(async () => ({ automations: [], available: true, error: 'timeout' })),
        runs: vi.fn(async () => ({ runs: [] })),
      },
    });
    useStore.setState({ automations: [automation()], schedulesAvailable: true, schedulesError: false });
    await useStore.getState().refreshSchedules();
    expect(useStore.getState().automations).toHaveLength(1);
    expect(useStore.getState().schedulesAvailable).toBe(true);
    expect(useStore.getState().schedulesError).toBe(true);
  });

  it('upserts a run from run-changed and replaces everything on a snapshot', () => {
    const st = useStore.getState();
    st.applyAutomationPush({ kind: 'event', event: { type: 'run-changed', run: run({ id: 'r1', state: 'completed' }), automationName: 'x' } });
    st.applyAutomationPush({ kind: 'event', event: { type: 'run-changed', run: run({ id: 'r9', state: 'running' }), automationName: 'x' } });
    expect(useStore.getState().automationRuns.map((r) => [r.id, r.state])).toEqual([['r1', 'completed'], ['r9', 'running']]);
    st.applyAutomationPush({ kind: 'snapshot', automations: [], runs: [] });
    expect(useStore.getState().automationRuns).toEqual([]);
    expect(useStore.getState().schedulesAvailable).toBe(true);
  });
});
