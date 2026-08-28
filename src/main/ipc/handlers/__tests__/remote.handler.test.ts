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
import type { RemoteAttachmentDescriptor, RemoteHost, RemoteHostPublic, RemoteWorkspacesResponse } from '../../../../shared/remoteHosts';
import type { RemoteHostClient, RemoteMetaEvent, RemoteResizeEvent, RemoteDataEvent, RemoteExitEvent, RemoteErrorEvent } from '../../../remote/RemoteHostClient';

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
  type NavCb = (e: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void;
  const navCbs: NavCb[] = [];
  return {
    id,
    isDestroyed: vi.fn(() => false),
    send: vi.fn((channel: string, payload: unknown) => { sent.push({ channel, payload }); }),
    once: vi.fn((event: string, cb: () => void) => { if (event === 'destroyed') destroyCbs.push(cb); }),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'render-process-gone') goneCbs.push(cb as () => void);
      if (event === 'did-start-navigation') navCbs.push(cb as NavCb);
    }),
    removeListener: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'destroyed') {
        const i = destroyCbs.indexOf(cb as () => void);
        if (i !== -1) destroyCbs.splice(i, 1);
      }
      if (event === 'render-process-gone') {
        const i = goneCbs.indexOf(cb as () => void);
        if (i !== -1) goneCbs.splice(i, 1);
      }
      if (event === 'did-start-navigation') {
        const i = navCbs.indexOf(cb as NavCb);
        if (i !== -1) navCbs.splice(i, 1);
      }
    }),
    sent,
    fireDestroyed: () => destroyCbs.forEach((cb) => cb()),
    fireGone: () => goneCbs.forEach((cb) => cb()),
    fireNavigation: (isInPlace: boolean, isMainFrame: boolean) =>
      navCbs.forEach((cb) => cb({}, 'https://example.com', isInPlace, isMainFrame)),
    listenerCounts: () => ({ destroyed: destroyCbs.length, gone: goneCbs.length, nav: navCbs.length }),
  };
}

/** A fake RemoteHostClient — captures onMeta/onData/onExit callbacks so a
 *  test can push a fake event straight through the shared client wiring. */
function fakeClient(host: RemoteHost) {
  const metaCbs: Array<(e: RemoteMetaEvent) => void> = [];
  const resizeCbs: Array<(e: RemoteResizeEvent) => void> = [];
  const dataCbs: Array<(e: RemoteDataEvent) => void> = [];
  const exitCbs: Array<(e: RemoteExitEvent) => void> = [];
  const errorCbs: Array<(e: RemoteErrorEvent) => void> = [];
  let nextAttachId = 0;
  return {
    host,
    attach: vi.fn((_sessionId: string) => `attach-${host.id}-${nextAttachId++}`),
    detach: vi.fn(),
    detachAll: vi.fn(),
    write: vi.fn(async () => undefined),
    listWorkspaces: vi.fn(async (): Promise<RemoteWorkspacesResponse> => ({ workspaces: [] })),
    createWorkspace: vi.fn(async (): Promise<{ sessionId: string }> => ({ sessionId: 'web-1' })),
    onMeta: vi.fn((cb: (e: RemoteMetaEvent) => void) => { metaCbs.push(cb); }),
    onResize: vi.fn((cb: (e: RemoteResizeEvent) => void) => { resizeCbs.push(cb); }),
    onData: vi.fn((cb: (e: RemoteDataEvent) => void) => { dataCbs.push(cb); }),
    onExit: vi.fn((cb: (e: RemoteExitEvent) => void) => { exitCbs.push(cb); }),
    onError: vi.fn((cb: (e: RemoteErrorEvent) => void) => { errorCbs.push(cb); }),
    emitMeta: (e: RemoteMetaEvent) => metaCbs.forEach((cb) => cb(e)),
    emitResize: (e: RemoteResizeEvent) => resizeCbs.forEach((cb) => cb(e)),
    emitData: (e: RemoteDataEvent) => dataCbs.forEach((cb) => cb(e)),
    emitExit: (e: RemoteExitEvent) => exitCbs.forEach((cb) => cb(e)),
    emitError: (e: RemoteErrorEvent) => errorCbs.forEach((cb) => cb(e)),
  } as unknown as RemoteHostClient & {
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    detachAll: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    listWorkspaces: ReturnType<typeof vi.fn>;
    createWorkspace: ReturnType<typeof vi.fn>;
    emitMeta: (e: RemoteMetaEvent) => void;
    emitResize: (e: RemoteResizeEvent) => void;
    emitData: (e: RemoteDataEvent) => void;
    emitExit: (e: RemoteExitEvent) => void;
    emitError: (e: RemoteErrorEvent) => void;
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
    addDirect: vi.fn((origin: string, token: string, label?: string) => {
      if ([...byId.values()].some((h) => h.origin === origin)) {
        return { ok: false as const, error: 'already registered' };
      }
      let hostname = origin;
      try { hostname = new URL(origin).hostname; } catch { /* keep origin as fallback */ }
      const host: RemoteHost = { id: `host-${byId.size + 1}`, label: label ?? hostname, origin, token, addedAt: 0 };
      byId.set(host.id, host);
      const { token: _t, ...pub } = host;
      return { ok: true as const, host: pub };
    }),
  };
}

