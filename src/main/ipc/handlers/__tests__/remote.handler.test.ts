// Unit tests for remote.handler.ts — the renderer-facing IPC surface for
// registered remote wmux web hosts and the per-pane attach/detach/write/push
// bridge. ipcMain and app are mocked (mirrors web.handler.test.ts /
// deck.handler.vendor.test.ts); RemoteHostsStore and RemoteHostClient are
// stubbed directly rather than mocked modules, since the handler takes them
// as injected deps.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const ipcListeners = new Map<string, (...args: unknown[]) => unknown>();
const appListeners = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => {
  const ipcMain = {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel);
    }),
    on: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcListeners.set(channel, fn);
    }),
    removeAllListeners: vi.fn((channel: string) => {
      ipcListeners.delete(channel);
    }),
  };
  const app = {
    on: vi.fn((event: string, fn: (...args: unknown[]) => unknown) => {
      appListeners.set(event, fn);
    }),
    removeListener: vi.fn((event: string) => {
      appListeners.delete(event);
    }),
  };
  return { ipcMain, app };
});

import { registerRemoteHandlers } from '../remote.handler';
import { IPC } from '../../../../shared/constants';
import type { RemoteHost, RemoteHostPublic, RemoteWorkspacesResponse } from '../../../../shared/remoteHosts';
import type { RemoteHostClient, RemoteMetaEvent, RemoteDataEvent, RemoteExitEvent } from '../../../remote/RemoteHostClient';

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn;
}

function getListener(channel: string): (...args: unknown[]) => unknown {
  const fn = ipcListeners.get(channel);
  if (!fn) throw new Error(`no listener for ${channel}`);
  return fn;
}

/** A minimal fake WebContents — captures send() calls and destroy listeners. */
function fakeSender(id: number) {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const destroyCbs: Array<() => void> = [];
  const goneCbs: Array<() => void> = [];
  return {
    id,
    isDestroyed: vi.fn(() => false),
    send: vi.fn((channel: string, payload: unknown) => { sent.push({ channel, payload }); }),
    once: vi.fn((event: string, cb: () => void) => { if (event === 'destroyed') destroyCbs.push(cb); }),
    on: vi.fn((event: string, cb: () => void) => { if (event === 'render-process-gone') goneCbs.push(cb); }),
    sent,
    fireDestroyed: () => destroyCbs.forEach((cb) => cb()),
    fireGone: () => goneCbs.forEach((cb) => cb()),
  };
}

/** A fake RemoteHostClient — captures onMeta/onData/onExit callbacks so a
 *  test can push a fake event straight through the shared client wiring. */
function fakeClient(host: RemoteHost) {
  const metaCbs: Array<(e: RemoteMetaEvent) => void> = [];
  const dataCbs: Array<(e: RemoteDataEvent) => void> = [];
  const exitCbs: Array<(e: RemoteExitEvent) => void> = [];
  let nextAttachId = 0;
  return {
    host,
    attach: vi.fn((_sessionId: string) => `attach-${host.id}-${nextAttachId++}`),
    detach: vi.fn(),
    detachAll: vi.fn(),
    write: vi.fn(async () => undefined),
    listWorkspaces: vi.fn(async (): Promise<RemoteWorkspacesResponse> => ({ workspaces: [] })),
    onMeta: vi.fn((cb: (e: RemoteMetaEvent) => void) => { metaCbs.push(cb); }),
    onData: vi.fn((cb: (e: RemoteDataEvent) => void) => { dataCbs.push(cb); }),
    onExit: vi.fn((cb: (e: RemoteExitEvent) => void) => { exitCbs.push(cb); }),
    emitMeta: (e: RemoteMetaEvent) => metaCbs.forEach((cb) => cb(e)),
    emitData: (e: RemoteDataEvent) => dataCbs.forEach((cb) => cb(e)),
    emitExit: (e: RemoteExitEvent) => exitCbs.forEach((cb) => cb(e)),
  } as unknown as RemoteHostClient & {
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    detachAll: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    listWorkspaces: ReturnType<typeof vi.fn>;
    emitMeta: (e: RemoteMetaEvent) => void;
    emitData: (e: RemoteDataEvent) => void;
    emitExit: (e: RemoteExitEvent) => void;
  };
}

