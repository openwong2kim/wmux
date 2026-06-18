// @vitest-environment jsdom
//
// Dynamic verification for the Fleet View per-pane activity line
// (fleet-activity-line-hook.md), renderer half.
//
// The metadata `onUpdate` handler is wired INSIDE useNotificationListener's
// useEffect (it reads the module-singleton useStore directly), so — like
// useKeyboard.zoom.dynamic.test.tsx — we mount the REAL hook against the REAL
// store, mock `window.electronAPI` to CAPTURE the onUpdate callback, then push
// a METADATA_UPDATE payload through it and assert the live store moved.
//
// Two contracts are pinned:
//  1. a `{ ptyId, activity }` payload writes surfaceActivity[ptyId].
//  2. [REGRESSION] the SAME payload for the ACTIVE pane does NOT leak `activity`
//     into that workspace's metadata — `activity` is destructured out before
//     applyToWorkspace's `...rest` spread (adversarial-review gap #8).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useNotificationListener } from '../useNotificationListener';
import { useStore } from '../../stores';
import { createWorkspace, type MetadataUpdatePayload, type Surface } from '../../../shared/types';

// React 19 logs a warning unless the test env flags act() support.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
// The captured METADATA_UPDATE callback the hook registered at mount.
let metaCb: ((payload: MetadataUpdatePayload) => void) | undefined;

/** A no-op subscriber that returns an unsubscribe fn (the shape the hook expects). */
function sub() {
  return vi.fn(() => vi.fn());
}

function installElectronApi(): void {
  metaCb = undefined;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    window: { flashFrame: vi.fn() },
    notification: {
      onNew: sub(),
      onFocusRequest: sub(),
      onCwdChanged: sub(),
      onTitleChanged: sub(),
      onGitBranchChanged: sub(),
    },
    metadata: {
      // Capture the real handler so the test can drive it.
      onUpdate: vi.fn((cb: (payload: MetadataUpdatePayload) => void) => {
        metaCb = cb;
        return vi.fn();
      }),
      resolveAgent: vi.fn(() => Promise.resolve(null)),
    },
    signalHealth: { onUpdate: sub() },
    usage: { onUpdate: sub(), setEnabled: vi.fn() },
  };
}

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  function Harness(): null {
    useNotificationListener();
    return null;
  }
  act(() => {
    root.render(React.createElement(Harness));
  });
}

function unmount(): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

/** Seed the store with a single workspace whose active pane's active surface is
 *  bound to `ptyId`. Returns the workspace id. */
function seedActivePaneSurface(ptyId: string): string {
  const ws = createWorkspace('Activity');
  const root = ws.rootPane;
  if (root.type !== 'leaf') throw new Error('expected leaf root');
  const surface: Surface = { id: 'sf-act', ptyId, title: 't', shell: 'pwsh', cwd: 'C:\\', surfaceType: 'terminal' };
  root.surfaces.push(surface);
  root.activeSurfaceId = surface.id;
  act(() => {
    useStore.setState((s) => {
      s.workspaces = [ws];
      s.activeWorkspaceId = ws.id;
      s.surfaceActivity = {};
    });
  });
  return ws.id;
}

beforeEach(() => {
  installElectronApi();
  mount();
});

afterEach(() => {
  unmount();
  // Reset the transient map so the module-singleton store doesn't bleed state.
  act(() => {
    useStore.setState((s) => { s.surfaceActivity = {}; });
  });
});

describe('useNotificationListener — Fleet activity line (METADATA_UPDATE.activity)', () => {
  it('registers a METADATA_UPDATE handler at mount', () => {
    expect(metaCb).toBeTypeOf('function');
  });

  it('writes surfaceActivity[ptyId] from a { ptyId, activity } payload', () => {
    seedActivePaneSurface('pty-1');
    act(() => { metaCb!({ ptyId: 'pty-1', activity: '✎ fleet.ts' }); });
    expect(useStore.getState().surfaceActivity['pty-1']).toBe('✎ fleet.ts');
  });

  it('overwrites the activity on a subsequent payload for the same pty', () => {
    seedActivePaneSurface('pty-1');
    act(() => { metaCb!({ ptyId: 'pty-1', activity: '→ types.ts' }); });
    act(() => { metaCb!({ ptyId: 'pty-1', activity: '$ npm test' }); });
    expect(useStore.getState().surfaceActivity['pty-1']).toBe('$ npm test');
  });

  it('clears surfaceActivity[ptyId] when an empty activity string arrives', () => {
    seedActivePaneSurface('pty-1');
    act(() => { metaCb!({ ptyId: 'pty-1', activity: '$ build' }); });
    expect(useStore.getState().surfaceActivity['pty-1']).toBe('$ build');
    act(() => { metaCb!({ ptyId: 'pty-1', activity: '' }); });
    expect(useStore.getState().surfaceActivity['pty-1']).toBeUndefined();
  });

  // [REGRESSION] adversarial-review gap #8: activity must be pulled out of the
  // payload BEFORE applyToWorkspace's `...rest` spread, or an active-pane update
  // writes it into the workspace metadata as junk.
  it('[REGRESSION] does NOT write activity into the active pane\'s workspace metadata', () => {
    const wsId = seedActivePaneSurface('pty-1');
    act(() => { metaCb!({ ptyId: 'pty-1', activity: '✎ leak.ts' }); });
    const ws = useStore.getState().workspaces.find((w) => w.id === wsId)!;
    // Either no metadata object at all, or one with no `activity` key — both are
    // acceptable; what must NOT happen is `metadata.activity` being set.
    expect((ws.metadata as Record<string, unknown> | undefined)?.activity).toBeUndefined();
    // And it must have actually been stored in the per-surface map instead.
    expect(useStore.getState().surfaceActivity['pty-1']).toBe('✎ leak.ts');
  });

  // A metadata payload that also carries a real workspace field (e.g. cwd) must
  // still apply that field; only `activity` is diverted. This proves the
  // destructure removed activity WITHOUT eating the rest of the payload.
  it('still applies co-arriving workspace fields while diverting activity', () => {
    const wsId = seedActivePaneSurface('pty-1');
    act(() => { metaCb!({ ptyId: 'pty-1', activity: '✎ x.ts', agentStatus: 'awaiting_input' }); });
    // agentStatus flows to the per-surface attention map (active pane → status).
    expect(useStore.getState().surfaceAgentStatus['pty-1']).toBe('awaiting_input');
    // activity went to its own map, not metadata.
    expect(useStore.getState().surfaceActivity['pty-1']).toBe('✎ x.ts');
    const ws = useStore.getState().workspaces.find((w) => w.id === wsId)!;
    expect((ws.metadata as Record<string, unknown> | undefined)?.activity).toBeUndefined();
  });
});
