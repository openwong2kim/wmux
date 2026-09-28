// a2a.task.query with view: 'page' (the a2a_task_query tool). A workspace with
// 135 tasks (~1.4 MB of history) made the daemon reply outgrow DaemonClient's
// 1 MiB control line: the line was dropped, the call sat out the 10 s RPC
// timeout, and the MCP call died with it. The paged view keeps every hop small:
// each source summarizes its own rows and main pages the merged list.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aRpc } from '../a2a.rpc';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';
import type { DaemonClient } from '../../../DaemonClient';
import { applyTaskQueryView } from '../../../../shared/a2aTaskQueryView';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('../../../../shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/constants')>()),
  getPidMapDir: () => '/tmp/wmux-test-pidmap',
}));

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** DaemonClient drops a control line over this size (MAX_LINE_BUFFER). */
const DAEMON_LINE_CAP = 1024 * 1024;
const WS = 'ws-r';

function task(index: number, messages: number, bodyChars: number, state = 'working'): Rec {
  const at = new Date(Date.UTC(2026, 8, 28, 0, index)).toISOString();
  return {
    kind: 'task',
    id: `task-${String(index).padStart(4, '0')}`,
    status: { state, timestamp: at },
    history: Array.from({ length: messages }, (_, m) => ({
      kind: 'message',
      messageId: `m-${index}-${m}`,
      role: m % 2 ? 'agent' : 'user',
      parts: [{ kind: 'text', text: `${m}:${'x'.repeat(bodyChars)}` }],
    })),
    artifacts: [],
    metadata: {
      title: `task ${index}`,
      from: { workspaceId: 'ws-s', name: 'Sender' },
      to: { workspaceId: WS, name: 'Receiver' },
      createdAt: at,
      updatedAt: at,
    },
  };
}

/** 150 tasks, ~9.6 KB of history each: ~1.4 MB, the live failure's size. */
const store = Array.from({ length: 150 }, (_, i) => task(i, 6, 1600));

interface Wire { daemonLineBytes: number[] }

/**
 * Renderer and daemon both answer from `rows` through the same view helper
 * their handlers use; the daemon client drops an oversized line the way
 * DaemonClient does (here as an immediate failure instead of a 10 s wait).
 */
function setup(rendererRows: Rec[], daemonRows: Rec[], opts: { legacyDaemon?: boolean } = {}): { router: RpcRouter; wire: Wire } {
  const wire: Wire = { daemonLineBytes: [] };
  sendToRendererMock.mockImplementation(async (_w: unknown, _m: string, params: Rec) =>
    ({ workspaceId: WS, tasks: applyTaskQueryView(rendererRows, params) }));
  const dc = {
    rpc: async (_method: string, params: Rec) => {
      const tasks = opts.legacyDaemon ? daemonRows : applyTaskQueryView(daemonRows, params);
      const line = JSON.stringify({ id: 'req-1', result: { ok: true, workspaceId: WS, tasks } });
      wire.daemonLineBytes.push(Buffer.byteLength(line, 'utf8'));
      if (line.length > DAEMON_LINE_CAP) throw new Error('RPC timeout: a2a.task.query (10000ms)');
      return JSON.parse(line).result;
    },
  } as unknown as DaemonClient;
  const router = new RpcRouter();
  registerA2aRpc(router, () => ({}) as BrowserWindow, {} as ClaudeWorker, { getDaemonClient: () => dc });
  return { router, wire };
}