/** A minimal fake RemoteHostsStore — in-memory, same shape as the real one. */
function fakeStore(hosts: RemoteHost[] = []) {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const added: Array<{ rawUrl: string; label?: string }> = [];
  return {
    list: vi.fn((): RemoteHostPublic[] => [...byId.values()].map(({ token: _t, ...rest }) => rest)),
    get: vi.fn((id: string): RemoteHost | null => byId.get(id) ?? null),
    add: vi.fn((rawUrl: string, label?: string) => {
      added.push({ rawUrl, label });
      const u = new URL(rawUrl);
      const token = u.searchParams.get('token') ?? '';
      if (!token) return { ok: false as const, error: 'invalid wmux web URL' };
      if ([...byId.values()].some((h) => h.origin === u.origin)) {
        return { ok: false as const, error: 'already registered' };
      }
      const host: RemoteHost = { id: `host-${byId.size + 1}`, label: label ?? u.hostname, origin: u.origin, token, addedAt: 0 };
      byId.set(host.id, host);
      const { token: _t, ...pub } = host;
      return { ok: true as const, host: pub };
    }),
    remove: vi.fn((id: string) => byId.delete(id)),
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  ipcHandlers.clear();
  ipcListeners.clear();
  appListeners.clear();
});

describe('remote.handler — hostsAdd', () => {
  it('probes /api/config before persisting and refuses an old remote (404)', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async () => jsonResponse({}, false));
    registerRemoteHandlers({ store: store as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_ADD)({}, 'https://box:9600?token=t') as { ok: boolean; error?: string };

    expect(res).toEqual({ ok: false, error: "that machine's wmux is too old for remote attach" });
    expect(store.add).not.toHaveBeenCalled();
  });

  it('refuses an old remote that returns unparseable JSON', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } } as unknown as Response));
    registerRemoteHandlers({ store: store as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_ADD)({}, 'https://box:9600?token=t') as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("that machine's wmux is too old for remote attach");
    expect(store.add).not.toHaveBeenCalled();
  });

  it('persists + returns allowInput from a successful probe', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async () => jsonResponse({ serverVersion: '1.0', protocolVersion: 1, minProtocolVersion: 1, allowInput: true }));
    registerRemoteHandlers({ store: store as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_ADD)({}, 'https://box:9600?token=t') as { ok: true; host: RemoteHostPublic };

    expect(res.ok).toBe(true);
    expect(res.host.allowInput).toBe(true);
    expect(store.add).toHaveBeenCalledWith('https://box:9600?token=t', undefined);
    expect(fetchImpl).toHaveBeenCalledWith('https://box:9600/api/config', { headers: { Authorization: 'Bearer t' } });
  });

  it('rejects an invalid URL without ever probing', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn();
    registerRemoteHandlers({ store: store as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_ADD)({}, 'not a url') as { ok: boolean; error?: string };

    expect(res).toEqual({ ok: false, error: 'invalid wmux web URL' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('remote.handler — workspacesList', () => {
  const host: RemoteHost = { id: 'h1', label: 'box', origin: 'https://box:9600', token: 't', addedAt: 0 };

  it('maps a client rejection to {ok:false}', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    client.listWorkspaces.mockRejectedValueOnce(new Error('network down'));
    const fetchImpl = vi.fn(async () => jsonResponse({ allowInput: false }));
    registerRemoteHandlers({ store: store as never, clientFactory: () => client, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_WORKSPACES_LIST)({}, 'h1') as { ok: boolean; error?: string };

    expect(res).toEqual({ ok: false, error: 'network down' });
  });

  it('returns workspaces on success', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    client.listWorkspaces.mockResolvedValueOnce({ workspaces: [{ id: 'w1', name: 'proj', panes: [] }] });
    const fetchImpl = vi.fn(async () => jsonResponse({ allowInput: false }));
    registerRemoteHandlers({ store: store as never, clientFactory: () => client, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_WORKSPACES_LIST)({}, 'h1') as { ok: true; workspaces: unknown[] };

    expect(res.ok).toBe(true);
    expect(res.workspaces).toHaveLength(1);
  });

  it('reports unknown host without touching a client', async () => {
    const store = fakeStore([]);
    const fetchImpl = vi.fn();
    registerRemoteHandlers({ store: store as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_WORKSPACES_LIST)({}, 'missing') as { ok: boolean; error?: string };

    expect(res).toEqual({ ok: false, error: 'unknown host' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('remote.handler — pane attach/detach/write push routing', () => {
  const host: RemoteHost = { id: 'h1', label: 'box', origin: 'https://box:9600', token: 't', addedAt: 0 };

  it('wires client events to the attaching event.sender with the right channel names', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, clientFactory: () => client });

    const sender = fakeSender(101);
    const res = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { ok: true; attachId: string };
    expect(res.ok).toBe(true);

    client.emitMeta({ attachId: res.attachId, cols: 80, rows: 24, snapshotB64: 'AA==' });
    client.emitData({ attachId: res.attachId, dataB64: 'BB==' });
    client.emitExit({ attachId: res.attachId });

    expect(sender.sent).toEqual([
      { channel: IPC.REMOTE_PANE_META, payload: { attachId: res.attachId, cols: 80, rows: 24, snapshotB64: 'AA==' } },
      { channel: IPC.REMOTE_PANE_DATA, payload: { attachId: res.attachId, dataB64: 'BB==' } },
      { channel: IPC.REMOTE_PANE_EXIT, payload: { attachId: res.attachId } },
    ]);
  });

  it('never pushes to a destroyed sender', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, clientFactory: () => client });

    const sender = fakeSender(102);
    const res = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { ok: true; attachId: string };
    sender.isDestroyed.mockReturnValue(true);

    client.emitData({ attachId: res.attachId, dataB64: 'BB==' });

    expect(sender.send).not.toHaveBeenCalled();
  });

  it('a duplicate attach for the same (sender, host, session) returns the existing attachId without a second SSE open', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, clientFactory: () => client });

    const sender = fakeSender(103);
    const first = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { ok: true; attachId: string };
    const second = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { ok: true; attachId: string };

    expect(second.attachId).toBe(first.attachId);
    expect(client.attach).toHaveBeenCalledTimes(1);
  });

  it('a different session on the same sender opens a distinct attach', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, clientFactory: () => client });

    const sender = fakeSender(104);
    const a = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { ok: true; attachId: string };
    const b = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-2') as { ok: true; attachId: string };

    expect(a.attachId).not.toBe(b.attachId);
    expect(client.attach).toHaveBeenCalledTimes(2);
  });

  it('an exit event detaches the dead attach and clears its idempotency key', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, clientFactory: () => client });

    const sender = fakeSender(111);
    const first = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { attachId: string };

    client.emitExit({ attachId: first.attachId });

    expect(client.detach).toHaveBeenCalledWith(first.attachId);

    // Re-attaching the same (sender, host, session) must open a NEW attach —
    // the idempotent branch must not hand back the now-dead attachId.
    const second = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { attachId: string };
    expect(second.attachId).not.toBe(first.attachId);
    expect(client.attach).toHaveBeenCalledTimes(2);
  });

  it('paneDetach forwards to the client and forgets the attach', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, clientFactory: () => client });

    const sender = fakeSender(105);
    const { attachId } = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { attachId: string };
    await getHandler(IPC.REMOTE_PANE_DETACH)({}, attachId);

    expect(client.detach).toHaveBeenCalledWith(attachId);

    // Re-attaching the same key now opens a NEW attach (the old one is gone).
    client.attach.mockClear();
    await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1');
    expect(client.attach).toHaveBeenCalledTimes(1);
  });

  it('paneWrite forwards to the owning client fire-and-forget', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, clientFactory: () => client });

    const sender = fakeSender(110);
    const { attachId } = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { attachId: string };

    getListener(IPC.REMOTE_PANE_WRITE)({}, attachId, 'hello');

    expect(client.write).toHaveBeenCalledWith(attachId, 'hello');
  });

  it('paneWrite for an unknown attachId is a silent no-op', () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, clientFactory: () => client });

    expect(() => getListener(IPC.REMOTE_PANE_WRITE)({}, 'never-attached', 'hello')).not.toThrow();
    expect(client.write).not.toHaveBeenCalled();
  });

  it("sender 'destroyed' detaches every attachId it owns", async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, clientFactory: () => client });

    const sender = fakeSender(106);
    const a = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { attachId: string };
    const b = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-2') as { attachId: string };

    sender.fireDestroyed();

    expect(client.detach).toHaveBeenCalledWith(a.attachId);
    expect(client.detach).toHaveBeenCalledWith(b.attachId);
    expect(client.detach).toHaveBeenCalledTimes(2);
  });

  it("sender 'render-process-gone' detaches every attachId it owns", async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, clientFactory: () => client });

    const sender = fakeSender(107);
    const a = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { attachId: string };

    sender.fireGone();

    expect(client.detach).toHaveBeenCalledWith(a.attachId);
  });

  it('a second sender is unaffected by the first sender being destroyed', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, clientFactory: () => client });

    const senderA = fakeSender(108);
    const senderB = fakeSender(109);
    await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender: senderA }, 'h1', 'session-1');
    const bAttach = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender: senderB }, 'h1', 'session-1') as { attachId: string };

    senderA.fireDestroyed();

    expect(client.detach).toHaveBeenCalledTimes(1);
    expect(client.detach).not.toHaveBeenCalledWith(bAttach.attachId);
  });
});

