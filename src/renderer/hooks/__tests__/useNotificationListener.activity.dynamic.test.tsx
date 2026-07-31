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
import { selectWorkspaceAgentRoster } from '../../stores/selectors/workspaceAgentRoster';

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
      // J3 §3 — 새 구독. 나머지 알림 구독과 동일하게 no-op unsub를 반환한다.
      onInitialCmdExhausted: sub(),
      // Renderer-readiness ping (codex review catch) + renderer-decided OS
      // toast relay — both fire unconditionally on mount / dispatch, so the
      // stub must exist even though this file doesn't assert on them.
      listenerReady: vi.fn(),
      showOsToast: vi.fn(),
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

  // Byte-based per-PTY 'running' (daemon ActivityMonitor) has no activity
  // string; it must stamp the running freshness clock (surfaceActivityAt) so a
  // background dot lights — this replaced the per-tool PostToolUse hook. The
  // attention-only surfaceAgentStatus map still drops 'running'.
  it('stamps surfaceActivityAt from a byte-based agentStatus=running (no string)', () => {
    seedActivePaneSurface('pty-1');
    act(() => { metaCb!({ ptyId: 'pty-1', agentStatus: 'running' }); });
    expect(useStore.getState().surfaceActivityAt['pty-1']).toBeGreaterThan(0);
    // running is not an attention status → not retained in the status map.
    expect(useStore.getState().surfaceAgentStatus['pty-1']).toBeUndefined();
    // and no phantom activity string was written.
    expect(useStore.getState().surfaceActivity['pty-1']).toBeUndefined();
  });

  it('does NOT stamp surfaceActivityAt for a non-running agentStatus', () => {
    // Fresh ptyId — surfaceActivityAt is not reset between tests in this suite.
    seedActivePaneSurface('pty-nr');
    act(() => { metaCb!({ ptyId: 'pty-nr', agentStatus: 'awaiting_input' }); });
    expect(useStore.getState().surfaceActivityAt['pty-nr']).toBeUndefined();
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

  // A non-empty activity-only hook is ordered proof that the agent resumed AFTER
  // any older complete/waiting state. Only this listener knows the event order:
  // a selector cannot compare an activity timestamp against an attention state
  // that carries no timestamp. Without this reconciliation a roster row shows a
  // stale `complete`/`Needs input` while the agent is visibly producing output.
  describe('activity-only lifecycle reconciliation', () => {
    it('clears a stale attention state and marks the pane running', () => {
      seedActivePaneSurface('pty-rec');
      // Activity only ever flows for a pane whose agent was already detected —
      // setSurfaceAgent(ptyId, undefined, status) updates an existing entry and
      // deliberately cannot mint an agent row without a name.
      act(() => { useStore.getState().setSurfaceAgent('pty-rec', 'Claude Code', 'complete'); });
      act(() => { metaCb!({ ptyId: 'pty-rec', agentStatus: 'complete' }); });
      expect(useStore.getState().surfaceAgentStatus['pty-rec']).toBe('complete');

      act(() => { metaCb!({ ptyId: 'pty-rec', activity: '✎ resumed.ts' }); });

      // surfaceAgentStatus is the ATTENTION-only map: 'running' is not an
      // attention status, so reconciling to running CLEARS the stale 'complete'
      // rather than storing a value. The lifecycle mirror carries the running.
      expect(useStore.getState().surfaceAgentStatus['pty-rec']).toBeUndefined();
      expect(useStore.getState().surfaceAgent['pty-rec']?.status).toBe('running');
      expect(useStore.getState().surfaceAgent['pty-rec']?.name).toBe('Claude Code');
      expect(useStore.getState().surfaceActivity['pty-rec']).toBe('✎ resumed.ts');
    });

    it('the roster row therefore reads running, not a stale Complete', () => {
      // The user-visible point of the reconciliation.
      seedActivePaneSurface('pty-rec4');
      act(() => {
        useStore.getState().setSurfaceAgent('pty-rec4', 'Claude Code', 'running');
      });
      act(() => { metaCb!({ ptyId: 'pty-rec4', agentStatus: 'complete' }); });
      const wsId = useStore.getState().activeWorkspaceId;
      expect(selectWorkspaceAgentRoster(useStore.getState(), wsId)
        .rows.find((r) => r.ptyId === 'pty-rec4')!.status).toBe('complete');

      act(() => { metaCb!({ ptyId: 'pty-rec4', activity: '✎ resumed.ts' }); });

      const row = selectWorkspaceAgentRoster(useStore.getState(), wsId)
        .rows.find((r) => r.ptyId === 'pty-rec4')!;
      expect(row.status).toBe('running');
      expect(row.needsAttention).toBe(false);
      expect(row.activity).toBe('✎ resumed.ts');
    });

    it('an EMPTY activity string does not reopen running (it only clears)', () => {
      seedActivePaneSurface('pty-rec2');
      act(() => { metaCb!({ ptyId: 'pty-rec2', agentStatus: 'awaiting_input' }); });
      act(() => { metaCb!({ ptyId: 'pty-rec2', activity: '' }); });
      // The pane is still blocked; a cleared activity line is not progress.
      expect(useStore.getState().surfaceAgentStatus['pty-rec2']).toBe('awaiting_input');
    });

    it('an explicit state on the SAME payload stays authoritative', () => {
      // The additive activity field must never overwrite a state the payload
      // itself declares — that state is the newer, stronger evidence.
      seedActivePaneSurface('pty-rec3');
      act(() => { metaCb!({ ptyId: 'pty-rec3', activity: '✎ x.ts', agentStatus: 'awaiting_input' }); });
      expect(useStore.getState().surfaceAgentStatus['pty-rec3']).toBe('awaiting_input');
    });
  });
});