/** A minimal fake RemoteAttachmentsStore — in-memory, same shape as the real
 *  one (which is exercised directly in RemoteAttachmentsStore.test.ts). */
function fakeAttachments(seed: RemoteAttachmentDescriptor[] = []) {
  const byKey = new Map(seed.map((a) => [a.key, a]));
  return {
    list: vi.fn((): RemoteAttachmentDescriptor[] => [...byKey.values()]),
    add: vi.fn((d: RemoteAttachmentDescriptor) => { byKey.set(d.key, d); }),
    remove: vi.fn((key: string) => byKey.delete(key)),
    removeByHost: vi.fn((hostId: string) => {
      let n = 0;
      for (const [key, a] of [...byKey.entries()]) {
        if (a.hostId === hostId) { byKey.delete(key); n++; }
      }
      return n;
    }),
  };
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 404): Response {
  return { ok, status, json: async () => body } as unknown as Response;
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
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_ADD)({}, 'https://box:9600?token=t') as { ok: boolean; error?: string };

    expect(res).toEqual({ ok: false, error: "that machine's wmux is too old for remote attach" });
    expect(store.add).not.toHaveBeenCalled();
  });

  it('refuses an old remote that returns unparseable JSON', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } } as unknown as Response));
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_ADD)({}, 'https://box:9600?token=t') as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("that machine's wmux is too old for remote attach");
    expect(store.add).not.toHaveBeenCalled();
  });

  it('persists + returns allowInput from a successful probe', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ serverVersion: '1.0', protocolVersion: 1, minProtocolVersion: 1, allowInput: true }));
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_ADD)({}, 'https://box:9600?token=t') as { ok: true; host: RemoteHostPublic };

    expect(res.ok).toBe(true);
    expect(res.host.allowInput).toBe(true);
    expect(store.add).toHaveBeenCalledWith('https://box:9600?token=t', undefined);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://box:9600/api/config');
    expect(init?.headers).toEqual({ Authorization: 'Bearer t' });
    // M2 — a Bearer-credentialed probe must never follow a redirect and
    // must not hang forever.
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects an invalid URL without ever probing', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn();
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_ADD)({}, 'not a url') as { ok: boolean; error?: string };

    expect(res).toEqual({ ok: false, error: 'invalid wmux web URL' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // I3(b) — a 401/403 (rejected token) and a fetch-throw (unreachable host)
  // used to both flatten into the same "too old" message as a 404. They are
  // now distinguished so the user gets an actionable message.
  it('reports a rejected token distinctly from "too old" on a 401', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 401));
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_ADD)({}, 'https://box:9600?token=t') as { ok: boolean; error?: string };

    expect(res).toEqual({ ok: false, error: 'token rejected — re-run wmux web on the remote and paste the new URL' });
    expect(store.add).not.toHaveBeenCalled();
  });

  it('reports an unreachable host distinctly from "too old" when fetch throws', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_ADD)({}, 'https://box:9600?token=t') as { ok: boolean; error?: string };

    expect(res).toEqual({ ok: false, error: 'could not reach that host' });
    expect(store.add).not.toHaveBeenCalled();
  });

  it('still reports "too old" for a genuinely incompatible remote (404)', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 404));
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_ADD)({}, 'https://box:9600?token=t') as { ok: boolean; error?: string };

    expect(res).toEqual({ ok: false, error: "that machine's wmux is too old for remote attach" });
  });

  // C1 — store.add() persists via secureWriteTokenFile, which is
  // fail-closed (throws on a chmod/ACL failure). The handler must never let
  // that throw escape with the raw token-bearing URL still in scope as the
  // args_summary'd first argument.
  it('never throws when store.add() throws — reports a generic save failure instead', async () => {
    const store = fakeStore();
    store.add.mockImplementationOnce(() => { throw new Error('EACCES: chmod failed'); });
    const fetchImpl = vi.fn(async () => jsonResponse({ allowInput: true }));
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      getHandler(IPC.REMOTE_HOSTS_ADD)({}, 'https://box:9600?token=t'),
    ).resolves.toEqual({ ok: false, error: 'could not save host' });
  });
});

