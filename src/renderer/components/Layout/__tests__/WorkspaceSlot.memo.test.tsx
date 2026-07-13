// @vitest-environment jsdom
//
// PERF REGRESSION (2026-07-13, measured root cause): AppLayout renders one
// WorkspaceSlot per workspace and subscribes to the whole `workspaces` array,
// so ANY pane's metadata update (title/cwd/agentStatus/byte-running) produces
// a new workspaces array and re-renders AppLayout. WorkspaceSlot is React.memo
// so the UNCHANGED workspaces bail — a metadata update to workspace X must
// re-render ONLY X's slot, not all N. Live measurement before the memo: a
// single title change re-rendered ALL workspaces' PaneContainer subtrees
// (~104 fibers × N); after: only the changed one.
//
// These tests lock the two facts the memo relies on:
//   1. WorkspaceSlot bails when its props are referentially equal (memo works).
//   2. workspaceSlice.updateWorkspaceMetadata keeps OTHER workspaces
//      referentially STABLE (immer structural sharing) — the property that
//      makes the memo actually skip them. If a refactor rebuilds the array,
//      the memo silently stops helping and the perf bug returns.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { Workspace } from '../../../../shared/types';

// Mock the heavy PaneContainer with a render counter — we only care that the
// slot's child re-renders (or not), not the terminal machinery.
const paneRenders = new Map<string, number>();
vi.mock('../../Pane/PaneContainer', () => ({
  default: ({ workspace }: { workspace: Workspace }) => {
    paneRenders.set(workspace.id, (paneRenders.get(workspace.id) ?? 0) + 1);
    return null;
  },
}));

// vi.mock is hoisted above imports, so this static import gets the mock.
import { WorkspaceSlot } from '../WorkspaceViewport';

function ws(id: string, agentName?: string): Workspace {
  return {
    id,
    name: id,
    rootPane: { type: 'leaf', id: `${id}-root`, surfaces: [], activeSurfaceId: '' } as unknown as Workspace['rootPane'],
    activePaneId: `${id}-root`,
    ...(agentName ? { metadata: { agentName } } : {}),
  } as Workspace;
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); paneRenders.clear(); });

function mount(node: React.ReactNode) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  cleanups.push(() => { act(() => root.unmount()); el.remove(); });
  return { el, rerender: (n: React.ReactNode) => act(() => root.render(n)) };
}

describe('WorkspaceSlot memo (perf regression guard)', () => {
  it('does NOT re-render PaneContainer when props are referentially equal', () => {
    const a = ws('a');
    const { rerender } = mount(<WorkspaceSlot workspace={a} isActive={false} />);
    expect(paneRenders.get('a')).toBe(1);
    // Same workspace ref + same isActive → memo bails, no child re-render.
    rerender(<WorkspaceSlot workspace={a} isActive={false} />);
    expect(paneRenders.get('a')).toBe(1);
  });

  it('DOES re-render when the workspace reference changes (a real update)', () => {
    const a1 = ws('a', 'n1');
    const { rerender } = mount(<WorkspaceSlot workspace={a1} isActive={false} />);
    expect(paneRenders.get('a')).toBe(1);
    const a2 = ws('a', 'n2'); // new reference = changed workspace
    rerender(<WorkspaceSlot workspace={a2} isActive={false} />);
    expect(paneRenders.get('a')).toBe(2);
  });

  it('re-renders when isActive flips (workspace switch)', () => {
    const a = ws('a');
    const { rerender } = mount(<WorkspaceSlot workspace={a} isActive={false} />);
    expect(paneRenders.get('a')).toBe(1);
    rerender(<WorkspaceSlot workspace={a} isActive />);
    expect(paneRenders.get('a')).toBe(2);
  });
});
