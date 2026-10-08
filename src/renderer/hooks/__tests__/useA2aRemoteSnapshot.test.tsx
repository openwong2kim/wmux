// @vitest-environment jsdom
//
// Cross-host A2A exposure snapshot: published once the startup session load
// settles, even on a first run with no saved session (E2E D1), and pane names
// read exactly like the pane header (E2E D2).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { useStore } from '../../stores';
import { createWorkspace, type Workspace } from '../../../shared/types';
import type { A2aRemotePaneSnapshot } from '../../../shared/rpc';
import type { MoaState } from '../../../shared/moa';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { A2A_SNAPSHOT_DEBOUNCE_MS, buildPaneSnapshot, useA2aRemoteSnapshot } from '../useA2aRemoteSnapshot';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let sent: A2aRemotePaneSnapshot[];

function Probe(): null {
  useA2aRemoteSnapshot();
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    a2aRemote: { snapshot: vi.fn(async (s: A2aRemotePaneSnapshot) => { sent.push(s); return { ok: true }; }) },
  };
  useStore.setState({ sessionRestored: false, sessionLoadSettled: false, workspaces: [], paneLabel: {}, moa: null });
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  vi.useRealTimers();
});

function mount(): void {
  const el = document.createElement('div');
  root = createRoot(el);
  act(() => root!.render(createElement(Probe)));
}

const moaOn = (hqId: string): MoaState =>
  ({ config: { enabled: true }, hq: { workspaceId: hqId, state: 'ok' }, archive: { unacked: 0, total: 0 } }) as unknown as MoaState;

describe('exposure snapshot on a first run', () => {
  it('nothing is published before the load settles; a first run (no saved session) publishes panes and Moa', async () => {
    mount();
    const ws: Workspace = createWorkspace('Fresh');
    act(() => useStore.setState({ workspaces: [ws], moa: moaOn(ws.id) }));
    await act(async () => { await vi.advanceTimersByTimeAsync(A2A_SNAPSHOT_DEBOUNCE_MS * 2); });
    expect(sent).toEqual([]);

    // No saved session: sessionRestored stays false, the load still settled.
    act(() => useStore.getState().markSessionLoadSettled());
    await act(async () => { await vi.advanceTimersByTimeAsync(A2A_SNAPSHOT_DEBOUNCE_MS * 2); });
    expect(sent).toHaveLength(1);
    expect(sent[0].workspaces.map((w) => w.id)).toEqual([ws.id]);
    expect(sent[0].workspaces[0].panes).toHaveLength(1);
    expect(sent[0].brain).toEqual({ workspaceId: ws.id, name: 'Fresh' });
    expect(sent[0].sessionRestored).toBe(true);
  });
});

describe('pane names match the header', () => {
  it('a pane_metadata label (the paneLabel mirror) is the exposed name', () => {
    const ws = createWorkspace('W');
    const leaf = getWorkspaceLeafPanes(ws)[0];
    const snap = buildPaneSnapshot({ workspaces: [ws], surfaceAgent: {}, paneLabel: { [leaf.id]: 'reviewer' } });
    expect(snap.workspaces[0].panes[0].label).toBe('reviewer');
    // No label anywhere: the auto coordinate, as the header shows it.
    expect(buildPaneSnapshot({ workspaces: [ws], surfaceAgent: {} }).workspaces[0].panes[0].label).toMatch(/^w\d+-\d+$/);
  });
});
