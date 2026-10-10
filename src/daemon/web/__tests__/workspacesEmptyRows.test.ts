import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { WebTerminalServer, type WebDeviceResolver } from '../WebTerminalServer';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import type { DesktopPhoneBridge } from '../../phone/DesktopPhoneBridge';

/**
 * PC rail: `GET /api/workspaces` lists workspaces the host desktop shows that
 * have no live terminal, as `empty: true` rows after the live ones. Without a
 * desktop answer (locked, occluded, headless) the list is the live rows only.
 */

type Meta = { id: string; env: Record<string, string>; cwd: string; state: string; cols: number; rows: number; lastActivity: string };

function live(id: string, env: Record<string, string>): Meta {
  return { id, env, cwd: '/tmp', state: 'detached', cols: 80, rows: 24, lastActivity: '2026-10-01T00:00:00.000Z' };
}

describe('GET /api/workspaces empty rows', () => {
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

  it('adds a desktop workspace with no terminal as an empty row after the live ones', async () => {
    const body = await list();
    expect(body.workspaces.map((w) => w.id)).toEqual(['ws-live', 'ws-idle']);
    expect(body.workspaces[1]).toMatchObject({ id: 'ws-idle', name: '', panes: [], empty: true, order: 1, pinned: true, color: 'teal', gitBranch: 'main' });
    expect('empty' in body.workspaces[0]).toBe(false);
  });

  it('never lists the HQ, a brain-only workspace or a task workspace as empty', async () => {
    const ids = (await list()).workspaces.map((w) => w.id);
    expect(ids).not.toContain('ws-hq');
    expect(ids).not.toContain('ws-brain');
    expect(ids).not.toContain('ws-task');
  });

  it('never lists a workspace the desktop still shows a pane for, even with its brain pty gone', async () => {
    sessions = sessions.filter((s) => s.id !== 'brain-1');
    sidebar = { ...(sidebar as object), panes: [{ ptyId: 'brain-1', workspaceId: 'ws-brain', paneName: 'w9-1' }] };
    expect((await list()).workspaces.map((w) => w.id)).toEqual(['ws-live', 'ws-idle']);
  });

  it('keeps activeWorkspaceId to rows with a live terminal', async () => {
    expect((await list()).activeWorkspaceId).toBeUndefined();
  });

  it('lists only live rows when the desktop does not answer (locked or headless host)', async () => {
    desktopAvailable = false;
    const body = await list();
    expect(body.workspaces.map((w) => w.id)).toEqual(['ws-live']);
    expect(body.workspaces[0]).toMatchObject({ name: 'Live' });
    expect('layout' in body.workspaces[0]).toBe(false);
  });
});
