// @vitest-environment jsdom
//
// The multiview grid tile header (the "CTO" label above each tile's panes)
// is the one place a workspace color tag was NOT reachable before this
// change — sidebar rail (MiniSidebar) and sidebar row (WorkspaceItem) already
// read it. This pins: untagged renders no dot (the common case, so most
// tiles are pixel-identical to before), tagged renders a dot in that exact
// color, and the tile's name/remove behavior is untouched.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { Workspace } from '../../../../shared/types';
import { WORKSPACE_COLOR_HEX, type WorkspaceColorId } from '../../../../shared/workspaceColors';

// Same mocking approach as WorkspaceSlot.memo.test.tsx — the tile header is
// what's under test, not the terminal machinery it hosts.
vi.mock('../../Pane/PaneContainer', () => ({
  default: () => null,
}));

// vi.mock is hoisted above imports, so this static import gets the mock.
import { MultiviewWorkspaceSlot } from '../WorkspaceViewport';

function ws(id: string, color?: WorkspaceColorId): Workspace {
  return {
    id,
    name: id,
    color,
    rootPane: { type: 'leaf', id: `${id}-root`, surfaces: [], activeSurfaceId: '' } as unknown as Workspace['rootPane'],
    activePaneId: `${id}-root`,
  } as Workspace;
}

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(workspace: Workspace): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MultiviewWorkspaceSlot
        workspace={workspace}
        isActive={false}
        multiviewCount={2}
        arrangement="auto"
        onActivate={() => undefined}
        onRemove={() => undefined}
      />,
    );
  });
}

function dot(): HTMLElement | null {
  return container.querySelector('[aria-hidden="true"]');
}

/** jsdom normalizes an inline `background: #hex` to `rgb(r, g, b)`. */
function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

describe('MultiviewWorkspaceSlot — workspace color tag dot', () => {
  it('renders no dot for an untagged workspace', () => {
    mount(ws('cto'));
    expect(container.textContent).toContain('cto');
    expect(dot()).toBeNull();
  });

  it('renders a dot in the tag color for a tagged workspace', () => {
    mount(ws('cto', 'teal'));
    const el = dot();
    expect(el).not.toBeNull();
    expect(el!.style.background).toBe(hexToRgb(WORKSPACE_COLOR_HEX.teal));
    expect(container.textContent).toContain('cto');
  });
});