describe('remote.handler — quit + host removal cleanup', () => {
  it("app 'will-quit' detaches all attachments on every host client", async () => {
    const host1: RemoteHost = { id: 'h1', label: 'box1', origin: 'https://box1:9600', token: 't1', addedAt: 0 };
    const host2: RemoteHost = { id: 'h2', label: 'box2', origin: 'https://box2:9600', token: 't2', addedAt: 0 };
    const store = fakeStore([host1, host2]);
    const clientsByHost = new Map<string, ReturnType<typeof fakeClient>>();
    registerRemoteHandlers({
      store: store as never,
      clientFactory: (h) => {
        const c = fakeClient(h);
        clientsByHost.set(h.id, c);
        return c;
      },
    });

    const sender = fakeSender(200);
    await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 's1');
    await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h2', 's1');

    const willQuit = appListeners.get('will-quit');
    expect(willQuit).toBeTruthy();
    willQuit!();

    expect(clientsByHost.get('h1')!.detachAll).toHaveBeenCalledTimes(1);
    expect(clientsByHost.get('h2')!.detachAll).toHaveBeenCalledTimes(1);
  });

  it('hostsRemove tears down that host client and forgets its attaches', async () => {
    const host1: RemoteHost = { id: 'h1', label: 'box1', origin: 'https://box1:9600', token: 't1', addedAt: 0 };
    const store = fakeStore([host1]);
    const client = fakeClient(host1);
    registerRemoteHandlers({ store: store as never, clientFactory: () => client });

    const sender = fakeSender(201);
    await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 's1');

    const removed = await getHandler(IPC.REMOTE_HOSTS_REMOVE)({}, 'h1');

    expect(removed).toBe(true);
    expect(client.detachAll).toHaveBeenCalledTimes(1);
  });
});
