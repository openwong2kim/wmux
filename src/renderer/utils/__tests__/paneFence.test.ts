// A person's pane in the worker fence, renderer side: the tab's switch in the
// store, the workspace profile that seeds new tabs, the create flag, the
// keybinding route and the chip's state.
import { describe, it, expect } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createSurfaceSlice, type SurfaceSlice } from '../../stores/slices/surfaceSlice';
import { createWorkspace, type Workspace } from '../../../shared/types';
import { normalizeWorkspaceProfile } from '../../../shared/workspaceProfile';
import { withWorkspaceProfile, type PtyCreateOptions } from '../ptyCreateOptions';
import { keybindingGoesThroughFence } from '../paneFence';
import { paneFenceChipState } from '../../components/Pane/PaneFenceChip';

type TestState = SurfaceSlice & { workspaces: Workspace[]; activeWorkspaceId: string; paneGate: 'pending' | 'ready' };

function store(fenceAgents: boolean) {
  const ws = createWorkspace('W1', 1);
  if (fenceAgents) ws.profile = { fenceAgents: true };
  return create<TestState>()(
    immer((...a) => ({
      ...(createSurfaceSlice as unknown as (...args: unknown[]) => SurfaceSlice)(...a),
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      paneGate: 'pending' as const,
    })),
  );
}
const firstSurface = (s: ReturnType<typeof store>) => {
  const pane = s.getState().workspaces[0].rootPane;
  return pane.type === 'leaf' ? pane.surfaces[0] : undefined;
};

describe('the tab\'s worker fence switch', () => {
  it('is off for a new tab unless the workspace profile turns it on', () => {
    const off = store(false);
    off.getState().addSurface(off.getState().workspaces[0].rootPane.id, 'pty-1', 'zsh', '/w');
    expect(firstSurface(off)?.workerFence).toBeUndefined();
    const on = store(true);
    on.getState().addSurface(on.getState().workspaces[0].rootPane.id, 'pty-1', 'zsh', '/w');
    expect(firstSurface(on)?.workerFence).toBe(true);
  });

  it('a sign-in tab says off, whatever the profile', () => {
    const on = store(true);
    on.getState().addSurface(on.getState().workspaces[0].rootPane.id, 'pty-1', 'zsh', '/w', undefined, { workerFence: false });
    expect(firstSurface(on)?.workerFence).toBeUndefined();
  });

  it('turns on and off for a terminal tab', () => {
    const s = store(false);
    s.getState().addSurface(s.getState().workspaces[0].rootPane.id, 'pty-1', 'zsh', '/w');
    const id = firstSurface(s)!.id;
    s.getState().setSurfaceWorkerFence(id, true);
    expect(firstSurface(s)?.workerFence).toBe(true);
    s.getState().setSurfaceWorkerFence(id, false);
    expect('workerFence' in firstSurface(s)!).toBe(false);
  });
});

describe('the workspace profile\'s fenceAgents', () => {
  it('keeps only a literal true', () => {
    expect(normalizeWorkspaceProfile({ fenceAgents: true })).toEqual({ fenceAgents: true });
    expect(normalizeWorkspaceProfile({ fenceAgents: 'true' })).toBeUndefined();
    expect(normalizeWorkspaceProfile({ fenceAgents: false })).toBeUndefined();
  });

  it('puts the flag on a create, unless the create names its own', () => {
    const plain: PtyCreateOptions = { workspaceId: 'w' };
    expect(withWorkspaceProfile(plain, { fenceAgents: true }).workerFence).toBe(true);
    expect(withWorkspaceProfile({ workspaceId: 'w', workerFence: false }, { fenceAgents: true }).workerFence).toBe(false);
    // A create without it stays as it was.
    expect('workerFence' in withWorkspaceProfile({ workspaceId: 'w' }, { startupCwd: '/w' })).toBe(false);
  });
});

describe('the keybinding route', () => {
  it('goes through main only in an opted-in tab, for one line', () => {
    expect(keybindingGoesThroughFence({ workerFence: true }, 'claude --dangerously-skip-permissions')).toBe(true);
    expect(keybindingGoesThroughFence({}, 'claude --dangerously-skip-permissions')).toBe(false);
    expect(keybindingGoesThroughFence({ workerFence: true }, 'a\nb')).toBe(false);
  });
});

describe('the chip', () => {
  it('shows the refusal first, then a pending change, then the switch', () => {
    expect(paneFenceChipState(false, undefined)).toEqual({ kind: 'none' });
    expect(paneFenceChipState(true, undefined)).toEqual({ kind: 'on' });
    expect(paneFenceChipState(false, { kind: 'pending' })).toEqual({ kind: 'pending', on: false });
    expect(paneFenceChipState(true, { kind: 'refused', reason: 'x' })).toEqual({ kind: 'refused', reason: 'x' });
  });
});