describe('remote.handler — hostsPair', () => {
  it('mints+stores a host on success and reports allowInput', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/api/pair')) return jsonResponse({ deviceId: 'd1', deviceSecret: 's1', token: 'd1.s1' });
      return jsonResponse({ allowInput: true });
    });
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_PAIR)({}, 'https://box:9600', 'ABCD1234') as { ok: true; host: RemoteHostPublic };

    expect(res.ok).toBe(true);
    expect(res.host.allowInput).toBe(true);
    expect(store.addDirect).toHaveBeenCalledWith('https://box:9600', 'd1.s1', undefined);

    const [pairUrl, pairInit] = fetchImpl.mock.calls[0];
    expect(pairUrl).toBe('https://box:9600/api/pair?code=ABCD1234');
    expect(pairInit?.redirect).toBe('error');
    expect(pairInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it('strips a trailing path/slash down to the bare origin', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/api/pair')) return jsonResponse({ token: 't' });
      return jsonResponse({ allowInput: false });
    });
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    await getHandler(IPC.REMOTE_HOSTS_PAIR)({}, 'https://box:9600/some/path/', 'CODE');

    expect(store.addDirect).toHaveBeenCalledWith('https://box:9600', 't', undefined);
  });

  it('refuses a non-http(s) origin without ever fetching', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn();
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_PAIR)({}, 'ftp://box:9600', 'CODE') as { ok: boolean; reason?: string };

    expect(res).toEqual({ ok: false, reason: 'invalid-origin' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an unparseable origin without ever fetching', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn();
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_PAIR)({}, 'not a url', 'CODE') as { ok: boolean; reason?: string };

    expect(res).toEqual({ ok: false, reason: 'invalid-origin' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a duplicate origin without ever fetching', async () => {
    const existing: RemoteHost = { id: 'h1', label: 'box', origin: 'https://box:9600', token: 't', addedAt: 0 };
    const store = fakeStore([existing]);
    const fetchImpl = vi.fn();
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_PAIR)({}, 'https://box:9600', 'CODE') as { ok: boolean; reason?: string };

    expect(res).toEqual({ ok: false, reason: 'already-registered' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', 'expired'],
    ['too many attempts', 'too-many-attempts'],
    ['insecure-transport', 'insecure-transport'],
    ['something-unmapped', 'pairing-failed'],
  ])('maps a 403 body {error: %s} to reason %s', async (bodyError, expectedReason) => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async () => jsonResponse({ error: bodyError }, false, 403));
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_PAIR)({}, 'https://box:9600', 'CODE') as { ok: boolean; reason?: string };

    expect(res).toEqual({ ok: false, reason: expectedReason });
    expect(store.addDirect).not.toHaveBeenCalled();
  });

  it('maps an "invalid code" 403 body to invalid-code and carries attemptsLeft', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid code', attemptsLeft: 3 }, false, 403));
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_PAIR)({}, 'https://box:9600', 'WRONG') as { ok: boolean; reason?: string; attemptsLeft?: number };

    expect(res).toEqual({ ok: false, reason: 'invalid-code', attemptsLeft: 3 });
  });

  it('reports unreachable when the fetch itself throws', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_PAIR)({}, 'https://box:9600', 'CODE') as { ok: boolean; reason?: string };

    expect(res).toEqual({ ok: false, reason: 'unreachable' });
    expect(store.addDirect).not.toHaveBeenCalled();
  });

  it('reports pairing-failed for a 500', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'pairing failed' }, false, 500));
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_PAIR)({}, 'https://box:9600', 'CODE') as { ok: boolean; reason?: string };

    expect(res).toEqual({ ok: false, reason: 'pairing-failed' });
  });

  it('refuses an incompatible remote after a successful code exchange, without persisting', async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/api/pair')) return jsonResponse({ token: 'freshly-minted' });
      return jsonResponse({}, false, 404); // /api/config probe fails
    });
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_HOSTS_PAIR)({}, 'https://box:9600', 'CODE') as { ok: boolean; reason?: string };

    expect(res).toEqual({ ok: false, reason: 'incompatible' });
    expect(store.addDirect).not.toHaveBeenCalled();
  });

  it('never throws when store.addDirect() throws — reports pairing-failed instead', async () => {
    const store = fakeStore();
    store.addDirect.mockImplementationOnce(() => { throw new Error('EACCES: chmod failed'); });
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/api/pair')) return jsonResponse({ token: 't' });
      return jsonResponse({ allowInput: true });
    });
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      getHandler(IPC.REMOTE_HOSTS_PAIR)({}, 'https://box:9600', 'CODE'),
    ).resolves.toEqual({ ok: false, reason: 'pairing-failed' });
  });
});