async function query(router: RpcRouter, params: Rec): Promise<Rec> {
  const res = await router.dispatch({ id: 'q', method: 'a2a.task.query', params: { workspaceId: WS, ...params } });
  expect(res.ok).toBe(true);
  return (res as unknown as { result: Rec }).result;
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('a2a.task.query view: page — 150 tasks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('before: a legacy list call outgrows the daemon line; after: every hop stays small and fast', async () => {
    const legacy = setup(store, store);
    const full = await query(legacy.router, {});
    // Backward compatible: no view → every task in full, as before.
    expect(full.tasks).toHaveLength(150);
    expect(full.tasks[0].history).toHaveLength(6);
    const legacyDaemonLine = legacy.wire.daemonLineBytes[0];
    expect(legacyDaemonLine).toBeGreaterThan(DAEMON_LINE_CAP); // dropped → 10 s timeout live

    const paged = setup(store, store);
    const started = performance.now();
    const page = await query(paged.router, { view: 'page' });
    const elapsedMs = performance.now() - started;
    const pagedDaemonLine = paged.wire.daemonLineBytes[0];
    expect(pagedDaemonLine).toBeLessThan(DAEMON_LINE_CAP / 8);
    expect(bytes(page)).toBeLessThan(64 * 1024);
    expect(elapsedMs).toBeLessThan(1000);
    expect(page.total).toBe(150);
    expect(page.tasks).toHaveLength(20);
    expect(page.tasks[0]).toMatchObject({ id: 'task-0149', messageCount: 6, state: 'working' });
    expect(page.tasks[0]).not.toHaveProperty('history');
    // The renderer hop carried summaries, not histories.
    expect(sendToRendererMock.mock.calls.at(-1)?.[2]).toMatchObject({ view: 'page' });

    // Every task is reachable by paging, each exactly once.
    const seen = page.tasks.map((t: Rec) => t.id);
    let cursor = page.nextCursor as string | undefined;
    while (cursor) {
      const next = await query(paged.router, { view: 'page', cursor, limit: 100 });
      seen.push(...next.tasks.map((t: Rec) => t.id));
      cursor = next.nextCursor;
    }
    expect(new Set(seen).size).toBe(150);

    if (process.env.WMUX_A2A_QUERY_BENCH) {
      console.log(JSON.stringify({ legacyDaemonLine, legacyResult: bytes(full), pagedDaemonLine, pagedResult: bytes(page), elapsedMs }));
    }
  });

  it('task_id sends only that task over each hop and returns it in full', async () => {
    const { router, wire } = setup(store, store);
    const detail = await query(router, { view: 'page', taskId: 'task-0042' });
    expect(detail.task.id).toBe('task-0042');
    expect(detail.task.history).toHaveLength(6);
    expect(wire.daemonLineBytes[0]).toBeLessThan(20_000);
  });

  it('merges summaries: a newer daemon state wins, daemon-only tasks join, the status filter applies after', async () => {
    const stale = task(1, 2, 10);
    const canonical = { ...task(1, 0, 10, 'completed'), metadata: { ...stale.metadata, updatedAt: '2026-09-28T05:00:00.000Z' } };
    const survivor = task(2, 1, 10);
    const { router } = setup([stale], [canonical, survivor]);

    const all = await query(router, { view: 'page' });
    const byId = new Map(all.tasks.map((t: Rec) => [t.id, t]));
    expect(byId.get(stale.id)).toMatchObject({ state: 'completed', updatedAt: '2026-09-28T05:00:00.000Z', messageCount: 2 });
    expect(byId.get(survivor.id)).toMatchObject({ state: 'working' });

    const working = await query(router, { view: 'page', status: 'working' });
    expect(working.tasks.map((t: Rec) => t.id)).toEqual([survivor.id]);
  });

  it('summarizes the full tasks of a daemon that predates the paged view', async () => {
    const { router } = setup([], [task(3, 2, 10)], { legacyDaemon: true });
    const page = await query(router, { view: 'page' });
    expect(page.tasks).toHaveLength(1);
    expect(page.tasks[0]).toMatchObject({ id: 'task-0003', messageCount: 2 });
    expect(page.tasks[0]).not.toHaveProperty('history');
  });

  it('gives the daemon a short deadline only on a paged call', async () => {
    const timeouts: unknown[] = [];
    sendToRendererMock.mockResolvedValue({ workspaceId: WS, tasks: [] });
    const dc = {
      rpc: async (_m: string, _p: Rec, opts?: { timeoutMs?: number }) => {
        timeouts.push(opts?.timeoutMs);
        return { ok: true, tasks: [] };
      },
    } as unknown as DaemonClient;
    const router = new RpcRouter();
    registerA2aRpc(router, () => ({}) as BrowserWindow, {} as ClaudeWorker, { getDaemonClient: () => dc });
    await query(router, {});
    await query(router, { view: 'page' });
    expect(timeouts[0]).toBeUndefined();
    expect(timeouts[1]).toBeLessThan(10_000);
  });
});

