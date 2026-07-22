import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createNotificationSlice, type NotificationSlice } from '../notificationSlice';
import type { Workspace, Pane, Notification } from '../../../../shared/types';

// Test store mirrors uiSlice.test.ts pattern: minimal slice + cross-slice
// fields seeded via setState. notificationSlice reads state.workspaces, so we
// expose it on the test type without composing the full workspaceSlice.
type TestState = NotificationSlice & {
  workspaces: Workspace[];
};

function makePane(id = 'pane-1'): Pane {
  return {
    id,
    type: 'leaf',
    surfaces: [],
    activeSurfaceId: '',
  };
}

function makeWorkspace(id: string, name = id): Workspace {
  return {
    id,
    name,
    rootPane: makePane(`${id}-root`),
    activePaneId: `${id}-root`,
  };
}

function createTestStore(workspaces: Workspace[] = []) {
  const store = create<TestState>()(
    immer((...args) => ({
      workspaces,
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createNotificationSlice(...args),
    }))
  );
  return store;
}

// ─── REGRESSION: existing behavior locked down before extension ──────────

describe('NotificationSlice — addNotification (regression)', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore([makeWorkspace('ws-a')]);
  });

  // R1
  it('pushes a notification with generated id, timestamp, and read=false', () => {
    const before = Date.now();
    store.getState().addNotification({
      workspaceId: 'ws-a',
      type: 'info',
      title: 'hello',
      body: 'world',
    });
    const after = Date.now();

    const list = store.getState().notifications;
    expect(list).toHaveLength(1);
    const n = list[0];
    expect(n.id).toMatch(/^notif-/);
    expect(n.read).toBe(false);
    expect(n.timestamp).toBeGreaterThanOrEqual(before);
    expect(n.timestamp).toBeLessThanOrEqual(after);
    expect(n.title).toBe('hello');
    expect(n.body).toBe('world');
    expect(n.type).toBe('info');
    expect(n.workspaceId).toBe('ws-a');
  });

  // R2
  it('sets lastNotification on the matching workspace metadata', () => {
    const before = Date.now();
    store.getState().addNotification({
      workspaceId: 'ws-a',
      type: 'info',
      title: 't',
      body: 'b',
    });
    const ws = store.getState().workspaces.find((w) => w.id === 'ws-a');
    expect(ws?.metadata?.lastNotification).toBeGreaterThanOrEqual(before);
  });

  // R3
  it('is a no-op for workspace lookup when workspaceId is unknown (no throw)', () => {
    expect(() =>
      store.getState().addNotification({
        workspaceId: 'ws-missing',
        type: 'info',
        title: 't',
        body: 'b',
      })
    ).not.toThrow();
    // The notification itself is still appended; only the workspace metadata
    // update is skipped because the workspace doesn't exist.
    expect(store.getState().notifications).toHaveLength(1);
    expect(store.getState().workspaces).toHaveLength(1);
    expect(store.getState().workspaces[0].metadata?.lastNotification).toBeUndefined();
  });
});

