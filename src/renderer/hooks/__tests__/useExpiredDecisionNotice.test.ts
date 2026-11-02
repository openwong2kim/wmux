// @vitest-environment jsdom
// The decisions main expired at startup (#2943) each get one info toast on
// mount, quoting the question shortened; an empty list shows nothing.
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

function stubList(decisions: Array<{ workspaceId: string; workspaceName?: string; id: string; question: string }>) {
  const expiredDecisions = vi.fn(async () => ({ decisions }));
  vi.stubGlobal('electronAPI', { deck: { expiredDecisions } });
  return expiredDecisions;
}

beforeEach(() => {
  useStore.setState({ toasts: [] });
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
  it('pushes one info toast per expired decision, with the workspace name when known', async () => {
    const long = `Resume it, or drop it? ${'x'.repeat(200)}`;
    const read = stubList([
      { workspaceId: 'ws-1', workspaceName: 'Backend', id: 'd-1', question: long },
      { workspaceId: 'ws-2', id: 'd-2', question: 'Ship it?' },
    ]);
    await act(async () => root.render(createElement(Probe)));

    expect(read).toHaveBeenCalledTimes(1);
    const toasts = useStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts.every((t) => t.level === 'info')).toBe(true);
    expect(toasts[0].message).toContain('Backend');
    expect(toasts[0].message).toContain(`${long.slice(0, 119)}…`);
    expect(toasts[0].message).not.toContain(long);
    expect(toasts[0].target).toEqual({ workspaceId: 'ws-1' });
    expect(toasts[1].message).toContain('"Ship it?"');
  });

  it('shows nothing when no decision was expired', async () => {
    stubList([]);
    await act(async () => root.render(createElement(Probe)));
    expect(useStore.getState().toasts).toEqual([]);
  });
});
