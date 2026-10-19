/**
 * T7 — useNotificationPolicy.test.ts
 *
 * Pure unit tests for `decideNotificationActions`. Vitest's default `node`
 * environment is sufficient — no DOM, no zustand, no IPC mocks. Every gate
 * combination is pinned here so the listener integration tests (T8) can
 * trust the policy and focus on dispatch + throttle plumbing.
 */

import { describe, it, expect } from 'vitest';
import {
  decideNotificationActions,
  type NotifPayload,
  type PolicyContext,
} from '../useNotificationPolicy';

const samplePayload: NotifPayload = {
  type: 'info',
  title: 'sample title',
  body: 'sample body',
};
const sampleTarget = { workspaceId: 'ws-1', surfaceId: 'sf-1' };

/**
 * Default "all toggles on, window focused, inactive pane, not muted, pane
 * id resolved" context. Each test below overrides only the fields it cares
 * about — keeps the cases readable without obscuring which knob is being
 * tested.
 */
function baseCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  const defaults: PolicyContext = {
    windowFocused: true,
    isActiveSurface: false,
    isMutedWorkspace: false,
    mutedCategories: [],
    paneId: 'pane-1',
    settings: {
      toastEnabled: true,
      notificationSoundEnabled: true,
      notificationSoundChoice: 'default',
      paneRingEnabled: true,
      paneFlashEnabled: true,
      taskbarFlashEnabled: true,
    },
  };
  return {
    ...defaults,
    ...overrides,
    settings: { ...defaults.settings, ...(overrides.settings ?? {}) },
  };
}

