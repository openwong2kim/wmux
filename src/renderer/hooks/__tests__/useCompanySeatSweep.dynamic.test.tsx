// @vitest-environment jsdom
// The company seat sweep requests: one once the saved session is loaded, one
// a few seconds after a workspace or an archived workspace goes, each with
// every folder a pane here works in or will open in; one toast per sweep
// that removed something.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { COMPANY_SEAT_SWEEP_DEBOUNCE_MS, companySeatKeepSet, useCompanySeatSweep } from '../useCompanySeatSweep';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const leaf = (id: string, surfaces: Array<Record<string, unknown>>) => ({ id, type: 'leaf', activeSurfaceId: surfaces[0]?.id, surfaces });
const workspace = (id: string, cwd: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, activePaneId: `${id}-p`,
  rootPane: leaf(`${id}-p`, [{ id: `${id}-s`, ptyId: `${id}-pty`, title: 'zsh', shell: 'zsh', cwd }]),
  ...extra,
});

let container: HTMLDivElement;
let root: Root;
let sweepCompanySeats: ReturnType<typeof vi.fn>;

function Probe({ loaded }: { loaded: boolean }) {
  useCompanySeatSweep(loaded);
  return null;
}
const render = (loaded: boolean) => act(() => root.render(createElement(Probe, { loaded })));
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sweepCompanySeats = vi.fn(async () => ({ ok: true, run: 1, removed: 0 }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { workTask: { sweepCompanySeats } };
  act(() => useStore.setState({
    workspaces: [
      workspace('ws-a', '/seats/a', {
        stashedPanes: [{ pane: leaf('stashed-p', [{ id: 'st-s', ptyId: 'st-pty', title: 'zsh', shell: 'zsh', cwd: '/seats/stashed' }]), stashedAt: 1 }],
      }),
      workspace('ws-b', '/seats/b'),
      {
        id: 'ws-web', name: 'web', activePaneId: 'web-p',
        rootPane: leaf('web-p', [{ id: 'web-s', title: 'docs', shell: '', cwd: '/not/a/terminal', surfaceType: 'browser' }]),
      },
    ],
    archivedWorkspaces: [
      { id: 'arch-1', name: 'old', tree: { type: 'leaf' }, leafCwds: ['/seats/archived', ''], archivedAt: 1 },
      { id: 'arch-2', name: 'older', tree: { type: 'leaf' }, archivedAt: 1 },
    ],
    projectPaneSeed: { 'new-p': { cwd: '/seats/starting' }, 'plain-p': { label: 'x' } },
    toasts: [],
  } as never));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('companySeatKeepSet', () => {
  it('holds every terminal folder: live, stashed, about to open, and archived', () => {
    expect(companySeatKeepSet(useStore.getState()).sort()).toEqual(
      ['/seats/a', '/seats/archived', '/seats/b', '/seats/starting', '/seats/stashed'],
    );
  });
});

describe('useCompanySeatSweep', () => {
  it('asks once the saved session is loaded, with the keep set', async () => {
    render(false);
    await flush();
    expect(sweepCompanySeats).not.toHaveBeenCalled();
    render(true);
    await flush();
    expect(sweepCompanySeats).toHaveBeenCalledTimes(1);
    expect(sweepCompanySeats.mock.calls[0][0].sort()).toEqual(['/seats/a', '/seats/archived', '/seats/b', '/seats/starting', '/seats/stashed']);
  });

  it('asks once, a few seconds after workspaces go, without the closed ones\' folders', async () => {
    render(true);
    await flush();
    act(() => useStore.setState({ workspaces: useStore.getState().workspaces.filter((w) => w.id !== 'ws-a') } as never));
    vi.advanceTimersByTime(COMPANY_SEAT_SWEEP_DEBOUNCE_MS - 1);
    act(() => useStore.setState({ workspaces: useStore.getState().workspaces.filter((w) => w.id !== 'ws-b') } as never));
    vi.advanceTimersByTime(COMPANY_SEAT_SWEEP_DEBOUNCE_MS - 1);
    expect(sweepCompanySeats).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await flush();
    expect(sweepCompanySeats).toHaveBeenCalledTimes(2);
    expect(sweepCompanySeats.mock.calls[1][0].sort()).toEqual(['/seats/archived', '/seats/starting']);
  });

  it('asks after an archived workspace is deleted, and not when a workspace is added', async () => {
    render(true);
    await flush();
    act(() => useStore.setState({ workspaces: [...useStore.getState().workspaces, workspace('ws-c', '/seats/c')] } as never));
    vi.advanceTimersByTime(COMPANY_SEAT_SWEEP_DEBOUNCE_MS);
    expect(sweepCompanySeats).toHaveBeenCalledTimes(1);
    act(() => useStore.setState({ archivedWorkspaces: useStore.getState().archivedWorkspaces.filter((a) => a.id !== 'arch-1') } as never));
    vi.advanceTimersByTime(COMPANY_SEAT_SWEEP_DEBOUNCE_MS);
    await flush();
    expect(sweepCompanySeats).toHaveBeenCalledTimes(2);
    expect(sweepCompanySeats.mock.calls[1][0]).not.toContain('/seats/archived');
  });

  it('shows one info toast per sweep that removed something, and none when nothing went', async () => {
    sweepCompanySeats
      .mockResolvedValueOnce({ ok: true, run: 1, removed: 0 })
      .mockResolvedValueOnce({ ok: true, run: 2, removed: 2 })
      .mockResolvedValueOnce({ ok: true, run: 2, removed: 2 });
    render(true);
    await flush();
    expect(useStore.getState().toasts).toHaveLength(0);
    act(() => useStore.setState({ workspaces: useStore.getState().workspaces.filter((w) => w.id !== 'ws-a') } as never));
    vi.advanceTimersByTime(COMPANY_SEAT_SWEEP_DEBOUNCE_MS);
    act(() => useStore.setState({ workspaces: useStore.getState().workspaces.filter((w) => w.id !== 'ws-b') } as never));
    vi.advanceTimersByTime(COMPANY_SEAT_SWEEP_DEBOUNCE_MS);
    await flush();
    expect(sweepCompanySeats).toHaveBeenCalledTimes(3);
    expect(useStore.getState().toasts.map((toast) => [toast.level, toast.message])).toEqual([
      ['info', 'Removed 2 company seat worktree(s); all their work is on the remote.'],
    ]);
  });
});