describe('a2a.task.query view: page — #1598 orphaned tasks', () => {
  beforeEach(() => vi.clearAllMocks());

  const pinned = (index: number, paneId: string): Rec => {
    const t = task(index, 1, 10, 'submitted');
    return { ...t, metadata: { ...t.metadata, to: { ...t.metadata.to, paneId } } };
  };
  // Renderer holds the live-pane task; the daemon alone holds the one whose
  // pane closed in an earlier session (a restart survivor).
  const live = pinned(1, 'pane-live');
  const gone = pinned(2, 'pane-gone');

  function setupPanes(panes: unknown): RpcRouter {
    sendToRendererMock.mockImplementation(async (_w: unknown, method: string, params: Rec) => (method === 'pane.list'
      ? panes
      : { workspaceId: WS, tasks: applyTaskQueryView([live], params) }));
    const dc = { rpc: async (_m: string, params: Rec) => ({ ok: true, workspaceId: WS, tasks: applyTaskQueryView([live, gone], params) }) } as unknown as DaemonClient;
    const router = new RpcRouter();
    registerA2aRpc(router, () => ({}) as BrowserWindow, {} as ClaudeWorker, { getDaemonClient: () => dc });
    return router;
  }

  it('flags a task whose receiver pane is gone, in the list and in the full task', async () => {
    const router = setupPanes([{ id: 'pane-live', surfacePtyIds: ['pty-1'] }]);
    const list = await query(router, { view: 'page' });
    const byId = Object.fromEntries(list.tasks.map((t: Rec) => [t.id, t]));
    expect(byId[gone.id].orphaned).toBe(true);
    expect(byId[live.id].orphaned).toBeUndefined();
    const one = await query(router, { view: 'page', taskId: gone.id });
    expect(one.task.orphaned).toBe(true);
  });

  it('does not flag an ended task whose receiver pane is gone', async () => {
    const ended: Rec = { ...gone, status: { ...gone.status, state: 'completed' } };
    sendToRendererMock.mockImplementation(async (_w: unknown, method: string, params: Rec) => (method === 'pane.list'
      ? [{ id: 'pane-live', surfacePtyIds: ['pty-1'] }]
      : { workspaceId: WS, tasks: applyTaskQueryView([live], params) }));
    const dc = { rpc: async (_m: string, params: Rec) => ({ ok: true, workspaceId: WS, tasks: applyTaskQueryView([live, ended], params) }) } as unknown as DaemonClient;
    const router = new RpcRouter();
    registerA2aRpc(router, () => ({}) as BrowserWindow, {} as ClaudeWorker, { getDaemonClient: () => dc });
    const list = await query(router, { view: 'page' });
    expect(list.tasks.find((t: Rec) => t.id === ended.id)?.orphaned).toBeUndefined();
  });

  it('flags nothing when the workspace is not in the pane tree yet (empty pane list)', async () => {
    const router = setupPanes([]);
    const list = await query(router, { view: 'page' });
    expect(list.tasks.some((t: Rec) => t.orphaned)).toBe(false);
  });

  it('flags nothing when the pane tree is unreadable, and ignores a wire-supplied pane list', async () => {
    const router = setupPanes(null);
    const list = await query(router, { view: 'page', livePaneIds: ['pane-x'] });
    expect(list.tasks.some((t: Rec) => t.orphaned)).toBe(false);
  });
});