describe('decideNotificationActions', () => {
  // C1 — "watched" now means active surface AND OS-focused window (the
  // baseCtx default). An active surface alone no longer suppresses (see N1).
  it('returns [] when the target IS the active surface and the window is focused', () => {
    const result = decideNotificationActions(samplePayload, sampleTarget, baseCtx({ isActiveSurface: true }));
    expect(result).toEqual([]);
  });

  // N1 — the chronic false-negative fix: an active surface in an UNFOCUSED
  // window (second monitor / alt-tabbed away) is NOT watched. Full fan-out,
  // including the OS toast.
  it('active surface + unfocused window → full fan-out (not watched)', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ isActiveSurface: true, windowFocused: false }),
    );
    expect(result.map((a) => a.kind)).toEqual([
      'addNotification',
      'pushToast',
      'playSound',
      'setPaneRing',
      'flashFrame',
      'osToast',
    ]);
  });

  // C2
  it('returns only addNotification when the workspace is muted (toggles ignored)', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ isMutedWorkspace: true }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('addNotification');
  });

  // Per-pane mute: same "recorded, surfaces silent" contract as a muted
  // workspace, including the unfocused-window OS toast; watched still wins.
  it('returns only addNotification when the originating pane is muted', () => {
    for (const windowFocused of [true, false]) {
      const result = decideNotificationActions(
        samplePayload,
        sampleTarget,
        baseCtx({ isMutedPane: true, windowFocused }),
      );
      expect(result.map((a) => a.kind)).toEqual(['addNotification']);
    }
    expect(
      decideNotificationActions(samplePayload, sampleTarget, baseCtx({ isMutedPane: true, isActiveSurface: true })),
    ).toEqual([]);
  });

  // C3
  it('happy path: focused window + inactive pane + all toggles on → add + toast + sound + ring(flash), NO flashFrame', () => {
    const result = decideNotificationActions(samplePayload, sampleTarget, baseCtx());
    expect(result.map((a) => a.kind)).toEqual([
      'addNotification',
      'pushToast',
      'playSound',
      'setPaneRing',
    ]);
    const ring = result.find((a) => a.kind === 'setPaneRing');
    if (ring && ring.kind === 'setPaneRing') {
      expect(ring.ring).toBe('flash');
      expect(ring.paneId).toBe('pane-1');
    }
  });

  // C4 — unfocused adds the two out-of-app surfaces: taskbar flash AND the
  // native OS toast (renderer-decided; previously main fired it blindly and
  // hook-sourced completions never got one at all).
  it('unfocused window with everything else equal → add + toast + sound + ring + flashFrame + osToast', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ windowFocused: false }),
    );
    expect(result.map((a) => a.kind)).toEqual([
      'addNotification',
      'pushToast',
      'playSound',
      'setPaneRing',
      'flashFrame',
      'osToast',
    ]);
  });

  // N2 — the OS toast never fires while the window is focused: in-app
  // surfaces already reach the user; a banner would double-announce.
  it('focused window never emits osToast', () => {
    const result = decideNotificationActions(samplePayload, sampleTarget, baseCtx());
    expect(result.some((a) => a.kind === 'osToast')).toBe(false);
  });

  // N3 — osToast shares the toastEnabled gate (that setting has always
  // driven main's ToastManager.enabled over IPC, so one toggle governs
  // both toast surfaces).
  it('toastEnabled=false suppresses osToast too (unfocused)', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({
        windowFocused: false,
        settings: { toastEnabled: false } as PolicyContext['settings'],
      }),
    );
    expect(result.some((a) => a.kind === 'osToast')).toBe(false);
    expect(result.some((a) => a.kind === 'pushToast')).toBe(false);
  });

  // N4 — mute silences the OS toast like every other surface (previously
  // main's direct toast path ignored the workspace mute entirely).
  it('muted workspace suppresses osToast even when unfocused', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ isMutedWorkspace: true, windowFocused: false }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('addNotification');
  });

  // C5
  it('toastEnabled=false suppresses pushToast', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ settings: { toastEnabled: false } as PolicyContext['settings'] }),
    );
    expect(result.some((a) => a.kind === 'pushToast')).toBe(false);
    expect(result[0].kind).toBe('addNotification');
  });

  // C6
  it('notificationSoundEnabled=false suppresses playSound', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ settings: { notificationSoundEnabled: false } as PolicyContext['settings'] }),
    );
    expect(result.some((a) => a.kind === 'playSound')).toBe(false);
  });

  // C7
  it('notificationSoundChoice="none" suppresses playSound even when the boolean is on', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({
        settings: {
          notificationSoundEnabled: true,
          notificationSoundChoice: 'none',
        } as PolicyContext['settings'],
      }),
    );
    expect(result.some((a) => a.kind === 'playSound')).toBe(false);
  });

  // C8
  it('paneRingEnabled=false suppresses setPaneRing', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ settings: { paneRingEnabled: false } as PolicyContext['settings'] }),
    );
    expect(result.some((a) => a.kind === 'setPaneRing')).toBe(false);
  });

  // C9
  it('paneFlashEnabled=false (ring on) emits setPaneRing with ring="glow"', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ settings: { paneFlashEnabled: false } as PolicyContext['settings'] }),
    );
    const ring = result.find((a) => a.kind === 'setPaneRing');
    expect(ring).toBeDefined();
    if (ring && ring.kind === 'setPaneRing') {
      expect(ring.ring).toBe('glow');
    }
  });

  // C10
  it('taskbarFlashEnabled=false suppresses flashFrame even when window is unfocused', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({
        windowFocused: false,
        settings: { taskbarFlashEnabled: false } as PolicyContext['settings'],
      }),
    );
    expect(result.some((a) => a.kind === 'flashFrame')).toBe(false);
  });

  // C11
  it('paneId=null suppresses setPaneRing regardless of toggles', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ paneId: null }),
    );
    expect(result.some((a) => a.kind === 'setPaneRing')).toBe(false);
    // Everything else still fires.
    expect(result.map((a) => a.kind)).toEqual(['addNotification', 'pushToast', 'playSound']);
  });

  // C12
  it('addNotification is always first in the returned action list', () => {
    // Three diverse cases — happy path, ring-only, sound-only.
    const cases: PolicyContext[] = [
      baseCtx(),
      baseCtx({ settings: { toastEnabled: false, notificationSoundEnabled: false, taskbarFlashEnabled: false } as PolicyContext['settings'] }),
      baseCtx({
        windowFocused: false,
        settings: { paneRingEnabled: false } as PolicyContext['settings'],
      }),
    ];
    for (const ctx of cases) {
      const result = decideNotificationActions(samplePayload, sampleTarget, ctx);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].kind).toBe('addNotification');
    }
  });

  // C13
  it('watched-surface skip takes precedence over mute (still returns [] when both are true)', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ isActiveSurface: true, isMutedWorkspace: true }),
    );
    expect(result).toEqual([]);
  });

  // Extra — orderedness sanity for the full unfocused case.
  it('full unfocused happy path preserves a stable action order', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ windowFocused: false }),
    );
    expect(result.map((a) => a.kind)).toEqual([
      'addNotification',
      'pushToast',
      'playSound',
      'setPaneRing',
      'flashFrame',
      'osToast',
    ]);
  });

  // Extra — addNotification carries the target IDs verbatim.
  it('addNotification action carries workspaceId and surfaceId from the target', () => {
    const result = decideNotificationActions(samplePayload, sampleTarget, baseCtx());
    const add = result.find((a) => a.kind === 'addNotification');
    expect(add).toBeDefined();
    if (add && add.kind === 'addNotification') {
      expect(add.workspaceId).toBe('ws-1');
      expect(add.surfaceId).toBe('sf-1');
      expect(add.payload).toEqual(samplePayload);
    }
  });

  // #516 — per-category mute. Same "data preserved, surfaces silent" contract
  // as a muted workspace, keyed on the event kind.
  it('a muted category suppresses every surface but still records the notification', () => {
    const result = decideNotificationActions(
      { ...samplePayload, type: 'agent', category: 'subagent' },
      sampleTarget,
      baseCtx({ windowFocused: false, mutedCategories: ['subagent'] }),
    );
    expect(result.map((a) => a.kind)).toEqual(['addNotification']);
  });

  it('muting one category leaves the others loud', () => {
    const result = decideNotificationActions(
      { ...samplePayload, type: 'agent', category: 'approval' },
      sampleTarget,
      baseCtx({ mutedCategories: ['subagent'] }),
    );
    expect(result.some((a) => a.kind === 'pushToast')).toBe(true);
  });

  it('an uncategorized notification is never suppressed by a category mute', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ mutedCategories: ['subagent', 'agent-turn', 'approval', 'terminal', 'system'] }),
    );
    expect(result.some((a) => a.kind === 'pushToast')).toBe(true);
  });
});
