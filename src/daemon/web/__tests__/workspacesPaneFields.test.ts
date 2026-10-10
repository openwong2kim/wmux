import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { WebTerminalServer, type WebDeviceResolver } from '../WebTerminalServer';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import type { DesktopPhoneBridge } from '../../phone/DesktopPhoneBridge';

/**
 * PC rail: each pane of `GET /api/workspaces` carries the session's last
 * output stamp, and, while the desktop is attached, the desktop sidebar's pane
 * name and tab title. All three are additive: a pane never loses a key.
 */

type Meta = { id: string; env: Record<string, string>; cwd: string; state: string; cols: number; rows: number; lastActivity: string };

function live(id: string, env: Record<string, string>): Meta {
  return { id, env, cwd: '/tmp', state: 'detached', cols: 80, rows: 24, lastActivity: '2026-10-01T00:00:00.000Z' };
}

describe('GET /api/workspaces pane fields', () => {
  let sessions: Meta[];
  let sidebar: unknown;
  let desktopAvailable: boolean;
  let server: WebTerminalServer;

  beforeEach(() => {
    sessions = [
      live('s1', { WMUX_WORKSPACE_ID: 'ws-live', WMUX_WORKSPACE_NAME: 'Live' }),
      live('brain-1', { WMUX_WORKSPACE_ID: 'ws-brain', WMUX_BRAIN_PTY: '1' }),
    ];
    sidebar = {
      activeWorkspaceId: 'ws-idle',
      hqWorkspaceId: 'ws-hq',
      workspaces: [
        { id: 'ws-live', order: 0, pinned: false },
        { id: 'ws-idle', order: 1, pinned: true, color: 'teal', gitBranch: 'main' },
        { id: 'ws-hq', order: 2, pinned: false },
        { id: 'ws-brain', order: 3, pinned: false },
        { id: 'ws-task', order: 4, pinned: false, task: { ownerWorkspaceId: 'ws-live', detached: false, nested: true, state: { needYou: false, toReview: false, finished: false } } },
      ],
      panes: [],
    };
    desktopAvailable = true;
    const devices: WebDeviceResolver = {
      async mint() { throw new Error('unused'); },
      async resolve() { return { ok: false, reason: 'unknown' }; },
    };
    const desktop = {
      get available() { return desktopAvailable; },
      request: async () => ({ sidebar }),
    } as unknown as DesktopPhoneBridge;
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: () => undefined,
      listManagedSessions: () => [],
      listLiveSessions: () => sessions.map((s) => ({ ...s })),
    }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({
      sessionManager,
      devices,
      desktop: () => desktop,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
  });

  afterEach(async () => {
    if (server.isRunning) await server.stop();
  });

  const list = async () => {
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
    const res = await fetch(`http://127.0.0.1:${server.status().port}/api/workspaces`, {
      headers: { Authorization: `Bearer ${info.token as string}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { workspaces: Array<Record<string, unknown>>; activeWorkspaceId?: string };
  };

  it('adds lastActivity, and the desktop pane name and title beside paneId', async () => {
    sidebar = { ...(sidebar as object), panes: [{ ptyId: 's1', workspaceId: 'ws-live', paneId: 'p1', paneName: 'w1-1', surfaceTitle: 'build' }] };
    const pane = ((await list()).workspaces[0].panes as Array<Record<string, unknown>>)[0];
    expect(pane).toMatchObject({ sessionId: 's1', paneId: 'p1', paneName: 'w1-1', surfaceTitle: 'build', lastActivity: '2026-10-01T00:00:00.000Z' });
  });

  it('carries no pane name or title for a pane the desktop files under another workspace', async () => {
    sidebar = { ...(sidebar as object), panes: [{ ptyId: 's1', workspaceId: 'ws-other', paneId: 'p1', paneName: 'w1-1', surfaceTitle: 'build' }] };
    const pane = ((await list()).workspaces[0].panes as Array<Record<string, unknown>>)[0];
    expect(pane).not.toHaveProperty('paneName');
    expect(pane).not.toHaveProperty('surfaceTitle');
    expect(pane).not.toHaveProperty('paneId');
  });

  it('keeps lastActivity and adds nothing else without a desktop', async () => {
    desktopAvailable = false;
    const pane = ((await list()).workspaces[0].panes as Array<Record<string, unknown>>)[0];
    expect(Object.keys(pane).sort()).toEqual(['cwd', 'lastActivity', 'sessionId']);
  });
});
