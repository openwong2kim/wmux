// @vitest-environment jsdom
//
// The checklist container: nothing is tickable until the saved exposure is
// read, and writes run one after another on the latest saved value, so two
// quick ticks never overwrite each other.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import type { A2aExposureV1 } from '../../../../shared/a2aRemote';
import { useStore } from '../../../stores';
import { A2aExposureChecklist } from '../A2aExposureChecklist';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const HOST = '11111111-1111-4111-8111-111111111111';
const t = (k: string): string => k;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = '';
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const rec = (workspaceIds: string[], paneIds: Record<string, string[]>): A2aExposureV1 => ({ v: 1, hostId: HOST, workspaceIds, paneIds, updatedAt: '' });

describe('A2aExposureChecklist', () => {
  it('waits for the saved exposure, then writes each tick on top of the last', async () => {
    let release!: (v: { exposure: A2aExposureV1 }) => void;
    const sets: Array<[string[], Record<string, string[]>]> = [];
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      a2aRemote: {
        exposureGet: vi.fn(() => new Promise((r) => { release = r; })),
        exposureSet: vi.fn(async (_h: string, ws: string[], panes: Record<string, string[]>) => {
          sets.push([ws, panes]);
          return { exposure: rec(ws, panes) };
        }),
      },
    };
    act(() => {
      useStore.setState({
        workspaces: [{
          id: 'w1', name: 'API', activePaneId: 'a',
          rootPane: { id: 'b0', type: 'branch', direction: 'horizontal', children: [
            { id: 'a', type: 'leaf', surfaces: [], activeSurfaceId: '' },
            { id: 'b', type: 'leaf', surfaces: [], activeSurfaceId: '' },
          ] },
        }],
      } as never);
    });
    const el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    act(() => root!.render(createElement(A2aExposureChecklist, { hostId: HOST, pcName: 'LAPTOP', t })));
    const box = (paneId: string): HTMLButtonElement => el.querySelector(`[data-pane-id="${paneId}"] [role="checkbox"]`)!;
    expect(box('a').disabled).toBe(true);

    await act(async () => release({ exposure: rec(['w1'], { w1: ['b'] }) }));
    expect(box('a').disabled).toBe(false);
    await act(async () => { box('a').click(); });
    expect(sets).toEqual([[['w1'], { w1: ['b', 'a'] }]]);
  });
});
