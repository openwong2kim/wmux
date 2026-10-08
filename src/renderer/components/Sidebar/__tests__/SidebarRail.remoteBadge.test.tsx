// @vitest-environment jsdom
// The Remote rail item's needs-you badge: link requests + held remote work +
// PCs whose certificate changed, read from the one a2aRemote slice that the
// single bridge (useA2aRemoteBridge) feeds from the daemon's nudges.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import MiniSidebar from '../MiniSidebar';
import { selectRemoteNeedsYou } from '../../../stores/slices/a2aRemoteSlice';
import { A2A_HELD_POLL_MS, refreshA2aRemote, useA2aRemoteBridge } from '../../../hooks/useA2aRemoteBridge';
import type { A2aLinkRecordV1 } from '../../../../shared/a2aRemote';
import type { A2aRemoteHostStatus } from '../../../../shared/rpc';
import type { Task } from '../../../../shared/types';

const HOST = '11111111-1111-4111-8111-111111111111';
const link = (linkId: string, state: A2aLinkRecordV1['state']): A2aLinkRecordV1 => ({
  v: 1, linkId, version: 1, state,
  local: { kind: 'pane', workspaceId: 'w1', paneId: 'p1' },
  remote: { hostId: HOST, kind: 'pane', workspaceId: 'rw', paneId: 'rp' },
  allow: { outbound: true, inbound: true }, proposer: 'remote',
  createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z',
});
const host = (state: A2aRemoteHostStatus['state']): A2aRemoteHostStatus => ({ hostId: HOST, name: 'DESK', role: 'joiner', state, pending: 0 });
const task = (held = 'pane-missing') => ({
  id: `rt-${held}`, metadata: { remote: { v: 1, held } },
}) as unknown as Task;

let container: HTMLDivElement;
let root: Root;
let linkListener: (() => void) | null;
let hostListener: (() => void) | null;
let goneListener: (() => void) | null;
let api: Record<string, ReturnType<typeof vi.fn>>;

function Bridge() {
  useA2aRemoteBridge();
  return null;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  linkListener = null;
  hostListener = null;
  api = {
    linksList: vi.fn(async () => ({ links: [link('a', 'proposed-in'), link('b', 'active')] })),
    hostsStatus: vi.fn(async () => ({ hosts: [host('connected')] })),
    heldList: vi.fn(async () => ({ tasks: [] })),
    hostsList: vi.fn(async () => ({ hosts: [] })),
    peersList: vi.fn(async () => ({ peers: [] })),
    onLinkEvent: vi.fn((cb: () => void) => { linkListener = cb; return () => { linkListener = null; }; }),
    onHostStatus: vi.fn((cb: () => void) => { hostListener = cb; return () => { hostListener = null; }; }),
  };
  goneListener = null;
  vi.stubGlobal('electronAPI', {
    web: { status: vi.fn(async () => ({ running: false })) },
    a2aRemote: api,
    daemon: { onDisconnected: (cb: () => void) => { goneListener = cb; return () => { goneListener = null; }; } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({
    appRoute: 'workspaces', readOnly: false, sidebarVisible: true, schedulesAvailable: false, moa: null,
    a2aRemote: { links: [], hosts: [], held: [], joined: [], peers: [], loaded: false },
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const remote = () => container.querySelector<HTMLButtonElement>('[data-sidebar-nav="remote"]')!;
const badge = () => remote().querySelector('.wmux-nav-badge');

describe('Remote rail badge', () => {
  it('counts link requests, held work and changed certificates, nothing else', () => {
    expect(selectRemoteNeedsYou({
      a2aRemote: {
        links: [link('a', 'proposed-in'), link('b', 'proposed-out'), link('c', 'active')],
        // Holds for Moa clear by themselves: not counted.
        held: [task(), task('occupant-changed'), task('brain-delivery-pending'), task('brain-unavailable')],
        hosts: [host('identity-changed'), host('disconnected')],
        joined: [], peers: [], loaded: true,
      },
    })).toBe(4);
  });

  it('follows the bridge: one read at start, then a re-read on each nudge', async () => {
    await act(async () => root.render(<><Bridge /><MiniSidebar rail collapsed={false} /></>));
    await act(async () => { await Promise.resolve(); });
    expect(api.onLinkEvent).toHaveBeenCalledTimes(1);
    expect(api.onHostStatus).toHaveBeenCalledTimes(1);
    expect(badge()?.textContent).toBe('1');
    expect(remote().getAttribute('aria-label')).toBe('Remote, needs you 1');

    api.hostsStatus.mockResolvedValue({ hosts: [host('identity-changed')] });
    await act(async () => { hostListener?.(); await Promise.resolve(); });
    expect(badge()?.textContent).toBe('2');

    api.linksList.mockResolvedValue({ links: [link('b', 'active')] });
    api.hostsStatus.mockResolvedValue({ hosts: [host('connected')] });
    await act(async () => { linkListener?.(); await Promise.resolve(); });
    expect(badge()).toBeNull();
    expect(remote().getAttribute('aria-label')).toBe('Remote');
  });

  it('re-reads only the held list on its slow cadence, and only while the window is visible', async () => {
    await act(async () => root.render(<Bridge />));
    await act(async () => { await Promise.resolve(); });
    expect(api.heldList).toHaveBeenCalledTimes(1);
    api.heldList.mockResolvedValue({ tasks: [task()] });
    await act(async () => { vi.advanceTimersByTime(A2A_HELD_POLL_MS); await Promise.resolve(); });
    expect(api.heldList).toHaveBeenCalledTimes(2);
    expect(api.linksList).toHaveBeenCalledTimes(1);
    expect(useStore.getState().a2aRemote.held).toHaveLength(1);

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { vi.advanceTimersByTime(A2A_HELD_POLL_MS); });
    expect(api.heldList).toHaveBeenCalledTimes(2);
    visibility.mockRestore();
  });

  it('drops a refresh that finishes after a newer one already applied', async () => {
    let releaseOld: (v: unknown) => void = () => undefined;
    api.linksList.mockImplementationOnce(() => new Promise((r) => { releaseOld = r; }));
    const old = refreshA2aRemote();
    api.linksList.mockResolvedValueOnce({ links: [] });
    await act(async () => { await refreshA2aRemote(); });
    expect(useStore.getState().a2aRemote.links).toEqual([]);
    await act(async () => { releaseOld({ links: [link('a', 'proposed-in')] }); await old; });
    // The older answer (one request) never rolls the newer one (none) back.
    expect(useStore.getState().a2aRemote.links).toEqual([]);
  });

  it('clears the feed, and the badge, when the daemon goes away or every read fails', async () => {
    await act(async () => root.render(<><Bridge /><MiniSidebar rail collapsed={false} /></>));
    await act(async () => { await Promise.resolve(); });
    expect(badge()?.textContent).toBe('1');
    act(() => goneListener?.());
    expect(badge()).toBeNull();
    expect(useStore.getState().a2aRemote.loaded).toBe(false);

    await act(async () => { linkListener?.(); await Promise.resolve(); });
    expect(badge()?.textContent).toBe('1');
    for (const fn of ['linksList', 'hostsStatus', 'heldList', 'hostsList', 'peersList']) api[fn].mockRejectedValue(new Error('gone'));
    await act(async () => { linkListener?.(); await Promise.resolve(); });
    expect(badge()).toBeNull();
  });
});