describe('remote.handler — workspacesList', () => {
  const host: RemoteHost = { id: 'h1', label: 'box', origin: 'https://box:9600', token: 't', addedAt: 0 };

  it('maps a client rejection to {ok:false}', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    client.listWorkspaces.mockRejectedValueOnce(new Error('network down'));
    const fetchImpl = vi.fn(async () => jsonResponse({ allowInput: false }));
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_WORKSPACES_LIST)({}, 'h1') as { ok: boolean; error?: string };

    expect(res).toEqual({ ok: false, error: 'network down' });
  });

  it('returns workspaces on success', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    client.listWorkspaces.mockResolvedValueOnce({ workspaces: [{ id: 'w1', name: 'proj', panes: [] }] });
    const fetchImpl = vi.fn(async () => jsonResponse({ allowInput: false }));
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_WORKSPACES_LIST)({}, 'h1') as { ok: true; workspaces: unknown[] };

    expect(res.ok).toBe(true);
    expect(res.workspaces).toHaveLength(1);
  });

  it('reports unknown host without touching a client', async () => {
    const store = fakeStore([]);
    const fetchImpl = vi.fn();
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await getHandler(IPC.REMOTE_WORKSPACES_LIST)({}, 'missing') as { ok: boolean; error?: string };

    expect(res).toEqual({ ok: false, error: 'unknown host' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('remote.handler — workspaceCreate (#1001)', () => {
  const host: RemoteHost = { id: 'h1', label: 'box', origin: 'https://box:9600', token: 't', addedAt: 0 };

  it('bootstraps a new workspace and returns its sessionId', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    client.createWorkspace.mockResolvedValueOnce({ sessionId: 'web-9' });
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

    const res = await getHandler(IPC.REMOTE_WORKSPACE_CREATE)({}, 'h1', 'ws-brand-new') as { ok: true; sessionId: string };

    expect(res).toEqual({ ok: true, sessionId: 'web-9' });
    expect(client.createWorkspace).toHaveBeenCalledWith('ws-brand-new', undefined);
  });

  it('forwards cwd when given', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

    await getHandler(IPC.REMOTE_WORKSPACE_CREATE)({}, 'h1', 'ws-1', '/repo');

    expect(client.createWorkspace).toHaveBeenCalledWith('ws-1', '/repo');
  });

  it('maps a client rejection to {ok:false} rather than throwing', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    client.createWorkspace.mockRejectedValueOnce(new Error('unknown-workspace-id: workspaceId must match ...'));
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

    const res = await getHandler(IPC.REMOTE_WORKSPACE_CREATE)({}, 'h1', 'bad id') as { ok: false; error: string };

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/workspaceId must match/);
  });

  it('reports unknown host without touching a client', async () => {
    const store = fakeStore([]);
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never });

    const res = await getHandler(IPC.REMOTE_WORKSPACE_CREATE)({}, 'missing', 'ws-1') as { ok: boolean; error?: string };

    expect(res).toEqual({ ok: false, error: 'unknown host' });
  });
});

