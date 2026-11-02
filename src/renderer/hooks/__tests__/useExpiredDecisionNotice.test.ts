// @vitest-environment jsdom
// The decisions main removed at startup (#2943) each get one info toast once
// the panes are ready, quoting the question shortened and naming the
// workspace from the store; an unknown workspace or an empty list shows
// nothing.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { useExpiredDecisionNotice } from '../useExpiredDecisionNotice';

let container: HTMLDivElement;
let root: Root;

function Probe() {
  useExpiredDecisionNotice();
  return null;
}

function stubList(decisions: Array<{ workspaceId: string; id: string; question: string }>) {
  const expiredDecisions = vi.fn(async () => ({ decisions }));
  vi.stubGlobal('electronAPI', { deck: { expiredDecisions } });
  return expiredDecisions;
}

beforeEach(() => {
  useStore.setState({
    toasts: [],
    paneGate: 'pending',
    workspaces: [{ id: 'ws-1', name: 'Backend' }] as never,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('useExpiredDecisionNotice', () => {
  it('waits for the panes, then pushes one info toast per decision of a known workspace', async () => {
    const long = `Resume it, or drop it? ${'x'.repeat(200)}`;
    const take = stubList([
      { workspaceId: 'ws-1', id: 'd-1', question: long },
      { workspaceId: 'ws-1', id: 'd-2', question: 'Ship it?' },
      { workspaceId: 'ws-gone', id: 'd-3', question: 'Orphan?' },
    ]);
    await act(async () => root.render(createElement(Probe)));
    expect(take).not.toHaveBeenCalled();

    await act(async () => useStore.setState({ paneGate: 'ready' }));
    expect(take).toHaveBeenCalledTimes(1);
    const toasts = useStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts.every((t) => t.level === 'info')).toBe(true);
    expect(toasts[0].message).toContain('Backend');
    expect(toasts[0].message).toContain(`${long.slice(0, 119)}…`);
    expect(toasts[0].message).not.toContain(long);
    expect(toasts[0].target).toEqual({ workspaceId: 'ws-1' });
    expect(toasts[1].message).toContain('"Ship it?"');
  });

  it('keeps a response that arrives after an unmount (StrictMode remounts once)', async () => {
    let resolve: (v: { decisions: Array<{ workspaceId: string; id: string; question: string }> }) => void = () => undefined;
    vi.stubGlobal('electronAPI', { deck: { expiredDecisions: vi.fn(() => new Promise((r) => { resolve = r; })) } });
    useStore.setState({ paneGate: 'ready' });
    await act(async () => root.render(createElement(Probe)));
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => resolve({ decisions: [{ workspaceId: 'ws-1', id: 'd-1', question: 'Go?' }] }));
    expect(useStore.getState().toasts).toHaveLength(1);
  });

  it('shows nothing when no decision was expired', async () => {
    stubList([]);
    useStore.setState({ paneGate: 'ready' });
    await act(async () => root.render(createElement(Probe)));
    expect(useStore.getState().toasts).toEqual([]);
  });
});
