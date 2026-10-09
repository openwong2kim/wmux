import { describe, it, expect, vi } from 'vitest';
import type { RemoteHost } from '../../../shared/remoteHosts';
import { fetchPcRailApprovals, fetchPcRailWorkspaces, normalizePcRailWorkspaces } from '../pcRailFeed';
import { PcRailHub, nextPcRailPollDelay, type PcRailHubDeps } from '../pcRailHub';
import { PcRailAttentionStream } from '../pcRailAttention';
import type { PcRailFeedEvent } from '../pcRailWire';

const host = (id: string, origin = `https://${id}.tail.ts.net`): RemoteHost => ({
  id, label: id, origin, token: `tok-${id}`, addedAt: 1,
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe('normalizePcRailWorkspaces', () => {
  it('keeps the sidebar extras and the host focus, drops unusable rows and repeats', () => {
    const out = normalizePcRailWorkspaces({
      activeWorkspaceId: 'w1',
      workspaces: [
        { id: 'w1', name: 'one', order: 2, pinned: true, color: 'blue', gitBranch: 'main', panes: [{ sessionId: 's1', agentName: 'claude', agentStatus: 'complete' }] },
        { id: 'w1', name: 'dup', panes: [{ sessionId: 's9' }] },
        { id: 'w2', name: 'no panes', panes: [] },
        { id: 'w3', name: 'empty', empty: true, panes: [] },
        { id: 'w4', name: 'reused session', panes: [{ sessionId: 's1' }] },
        { id: 'x'.repeat(500), name: 'long id', panes: [{ sessionId: 's5' }] },
      ],
    });
    expect(out.activeWorkspaceId).toBe('w1');
    expect(out.workspaces.map((w) => w.id)).toEqual(['w1', 'w3']);
    expect(out.workspaces[0]).toMatchObject({ order: 2, pinned: true, gitBranch: 'main', panes: [{ sessionId: 's1', agentStatus: 'complete' }] });
    expect(out.workspaces[1]).toMatchObject({ empty: true, panes: [] });
  });

  it('caps rows and drops a focus that is not listed', () => {
    const workspaces = Array.from({ length: 400 }, (_, i) => ({ id: `w${i}`, name: '', panes: [{ sessionId: `s${i}` }] }));
    const out = normalizePcRailWorkspaces({ workspaces, activeWorkspaceId: 'gone' });
    expect(out.workspaces).toHaveLength(256);
    expect(out.activeWorkspaceId).toBeUndefined();
  });
});

describe('pcRail fetches', () => {
  it('maps statuses and never contacts an insecure host', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('revoked')) return json({}, 401);
      if (url.includes('down')) throw new TypeError('fetch failed');
      return json({ workspaces: [] });
    }) as unknown as typeof fetch;
    expect(await fetchPcRailWorkspaces(host('revoked'), fetchImpl)).toEqual({ ok: false, reason: 'auth-rejected' });
    expect(await fetchPcRailWorkspaces(host('down'), fetchImpl)).toEqual({ ok: false, reason: 'unreachable' });
    expect(await fetchPcRailWorkspaces(host('lan', 'http://192.168.0.5:9600'), fetchImpl)).toEqual({ ok: false, reason: 'insecure-transport' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses a body over the cap', async () => {
    const big = 'x'.repeat(1024 * 1024 + 10);
    const fetchImpl = vi.fn(async () => new Response(`{"pending":["${big}"]}`)) as unknown as typeof fetch;
    expect(await fetchPcRailApprovals(host('a'), fetchImpl)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('reads the pending approvals', async () => {
    const fetchImpl = vi.fn(async () => json({ pending: [{ id: 'a1', sessionId: 's1', state: 'pending' }], recentlyResolved: [] })) as unknown as typeof fetch;
    expect(await fetchPcRailApprovals(host('a'), fetchImpl)).toEqual({ ok: true, approvals: [{ id: 'a1', sessionId: 's1' }] });
  });
});

describe('nextPcRailPollDelay', () => {
  it('polls every 10 s and backs off an unreachable host', () => {
    expect(nextPcRailPollDelay(0)).toBe(10_000);
    expect([1, 2, 3, 9].map((n) => nextPcRailPollDelay(n, 'unreachable'))).toEqual([20_000, 40_000, 60_000, 60_000]);
    expect(nextPcRailPollDelay(1, 'auth-rejected')).toBe(60_000);
  });
});

function hubWith(hosts: RemoteHost[], fetchImpl: typeof fetch, extra: Partial<PcRailHubDeps> = {}) {
  const feeds: PcRailFeedEvent[] = [];
  const toasts: string[] = [];
  const handlers = new Map<string, Parameters<NonNullable<PcRailHubDeps['streamFactory']>>[1]>();
  const hub = new PcRailHub({
    hosts: { list: () => hosts.map(({ token: _t, ...pub }) => pub), get: (id) => hosts.find((h) => h.id === id) ?? null },
    attachedHostIds: () => new Set(),
    feed: (e) => feeds.push(e),
    frame: () => undefined,
    stream: () => undefined,
    toast: (_hostId, label, n) => toasts.push(`${label}:${n.title}`),
    fetchImpl,
    setTimeoutImpl: () => ({ unref() { /* never fires */ } }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeoutImpl: () => undefined,
    streamFactory: (h, hs) => {
      handlers.set(h.id, hs);
      return { start: () => undefined, stop: () => undefined };
    },
    ...extra,
  });
  return { hub, feeds, toasts, handlers };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PcRailHub', () => {
  it('a slow host does not hold back another host', async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url.startsWith('https://slow.')) return new Promise<Response>(() => undefined);
      if (url.endsWith('/api/approvals')) return Promise.resolve(json({ pending: [] }));
      if (url.endsWith('/api/config')) return Promise.resolve(json({ allowInput: true }));
      return Promise.resolve(json({ workspaces: [{ id: 'w', name: 'w', panes: [{ sessionId: 's' }] }] }));
    }) as unknown as typeof fetch;
    const { hub, feeds } = hubWith([host('slow'), host('fast')], fetchImpl);
    hub.start();
    await flush();
    await flush();
    expect(feeds[0]).toEqual({ type: 'hosts', hosts: [{ id: 'slow', label: 'slow' }, { id: 'fast', label: 'fast' }] });
    const fast = feeds.find((e) => e.type === 'feed' && e.hostId === 'fast');
    expect(fast).toMatchObject({ ok: true, approvals: [], allowInput: true });
    expect(feeds.some((e) => e.type === 'feed' && e.hostId === 'slow')).toBe(false);
    hub.stop();
  });

  it('flags an insecure host without contacting it', () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { hub, feeds, handlers } = hubWith([host('lan', 'http://192.168.0.5:9600')], fetchImpl);
    hub.start();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(handlers.size).toBe(0);
    expect(feeds).toContainEqual(expect.objectContaining({ type: 'feed', hostId: 'lan', ok: false, reason: 'insecure-transport' }));
    hub.stop();
  });

  it('a muted host still feeds but never toasts', () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const { hub, toasts, handlers } = hubWith([host('a'), host('b')], fetchImpl);
    hub.setMuted(['a']);
    hub.start();
    const n = { sessionId: 's', title: 'Approval needed', body: '', type: 'warning' as const, category: 'approval' as const };
    handlers.get('a')!.onNotification('a', n);
    handlers.get('b')!.onNotification('b', n);
    expect(toasts).toEqual(['b:Approval needed']);
    hub.stop();
  });
});

