// @vitest-environment jsdom
//
// Cold-park of a mixed workspace: a parked workspace holding a browser keeps
// its pane tree (and so the browser) mounted, and only its terminals unmount.
// A terminal-only parked workspace still unmounts whole, and revealing either
// mounts the terminals again without remounting the browser.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { Workspace } from '../../../../shared/types';

/** `kind:surfaceId` of every surface currently mounted. */
const mounted = new Set<string>();
/** Browser mounts, to prove a reveal does not remount it. */
let browserMounts = 0;

vi.mock('../../Pane/PaneContainer', async () => {
  const { useContext, useEffect } = await import('react');
  const { TerminalsParkedContext } = await import('../../Pane/terminalsParked');
  type S = { id: string; surfaceType?: string };
  // Stands in for Pane's TerminalSurface: renders nothing while parked.
  function Term({ id }: { id: string }) {
    const parked = useContext(TerminalsParkedContext);
    return parked ? null : <Mount tag={`terminal:${id}`} />;
  }
  function Mount({ tag }: { tag: string }) {
    useEffect(() => {
      mounted.add(tag);
      if (tag.startsWith('browser:')) browserMounts += 1;
      return () => { mounted.delete(tag); };
    }, [tag]);
    return null;
  }
  return {
    default: function PaneContainerMock({ workspace }: { workspace: Workspace }) {
      const surfaces = (workspace.rootPane as unknown as { surfaces: S[] }).surfaces;
      return (
        <>
          {surfaces.map((s) => (s.surfaceType ?? 'terminal') === 'terminal'
            ? <Term key={s.id} id={s.id} />
            : <Mount key={s.id} tag={`${s.surfaceType}:${s.id}`} />)}
        </>
      );
    },
  };
});

import { WorkspaceViewport } from '../WorkspaceViewport';
import { useStore } from '../../../stores';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ws(id: string, surfaces: Array<{ id: string; surfaceType?: string }>): Workspace {
  return {
    id,
    name: id,
    rootPane: { type: 'leaf', id: `${id}-root`, surfaces, activeSurfaceId: surfaces[0]?.id ?? '' },
    activePaneId: `${id}-root`,
  } as unknown as Workspace;
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); mounted.clear(); browserMounts = 0; });

function renderViewport(): void {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(<WorkspaceViewport />));
  cleanups.push(() => { act(() => root.unmount()); el.remove(); });
}

describe('WorkspaceViewport cold-park of a mixed workspace', () => {
  it('unmounts only the terminals of a parked mixed workspace and keeps its browser', () => {
    act(() => useStore.setState({
      workspaces: [
        ws('w1', [{ id: 't-w1' }]),
        ws('mixed', [{ id: 't-m1' }, { id: 't-m2', surfaceType: 'terminal' }, { id: 'b-m', surfaceType: 'browser' }, { id: 'e-m', surfaceType: 'editor' }]),
        ws('plain', [{ id: 't-p' }]),
      ],
      activeWorkspaceId: 'w1',
      multiviewIds: [],
      parkedWorkspaceIds: {},
      paneGate: 'ready',
      appRoute: 'workspaces',
      botsWorkerPanel: null,
    } as never));
    renderViewport();
    expect([...mounted].sort()).toEqual(['browser:b-m', 'editor:e-m', 'terminal:t-m1', 'terminal:t-m2', 'terminal:t-p', 'terminal:t-w1']);
    expect(browserMounts).toBe(1);

    act(() => useStore.setState({ parkedWorkspaceIds: { mixed: true, plain: true } } as never));
    expect([...mounted].sort()).toEqual(['browser:b-m', 'editor:e-m', 'terminal:t-w1']);

    // Reveal: the terminals come back; the browser was never remounted.
    act(() => useStore.getState().setActiveWorkspace('mixed'));
    expect([...mounted].sort()).toEqual(['browser:b-m', 'editor:e-m', 'terminal:t-m1', 'terminal:t-m2', 'terminal:t-w1']);
    expect(browserMounts).toBe(1);
  });
});