describe('NotificationSlice — cap eviction (regression)', () => {
  // R4: cap eviction — push 500 with mix → 501st evicts OLDEST READ entry.
  it('evicts the oldest read entry when capacity exceeds 500', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);

    // Seed 500 unread, then mark entries at index 100 and 200 as read.
    for (let i = 0; i < 500; i++) {
      store.getState().addNotification({
        workspaceId: 'ws-a',
        type: 'info',
        title: `t${i}`,
        body: `b${i}`,
      });
    }
    expect(store.getState().notifications).toHaveLength(500);

    const idAt100 = store.getState().notifications[100].id;
    const idAt200 = store.getState().notifications[200].id;
    store.getState().markRead(idAt100);
    store.getState().markRead(idAt200);

    // Push the 501st — eviction should drop idAt100 (oldest read).
    store.getState().addNotification({
      workspaceId: 'ws-a',
      type: 'info',
      title: 'overflow',
      body: 'evict me',
    });

    const list = store.getState().notifications;
    expect(list).toHaveLength(500);
    expect(list.find((n) => n.id === idAt100)).toBeUndefined();
    // The other read entry survives.
    expect(list.find((n) => n.id === idAt200)).toBeDefined();
  });

  // R5: all unread → 501st falls back to shift() (oldest first).
  it('falls back to shifting the oldest entry when all are unread', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);

    for (let i = 0; i < 500; i++) {
      store.getState().addNotification({
        workspaceId: 'ws-a',
        type: 'info',
        title: `t${i}`,
        body: `b${i}`,
      });
    }
    const oldestId = store.getState().notifications[0].id;
    const secondId = store.getState().notifications[1].id;

    store.getState().addNotification({
      workspaceId: 'ws-a',
      type: 'info',
      title: 'overflow',
      body: 'evict oldest',
    });

    const list = store.getState().notifications;
    expect(list).toHaveLength(500);
    expect(list.find((n) => n.id === oldestId)).toBeUndefined();
    // What was previously the second-oldest is now at index 0.
    expect(list[0].id).toBe(secondId);
  });
});

describe('NotificationSlice — markRead (regression)', () => {
  // R6
  it('flips read=true for the matched id and is a no-op for missing ids', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);
    store.getState().addNotification({
      workspaceId: 'ws-a', type: 'info', title: 'a', body: 'a',
    });
    store.getState().addNotification({
      workspaceId: 'ws-a', type: 'info', title: 'b', body: 'b',
    });
    const [first, second] = store.getState().notifications;

    store.getState().markRead(first.id);
    const after = store.getState().notifications;
    expect(after.find((n) => n.id === first.id)?.read).toBe(true);
    expect(after.find((n) => n.id === second.id)?.read).toBe(false);

    expect(() => store.getState().markRead('notif-does-not-exist')).not.toThrow();
    const final = store.getState().notifications;
    expect(final.find((n) => n.id === first.id)?.read).toBe(true);
    expect(final.find((n) => n.id === second.id)?.read).toBe(false);
  });
});

describe('NotificationSlice — markAllReadForWorkspace (regression)', () => {
  // R7
  it('flips read=true only for notifications matching the given workspaceId', () => {
    const store = createTestStore([makeWorkspace('ws-a'), makeWorkspace('ws-b')]);
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: 'a1', body: '' });
    store.getState().addNotification({ workspaceId: 'ws-b', type: 'info', title: 'b1', body: '' });
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: 'a2', body: '' });

    store.getState().markAllReadForWorkspace('ws-a');

    const list = store.getState().notifications;
    expect(list.filter((n) => n.workspaceId === 'ws-a').every((n) => n.read)).toBe(true);
    expect(list.filter((n) => n.workspaceId === 'ws-b').every((n) => !n.read)).toBe(true);
  });
});

describe('NotificationSlice — clearNotifications (regression)', () => {
  // R8
  it('empties the notifications array', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: 'a', body: '' });
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: 'b', body: '' });
    expect(store.getState().notifications).toHaveLength(2);

    store.getState().clearNotifications();
    expect(store.getState().notifications).toEqual([]);
  });
});

// ─── NEW BEHAVIOR ────────────────────────────────────────────────────────