describe('remote.handler — pane attach/detach/write push routing', () => {
  const host: RemoteHost = { id: 'h1', label: 'box', origin: 'https://box:9600', token: 't', addedAt: 0 };

  it('wires client events to the attaching event.sender with the right channel names', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

    const sender = fakeSender(101);
    const res = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { ok: true; attachId: string };
    expect(res.ok).toBe(true);

    client.emitMeta({ attachId: res.attachId, cols: 80, rows: 24, snapshotB64: 'AA==' });
    // Geometry-only, on its own channel: the renderer re-grids without the
    // reset+repaint a META implies.
    client.emitResize({ attachId: res.attachId, cols: 100, rows: 40 });
    client.emitData({ attachId: res.attachId, dataB64: 'BB==' });
    client.emitExit({ attachId: res.attachId });

    expect(sender.sent).toEqual([
      { channel: IPC.REMOTE_PANE_META, payload: { attachId: res.attachId, cols: 80, rows: 24, snapshotB64: 'AA==' } },
      { channel: IPC.REMOTE_PANE_RESIZE, payload: { attachId: res.attachId, cols: 100, rows: 40 } },
      { channel: IPC.REMOTE_PANE_DATA, payload: { attachId: res.attachId, dataB64: 'BB==' } },
      { channel: IPC.REMOTE_PANE_EXIT, payload: { attachId: res.attachId } },
    ]);
  });

  it('never pushes to a destroyed sender', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

    const sender = fakeSender(102);
    const res = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { ok: true; attachId: string };
    sender.isDestroyed.mockReturnValue(true);

    client.emitData({ attachId: res.attachId, dataB64: 'BB==' });

    expect(sender.send).not.toHaveBeenCalled();
  });

  it('a duplicate attach for the same (sender, host, session) returns the existing attachId without a second SSE open', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

    const sender = fakeSender(103);
    const first = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { ok: true; attachId: string };
    const second = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { ok: true; attachId: string };

    expect(second.attachId).toBe(first.attachId);
    expect(client.attach).toHaveBeenCalledTimes(1);
  });

  it('a different session on the same sender opens a distinct attach', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

    const sender = fakeSender(104);
    const a = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { ok: true; attachId: string };
    const b = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-2') as { ok: true; attachId: string };

    expect(a.attachId).not.toBe(b.attachId);
    expect(client.attach).toHaveBeenCalledTimes(2);
  });

  it('an exit event detaches the dead attach and clears its idempotency key', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

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
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

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
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

    const sender = fakeSender(110);
    const { attachId } = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { attachId: string };

    getListener(IPC.REMOTE_PANE_WRITE)({}, attachId, 'hello');

    expect(client.write).toHaveBeenCalledWith(attachId, 'hello');
  });

  it('paneWrite for an unknown attachId is a silent no-op', () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

    expect(() => getListener(IPC.REMOTE_PANE_WRITE)({}, 'never-attached', 'hello')).not.toThrow();
    expect(client.write).not.toHaveBeenCalled();
  });

  it("sender 'destroyed' detaches every attachId it owns", async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

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
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

    const sender = fakeSender(107);
    const a = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { attachId: string };

    sender.fireGone();

    expect(client.detach).toHaveBeenCalledWith(a.attachId);
  });

  it("a main-frame, non-same-document 'did-start-navigation' (e.g. Cmd+R) detaches every attachId the sender owns", async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

    const sender = fakeSender(112);
    const a = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { attachId: string };
    const b = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-2') as { attachId: string };

    sender.fireNavigation(false, true); // isInPlace=false, isMainFrame=true

    expect(client.detach).toHaveBeenCalledWith(a.attachId);
    expect(client.detach).toHaveBeenCalledWith(b.attachId);
    expect(client.detach).toHaveBeenCalledTimes(2);

    // Idempotency keys were cleared too — a re-attach for the same
    // (sender, host, session) opens a fresh attach, not the dead one.
    client.attach.mockClear();
    await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1');
    expect(client.attach).toHaveBeenCalledTimes(1);
  });

  it("ignores a same-document 'did-start-navigation' (isInPlace)", async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

    const sender = fakeSender(113);
    await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1');

    sender.fireNavigation(true, true); // isInPlace=true — hash change/pushState, not a reload

    expect(client.detach).not.toHaveBeenCalled();
  });

  // M1 — a plain reload does NOT destroy the WebContents, so the SAME
  // sender re-enters installSenderCleanup on its next REMOTE_PANE_ATTACH.
  // Without removing the three listeners onGone installs, every
  // attach→navigation cycle stacks a duplicate set, and detach fires once
  // per stacked listener on the next cycle instead of once.
  it('two attach->navigation cycles on the same sender do not stack cleanup listeners', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

    const sender = fakeSender(120) as ReturnType<typeof fakeSender> & { listenerCounts: () => Record<string, number> };

    await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1');
    expect(sender.listenerCounts()).toEqual({ destroyed: 1, gone: 1, nav: 1 });

    // Cycle 1: a reload-style navigation fires onGone, which must remove
    // all three listeners it installed.
    sender.fireNavigation(false, true);
    expect(sender.listenerCounts()).toEqual({ destroyed: 0, gone: 0, nav: 0 });

    // Cycle 2: the next attach re-installs exactly one set, not a second
    // stacked set on top of a leftover first set.
    await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1');
    expect(sender.listenerCounts()).toEqual({ destroyed: 1, gone: 1, nav: 1 });

    client.detach.mockClear();
    sender.fireNavigation(false, true);
    // Exactly one detach for this cycle's single attach — not two, which is
    // what a stacked duplicate listener set would produce.
    expect(client.detach).toHaveBeenCalledTimes(1);
  });

  it("ignores a subframe 'did-start-navigation' (isMainFrame=false)", async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

    const sender = fakeSender(114);
    await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1');

    sender.fireNavigation(false, false); // isMainFrame=false — an iframe/subframe nav

    expect(client.detach).not.toHaveBeenCalled();
  });

  it('forwards a client onError to the owning sender on REMOTE_PANE_ERROR', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

    const sender = fakeSender(115);
    const { attachId } = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 'session-1') as { attachId: string };

    client.emitError({ attachId, message: 'gave up reconnecting' });

    expect(sender.sent).toContainEqual({
      channel: IPC.REMOTE_PANE_ERROR,
      payload: { attachId, message: 'gave up reconnecting' },
    });
  });

  it('a second sender is unaffected by the first sender being destroyed', async () => {
    const store = fakeStore([host]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

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
      store: store as never, attachments: fakeAttachments() as never,
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
    registerRemoteHandlers({ store: store as never, attachments: fakeAttachments() as never, clientFactory: () => client });

    const sender = fakeSender(201);
    await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 's1');

    const removed = await getHandler(IPC.REMOTE_HOSTS_REMOVE)({}, 'h1');

    expect(removed).toBe(true);
    expect(client.detachAll).toHaveBeenCalledTimes(1);
  });
});

