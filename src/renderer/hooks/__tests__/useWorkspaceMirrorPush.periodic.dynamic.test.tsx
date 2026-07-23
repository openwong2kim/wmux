// @vitest-environment jsdom
//
// Behavioral verification of the WorkspaceMirror push cadence (Finding 2). Like
// useNotificationListener.activity.dynamic.test.tsx, we mount the REAL hook
// against the REAL module-singleton store and capture pushes through a mocked
// `window.electronAPI.workspaceMirror.push`.
//
// Two contracts, under fake timers:
//   1. a clock-only tick (agentClockMs) does NOT push — the ~2s agent clock is
//      no longer a churn key, so it can't re-push the full payload every 2s.
//   2. the slow periodic refresh fires a push at 30s so decay-derived status
//      still reaches the mirror boundedly.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useWorkspaceMirrorPush } from '../useWorkspaceMirrorPush';
import { useStore } from '../../stores';
import { createWorkspace } from '../../../shared/types';

// React 19 logs a warning unless the test env flags act() support.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let push: ReturnType<typeof vi.fn>;

function installElectronApi(): void {
  push = vi.fn();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    workspaceMirror: { push },
  };
}

/** Seed a single ready workspace so buildWorkspaceMirrorPayload has real data. */
function seedReady(): void {
  const ws = createWorkspace('Mirror');
  act(() => {
    useStore.setState((s) => {
      s.workspaces = [ws];
      s.activeWorkspaceId = ws.id;
      s.agentClockMs = 1_000;
      s.paneGate = 'ready';
    });
  });
}

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  function Harness(): null {
    useWorkspaceMirrorPush();
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

beforeEach(() => {
  vi.useFakeTimers();
  installElectronApi();
  seedReady();
});

afterEach(() => {
  unmount();
  vi.useRealTimers();
  act(() => {
    useStore.setState((s) => {
      s.workspaces = [];
      s.paneGate = 'pending';
    });
  });
});

describe('useWorkspaceMirrorPush — push cadence', () => {
  it('does NOT push on a clock-only tick (agentClockMs), even past the debounce', () => {
    mount();
    push.mockClear(); // drop the mount seed push
    act(() => {
      useStore.setState((s) => {
        s.agentClockMs = 3_000; // ~2s decay clock advanced, nothing else
      });
    });
    // Well beyond the 300ms trailing debounce window.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('fires the periodic refresh push at 30s', () => {
    mount();
    push.mockClear();
    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(push).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1_000); // now at 30s
    });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('still debounces a real status change (surfaceAgentStatus) at 300ms', () => {
    mount();
    push.mockClear();
    act(() => {
      useStore.setState((s) => {
        s.surfaceAgentStatus = { 'pty-x': 'awaiting_input' };
      });
    });
    expect(push).not.toHaveBeenCalled(); // trailing, not leading
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(push).toHaveBeenCalledTimes(1);
  });
});