describe('NotificationSlice — markAllRead (new)', () => {
  // N1
  it('flips read=true on every notification regardless of workspaceId', () => {
    const store = createTestStore([makeWorkspace('ws-a'), makeWorkspace('ws-b')]);
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: 'a', body: '' });
    store.getState().addNotification({ workspaceId: 'ws-b', type: 'info', title: 'b', body: '' });
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'warning', title: 'c', body: '' });

    store.getState().markAllRead();

    expect(store.getState().notifications.every((n) => n.read)).toBe(true);
  });

  // N2
  it('is idempotent on already-read items', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: 'a', body: '' });
    store.getState().markAllRead();
    expect(store.getState().notifications.every((n) => n.read)).toBe(true);

    // Second call must not throw and must leave the state still all-read.
    store.getState().markAllRead();
    expect(store.getState().notifications.every((n) => n.read)).toBe(true);
    expect(store.getState().notifications).toHaveLength(1);
  });

  // N2b (FIX #3) — lifecycle: markAllRead also clears paneNotificationRing.
  // Phase 4 review found that rings stayed in 'glow' forever after user
  // hit "Mark all read" because the slice only flipped notifications.read
  // but left the visual ring state untouched.
  it('clears paneNotificationRing alongside flipping read=true', () => {
    // Seed the ring map by hand — the test store doesn't compose paneSlice,
    // so we install the field directly. The action's `if (state.paneNotificationRing)`
    // guard means we exercise the real branch here.
    const store = createTestStore([makeWorkspace('ws-a')]);
    store.setState((s) => {
      (s as unknown as { paneNotificationRing: Record<string, 'flash' | 'glow'> })
        .paneNotificationRing = { 'pane-1': 'flash', 'pane-2': 'glow' };
    });
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: 'a', body: '' });

    store.getState().markAllRead();

    const ring = (store.getState() as unknown as { paneNotificationRing: Record<string, unknown> })
      .paneNotificationRing;
    expect(ring).toEqual({});
    // Sanity — read flag still flipped.
    expect(store.getState().notifications.every((n) => n.read)).toBe(true);
  });

  // N2c — no-throw when paneNotificationRing field is absent (the minimal
  // test store without paneSlice still works).
  it('is a no-op for the ring map when notificationSlice mounted without paneSlice', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: 'a', body: '' });
    expect(() => store.getState().markAllRead()).not.toThrow();
  });
});

describe('NotificationSlice — jumpToUnread (new)', () => {
  // N3
  it('returns the workspaceId of the most-recent unread notification', () => {
    const store = createTestStore([makeWorkspace('ws-a'), makeWorkspace('ws-b')]);
    // Seed three with explicit timestamps so we control ordering.
    store.setState((s) => {
      s.notifications = [
        { id: 'n1', workspaceId: 'ws-a', type: 'info', title: 'a', body: '', timestamp: 100, read: false },
        { id: 'n2', workspaceId: 'ws-b', type: 'info', title: 'b', body: '', timestamp: 300, read: false },
        { id: 'n3', workspaceId: 'ws-a', type: 'info', title: 'c', body: '', timestamp: 200, read: false },
      ];
    });

    expect(store.getState().jumpToUnread()).toBe('ws-b');
    // Selector must not mutate state.
    expect(store.getState().notifications.every((n) => !n.read)).toBe(true);
  });

  // N4
  it('returns null when no unread notifications exist', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);
    expect(store.getState().jumpToUnread()).toBeNull();

    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: 'a', body: '' });
    store.getState().markAllRead();
    expect(store.getState().jumpToUnread()).toBeNull();
  });

  // N5
  it('skips notifications whose workspace was deleted from state.workspaces', () => {
    // ws-a exists, ws-gone does not. The newer unread points at ws-gone and
    // must be ignored; jumpToUnread should fall back to the ws-a entry.
    const store = createTestStore([makeWorkspace('ws-a')]);
    store.setState((s) => {
      s.notifications = [
        { id: 'n1', workspaceId: 'ws-a', type: 'info', title: 'a', body: '', timestamp: 100, read: false },
        { id: 'n2', workspaceId: 'ws-gone', type: 'info', title: 'g', body: '', timestamp: 500, read: false },
      ];
    });

    expect(store.getState().jumpToUnread()).toBe('ws-a');

    // If every unread entry points at a dead workspace, the selector returns null.
    store.setState((s) => {
      s.notifications = [
        { id: 'n3', workspaceId: 'ws-gone', type: 'info', title: 'g', body: '', timestamp: 500, read: false },
      ];
    });
    expect(store.getState().jumpToUnread()).toBeNull();
  });

  // N6
  it('breaks ties by highest timestamp — most-recent wins', () => {
    const store = createTestStore([makeWorkspace('ws-a'), makeWorkspace('ws-b'), makeWorkspace('ws-c')]);
    store.setState((s) => {
      s.notifications = [
        { id: 'n1', workspaceId: 'ws-a', type: 'info', title: '', body: '', timestamp: 999, read: false },
        { id: 'n2', workspaceId: 'ws-b', type: 'info', title: '', body: '', timestamp: 1000, read: false },
        { id: 'n3', workspaceId: 'ws-c', type: 'info', title: '', body: '', timestamp: 1001, read: false },
        { id: 'n4', workspaceId: 'ws-a', type: 'info', title: '', body: '', timestamp: 998, read: false },
      ];
    });

    expect(store.getState().jumpToUnread()).toBe('ws-c');
  });
});