describe('remote.handler — attachment descriptors', () => {
  const host: RemoteHost = { id: 'h1', label: 'box1', origin: 'https://box1:9600', token: 't1', addedAt: 0 };
  const descriptor: RemoteAttachmentDescriptor = {
    key: 'h1:ws-1',
    hostId: 'h1',
    hostLabel: 'box1',
    workspaceId: 'ws-1',
    name: 'Remote WS',
  };

  it('add → list roundtrips a descriptor', async () => {
    const store = fakeStore([host]);
    const attachments = fakeAttachments();
    registerRemoteHandlers({ store: store as never, attachments: attachments as never });

    await expect(getHandler(IPC.REMOTE_ATTACHMENTS_ADD)({}, descriptor)).resolves.toBe(true);
    await expect(getHandler(IPC.REMOTE_ATTACHMENTS_LIST)({})).resolves.toEqual([descriptor]);
  });

  it('strips a pane list off an add — panes are never persisted', async () => {
    const store = fakeStore([host]);
    const attachments = fakeAttachments();
    registerRemoteHandlers({ store: store as never, attachments: attachments as never });

    await getHandler(IPC.REMOTE_ATTACHMENTS_ADD)({}, { ...descriptor, panes: [{ sessionId: 's1' }] });
    expect(attachments.add).toHaveBeenCalledWith(descriptor);
  });

  it('refuses a descriptor for an unregistered host', async () => {
    const store = fakeStore();
    const attachments = fakeAttachments();
    registerRemoteHandlers({ store: store as never, attachments: attachments as never });

    await expect(getHandler(IPC.REMOTE_ATTACHMENTS_ADD)({}, descriptor)).resolves.toBe(false);
    expect(attachments.add).not.toHaveBeenCalled();
  });

  it('reports false rather than rejecting when the disk write fails', async () => {
    const store = fakeStore([host]);
    const attachments = fakeAttachments();
    attachments.add.mockImplementation(() => { throw new Error('EACCES'); });
    registerRemoteHandlers({ store: store as never, attachments: attachments as never });

    await expect(getHandler(IPC.REMOTE_ATTACHMENTS_ADD)({}, descriptor)).resolves.toBe(false);
  });

  it('remove drops the descriptor and reports whether it existed', async () => {
    const store = fakeStore([host]);
    const attachments = fakeAttachments([descriptor]);
    registerRemoteHandlers({ store: store as never, attachments: attachments as never });

    await expect(getHandler(IPC.REMOTE_ATTACHMENTS_REMOVE)({}, 'h1:ws-1')).resolves.toBe(true);
    await expect(getHandler(IPC.REMOTE_ATTACHMENTS_REMOVE)({}, 'h1:ws-1')).resolves.toBe(false);
    await expect(getHandler(IPC.REMOTE_ATTACHMENTS_LIST)({})).resolves.toEqual([]);
  });

  // Finding 9 — `key` is what every later lookup addresses the record by.
  it('refuses a descriptor whose key does not derive from its own ids', async () => {
    const store = fakeStore([host]);
    const attachments = fakeAttachments();
    registerRemoteHandlers({ store: store as never, attachments: attachments as never });

    await expect(getHandler(IPC.REMOTE_ATTACHMENTS_ADD)({}, { ...descriptor, key: 'h9:ws-9' })).resolves.toBe(false);
    await expect(getHandler(IPC.REMOTE_ATTACHMENTS_ADD)({}, { ...descriptor, key: 'ws-1' })).resolves.toBe(false);
    expect(attachments.add).not.toHaveBeenCalled();
  });

  it('refuses a remove for a key nothing could have minted', async () => {
    const store = fakeStore([host]);
    const attachments = fakeAttachments([descriptor]);
    registerRemoteHandlers({ store: store as never, attachments: attachments as never });

    await expect(getHandler(IPC.REMOTE_ATTACHMENTS_REMOVE)({}, 'no-separator')).resolves.toBe(false);
    await expect(getHandler(IPC.REMOTE_ATTACHMENTS_REMOVE)({}, ':ws-1')).resolves.toBe(false);
    await expect(getHandler(IPC.REMOTE_ATTACHMENTS_REMOVE)({}, 'h1:')).resolves.toBe(false);
    expect(attachments.remove).not.toHaveBeenCalled();
    await expect(getHandler(IPC.REMOTE_ATTACHMENTS_LIST)({})).resolves.toEqual([descriptor]);
  });

  // Finding 5 — the cascade runs AFTER the host is already gone from the
  // store, so letting it throw would report a completed removal as a failure.
  it('hostsRemove still reports success when the descriptor cascade fails', async () => {
    const store = fakeStore([host]);
    const attachments = fakeAttachments([descriptor]);
    attachments.removeByHost.mockImplementation(() => { throw new Error('EACCES'); });
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, attachments: attachments as never, clientFactory: () => client });
    // Clients are lazy — attach once so there is something left to tear down.
    await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender: fakeSender(202) }, 'h1', 's1');

    await expect(getHandler(IPC.REMOTE_HOSTS_REMOVE)({}, 'h1')).resolves.toBe(true);
    // The rest of the teardown still ran.
    expect(client.detachAll).toHaveBeenCalledTimes(1);
  });

  it('hostsRemove cascades into the descriptors of that host', async () => {
    const store = fakeStore([host]);
    const attachments = fakeAttachments([descriptor, { ...descriptor, key: 'h2:ws-1', hostId: 'h2' }]);
    registerRemoteHandlers({ store: store as never, attachments: attachments as never });

    await getHandler(IPC.REMOTE_HOSTS_REMOVE)({}, 'h1');
    expect(attachments.removeByHost).toHaveBeenCalledWith('h1');
    await expect(getHandler(IPC.REMOTE_ATTACHMENTS_LIST)({})).resolves.toEqual([
      { ...descriptor, key: 'h2:ws-1', hostId: 'h2' },
    ]);
  });

  it('a renderer reload tears down live SSE attaches but keeps the descriptors', async () => {
    const store = fakeStore([host]);
    const attachments = fakeAttachments([descriptor]);
    const client = fakeClient(host);
    registerRemoteHandlers({ store: store as never, attachments: attachments as never, clientFactory: () => client });

    const sender = fakeSender(300);
    const res = await getHandler(IPC.REMOTE_PANE_ATTACH)({ sender }, 'h1', 's1') as { ok: true; attachId: string };
    sender.fireNavigation(false, true);

    expect(client.detach).toHaveBeenCalledWith(res.attachId);
    // The descriptor survives — that is what the renderer restores from.
    await expect(getHandler(IPC.REMOTE_ATTACHMENTS_LIST)({})).resolves.toEqual([descriptor]);
  });
});
