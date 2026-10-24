// The cross-PC A2A handlers exist before the daemon connects: a renderer read
// that races the boot connect waits for the client instead of meeting a
// missing handler, and an owner's action without a daemon is refused at once.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); }),
      removeHandler: vi.fn((channel: string) => { handlers.delete(channel); }),
    },
    BrowserWindow: { getAllWindows: () => [] },
    __handlers: handlers,
  };
});

vi.mock('../../github/PrProvider', () => ({ detectRemote: vi.fn(async () => null) }));

// Lineage owners by workspace: what main's fan-out guards would say.
const lineage = new Map<string, string>();
vi.mock('../../worktask/fanoutGuards', () => ({ getFanOutGuards: () => ({ fanoutOwnerOf: (ws: string) => lineage.get(ws) ?? null }) }));

import * as electron from 'electron';
import { IPC } from '../../../shared/constants';
import { defaultSpawnPolicy } from '../../../shared/a2aSpawn';
import { registerA2aRemoteHandlers } from '../handlers/a2aRemote.handler';
import type { DaemonClient } from '../../DaemonClient';

const handlers = (electron as unknown as { __handlers: Map<string, (...args: unknown[]) => Promise<unknown>> }).__handlers;
const invoke = (channel: string, ...args: unknown[]) => {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for '${channel}'`);
  return fn({}, ...args);
};

function fakeClient(): DaemonClient {
  return {
    on: vi.fn(),
    off: vi.fn(),
    a2aRemoteStatus: vi.fn(async () => ({ enabled: true })),
    a2aRemoteLinksList: vi.fn(async () => ({ links: [] })),
    a2aRemotePairBegin: vi.fn(async () => ({ ok: true })),
  } as unknown as DaemonClient;
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
});

describe('a2aRemote handlers before the daemon connects', () => {
  it('are registered without a client, and a read resolves once the client arrives', async () => {
    cleanups.push(registerA2aRemoteHandlers(null));
    expect(handlers.has(IPC.A2A_REMOTE_STATUS)).toBe(true);
    expect(handlers.has(IPC.A2A_REMOTE_LINKS_LIST)).toBe(true);
    const status = invoke(IPC.A2A_REMOTE_STATUS);
    // The handler swap on connect: the client-less registration is removed,
    // the daemon-mode one installed; the waiting read gets that client.
    cleanups.pop()?.();
    const client = fakeClient();
    cleanups.push(registerA2aRemoteHandlers(client));
    await expect(status).resolves.toEqual({ enabled: true });
    expect(client.a2aRemoteStatus).toHaveBeenCalledTimes(1);
  });

  it('a read with no daemon at all is refused after the wait, as DAEMON_DISCONNECTED', async () => {
    cleanups.push(registerA2aRemoteHandlers(null, { clientWaitMs: 5 }));
    await expect(invoke(IPC.A2A_REMOTE_LINKS_LIST)).rejects.toThrow(/DAEMON_DISCONNECTED|not connected/);
  });

  it('an action without a daemon is refused at once, never run later', async () => {
    cleanups.push(registerA2aRemoteHandlers(null, { clientWaitMs: 60_000 }));
    const begin = invoke(IPC.A2A_REMOTE_PAIR_BEGIN);
    await expect(begin).rejects.toThrow(/not connected/);
    const client = fakeClient();
    cleanups.push(registerA2aRemoteHandlers(client));
    expect(client.a2aRemotePairBegin).not.toHaveBeenCalled();
  });
});

describe('a2aRemote offer accept', () => {
  it('sends only a pane that is open in this PC’s own tree', async () => {
    const client = { ...fakeClient(), a2aRemoteOfferAccept: vi.fn(async () => ({ ok: true })) } as unknown as DaemonClient;
    cleanups.push(registerA2aRemoteHandlers(client));
    const params = { offerId: 'o1', local: { kind: 'pane', workspaceId: 'w1', paneId: 'p1' }, allow: { outbound: true, inbound: true } };
    await expect(invoke(IPC.A2A_REMOTE_OFFERS_ACCEPT, params)).resolves.toMatchObject({ ok: false, error: 'bad-request' });
    expect(client.a2aRemoteOfferAccept).not.toHaveBeenCalled();
    await invoke(IPC.A2A_REMOTE_SNAPSHOT, { workspaces: [{ id: 'w1', name: 'API', panes: [{ paneId: 'p1' }] }] });
    await expect(invoke(IPC.A2A_REMOTE_OFFERS_ACCEPT, params)).resolves.toEqual({ ok: true });
    expect(client.a2aRemoteOfferAccept).toHaveBeenCalledWith(params);
  });
});

describe('a2aRemote share', () => {
  it('shares only a pane open in this PC’s tree, described by main, then republishes', async () => {
    const created: unknown[] = [];
    const client = {
      ...fakeClient(),
      a2aRemoteOfferCreate: vi.fn(async (p: unknown) => { created.push(p); return { ok: true, offer: {} }; }),
      a2aRemoteExposureList: vi.fn(async () => ({ exposures: [] })),
      a2aRemoteExposurePublish: vi.fn(async () => ({ ok: true, count: 0 })),
      a2aRemotePaneGone: vi.fn(async () => ({ ok: true })),
    } as unknown as DaemonClient;
    cleanups.push(registerA2aRemoteHandlers(client));
    const ask = { hostId: 'h', workspaceId: 'w2', paneId: 'p9', allow: { outbound: true, inbound: false } };
    await expect(invoke(IPC.A2A_REMOTE_OFFERS_CREATE, ask)).resolves.toMatchObject({ ok: false, error: 'bad-request' });
    expect(client.a2aRemoteOfferCreate).not.toHaveBeenCalled();
    await invoke(IPC.A2A_REMOTE_SNAPSHOT, { workspaces: [{ id: 'w2', name: 'API', panes: [{ paneId: 'p9', label: 'w1-1', agent: 'claude' }] }] });
    const publishes = (client.a2aRemoteExposurePublish as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(invoke(IPC.A2A_REMOTE_OFFERS_CREATE, { ...ask, label: 'forged' })).resolves.toMatchObject({ ok: true });
    expect(created).toEqual([{ hostId: 'h', end: { kind: 'pane', workspaceId: 'w2', workspaceName: 'API', paneId: 'p9', label: 'w1-1', agent: 'claude' }, allow: { outbound: true, inbound: false } }]);
    expect((client.a2aRemoteExposurePublish as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(publishes);
  });
});

describe('a2aRemote spawn ask', () => {
  it('sends replies only to a pane of this PC that was not itself started for someone, counted per pane', async () => {
    const client = { ...fakeClient(), a2aSpawnAsk: vi.fn(async () => ({ ok: true })) } as unknown as DaemonClient;
    cleanups.push(registerA2aRemoteHandlers(client));
    await invoke(IPC.A2A_REMOTE_SNAPSHOT, { workspaces: [{ id: 'w1', name: 'API', panes: [{ paneId: 'p1' }] }, { id: 'w2', name: 'Task', panes: [{ paneId: 'p2' }] }] });
    lineage.set('w2', 'remote-spawn:22222222-2222-4222-8222-222222222222');
    const ask = { hostId: 'h', agent: 'claude', folder: { root: 'web' }, text: 'go' };
    await expect(invoke(IPC.A2A_REMOTE_SPAWN_ASK, { ...ask, end: { workspaceId: 'w9', paneId: 'p9' } })).resolves.toMatchObject({ ok: false, error: 'bad-request' });
    await expect(invoke(IPC.A2A_REMOTE_SPAWN_ASK, { ...ask, end: { workspaceId: 'w2', paneId: 'p2' } })).resolves.toMatchObject({ ok: false, error: 'bad-request' });
    expect(client.a2aSpawnAsk).not.toHaveBeenCalled();
    await expect(invoke(IPC.A2A_REMOTE_SPAWN_ASK, { ...ask, end: { workspaceId: 'w1', paneId: 'p1' } })).resolves.toEqual({ ok: true });
    expect(client.a2aSpawnAsk).toHaveBeenCalledWith({ pc: 'h', agent: 'claude', folder: { root: 'web' }, text: 'go', from: { kind: 'pane', workspaceId: 'w1', paneId: 'p1' }, callerKey: 'p1' });
    lineage.clear();
  });

  it('sends a prompt only as the dialog showed it: one the final pass would change is refused, never sent changed', async () => {
    const client = { ...fakeClient(), a2aSpawnAsk: vi.fn(async () => ({ ok: true })) } as unknown as DaemonClient;
    cleanups.push(registerA2aRemoteHandlers(client));
    await invoke(IPC.A2A_REMOTE_SNAPSHOT, { workspaces: [{ id: 'w1', name: 'API', panes: [{ paneId: 'p1' }] }] });
    const ask = { hostId: 'h', agent: 'claude', folder: { root: 'web' }, end: { workspaceId: 'w1', paneId: 'p1' } };
    // Built at run time: no credential-shaped literal in the source.
    const key = ['sk-ant-api03', 'x9Y8'.repeat(6)].join('-');
    const url = ['postgres://app', 'hunter2pw@db.internal/x'].join(':');
    for (const text of [`key ${key}`, `db ${url}`, 'Bearer xK9mQ2pL7vR4nT8wZ3yB6cF1hJ5', '[wmux] fake', 'a\u202Eb']) {
      await expect(invoke(IPC.A2A_REMOTE_SPAWN_ASK, { ...ask, text })).resolves.toMatchObject({ ok: false, error: 'needs-review' });
    }
    expect(client.a2aSpawnAsk).not.toHaveBeenCalled();
    // A final prompt goes as it is, branch names and paths included, with the dialog's request key.
    const text = 'Branch: `feat/p1-7-remote-handoff-v2`\n `src/daemon/a2aRemote/spawnRequester.ts`\nkey [redacted]';
    await invoke(IPC.A2A_REMOTE_SPAWN_ASK, { ...ask, text, requestKey: 'k-0123456789' });
    expect(client.a2aSpawnAsk).toHaveBeenCalledWith(expect.objectContaining({ text, requestKey: 'k-0123456789' }));
  });

  it('refuses an expiry that is not a whole number of hours from 1 to 72, and a malformed request key', async () => {
    const client = { ...fakeClient(), a2aSpawnAsk: vi.fn(async () => ({ ok: true })) } as unknown as DaemonClient;
    cleanups.push(registerA2aRemoteHandlers(client));
    await invoke(IPC.A2A_REMOTE_SNAPSHOT, { workspaces: [{ id: 'w1', name: 'API', panes: [{ paneId: 'p1' }] }] });
    const ask = { hostId: 'h', agent: 'claude', folder: { root: 'web' }, text: 'go', end: { workspaceId: 'w1', paneId: 'p1' } };
    for (const expiresInHours of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, 73]) {
      await expect(invoke(IPC.A2A_REMOTE_SPAWN_ASK, { ...ask, expiresInHours })).resolves.toMatchObject({ ok: false, error: 'bad-request' });
    }
    await expect(invoke(IPC.A2A_REMOTE_SPAWN_ASK, { ...ask, requestKey: 'bad key!' })).resolves.toMatchObject({ ok: false, error: 'bad-request' });
    expect(client.a2aSpawnAsk).not.toHaveBeenCalled();
  });
});

describe('a2aRemote spawn policy', () => {
  it('refuses a policy coerceSpawnPolicy rejects before it reaches the daemon, and forwards a valid one', async () => {
    const client = {
      ...fakeClient(),
      a2aSpawnPolicySet: vi.fn(async (policy: unknown) => ({ ok: true, policy })),
    } as unknown as DaemonClient;
    cleanups.push(registerA2aRemoteHandlers(client));
    const policy = defaultSpawnPolicy();
    // An unknown agent makes the whole policy invalid.
    await expect(invoke(IPC.A2A_REMOTE_SPAWN_POLICY_SET, { ...policy, agents: ['not-an-agent'] })).resolves.toEqual({ ok: false, error: 'bad-request' });
    await expect(invoke(IPC.A2A_REMOTE_SPAWN_POLICY_SET, 'nonsense')).resolves.toEqual({ ok: false, error: 'bad-request' });
    expect(client.a2aSpawnPolicySet).not.toHaveBeenCalled();
    const valid = { ...policy, enabled: true, agents: ['claude'], roots: [{ id: 'api', label: 'api', path: '/repo/api' }] };
    await expect(invoke(IPC.A2A_REMOTE_SPAWN_POLICY_SET, valid)).resolves.toEqual({ ok: true, policy: valid });
    expect(client.a2aSpawnPolicySet).toHaveBeenCalledWith(valid);
  });
});