// ─── TASK-3: unreadBySurfaceId index ─────────────────────────────────────
// The old O(P×N×S) Pane badge selector is replaced by a per-surfaceId unread
// index maintained at all six mutation sites. These tests lock the index down.

describe('NotificationSlice — unreadBySurfaceId index (TASK-3)', () => {
  // Old filter-based count, replicated here as the source of truth for parity.
  function oldUnreadForSurfaces(list: Notification[], surfaceIds: string[]): number {
    return list.filter((n) => !n.read && surfaceIds.includes(n.surfaceId ?? '')).length;
  }

  // U1 — IRON RULE regression: cap-500 eviction of an UNREAD entry decrements.
  it('decrements the evicted surfaceId when the cap-500 shift() drops an unread entry', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);
    // 501 unread notifications, each on a distinct surfaceId.
    for (let i = 0; i < 501; i++) {
      store.getState().addNotification({
        workspaceId: 'ws-a', type: 'info', title: `t${i}`, body: '', surfaceId: `surf-${i}`,
      });
    }
    const list = store.getState().notifications;
    expect(list).toHaveLength(500);
    // surf-0 was the oldest and got shift()ed out (all-unread branch).
    expect(list.find((n) => n.surfaceId === 'surf-0')).toBeUndefined();
    const map = store.getState().unreadBySurfaceId;
    // Its bucket must be gone (decremented to 0 → deleted), not left at 1.
    expect(map['surf-0']).toBeUndefined();
    // A surviving surface still counts 1.
    expect(map['surf-500']).toBe(1);
  });

  // U2 — eviction of a READ entry does NOT decrement any bucket.
  it('does not decrement when the evicted entry is a read entry', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);
    for (let i = 0; i < 500; i++) {
      store.getState().addNotification({
        workspaceId: 'ws-a', type: 'info', title: `t${i}`, body: '', surfaceId: `surf-${i}`,
      });
    }
    // Mark surf-10 read → its bucket disappears, and it becomes the eviction target.
    const idAt10 = store.getState().notifications[10].id;
    store.getState().markRead(idAt10);
    expect(store.getState().unreadBySurfaceId['surf-10']).toBeUndefined();
    const countBefore = { ...store.getState().unreadBySurfaceId };

    // 501st push evicts the read surf-10 entry — no unread bucket should change.
    store.getState().addNotification({
      workspaceId: 'ws-a', type: 'info', title: 'overflow', body: '', surfaceId: 'surf-new',
    });
    const map = store.getState().unreadBySurfaceId;
    // Every previously-existing bucket is unchanged...
    for (const k of Object.keys(countBefore)) {
      expect(map[k]).toBe(countBefore[k]);
    }
    // ...and the new one is added.
    expect(map['surf-new']).toBe(1);
  });

  // U3 — markAllReadForWorkspace leaves other workspaces' surface counts intact.
  it('markAllReadForWorkspace only clears buckets for that workspace', () => {
    const store = createTestStore([makeWorkspace('ws-a'), makeWorkspace('ws-b')]);
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: '', body: '', surfaceId: 'a1' });
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: '', body: '', surfaceId: 'a2' });
    store.getState().addNotification({ workspaceId: 'ws-b', type: 'info', title: '', body: '', surfaceId: 'b1' });

    store.getState().markAllReadForWorkspace('ws-a');

    const map = store.getState().unreadBySurfaceId;
    expect(map['a1']).toBeUndefined();
    expect(map['a2']).toBeUndefined();
    expect(map['b1']).toBe(1);
  });

  // U4 — markRead twice on the same id decrements only once.
  it('decrements once when markRead is called twice on the same id', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: '', body: '', surfaceId: 's1' });
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: '', body: '', surfaceId: 's1' });
    expect(store.getState().unreadBySurfaceId['s1']).toBe(2);

    const firstId = store.getState().notifications[0].id;
    store.getState().markRead(firstId);
    store.getState().markRead(firstId);

    expect(store.getState().unreadBySurfaceId['s1']).toBe(1);
  });

  // U5 — a notification without surfaceId does not create an 'undefined' key.
  it('does not create an undefined key for surfaceId-less notifications', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: '', body: '' });
    const map = store.getState().unreadBySurfaceId;
    expect(Object.keys(map)).toHaveLength(0);
    expect('undefined' in map).toBe(false);
    expect(map[undefined as unknown as string]).toBeUndefined();
  });

  // U6 — markAllRead and clearNotifications reset the map to {}.
  it('markAllRead and clearNotifications reset the index to {}', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: '', body: '', surfaceId: 's1' });
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: '', body: '', surfaceId: 's2' });
    expect(Object.keys(store.getState().unreadBySurfaceId)).toHaveLength(2);

    store.getState().markAllRead();
    expect(store.getState().unreadBySurfaceId).toEqual({});

    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: '', body: '', surfaceId: 's3' });
    expect(Object.keys(store.getState().unreadBySurfaceId)).toHaveLength(1);
    store.getState().clearNotifications();
    expect(store.getState().unreadBySurfaceId).toEqual({});
  });

  // U7 — selector parity: index-derived count equals the old filter-based
  // count across a randomized mutation sequence.
  it('index-derived count matches the old filter-based count under random mutations', () => {
    const store = createTestStore([makeWorkspace('ws-a'), makeWorkspace('ws-b')]);
    const surfaces = ['s1', 's2', 's3', 's4'];
    const workspaces = ['ws-a', 'ws-b'];
    // Deterministic PRNG so failures reproduce.
    let seed = 1234567;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let step = 0; step < 400; step++) {
      const roll = rand();
      if (roll < 0.6) {
        // add — sometimes with no surfaceId (workspace-scoped)
        const withSurface = rand() < 0.85;
        store.getState().addNotification({
          workspaceId: workspaces[Math.floor(rand() * workspaces.length)],
          type: 'info', title: `t${step}`, body: '',
          ...(withSurface ? { surfaceId: surfaces[Math.floor(rand() * surfaces.length)] } : {}),
        });
      } else if (roll < 0.8) {
        const list = store.getState().notifications;
        if (list.length) store.getState().markRead(list[Math.floor(rand() * list.length)].id);
      } else if (roll < 0.9) {
        store.getState().markAllReadForWorkspace(workspaces[Math.floor(rand() * workspaces.length)]);
      } else if (roll < 0.95) {
        store.getState().markAllRead();
      } else {
        store.getState().clearNotifications();
      }

      // Parity check every step for each surface subset a Pane might hold.
      const list = store.getState().notifications;
      const map = store.getState().unreadBySurfaceId;
      for (const subset of [['s1'], ['s2', 's3'], surfaces]) {
        const indexed = subset.reduce((acc, id) => acc + (map[id] ?? 0), 0);
        expect(indexed).toBe(oldUnreadForSurfaces(list, subset));
      }
    }
  });
});
