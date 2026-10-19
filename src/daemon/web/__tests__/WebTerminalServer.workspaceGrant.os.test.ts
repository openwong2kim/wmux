import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { MAX_NEW_WORKSPACE_NAME_CHARS, WebTerminalServer, newWorkspaceName } from '../WebTerminalServer';
import { DeviceStore } from '../DeviceStore';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import { DEVICE_KIND_HEADER } from '../../../shared/web';
import { HOST_CAPABILITIES } from '../../../shared/sshPcContract';

/**
 * B2 — the workspace-create grant, end to end against a REAL DeviceStore:
 * minted at pairStart for the computer card only, carried by the device's own
 * credential, and honoured by POST /api/sessions for a workspace id no live
 * pane runs under. Everyone else still gets `unknown-workspace-id`.
 */
describe('workspace-create grant', () => {
  let dir: string;
  let store: DeviceStore;
  let server: WebTerminalServer;
  let created: Array<{ workspaceId?: string; workspaceName?: string }>;
  let live: Array<Record<string, unknown>>;
  let suspended: Array<Record<string, unknown>>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-web-wsgrant-'));
    store = new DeviceStore({ wmuxDir: dir, log: () => { /* silent */ } });
    created = [];
    live = [];
    suspended = [];
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: () => undefined,
      listLiveSessions: () => live,
      listSessions: () => [...live, ...suspended],
    }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({
      sessionManager,
      devices: store,
      lifecycle: {
        async create({ workspaceId, workspaceName }: { workspaceId?: string; workspaceName?: string }) {
          created.push({ workspaceId, ...(workspaceName ? { workspaceName } : {}) });
          const id = `web-${created.length}`;
          live.push({
            id, cwd: '/home', cols: 80, rows: 24, state: 'detached', cmd: '/bin/sh',
            lastActivity: '2020-01-01T00:00:00.000Z',
            env: workspaceId ? { WMUX_WORKSPACE_ID: workspaceId } : {},
          });
          return { id };
        },
        async destroy() { /* unused */ },
      },
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
    await server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false });
  });

  afterEach(async () => {
    if (server.isRunning) await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${server.status().port}`;
  const pairAs = async (flow: 'phone' | 'computer', grantCreateWorkspace: boolean): Promise<string> => {
    const started = server.startPairing({ name: `${flow} device`, flow, grantCreateWorkspace });
    if (!started.ok) throw new Error(started.error);
    // The kind header is caller-written: it may claim anything and must not matter.
    const res = await fetch(`${base()}/api/pair?code=${started.code}`, { headers: { [DEVICE_KIND_HEADER]: 'computer' } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  };
  const createIn = (token: string, workspaceId: string, workspaceName?: unknown) =>
    fetch(`${base()}/api/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, ...(workspaceName !== undefined ? { workspaceName } : {}) }),
    });

  it('lets a computer paired with the grant open a new workspace id', async () => {
    const token = await pairAs('computer', true);
    const res = await createIn(token, 'ws-new');
    expect(res.status).toBe(201);
    expect(created).toEqual([{ workspaceId: 'ws-new' }]);
  });

  it('never grants a phone or an ungranted computer, and a revoke takes the grant away', async () => {
    const phone = await pairAs('phone', true);
    const plain = await pairAs('computer', false);
    for (const token of [phone, plain]) {
      const res = await createIn(token, 'ws-new');
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'unknown-workspace-id' });
    }
    const granted = await pairAs('computer', true);
    store.revoke(granted.split('.')[0], 'desktop');
    expect((await createIn(granted, 'ws-other')).status).toBe(401);
    expect(created).toEqual([]);
  });

  it('does not carry the grant onto a refreshed code', async () => {
    const started = server.startPairing({ name: 'Laptop', flow: 'computer', grantCreateWorkspace: true });
    if (!started.ok) throw new Error(started.error);
    const refreshed = server.refreshPairCode().pairCode as string;
    expect(refreshed).not.toBe(started.code);
    const res = await fetch(`${base()}/api/pair?code=${refreshed}`);
    const token = ((await res.json()) as { token: string }).token;
    expect((await createIn(token, 'ws-new')).status).toBe(400);
  });

  it('names a workspace it starts, cleaned, and never renames one a live pane already runs under', async () => {
    const token = await pairAs('computer', true);
    expect((await createIn(token, 'ws-new', ' Work\u0007space 3\n')).status).toBe(201);
    // The workspace now has a live pane: a second create there must not rename it.
    expect((await createIn(token, 'ws-new', 'Renamed')).status).toBe(201);
    // No name (what an older desktop sends) is just no name.
    expect((await createIn(token, 'ws-other')).status).toBe(201);
    // A workspace whose only pane is suspended (awaiting recovery) is not new either.
    suspended.push({ id: 'old', state: 'suspended', env: { WMUX_WORKSPACE_ID: 'ws-parked' } });
    expect((await createIn(token, 'ws-parked', 'Hijack')).status).toBe(201);
    expect(created).toEqual([
      { workspaceId: 'ws-new', workspaceName: 'Workspace 3' },
      { workspaceId: 'ws-new' },
      { workspaceId: 'ws-other' },
      { workspaceId: 'ws-parked' },
    ]);
  });

  it('advertises its capabilities in /api/config', async () => {
    const token = await pairAs('computer', false);
    const config = await (await fetch(`${base()}/api/config`, { headers: { Authorization: `Bearer ${token}` } })).json() as {
      capabilities?: string[];
    };
    expect(config.capabilities).toEqual(Object.values(HOST_CAPABILITIES));
  });
});

describe('newWorkspaceName', () => {
  it('strips control characters, trims, caps at the rename limit, and refuses non-strings', () => {
    expect(newWorkspaceName('\u001b[31mapi\u009b\t')).toBe('[31mapi');
    expect(newWorkspaceName('x'.repeat(200))).toHaveLength(MAX_NEW_WORKSPACE_NAME_CHARS);
    expect(newWorkspaceName('😀'.repeat(70))).toBe('😀'.repeat(MAX_NEW_WORKSPACE_NAME_CHARS));
    expect(newWorkspaceName('\n\u0000 ')).toBeUndefined();
    // Bidi overrides, line separators and zero-width marks cannot reorder or split a label.
    expect(newWorkspaceName('ab\u202ecd\u2028ef\u200bgh\u2066')).toBe('abcdefgh');
    expect(newWorkspaceName(42)).toBeUndefined();
  });
});