describe('PcRailAttentionStream', () => {
  it('forwards only frames after the reset head, and reports open', async () => {
    const sse = [
      'event: reset\ndata: {"epoch":"e","headId":5}\n\n',
      'event: critical\ndata: {"sessionId":"old","id":4,"epoch":"e","tier":"act"}\n\n',
      'event: approval\ndata: {"sessionId":"s1","approvalId":"a1","phase":"create","tier":"act","id":6,"epoch":"e"}\n\n',
    ].join('');
    const fetchImpl = vi.fn(async () => new Response(sse)) as unknown as typeof fetch;
    const frames: unknown[] = [];
    const states: string[] = [];
    const toasts: string[] = [];
    const stream = new PcRailAttentionStream({
      host: host('a'),
      fetchImpl,
      onFrame: (kind, data) => frames.push([kind, (data as { sessionId: string }).sessionId]),
      onState: (s) => states.push(s),
      onNotification: (_l, n) => toasts.push(n.sessionId),
      setTimeoutImpl: () => ({ unref() { /* never fires */ } }) as unknown as ReturnType<typeof setTimeout>,
      clearTimeoutImpl: () => undefined,
    });
    stream.start();
    await flush();
    await flush();
    await flush();
    expect(frames).toEqual([['approval', 's1']]);
    expect(toasts).toEqual(['s1']);
    expect(states[0]).toBe('open');
    stream.stop();
  });
});

