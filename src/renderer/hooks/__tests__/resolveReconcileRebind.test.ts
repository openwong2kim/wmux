import { describe, it, expect } from 'vitest';
import { resolveReconcileRebind, buildLiveBySurface, type LiveSessionInfo } from '../resolveReconcileRebind';

const cand = (paneId: string, surfaceId: string, ptyId: string) => ({ paneId, surfaceId, ptyId });
const live = (id: string, surfaceId?: string, createdAt?: string): LiveSessionInfo => ({ id, surfaceId, createdAt });

describe('resolveReconcileRebind (axis B-lite: clear-vs-rebind policy)', () => {
  it('rebinds a dead ptyId to a live session on the SAME surfaceId', () => {
    const actions = resolveReconcileRebind(
      [cand('p1', 's1', 'dead-1')],
      new Set(['dead-1']),
      [live('live-1', 's1')],
    );
    expect(actions).toEqual([
      { paneId: 'p1', surfaceId: 's1', newPtyId: 'live-1', kind: 'rebind', stalePtyId: 'dead-1' },
    ]);
  });

  it('clears a dead ptyId when no live session shares its surfaceId', () => {
    const actions = resolveReconcileRebind(
      [cand('p1', 's1', 'dead-1')],
      new Set(['dead-1']),
      [live('live-x' /* no surfaceId: empty-pane-origin session */)],
    );
    expect(actions).toEqual([
      { paneId: 'p1', surfaceId: 's1', newPtyId: '', kind: 'clear', stalePtyId: 'dead-1' },
    ]);
  });

  // REGRESSION CRITICAL (plan §4): reconcile must NEVER swap a ptyId that is only
  // absent from ONE snapshot (still possibly live). Only 2-strike-confirmed-dead
  // ptyIds (in toClear) may be acted on — everything else is left in place.
  it('never touches a ptyId absent from toClear — even with a surface match', () => {
    const actions = resolveReconcileRebind(
      [cand('p1', 's1', 'maybe-live')],
      new Set<string>(), // not confirmed dead
      [live('live-1', 's1')], // a live session shares the surface, but...
    );
    expect(actions).toEqual([]); // ...no action: the ptyId stays put
  });

  // Review hardening (codex + testing + adversarial): duplicate claimants on one
  // surfaceId pick the NEWEST createdAt — the binding the user last saw — not
  // whatever Map insertion order (oldest) happened to yield.
  it('duplicate live surfaceId: newest createdAt wins deterministically', () => {
    const actions = resolveReconcileRebind(
      [cand('p1', 's1', 'dead-1')],
      new Set(['dead-1']),
      [
        live('orphan-old', 's1', '2026-06-15T00:00:00.000Z'),
        live('fresh-new', 's1', '2026-07-01T13:49:00.000Z'),
      ],
    );
    expect(actions[0]).toMatchObject({ kind: 'rebind', newPtyId: 'fresh-new' });
  });

  it('duplicate with missing createdAt: a parseable date beats an unparseable one', () => {
    const map = buildLiveBySurface([
      live('no-date', 's1'),
      live('dated', 's1', '2026-07-01T00:00:00.000Z'),
    ]);
    expect(map.get('s1')).toBe('dated');
  });

  // Review hardening (testing specialist): one live pty may satisfy at most ONE
  // candidate — a second dead candidate on the same surfaceId must fall back to
  // clear, never double-bind one daemon session onto two surfaces.
  it('two dead candidates on the same surfaceId do not double-bind one live pty', () => {
    const actions = resolveReconcileRebind(
      [cand('p1', 's1', 'dead-1'), cand('p2', 's1', 'dead-2')],
      new Set(['dead-1', 'dead-2']),
      [live('live-1', 's1')],
    );
    expect(actions).toEqual([
      { paneId: 'p1', surfaceId: 's1', newPtyId: 'live-1', kind: 'rebind', stalePtyId: 'dead-1' },
      { paneId: 'p2', surfaceId: 's1', newPtyId: '', kind: 'clear', stalePtyId: 'dead-2' },
    ]);
  });

  it('mixes rebind + clear and skips non-dead candidates in one pass', () => {
    const actions = resolveReconcileRebind(
      [
        cand('p1', 's1', 'dead-1'),     // → rebind (surface match)
        cand('p2', 's2', 'dead-2'),     // → clear (no match)
        cand('p3', 's3', 'still-live'), // → untouched (not in toClear)
      ],
      new Set(['dead-1', 'dead-2']),
      [live('live-1', 's1')],
    );
    expect(actions).toEqual([
      { paneId: 'p1', surfaceId: 's1', newPtyId: 'live-1', kind: 'rebind', stalePtyId: 'dead-1' },
      { paneId: 'p2', surfaceId: 's2', newPtyId: '', kind: 'clear', stalePtyId: 'dead-2' },
    ]);
  });

  it('returns [] for no candidates', () => {
    expect(resolveReconcileRebind([], new Set(), [])).toEqual([]);
  });
});
