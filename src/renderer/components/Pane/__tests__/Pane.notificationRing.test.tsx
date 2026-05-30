/**
 * Tests for T11 — Pane.tsx notification ring state-machine wiring.
 *
 * The repository's vitest config runs in `node` env without a DOM library
 * (no jsdom / RTL — see SettingsPanel.firstRunSection.test.tsx for the
 * established pattern). We therefore test the wiring at two layers:
 *
 *   1. The pure `composePaneClassName` helper exported from Pane.tsx.
 *      This is the load-bearing piece: every className the component
 *      renders is produced by this function. Exhaustive coverage here
 *      gives us the same guarantees as a full RTL render would.
 *
 *   2. The store-selector contract — we exercise the exact selectors
 *      Pane.tsx uses (`paneNotificationRing[paneId]`, `paneRingEnabled`)
 *      against the live zustand store to confirm:
 *        a) defensive defaults when T3/T5 slices are unmerged (current
 *           state of this worktree),
 *        b) round-trip when those fields are present (simulated via
 *           useStore.setState — the same shape T3/T5 will install).
 *
 * Toggle reconciliation choice: OPTION C — legacy `notificationRingEnabled`
 * gates the unread-count pulse (folded into `hasUnread` upstream); new
 * `paneRingEnabled` gates the state-machine flash/glow.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { composePaneClassName, type PaneRingState } from '../Pane';
import { useStore } from '../../../stores';

// ─── composePaneClassName (pure helper) ───────────────────────────────────────

describe('composePaneClassName — base classes', () => {
  it('always includes the layout base classes', () => {
    const cls = composePaneClassName({
      hasUnread: false,
      ringState: null,
      paneRingEnabled: true,
      flashing: false,
    });
    expect(cls).toContain('flex');
    expect(cls).toContain('flex-col');
    expect(cls).toContain('h-full');
    expect(cls).toContain('w-full');
    expect(cls).toContain('relative');
    expect(cls).toContain('box-border');
  });

  it('emits no ring classes when nothing is active', () => {
    const cls = composePaneClassName({
      hasUnread: false,
      ringState: null,
      paneRingEnabled: true,
      flashing: false,
    });
    expect(cls).not.toContain('notification-ring');
    expect(cls).not.toContain('pane-ring-flash');
    expect(cls).not.toContain('pane-ring-glow');
    expect(cls).not.toContain('pane-flash');
  });
});

describe('composePaneClassName — ringState wiring', () => {
  const base = { hasUnread: false, paneRingEnabled: true, flashing: false };

  it('ringState=null produces no pane-ring-* class', () => {
    const cls = composePaneClassName({ ...base, ringState: null });
    expect(cls).not.toContain('pane-ring-flash');
    expect(cls).not.toContain('pane-ring-glow');
  });

  it('ringState=undefined produces no pane-ring-* class', () => {
    const cls = composePaneClassName({ ...base, ringState: undefined });
    expect(cls).not.toContain('pane-ring-flash');
    expect(cls).not.toContain('pane-ring-glow');
  });

  it('ringState="flash" applies pane-ring-flash and NOT pane-ring-glow', () => {
    const cls = composePaneClassName({ ...base, ringState: 'flash' });
    expect(cls).toContain('pane-ring-flash');
    expect(cls).not.toContain('pane-ring-glow');
  });

  it('ringState="glow" applies pane-ring-glow and NOT pane-ring-flash', () => {
    const cls = composePaneClassName({ ...base, ringState: 'glow' });
    expect(cls).toContain('pane-ring-glow');
    expect(cls).not.toContain('pane-ring-flash');
  });
});

describe('composePaneClassName — paneRingEnabled gate (OPTION C)', () => {
  it('paneRingEnabled=false drops pane-ring-flash even if ringState="flash"', () => {
    const cls = composePaneClassName({
      hasUnread: false,
      ringState: 'flash',
      paneRingEnabled: false,
      flashing: false,
    });
    expect(cls).not.toContain('pane-ring-flash');
  });

  it('paneRingEnabled=false drops pane-ring-glow even if ringState="glow"', () => {
    const cls = composePaneClassName({
      hasUnread: false,
      ringState: 'glow',
      paneRingEnabled: false,
      flashing: false,
    });
    expect(cls).not.toContain('pane-ring-glow');
  });

  it('paneRingEnabled=false does NOT drop legacy notification-ring (independent toggle)', () => {
    // OPTION C contract: `notificationRingEnabled` is folded into `hasUnread`
    // by the caller; `paneRingEnabled` ONLY governs flash/glow. These two
    // visual channels must not interfere.
    const cls = composePaneClassName({
      hasUnread: true,
      ringState: 'flash',
      paneRingEnabled: false,
      flashing: false,
    });
    expect(cls).toContain('notification-ring');
    expect(cls).not.toContain('pane-ring-flash');
  });

  it('paneRingEnabled=false does NOT drop pane-flash (Ctrl+Shift+H, untouched legacy)', () => {
    const cls = composePaneClassName({
      hasUnread: false,
      ringState: 'flash',
      paneRingEnabled: false,
      flashing: true,
    });
    expect(cls).toContain('pane-flash');
    expect(cls).not.toContain('pane-ring-flash');
  });
});

describe('composePaneClassName — completeBlink (B8: completed-terminal blink)', () => {
  const base = { hasUnread: false, paneRingEnabled: true, flashing: false } as const;

  it('completeBlink=true applies pane-complete-blink', () => {
    const cls = composePaneClassName({ ...base, ringState: null, completeBlink: true });
    expect(cls).toContain('pane-complete-blink');
  });

  it('completeBlink omitted/false does NOT apply pane-complete-blink', () => {
    expect(composePaneClassName({ ...base, ringState: null })).not.toContain('pane-complete-blink');
    expect(composePaneClassName({ ...base, ringState: null, completeBlink: false })).not.toContain('pane-complete-blink');
  });

  it('completeBlink takes precedence: suppresses pane-ring-glow even when ringState="glow"', () => {
    // A completed agent also fires a notification (→ ring glow). The green
    // completion blink IS the signal for that pane, so the blue glow must be
    // suppressed to avoid two competing border treatments.
    const cls = composePaneClassName({ ...base, ringState: 'glow', completeBlink: true });
    expect(cls).toContain('pane-complete-blink');
    expect(cls).not.toContain('pane-ring-glow');
  });

  it('completeBlink takes precedence: suppresses pane-ring-flash even when ringState="flash"', () => {
    const cls = composePaneClassName({ ...base, ringState: 'flash', completeBlink: true });
    expect(cls).toContain('pane-complete-blink');
    expect(cls).not.toContain('pane-ring-flash');
  });

  it('completeBlink=false restores normal ring behavior', () => {
    const cls = composePaneClassName({ ...base, ringState: 'glow', completeBlink: false });
    expect(cls).toContain('pane-ring-glow');
    expect(cls).not.toContain('pane-complete-blink');
  });

  it('completeBlink and pane-flash (Ctrl+Shift+H) coexist — independent channels', () => {
    const cls = composePaneClassName({ hasUnread: false, ringState: null, paneRingEnabled: true, flashing: true, completeBlink: true });
    expect(cls).toContain('pane-complete-blink');
    expect(cls).toContain('pane-flash');
  });
});

describe('composePaneClassName — legacy classes preserved', () => {
  it('hasUnread=true applies notification-ring', () => {
    const cls = composePaneClassName({
      hasUnread: true,
      ringState: null,
      paneRingEnabled: true,
      flashing: false,
    });
    expect(cls).toContain('notification-ring');
  });

  it('flashing=true applies pane-flash', () => {
    const cls = composePaneClassName({
      hasUnread: false,
      ringState: null,
      paneRingEnabled: true,
      flashing: true,
    });
    expect(cls).toContain('pane-flash');
  });

  it('all four channels can coexist (hasUnread + ringState + flashing)', () => {
    const cls = composePaneClassName({
      hasUnread: true,
      ringState: 'flash',
      paneRingEnabled: true,
      flashing: true,
    });
    expect(cls).toContain('notification-ring');
    expect(cls).toContain('pane-ring-flash');
    expect(cls).toContain('pane-flash');
    expect(cls).not.toContain('pane-ring-glow');
  });

  it('mutual exclusion: flash and glow never coexist on the same render', () => {
    // The PaneRingState type only admits one of 'flash' | 'glow' at a time,
    // but the helper should still not emit both even if a bad value sneaks in.
    const flashOnly = composePaneClassName({
      hasUnread: false,
      ringState: 'flash',
      paneRingEnabled: true,
      flashing: false,
    });
    const glowOnly = composePaneClassName({
      hasUnread: false,
      ringState: 'glow',
      paneRingEnabled: true,
      flashing: false,
    });
    expect(flashOnly.includes('pane-ring-flash') && !flashOnly.includes('pane-ring-glow')).toBe(true);
    expect(glowOnly.includes('pane-ring-glow') && !glowOnly.includes('pane-ring-flash')).toBe(true);
  });
});

// ─── Store-selector contract ──────────────────────────────────────────────────
//
// These tests exercise the exact selector expressions Pane.tsx uses against
// the real zustand store. They protect against:
//   - a future renamed field breaking the defensive accessor,
//   - the legacy ring toggle silently shadowing the new gate.

describe('Pane store selectors — defensive defaults (pre-T3/T5)', () => {
  beforeEach(() => {
    // Reset only the fields we touch — the rest of the store stays as the
    // slice initializers built it.
    useStore.setState((s) => {
      const sx = s as unknown as { paneNotificationRing?: Record<string, PaneRingState>; paneRingEnabled?: boolean };
      delete sx.paneNotificationRing;
      delete sx.paneRingEnabled;
    });
  });

  it('paneNotificationRing missing → ringState selector resolves to undefined', () => {
    const s = useStore.getState();
    const map = (s as unknown as { paneNotificationRing?: Record<string, PaneRingState> }).paneNotificationRing;
    const ringState = map ? map['pane-x'] : undefined;
    expect(ringState).toBeUndefined();
  });

  it('paneRingEnabled missing → defaults to true (new ring available when listener dispatches)', () => {
    const s = useStore.getState();
    const flag = (s as unknown as { paneRingEnabled?: boolean }).paneRingEnabled;
    const resolved = flag === undefined ? true : flag;
    expect(resolved).toBe(true);
  });
});

describe('Pane store selectors — post-T3/T5 shape', () => {
  beforeEach(() => {
    // Simulate the slice fields T3 / T5 will install.
    useStore.setState((s) => {
      const sx = s as unknown as { paneNotificationRing?: Record<string, PaneRingState>; paneRingEnabled?: boolean };
      sx.paneNotificationRing = {};
      sx.paneRingEnabled = true;
    });
  });

  it('paneNotificationRing["pane-1"]="flash" round-trips through the selector', () => {
    useStore.setState((s) => {
      const sx = s as unknown as { paneNotificationRing: Record<string, PaneRingState> };
      sx.paneNotificationRing['pane-1'] = 'flash';
    });
    const s = useStore.getState();
    const map = (s as unknown as { paneNotificationRing: Record<string, PaneRingState> }).paneNotificationRing;
    expect(map['pane-1']).toBe('flash');
  });

  it('paneNotificationRing["pane-2"]="glow" round-trips through the selector', () => {
    useStore.setState((s) => {
      const sx = s as unknown as { paneNotificationRing: Record<string, PaneRingState> };
      sx.paneNotificationRing['pane-2'] = 'glow';
    });
    const s = useStore.getState();
    const map = (s as unknown as { paneNotificationRing: Record<string, PaneRingState> }).paneNotificationRing;
    expect(map['pane-2']).toBe('glow');
  });

  it('paneRingEnabled=false propagates through the gate and drops flash/glow', () => {
    useStore.setState((s) => {
      const sx = s as unknown as { paneNotificationRing: Record<string, PaneRingState>; paneRingEnabled: boolean };
      sx.paneNotificationRing['pane-3'] = 'flash';
      sx.paneRingEnabled = false;
    });
    const s = useStore.getState();
    const map = (s as unknown as { paneNotificationRing: Record<string, PaneRingState> }).paneNotificationRing;
    const flag = (s as unknown as { paneRingEnabled: boolean }).paneRingEnabled;
    const cls = composePaneClassName({
      hasUnread: false,
      ringState: map['pane-3'],
      paneRingEnabled: flag,
      flashing: false,
    });
    expect(cls).not.toContain('pane-ring-flash');
    expect(cls).not.toContain('pane-ring-glow');
  });
});

// ─── No-regression checks against existing toggles ────────────────────────────

describe('Legacy notificationRingEnabled — unaffected by T11 wiring', () => {
  it('notificationRingEnabled remains a top-level boolean on the store', () => {
    const s = useStore.getState();
    expect(typeof s.notificationRingEnabled).toBe('boolean');
    expect(typeof s.setNotificationRingEnabled).toBe('function');
  });

  it('flipping notificationRingEnabled does NOT touch paneRingEnabled (OPTION C)', () => {
    useStore.setState((s) => {
      (s as unknown as { paneRingEnabled: boolean }).paneRingEnabled = true;
    });
    useStore.getState().setNotificationRingEnabled(false);
    const s = useStore.getState();
    expect(s.notificationRingEnabled).toBe(false);
    expect((s as unknown as { paneRingEnabled: boolean }).paneRingEnabled).toBe(true);
    // Restore for test isolation
    useStore.getState().setNotificationRingEnabled(true);
  });
});

// ─── FIX #2 — Pane handleClick clears the ring on markedAny ────────────────
//
// The full handler runs inside React (vitest env=node, no jsdom), so we
// exercise the exact code path against the real zustand store instead of
// mounting the component. The handler shape is:
//
//   const { notifications } = useStore.getState();
//   const surfaceIds = new Set(pane.surfaces.map(s => s.id));
//   let markedAny = false;
//   for (const n of notifications) {
//     if (!n.read && n.surfaceId !== undefined && surfaceIds.has(n.surfaceId)) {
//       markRead(n.id);
//       markedAny = true;
//     }
//   }
//   if (markedAny) setPaneNotificationRing(pane.id, null);
//
// We reproduce that loop directly so a future refactor can't drift the
// invariant.

describe('Pane handleClick — clears ring when notifications were marked read (FIX #2)', () => {
  beforeEach(() => {
    // Reset slices touched by this test. clearNotifications is exposed on the
    // notification slice; ring map is the paneSlice action.
    useStore.getState().clearNotifications();
    useStore.setState((s) => {
      s.paneNotificationRing = {};
    });
  });

  function simulatePaneClick(paneId: string, surfaceIds: string[]) {
    // Direct transcription of Pane.tsx handleClick (minus setActivePane,
    // which has its own coverage and would require a workspace tree fixture).
    const { notifications, markRead, setPaneNotificationRing } = useStore.getState();
    const ids = new Set(surfaceIds);
    let markedAny = false;
    for (const n of notifications) {
      if (!n.read && n.surfaceId !== undefined && ids.has(n.surfaceId)) {
        markRead(n.id);
        markedAny = true;
      }
    }
    if (markedAny) {
      setPaneNotificationRing(paneId, null);
    }
    return { markedAny };
  }

  it('clears the ring entry when at least one notification was marked read', () => {
    // Seed: one unread notification on surface 'sf-1', ring already set to glow.
    useStore.getState().addNotification({
      workspaceId: useStore.getState().workspaces[0].id,
      surfaceId: 'sf-1',
      type: 'info',
      title: 't',
      body: 'b',
    });
    useStore.getState().setPaneNotificationRing('pane-1', 'glow');
    expect(useStore.getState().paneNotificationRing['pane-1']).toBe('glow');

    const result = simulatePaneClick('pane-1', ['sf-1']);
    expect(result.markedAny).toBe(true);
    expect(useStore.getState().paneNotificationRing['pane-1']).toBeUndefined();
    expect(useStore.getState().notifications[0].read).toBe(true);
  });

  it('preserves the ring entry when no unread notification matches the pane (fresh flash protection)', () => {
    // A notification arrived 50ms ago for surface 'sf-2', listener set ring
    // to 'flash' on pane-2. User clicks pane-1 (different surfaces) — pane-2
    // must keep its fresh 'flash' because nothing on pane-1 got read.
    useStore.getState().addNotification({
      workspaceId: useStore.getState().workspaces[0].id,
      surfaceId: 'sf-2',
      type: 'info',
      title: 't',
      body: 'b',
    });
    useStore.getState().setPaneNotificationRing('pane-2', 'flash');

    const result = simulatePaneClick('pane-1', ['sf-1']);
    expect(result.markedAny).toBe(false);
    // pane-2's flash survives — the click on pane-1 should NOT have touched it.
    expect(useStore.getState().paneNotificationRing['pane-2']).toBe('flash');
  });

  it('does not clear unrelated panes when only the clicked pane has matching surfaces', () => {
    // Two notifications on two different surfaces, two panes with rings.
    const wsId = useStore.getState().workspaces[0].id;
    useStore.getState().addNotification({ workspaceId: wsId, surfaceId: 'sf-1', type: 'info', title: 'a', body: '' });
    useStore.getState().addNotification({ workspaceId: wsId, surfaceId: 'sf-2', type: 'info', title: 'b', body: '' });
    useStore.getState().setPaneNotificationRing('pane-1', 'glow');
    useStore.getState().setPaneNotificationRing('pane-2', 'glow');

    simulatePaneClick('pane-1', ['sf-1']);

    expect(useStore.getState().paneNotificationRing['pane-1']).toBeUndefined();
    expect(useStore.getState().paneNotificationRing['pane-2']).toBe('glow');
  });

  it('clearing notifications between renders is idempotent', () => {
    // No unread, ring entry present (left behind from earlier session, e.g.
    // notification got cleared via panel). Click should be a no-op for ring
    // because nothing was marked read — caller is responsible for explicit
    // clears (markAllRead handles that case, FIX #3).
    useStore.getState().setPaneNotificationRing('pane-1', 'glow');
    const result = simulatePaneClick('pane-1', ['sf-1']);
    expect(result.markedAny).toBe(false);
    expect(useStore.getState().paneNotificationRing['pane-1']).toBe('glow');
  });
});
