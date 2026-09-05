// @vitest-environment jsdom
//
// The SETTLE marker, renderer half. Live re-test after the interrupt edge
// shipped: a single Ctrl+C released main's latch and broadcast idle, but the
// sidebar still read "Running" at +2s and +10s. 'running' has TWO carriers in
// the renderer — the turn latch AND `surfaceActivityAt`, the 120s freshness
// stamp the byte heuristic writes — and an idle broadcast only ever ended the
// first. Claude's "Interrupted …" redraw re-stamped the second, and it outlived
// the settle by up to two minutes. Every settle path (interrupt, OSC 133
// back-at-prompt, agent exit, latch expiry) was visually undone the same way.
//
// Same harness as useNotificationListener.activity.dynamic: mount the REAL hook
// against the REAL store, capture the METADATA_UPDATE callback, push payloads.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useNotificationListener } from '../useNotificationListener';
import { useStore } from '../../stores';
import { createWorkspace, type MetadataUpdatePayload, type Surface } from '../../../shared/types';
import { isHookRunning } from '../../stores/selectors/fleet';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let metaCb: ((payload: MetadataUpdatePayload) => void) | undefined;

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
      onInitialCmdExhausted: sub(),
      listenerReady: vi.fn(),
      showOsToast: vi.fn(),
    },
    metadata: {
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
  act(() => { root.render(React.createElement(Harness)); });
}

function unmount(): void {
  act(() => { root.unmount(); });
  container.remove();
}

function seedActivePaneSurface(ptyId: string): void {
  const ws = createWorkspace('Settle');
  const wsRoot = ws.rootPane;
  if (wsRoot.type !== 'leaf') throw new Error('expected leaf root');
  const surface: Surface = { id: 'sf-settle', ptyId, title: 't', shell: 'pwsh', cwd: 'C:\\', surfaceType: 'terminal' };
  wsRoot.surfaces.push(surface);
  wsRoot.activeSurfaceId = surface.id;
  act(() => {
    useStore.setState((s) => {
      s.workspaces = [ws];
      s.activeWorkspaceId = ws.id;
      s.surfaceActivityAt = {};
      s.surfaceTurnOpenAt = {};
    });
  });
}

/** The exact question the dot and the roster row both ask. */
function hookRunning(ptyId: string): boolean {
  const s = useStore.getState();
  return isHookRunning({
    activityAt: s.surfaceActivityAt[ptyId],
    turnOpenAt: s.surfaceTurnOpenAt[ptyId],
    agentClockMs: Date.now(),
  });
}

/** A pane mid-turn: hook latch open AND a fresh byte-activity stamp. */
function seedRunningPane(ptyId: string): void {
  seedActivePaneSurface(ptyId);
  act(() => {
    metaCb!({ ptyId, agentStatus: 'running', hookKind: 'agent.user_prompt_submit' });
  });
  expect(useStore.getState().surfaceTurnOpenAt[ptyId]).toBeGreaterThan(0);
  expect(useStore.getState().surfaceActivityAt[ptyId]).toBeGreaterThan(0);
  expect(hookRunning(ptyId)).toBe(true);
}

beforeEach(() => {
  installElectronApi();
  mount();
});

afterEach(() => {
  unmount();
  act(() => {
    useStore.setState((s) => { s.surfaceActivityAt = {}; s.surfaceTurnOpenAt = {}; });
  });
});

describe('useNotificationListener — a settled idle clears BOTH running carriers', () => {
  it('clears the latch and the activity stamp, so the pane reads idle at once', () => {
    seedRunningPane('pty-settle');

    act(() => { metaCb!({ ptyId: 'pty-settle', agentStatus: 'idle', settled: true }); });

    expect(useStore.getState().surfaceTurnOpenAt['pty-settle']).toBeUndefined();
    expect(useStore.getState().surfaceActivityAt['pty-settle']).toBeUndefined();
    expect(hookRunning('pty-settle')).toBe(false);
  });

  it('leaves the activity stamp alone on an UNMARKED idle', () => {
    // Byte silence is not proof the turn ended — that idle only ends the latch,
    // exactly as before, and the heuristic keeps carrying the pane.
    seedRunningPane('pty-plain');

    act(() => { metaCb!({ ptyId: 'pty-plain', agentStatus: 'idle' }); });

    expect(useStore.getState().surfaceTurnOpenAt['pty-plain']).toBeUndefined();
    expect(useStore.getState().surfaceActivityAt['pty-plain']).toBeGreaterThan(0);
    expect(hookRunning('pty-plain')).toBe(true);
  });

  it('settles only the pane named in the payload', () => {
    seedRunningPane('pty-a');
    act(() => { metaCb!({ ptyId: 'pty-b', agentStatus: 'running' }); });

    act(() => { metaCb!({ ptyId: 'pty-a', agentStatus: 'idle', settled: true }); });

    expect(hookRunning('pty-a')).toBe(false);
    expect(useStore.getState().surfaceActivityAt['pty-b']).toBeGreaterThan(0);
  });

  it('does not leak the marker into the active pane\'s workspace metadata', () => {
    seedRunningPane('pty-meta');
    act(() => { metaCb!({ ptyId: 'pty-meta', agentStatus: 'idle', settled: true }); });
    const ws = useStore.getState().workspaces[0];
    expect((ws.metadata as Record<string, unknown> | undefined)?.settled).toBeUndefined();
  });
});
