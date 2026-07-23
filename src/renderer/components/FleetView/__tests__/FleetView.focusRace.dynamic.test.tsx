// @vitest-environment jsdom
//
// NB2 wave 2 — FleetView mount focus race regression harness.
//
// Symptom (CRITICAL, two-model consensus): switching to persistent chrome split the mount
// effect (rAF focus pull) and roving focus effect into separate useEffects. The roving
// effect's `panel.contains(document.activeElement)` guard runs synchronously at mount time,
// but the rAF callback has not run yet, so focus is not inside the panel → false → immediate
// return. The old mount effect only focused panelRef (the container), so no card ever got
// real DOM focus. With a single card in the tab, arrow keys clamp the index and roving never
// wakes up; screen readers also fail to announce the initial selection.
//
// Fix: the mount effect focuses the card/row at the current focus index directly, not
// panelRef. This harness mounts REAL <FleetView/> via createRoot, runs effects, flushes rAF,
// then verifies document.activeElement is the data-fleet-card button (not the container).
// Fixtures the single-card case (where the race used to persist). Also verifies focus restore
// on close (INFO item 4).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FleetView from '../FleetView';
import { useStore } from '../../../stores';
import type { Workspace, Pane, Surface } from '../../../../shared/types';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Fixtures: single browser-surface pane = one card (avoids terminal tail path) ─────
function surface(id: string, ptyId: string, extra: Partial<Surface> = {}): Surface {
  return { id, ptyId, title: id, shell: 'pwsh', cwd: `C:\\repo\\${id}`, surfaceType: 'browser', ...extra };
}
function leaf(id: string, surfaces: Surface[]): Pane {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
}
function workspace(id: string, name: string, rootPane: Pane, activePaneId: string): Workspace {
  return { id, name, rootPane, activePaneId };
}
const singleCardWorkspaces: Workspace[] = [
  workspace('ws-1', 'alpha', leaf('p1', [surface('s1', 'pty-1')]), 'p1'),
];

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(FleetView));
  });
}

function unmount(): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

/** Flush the rAF callback scheduled by the mount effect (focus move). */
async function flushRaf(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

beforeEach(() => {
  act(() => {
    useStore.setState({
      locale: 'en',
      sidebarPosition: 'left',
      fleetActiveTab: 'fleet',
      fleetSortMode: 'attention',
      workspaces: singleCardWorkspaces,
    });
  });
});

afterEach(() => {
  try {
    unmount();
  } catch {
    /* self-unmounted */
  }
  document.body.innerHTML = '';
});

describe('FleetView — mount focus race (NB2 wave2)', () => {
  it('lands real DOM focus on the single fleet card, not the panel container', async () => {
    mount();
    await flushRaf();

    const active = document.activeElement as HTMLElement | null;
    // With the race, active would be the role=region panel (or body) and this would fail.
    expect(active?.hasAttribute('data-fleet-card')).toBe(true);
    expect(active?.getAttribute('role')).toBe('option');
  });

  it('restores focus to the opener element on close (unmount)', async () => {
    // Open trigger band: element that held focus just before mount (e.g. pane textarea).
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    mount();
    await flushRaf();
    // When open, focus moves to the card.
    expect(document.activeElement).not.toBe(opener);

    unmount();
    // When closed, focus restores to the opener (browser does not drop to body).
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
