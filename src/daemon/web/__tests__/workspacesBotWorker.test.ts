import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { WebTerminalServer, type WebDeviceResolver } from '../WebTerminalServer';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import type { DesktopPhoneBridge } from '../../phone/DesktopPhoneBridge';

/**
 * A factory bot's worker workspace is left out of the desktop sidebar, but the
 * daemon still lists its live panes. `botWorker` marks those rows, on
 * `GET /api/workspaces` and on `GET /api/sessions` by the session's own
 * workspace id, so the phone can tell a bot's worker from a workspace the
 * snapshot has not caught up with.
 */

type Meta = { id: string; env: Record<string, string>; cwd: string; state: string; cols: number; rows: number; lastActivity: string };

function live(id: string, workspaceId: string, name: string): Meta {
  return {
    id,
    env: { WMUX_WORKSPACE_ID: workspaceId, WMUX_WORKSPACE_NAME: name },
    cwd: '/tmp',
    state: 'detached',
    cols: 80,
    rows: 24,
    lastActivity: '2026-10-01T00:00:00.000Z',
  };
}

describe('botWorker on the phone list routes', () => {
  let sidebar: unknown;
  let desktopAvailable: boolean;
  let server: WebTerminalServer;
  const sessions: Meta[] = [
    live('s-owner', 'ws-owner', 'App'),
    live('s-own-task', 'ws-own-task', 'wtask: fix login'),
    live('s-bot', 'ws-bot', 'wtask: verify PR #2245'),
    live('s-bot-2', 'ws-bot', 'wtask: verify PR #2245'),
  ];

  beforeEach(() => {
    sidebar = {
      activeWorkspaceId: 'ws-owner',
      workspaces: [
        { id: 'ws-owner', order: 0, pinned: false },
        { id: 'ws-own-task', order: 1, pinned: false, task: { ownerWorkspaceId: 'ws-owner', detached: false, nested: true, state: { needYou: false, toReview: false, finished: false } } },
      ],
      panes: [
        { ptyId: 's-owner', workspaceId: 'ws-owner', paneId: 'p-owner', paneName: 'w1-1' },
        { ptyId: 's-own-task', workspaceId: 'ws-own-task', paneId: 'p-own-task', paneName: 'w2-1' },
      ],
      botWorkers: [{ workspaceId: 'ws-bot', botId: 'bot-1a2b3c4d', taskId: 'wtask-0b6c1f2e-5d4a-4e1b-9c3d-2a7f8e6b1c90' }],
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
    server = new WebTerminalServer({ sessionManager, devices, desktop: () => desktop, log: () => { /* silent */ }, assetsDir: os.tmpdir() });
  });

  afterEach(async () => {
    if (server.isRunning) await server.stop();
  });

  const get = async <T,>(route: string): Promise<T> => {
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
    const res = await fetch(`http://127.0.0.1:${server.status().port}${route}`, { headers: { Authorization: `Bearer ${info.token as string}` } });
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  };
  const workspaces = async () => (await get<{ workspaces: Array<Record<string, unknown>> }>('/api/workspaces')).workspaces;
  const sessionRows = async () => (await get<{ sessions: Array<Record<string, unknown>> }>('/api/sessions')).sessions;
  const byId = <T extends Record<string, unknown>>(rows: T[], key: string, id: string) => rows.find((r) => r[key] === id);

  it('marks the bot worker\'s workspace row and keeps listing it', async () => {
    const rows = await workspaces();
    const row = byId(rows, 'id', 'ws-bot');
    expect(row).toMatchObject({ id: 'ws-bot', name: 'wtask: verify PR #2245', botWorker: { botId: 'bot-1a2b3c4d', taskId: 'wtask-0b6c1f2e-5d4a-4e1b-9c3d-2a7f8e6b1c90' } });
    expect((row?.panes as unknown[]).length).toBe(2);
    expect(row).not.toHaveProperty('ownerWorkspaceId');
    expect(row).not.toHaveProperty('nested');
  });

  it('marks every session of the bot worker through its workspace id, labeled or not', async () => {
    const rows = await sessionRows();
    for (const id of ['s-bot', 's-bot-2']) {
      expect(byId(rows, 'id', id)).toMatchObject({ workspaceId: 'ws-bot', botWorker: { botId: 'bot-1a2b3c4d', taskId: 'wtask-0b6c1f2e-5d4a-4e1b-9c3d-2a7f8e6b1c90' } });
    }
    // A label for the worker's pane (an older or a racing desktop) changes nothing.
    sidebar = { ...(sidebar as object), panes: [...(sidebar as { panes: unknown[] }).panes, { ptyId: 's-bot', workspaceId: 'ws-bot', paneId: 'p-bot' }] };
    await server.stop();
    expect(byId(await sessionRows(), 'id', 's-bot')).toMatchObject({ paneId: 'p-bot', botWorker: { botId: 'bot-1a2b3c4d' } });
  });

  it('leaves the owner\'s own task its ownerWorkspaceId and nested, with no botWorker', async () => {
    const wsRows = await workspaces();
    const task = byId(wsRows, 'id', 'ws-own-task');
    expect(task).toMatchObject({ ownerWorkspaceId: 'ws-owner', nested: true });
    expect(task).not.toHaveProperty('botWorker');
    expect(byId(wsRows, 'id', 'ws-owner')).not.toHaveProperty('botWorker');
    await server.stop();
    const sRows = await sessionRows();
    expect(byId(sRows, 'id', 's-own-task')).not.toHaveProperty('botWorker');
    expect(byId(sRows, 'id', 's-owner')).not.toHaveProperty('botWorker');
  });

  it('carries no botWorker without a snapshot, or from a desktop that sends none', async () => {
    desktopAvailable = false;
    expect((await workspaces()).some((r) => 'botWorker' in r)).toBe(false);
    await server.stop();
    expect((await sessionRows()).some((r) => 'botWorker' in r)).toBe(false);
    await server.stop();
    desktopAvailable = true;
    const older = { ...(sidebar as Record<string, unknown>) };
    delete older.botWorkers;
    sidebar = older;
    expect((await workspaces()).some((r) => 'botWorker' in r)).toBe(false);
  });
});
