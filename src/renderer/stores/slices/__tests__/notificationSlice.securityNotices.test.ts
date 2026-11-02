import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createNotificationSlice, type NotificationSlice } from '../notificationSlice';
import type { Workspace } from '../../../../shared/types';
import type { SecurityNotice } from '../../../../shared/securityNotice';

// Pending daemon security notices are pinned: the read / clear actions leave
// them alone, and only acknowledging one turns it into an ordinary read row.
type TestState = NotificationSlice & { workspaces: Workspace[]; activeWorkspaceId: string };

function makeWorkspace(id: string, ptyId?: string): Workspace {
  return {
    id,
    name: id,
    rootPane: {
      id: `${id}-pane`,
      type: 'leaf',
      surfaces: ptyId ? [{ id: `${id}-surface`, ptyId, title: 'shell', shell: '', cwd: '' }] : [],
      activeSurfaceId: ptyId ? `${id}-surface` : '',
    },
    activePaneId: `${id}-pane`,
  };
}

function createTestStore(workspaces: Workspace[], activeWorkspaceId: string) {
  return create<TestState>()(
    immer((...args) => ({
      workspaces,
      activeWorkspaceId,
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createNotificationSlice(...args),
    })),
  );
}

const notice = (id: string, partial: Partial<SecurityNotice> = {}): SecurityNotice => ({
  id,
  title: `Agent started with prompts off ${id}`,
  body: `body ${id}`,
  ptyId: null,
  timestamp: 1_000,
  ...partial,
});

describe('notificationSlice — security notices', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore([makeWorkspace('ws-a'), makeWorkspace('ws-b', 'pty-7')], 'ws-a');
  });

  it('Mark all read, Mark workspace read and Clear keep pending notices', () => {
    store.getState().addSecurityNotice(notice('s1'));
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: 't', body: 'b' });
    store.getState().markAllRead();
    store.getState().markAllReadForWorkspace('ws-a');
    store.getState().clearNotifications();
    expect(store.getState().securityNotices.map((n) => n.id)).toEqual(['s1']);
    expect(store.getState().notifications).toEqual([]);
  });

  it('acknowledge unpins the notice and adds a read warning row on the workspace that holds its pane', () => {
    store.getState().addSecurityNotice(notice('s1', { ptyId: 'pty-7', timestamp: 42 }));
    store.getState().acknowledgeSecurityNotice('s1');
    const s = store.getState();
    expect(s.securityNotices).toEqual([]);
    expect(s.notifications).toHaveLength(1);
    expect(s.notifications[0]).toMatchObject({
      type: 'warning',
      title: 'Agent started with prompts off s1',
      body: 'body s1',
      read: true,
      ptyId: 'pty-7',
      workspaceId: 'ws-b',
      surfaceId: 'ws-b-surface',
      timestamp: 42,
    });
    expect(s.notifications[0].category).toBeUndefined();
    expect(s.unreadBySurfaceId).toEqual({});
  });

  it('acknowledge files a notice without a known pane under the active workspace', () => {
    store.getState().addSecurityNotice(notice('s1', { ptyId: 'pty-gone' }));
    store.getState().acknowledgeSecurityNotice('s1');
    const row = store.getState().notifications[0];
    expect(row.workspaceId).toBe('ws-a');
    expect(row.surfaceId).toBeUndefined();
    expect(row.ptyId).toBe('pty-gone');
  });

  it('acknowledging an unknown id changes nothing', () => {
    store.getState().addSecurityNotice(notice('s1'));
    store.getState().acknowledgeSecurityNotice('nope');
    expect(store.getState().securityNotices).toHaveLength(1);
    expect(store.getState().notifications).toEqual([]);
  });

  it('dedupes by id, and the initial list merges with notices heard before it, oldest first', () => {
    store.getState().addSecurityNotice(notice('s2', { timestamp: 20 }));
    store.getState().addSecurityNotice(notice('s2', { timestamp: 20 }));
    store.getState().setSecurityNotices([notice('s1', { timestamp: 10 }), notice('s2', { timestamp: 20 })]);
    expect(store.getState().securityNotices.map((n) => n.id)).toEqual(['s1', 's2']);
  });
});