describe('normalizePcRailWorkspaces layout', () => {
  it('keeps a bounded layout and limits unplaced to the row sessions', () => {
    const layout = { root: { kind: 'leaf', paneId: 'p1', activeIndex: 0, surfaces: [{ surfaceId: 'sf1', kind: 'terminal', ptyId: 's1' }] }, activePaneId: 'p1', unplaced: ['s2', 'elsewhere', 's2'] };
    const out = normalizePcRailWorkspaces({ workspaces: [{ id: 'w1', name: 'one', layout, panes: [{ sessionId: 's1' }, { sessionId: 's2' }] }] });
    expect(out.workspaces[0].layout).toMatchObject({ activePaneId: 'p1', unplaced: ['s2'] });
    const deep = { kind: 'split', direction: 'horizontal', children: [] as unknown[] };
    let node = deep;
    for (let i = 0; i < 40; i++) { const next = { kind: 'split', direction: 'horizontal', children: [] as unknown[] }; node.children.push(next); node = next; }
    const deepOut = normalizePcRailWorkspaces({ workspaces: [{ id: 'w2', name: 'deep', layout: { root: deep }, panes: [{ sessionId: 's9' }] }] });
    expect(deepOut.workspaces[0].layout).toBeUndefined();
  });
});

describe('pcRail review fixes', () => {
  it('a layout tab may only name a session of its own row', () => {
    const leaf = (paneId: string, ptyId: string, surfaceId: string) => ({ kind: 'leaf', paneId, activeIndex: 0, surfaces: [{ surfaceId, kind: 'terminal', ptyId }] });
    const layout = {
      root: { kind: 'split', direction: 'horizontal', sizes: [34, 33, 33], children: [leaf('p1', 's1', 'a'), leaf('p2', 'other-ws', 'b'), leaf('p3', 'cut-by-limit', 'c')] },
      unplaced: ['other-ws'],
    };
    const out = normalizePcRailWorkspaces({
      workspaces: [
        { id: 'w1', name: 'one', layout, panes: [{ sessionId: 's1' }, { sessionId: 's2' }] },
        { id: 'w2', name: 'two', panes: [{ sessionId: 'other-ws' }] },
      ],
    });
    const root = out.workspaces[0].layout?.root as unknown as { children: Array<{ surfaces: Array<{ ptyId?: string }> }> };
    expect(root.children.map((c) => c.surfaces[0].ptyId)).toEqual(['s1', undefined, undefined]);
    expect(out.workspaces[0].layout?.unplaced).toEqual(['s2']);
  });

  it('sends the roster before the failure feed of an insecure host added later', () => {
    const list: RemoteHost[] = [host('a')];
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const { hub, feeds } = hubWith(list, fetchImpl);
    hub.start();
    list.push(host('lan', 'http://192.168.0.5:9600'));
    hub.sync();
    const rosterAt = feeds.findIndex((e) => e.type === 'hosts' && e.hosts.some((h) => h.id === 'lan'));
    const failAt = feeds.findIndex((e) => e.type === 'feed' && e.hostId === 'lan');
    expect(rosterAt).toBeGreaterThanOrEqual(0);
    expect(failAt).toBeGreaterThan(rosterAt);
    hub.stop();
  });

  it('a tick whose approvals read failed says so', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/api/approvals')) return json({}, 503);
      if (url.endsWith('/api/config')) return json({ allowInput: false });
      return json({ workspaces: [] });
    }) as unknown as typeof fetch;
    const { hub, feeds } = hubWith([host('a')], fetchImpl);
    hub.start();
    await flush();
    await flush();
    await flush();
    const tick = feeds.find((e) => e.type === 'feed');
    expect(tick).toMatchObject({ ok: true, approvalsError: 'unavailable' });
    expect(tick && 'approvals' in tick).toBe(false);
    expect(tick).toHaveProperty('listRequestedAt');
    hub.stop();
  });
});
