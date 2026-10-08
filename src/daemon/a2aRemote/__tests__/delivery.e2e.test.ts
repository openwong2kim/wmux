// In-process end to end for layer 4: two "PCs" (server B, joiner A), each with
// its own stores, task ledger, delivery layer and a real A2aServer on loopback
// TLS. main is played by RemoteA2aBridge over the daemon RPCs; the renderer is
// a fake that records what it was handed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2A_ROUTES, formatPeerCredential, type A2aLinkRecordV1 } from '../../../shared/a2aRemote';
import { A2A_REMOTE_NOTIFY_METHOD, A2A_REMOTE_RPC } from '../../../shared/a2aRemoteDelivery';
import type { DaemonConfig } from '../../types';
import { RemoteA2aBridge } from '../../../main/a2a/RemoteA2aBridge';
import { CommanderEventCoalescer, type CoalescerInput } from '../../../main/deck/CommanderEventCoalescer';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aRemoteController } from '../controller';
import { A2aRemoteDelivery } from '../delivery';
import { ExposedPaneCache } from '../exposedPanes';
import { ExposureStore } from '../exposureStore';
import { joinRemoteHost } from '../joiner';
import { registerA2aLinkRpc } from '../linkRpc';
import { LinkStore } from '../linkStore';
import { PeerStore } from '../peerStore';
import { PinnedClientError, PinnedTlsClient, type PinnedClientOptions } from '../pinnedClient';
import { RemoteHostStore } from '../remoteHostStore';
import { createA2aRoutes } from '../routes';
import { A2aServer } from '../server';
import type { SessionClient } from '../session';
import { freePort } from './a2aServerRig';

// Two PCs each mint a certificate and every step is a TLS handshake: slow CI
// runners (Windows) need far more than the default per-test budget.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });

const FAST = { connectMs: 5_000, requestMs: 10_000 };
const TIMING = { backoffMinMs: 30, backoffMaxMs: 150, livenessMs: 10_000, connectMs: 5_000, requestMs: 10_000 };

type Rpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

interface Pc {
  name: string;
  dir: string;
  port: number;
  hostId: string;
  links: LinkStore;
  remoteHosts: RemoteHostStore;
  peers: PeerStore;
  tasks: A2aTaskService;
  server: A2aServer;
  delivery: A2aRemoteDelivery;
  bridge: RemoteA2aBridge;
  rpc: Rpc;
  /** What the fake renderer was handed. */
  rendered: Array<{ method: string; params: Record<string, unknown> }>;
  /** What main's bridge put on this PC's event bus (brain-link work). */
  emitted: Array<Record<string, unknown>>;
  /** This PC's Moa can take work (the deck's probe); `changed` tells the bridge. */
  moa: { ready: boolean; changed: () => void };
  /** Envelopes this PC's routes accepted from a peer (any outcome). */
  received: unknown[];
  stop: () => Promise<void>;
}

const pcs: Pc[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // Stop every PC at once and bound each stop: one slow listener close on a
  // Windows runner must not hold the hook past its budget.
  await Promise.all(pcs.splice(0).map((pc) => Promise.race([pc.stop(), new Promise<void>((r) => setTimeout(r, 15_000))])));
  // Windows keeps a stopped PC's files locked for a moment (EBUSY): retry the cleanup.
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** A client seam: lets a test break the first POST of a message after it was really sent. */
type ClientHook = (opts: PinnedClientOptions) => SessionClient;

async function makePc(
  name: string,
  opts: { dir?: string; port?: number; client?: ClientHook; render?: (method: string) => Promise<unknown> } = {},
): Promise<Pc> {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-deliv-'));
  if (!opts.dir) dirs.push(dir);
  const a2aDir = path.join(dir, 'a2a');
  const port = opts.port ?? (await freePort());
  const quiet = (): void => undefined;
  const store = { dir: a2aDir, scheduleHarden: quiet };
  const log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  const tasks = new A2aTaskService({ log, origin: { machineId: name, daemonEpoch: 1 } });
  tasks.restoreFromLog();
  let delivery: A2aRemoteDelivery | null = null;
  const links = new LinkStore({ ...store, onTransition: (l) => delivery?.onLinkTransition(l) });
  const exposures = new ExposureStore(store);
  const panes = new ExposedPaneCache();
  const peers = new PeerStore(store);
  const remoteHosts = new RemoteHostStore({ dir: a2aDir });
  const linkBroadcast = quiet;
  const routes = createA2aRoutes({ exposures, panes, links, broadcast: linkBroadcast, log: quiet });
  const config = { a2aRemote: { enabled: true, port } } as unknown as DaemonConfig;
  const controller = new A2aRemoteController({ config, persist: quiet });
  const server = new A2aServer({
    controller,
    identityDir: a2aDir,
    peers,
    onPeerRevoked: (hostId) => delivery?.onPeerRevoked(hostId),
    routes,
    hostname: () => name,
    ipv4s: () => ['127.0.0.1'],
    bindHost: '127.0.0.1',
    log: quiet,
  });
  await server.whenIdle();

  const handlers = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();
  const onRpc = (m: string, h: (p: Record<string, unknown>) => Promise<unknown>): void => void handlers.set(m, h);
  registerA2aLinkRpc(onRpc, {
    links,
    exposures,
    panes,
    remoteHosts,
    broadcast: linkBroadcast,
    notifyLinkChange: (...args) => delivery?.notifyLinkChange(...args),
    log: quiet,
    timeouts: FAST,
  });
  const received: unknown[] = [];
  const listeners = new Set<(e: { type?: unknown }) => void>();
  delivery = new A2aRemoteDelivery({
    dir: a2aDir,
    links,
    taskService: tasks,
    peers,
    remoteHosts,
    broadcast: (event) => {
      for (const l of listeners) l(event);
    },
    refreshLink: (linkId) => handlers.get('a2a.remote.links.refresh')!({ linkId }),
    log: quiet,
    timing: TIMING,
    heartbeatMs: 200,
    syncMs: 50,
    ...(opts.client ? { client: opts.client } : {}),
  });
  const realAccept = delivery.accept.bind(delivery);
  delivery.accept = (env, peer) => {
    received.push(env);
    return realAccept(env, peer);
  };
  delivery.registerRoutes(routes);
  delivery.registerRpc(onRpc);
  const rpc: Rpc = (method, params = {}) => handlers.get(method)!(params);

  const rendered: Pc['rendered'] = [];
  const emitted: Pc['emitted'] = [];
  const moa: Pc['moa'] = { ready: true, changed: () => undefined };
  const bridge = new RemoteA2aBridge({
    emitEvent: (input) => void emitted.push(input),
    brainReady: () => moa.ready,
    onBrainReadyChanged: (l) => {
      moa.changed = l;
      return () => { moa.changed = () => undefined; };
    },
    daemonRpc: (method, params) => rpc(method, params),
    sendToRenderer: async (method, params) => {
      rendered.push({ method, params });
      if (opts.render) return opts.render(method);
      return { ok: true, delivered: true, ptyId: 'pty-1' };
    },
    onDaemonEvent: (l) => {
      listeners.add(l as (e: { type?: unknown }) => void);
      return () => listeners.delete(l as (e: { type?: unknown }) => void);
    },
    backstopMs: 100,
  });
  delivery.start();
  bridge.start();

  const pc: Pc = {
    name,
    dir,
    port,
    hostId: server.ensureIdentity().hostId,
    links,
    remoteHosts,
    peers,
    tasks,
    server,
    delivery,
    bridge,
    rpc,
    rendered,
    emitted,
    moa,
    received,
    stop: async () => {
      bridge.stop();
      // Nothing may write to this PC's ledger after its log closes. Bounded:
      // a test may leave a renderer call that never answers.
      await Promise.race([bridge.whenIdle(), new Promise((r) => setTimeout(r, 2_000))]);
      await delivery!.stop();
      server.dispose();
      await server.whenIdle();
      log.close();
    },
  };
  pcs.push(pc);
  return pc;
}

async function pair(joiner: Pc, server: Pc): Promise<void> {
  const res = await joinRemoteHost(server.server.beginPairing().invite, {
    self: () => joiner.server.ensureIdentity(),
    selfName: joiner.name,
    remoteHosts: joiner.remoteHosts,
    timeouts: FAST,
  });
  expect(res.ok).toBe(true);
  joiner.delivery.syncSessions();
}

const B_PANE = { kind: 'pane', workspaceId: 'ws-b', workspaceName: 'Backend', paneId: 'pane-b', label: 'codex' };
const A_PANE = { kind: 'pane', workspaceId: 'ws-a', workspaceName: 'Web', paneId: 'pane-a', label: 'claude' };

/** Pair A to B, B exposes its pane, A proposes, B's human accepts; the accept reaches A over the stream. */
async function linked(a: Pc, b: Pc): Promise<string> {
  await pair(a, b);
  await b.rpc('a2a.remote.exposure.publish', { panes: [B_PANE] });
  await b.rpc('a2a.remote.exposure.set', { hostId: a.hostId, workspaceIds: ['ws-b'], paneIds: { 'ws-b': ['pane-b'] } });
  const proposed = (await a.rpc('a2a.remote.links.propose', {
    hostId: b.hostId,
    local: A_PANE,
    remote: { kind: 'pane', workspaceId: 'ws-b', paneId: 'pane-b', label: 'codex', workspaceName: 'Backend' },
    allow: { outbound: true, inbound: true },
  })) as { ok: boolean; link: A2aLinkRecordV1 };
  expect(proposed.ok).toBe(true);
  const linkId = proposed.link.linkId;
  expect(await b.rpc('a2a.remote.links.accept', { linkId })).toMatchObject({ ok: true });
  // No refresh call: the accept notice travels B outbox -> stream -> A.
  await until(() => a.links.get(linkId)?.state === 'active');
  return linkId;
}

async function until(cond: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function sendTask(a: Pc, linkId: string, text: string): Promise<string> {
  const res = (await a.rpc(A2A_REMOTE_RPC.sendTask, {
    linkId,
    from: { workspaceId: 'ws-a', name: 'Web', paneId: 'pane-a' },
    title: text,
    text,
  })) as { ok: boolean; taskId: string };
  expect(res.ok).toBe(true);
  return res.taskId;
}

const taskSends = (pc: Pc): Array<Record<string, unknown>> => pc.rendered.filter((r) => r.method === 'a2a.task.send').map((r) => r.params);

describe('cross-host delivery, end to end', () => {
  it('A sends a task to B, B delivers it, B replies, the reply reaches A; and B -> A over the stream', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A');
    const linkId = await linked(a, b);

    // Discover: A's target alias uses B's workspace name and pane label.
    const targets = (await a.rpc(A2A_REMOTE_RPC.targets)) as { targets: Array<{ alias: string }> };
    expect(targets.targets.map((t) => t.alias)).toEqual(['PC-B/Backend/codex']);

    const taskId = await sendTask(a, linkId, 'review the API');
    await until(() => taskSends(b).length === 1);
    const delivered = taskSends(b)[0];
    expect(delivered).toMatchObject({ presetTaskId: taskId, paneId: 'pane-b', gatedDelivery: true, execute: false, message: 'review the API' });
    expect(delivered['remoteFrom']).toMatchObject({ workspaceId: `remote:${linkId}`, name: 'PC-A/Web/claude' });
    await until(() => (b.tasks.getTask(taskId)?.metadata.remote as { delivered?: boolean })?.delivered === true);

    // B's agent replies; A's sending pane gets it (bridge notify).
    expect(await b.rpc(A2A_REMOTE_RPC.reply, { taskId, workspaceId: 'ws-b', text: 'looks good' })).toMatchObject({ ok: true });
    await until(() => a.rendered.some((r) => r.method === A2A_REMOTE_NOTIFY_METHOD));
    const aTask = a.tasks.getTask(taskId)!;
    expect(aTask.history.map((m) => (m.parts[0] as { text: string }).text)).toEqual(['review the API', 'looks good']);

    // a2a_task_query reads the rt- task with its history (the daemon copy).
    expect(a.tasks.queryTasks('ws-a', {}).map((t) => t.id)).toContain(taskId);

    // Reverse: B -> A is a stream event.
    const back = (await b.rpc(A2A_REMOTE_RPC.sendTask, {
      linkId,
      from: { workspaceId: 'ws-b', name: 'Backend', paneId: 'pane-b' },
      title: 'ping',
      text: 'ping from B',
    })) as { ok: boolean; taskId: string };
    expect(back.ok).toBe(true);
    await until(() => taskSends(a).length === 1);
    expect(taskSends(a)[0]).toMatchObject({ presetTaskId: back.taskId, paneId: 'pane-a', message: 'ping from B' });

    // Exactly once each way, and every message acked.
    expect(taskSends(b)).toHaveLength(1);
    await until(() => a.delivery.outbox.pending(b.hostId).length === 0 && b.delivery.outbox.pending(a.hostId).length === 0);
    expect(a.delivery.status()).toMatchObject([{ hostId: b.hostId, role: 'joiner', state: 'connected', pending: 0 }]);
    expect(b.delivery.status()).toMatchObject([{ hostId: a.hostId, role: 'server', state: 'connected' }]);
  });

  it('roaming: a session that gets through at a later address dials it first from then on', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A');
    const res = await joinRemoteHost(b.server.beginPairing().invite, {
      self: () => a.server.ensureIdentity(),
      selfName: a.name,
      remoteHosts: a.remoteHosts,
      timeouts: FAST,
    });
    expect(res.ok).toBe(true);
    // The PC moved: the first saved address no longer answers.
    a.remoteHosts.updateAddresses(b.hostId, ['no-such-host.invalid', '127.0.0.1']);
    a.delivery.syncSessions();
    await until(() => a.remoteHosts.get(b.hostId)?.addresses[0] === '127.0.0.1');
    expect(a.remoteHosts.get(b.hostId)?.addresses).toEqual(['127.0.0.1', 'no-such-host.invalid']);
    // And it is persisted, so a restart dials it first too.
    expect(new RemoteHostStore({ dir: path.join(a.dir, 'a2a') }).get(b.hostId)?.addresses[0]).toBe('127.0.0.1');
  });

  it('a send while B is down is delivered once B is back; B resumes its stream from the cursor without duplicates', async () => {
    let b = await makePc('PC-B');
    const a = await makePc('PC-A');
    const linkId = await linked(a, b);
    const bDir = b.dir;

    // B owes A one reply-less task over the stream before going down.
    const early = (await b.rpc(A2A_REMOTE_RPC.sendTask, {
      linkId, from: { workspaceId: 'ws-b', name: 'Backend', paneId: 'pane-b' }, title: 'one', text: 'one',
    })) as { taskId: string };
    await until(() => taskSends(a).length === 1);

    const bPort = b.port;
    pcs.splice(pcs.indexOf(b), 1);
    await b.stop();
    const taskId = await sendTask(a, linkId, 'while you were away');
    await new Promise((r) => setTimeout(r, 300));
    // The task, not counting A's receipt for B's earlier task (also owed to B).
    expect(a.delivery.outbox.pending(b.hostId).filter((r) => r.envelope.kind !== 'receipt')).toHaveLength(1);
    await until(() => a.delivery.status()[0]?.state !== 'connected');

    b = await makePc('PC-B', { dir: bDir, port: bPort });
    await until(() => taskSends(b).length === 1);
    expect(taskSends(b)[0]).toMatchObject({ presetTaskId: taskId });
    // B -> A: still exactly the one task from before the restart.
    const more = (await b.rpc(A2A_REMOTE_RPC.sendTask, {
      linkId, from: { workspaceId: 'ws-b', name: 'Backend', paneId: 'pane-b' }, title: 'two', text: 'two',
    })) as { taskId: string };
    await until(() => taskSends(a).length === 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(taskSends(a).map((p) => p['presetTaskId'])).toEqual([early.taskId, more.taskId]);
    expect(taskSends(b)).toHaveLength(1);
  });

  it('a POST that got no answer is resent as is and delivered once', async () => {
    let broke = false;
    const flaky: ClientHook = (opts) => {
      const real = new PinnedTlsClient(opts);
      return {
        openStream: (p, o) => real.openStream(p, o),
        requestJson: async (method, p, body) => {
          const res = await real.requestJson(method, p, body);
          // The first task message really landed; its answer is "lost".
          if (!broke && p === A2A_ROUTES.messages && (body as { kind?: string }).kind === 'task') {
            broke = true;
            throw new PinnedClientError('timeout', 'answer lost', { sent: true });
          }
          return res;
        },
      };
    };
    const b = await makePc('PC-B');
    const a = await makePc('PC-A', { client: flaky });
    const linkId = await linked(a, b);
    const taskId = await sendTask(a, linkId, 'exactly once');
    await until(() => a.delivery.outbox.pending(b.hostId).length === 0);
    const posts = b.received.filter((e) => (e as { kind?: string }).kind === 'task');
    expect(posts).toHaveLength(2); // the original and the resend
    await until(() => taskSends(b).length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(taskSends(b)).toHaveLength(1);
    expect(b.tasks.getTask(taskId)).toBeDefined();
  });

  it('revoking a link mid-task fails it on both sides and refuses later sends', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A');
    const linkId = await linked(a, b);
    const taskId = await sendTask(a, linkId, 'long job');
    await until(() => b.tasks.getTask(taskId) !== undefined);

    expect(await b.rpc('a2a.remote.links.revoke', { linkId })).toMatchObject({ ok: true, link: { state: 'revoked' } });
    await until(() => a.links.get(linkId)?.state === 'revoked');
    await until(() => a.tasks.getTask(taskId)?.status.state === 'failed' && b.tasks.getTask(taskId)?.status.state === 'failed');

    expect(await a.rpc(A2A_REMOTE_RPC.sendTask, {
      linkId, from: { workspaceId: 'ws-a', name: 'Web', paneId: 'pane-a' }, title: 'x', text: 'x',
    })).toMatchObject({ ok: false, error: 'link-not-active' });
  });

  it('a certificate that is not the pinned one stops A: identity-changed, nothing sent', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A');
    const linkId = await linked(a, b);
    // B's certificate "changed": A's pin no longer matches what B serves.
    a.remoteHosts.updateFingerprint(b.hostId, 'AB:'.repeat(31) + 'AB');
    a.delivery.syncSessions();
    await until(() => a.delivery.status()[0]?.state === 'identity-changed');
    const before = b.received.length;
    await sendTask(a, linkId, 'must not leave');
    await new Promise((r) => setTimeout(r, 400));
    expect(b.received.length).toBe(before);
    expect(a.delivery.outbox.pending(b.hostId)).toHaveLength(1);
  });

  it('a second stream from the same peer closes the first', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A');
    await pair(a, b);
    await a.delivery.stop(); // only the raw streams below
    const cred = a.remoteHosts.credentialFor(b.hostId)!;
    const client = new PinnedTlsClient({
      addresses: ['127.0.0.1'],
      port: b.server.boundPort()!,
      fingerprint256: b.server.status().fingerprint256!,
      credential: formatPeerCredential(cred),
      connectTimeoutMs: FAST.connectMs,
      requestTimeoutMs: FAST.requestMs,
    });
    const first = new AbortController();
    const second = new AbortController();
    let firstEnded = false;
    const firstRun = (async () => {
      for await (const ev of client.openStream(A2A_ROUTES.stream, { signal: first.signal })) void ev;
      firstEnded = true;
    })();
    await until(() => b.delivery.hub.isConnected(a.hostId));
    const secondEvents: string[] = [];
    const secondRun = (async () => {
      for await (const ev of client.openStream(A2A_ROUTES.stream, { signal: second.signal })) secondEvents.push(ev.event);
    })();
    await until(() => firstEnded && secondEvents.includes('hello'));
    expect(b.delivery.hub.isConnected(a.hostId)).toBe(true);
    second.abort();
    first.abort();
    await Promise.all([firstRun, secondRun]);
  });

  it('main restarting mid-paste: the task is not pasted again and shows as delivery-unconfirmed', async () => {
    // B's renderer takes the paste and never answers (main dies right there).
    const b = await makePc('PC-B', { render: () => new Promise(() => undefined) });
    const a = await makePc('PC-A');
    const linkId = await linked(a, b);
    const taskId = await sendTask(a, linkId, 'paste me once');
    await until(() => taskSends(b).length === 1);
    await until(() => (b.tasks.getTask(taskId)?.metadata.remote as { attempted?: boolean })?.attempted === true);

    // A new main: fresh bridge, same daemon.
    b.bridge.stop();
    const reRendered: string[] = [];
    const fresh = new RemoteA2aBridge({
      daemonRpc: (m, p) => b.rpc(m, p),
      sendToRenderer: async (m) => {
        reRendered.push(m);
        return { ok: true, delivered: true };
      },
      onDaemonEvent: () => () => undefined,
      backstopMs: 100,
    });
    fresh.start();
    try {
      const held = async (): Promise<string | undefined> => {
        const res = (await b.rpc(A2A_REMOTE_RPC.held)) as { tasks: Array<{ id: string; metadata: { remote: { held?: string } } }> };
        return res.tasks.find((t) => t.id === taskId)?.metadata.remote.held;
      };
      const end = Date.now() + 30_000;
      while ((await held()) !== 'delivery-unconfirmed') {
        if (Date.now() > end) throw new Error('not held');
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 400));
      expect(reRendered).toEqual([]);
      // A person's "send again" is the only way it is written once more.
      expect(await fresh.retryHeld(taskId)).toMatchObject({ ok: true, results: [{ outcome: 'delivered' }] });
      expect(reRendered).toEqual(['a2a.task.send']);
    } finally {
      fresh.stop();
    }
  });
});

describe('Moa to Moa across PCs (brain links), end to end', () => {
  const HQ_A = 'ws-hq-a';
  const HQ_B = 'ws-hq-b';

  /** Both PCs expose their Moa to each other; A proposes Moa <-> Moa, B accepts. */
  async function moaLinked(a: Pc, b: Pc): Promise<string> {
    await pair(a, b);
    await b.rpc('a2a.remote.exposure.publish', { panes: [{ kind: 'brain', workspaceId: HQ_B, workspaceName: 'Moa' }] });
    await b.rpc('a2a.remote.exposure.set', { hostId: a.hostId, workspaceIds: [], brain: true });
    const proposed = (await a.rpc('a2a.remote.links.propose', {
      hostId: b.hostId,
      local: { kind: 'brain', workspaceId: HQ_A, workspaceName: 'Moa' },
      remote: { kind: 'brain', workspaceId: HQ_B, workspaceName: 'Moa' },
      allow: { outbound: true, inbound: true },
    })) as { ok: boolean; link: A2aLinkRecordV1 };
    expect(proposed.ok).toBe(true);
    const linkId = proposed.link.linkId;
    expect(await b.rpc('a2a.remote.links.accept', { linkId })).toMatchObject({ ok: true });
    await until(() => a.links.get(linkId)?.state === 'active');
    return linkId;
  }

  const moaSend = async (pc: Pc, hq: string, linkId: string, text: string): Promise<string> => {
    const res = (await pc.rpc(A2A_REMOTE_RPC.sendTask, { linkId, from: { workspaceId: hq, name: 'Moa' }, title: text, text })) as { ok: boolean; taskId: string };
    expect(res.ok).toBe(true);
    return res.taskId;
  };

  /**
   * A fake brain: on each `a2a.received` new task, it reads the task (what
   * a2a_task_query returns), answers it and completes it — what Moa does after
   * the wake. The state goes out the way main's a2a.task.update does: the
   * ledger first, then the state RPC.
   */
  function fakeBrain(pc: Pc, hq: string): () => Promise<void> {
    let seen = 0;
    let stopped = false;
    const tick = async (): Promise<void> => {
      while (!stopped) {
        const ev = pc.emitted.slice(seen).find((e) => e.type === 'a2a.received' && e.item === 'task');
        seen = pc.emitted.length;
        if (ev) {
          const taskId = ev.taskId as string;
          const task = pc.tasks.queryTasks(hq, {}).find((t) => t.id === taskId)!;
          // What main does when Moa reads it with a2a_task_query.
          await pc.rpc(A2A_REMOTE_RPC.read, { taskId, workspaceId: hq });
          const asked = (task.history[0].parts[0] as { text: string }).text;
          await pc.rpc(A2A_REMOTE_RPC.reply, { taskId, workspaceId: hq, text: `answer to: ${asked}` });
          // A brain on its own HQ: no pane to prove, and the task has none.
          for (const to of ['working', 'completed'] as const) {
            const evidence = to === 'completed' ? { evidence: { summary: 'answered', items: [{ kind: 'inspection' as const, status: 'unverified' as const, summary: 'replied' }] } } : {};
            expect(await pc.tasks.transition({ taskId, to, callerWorkspaceId: hq, requirePaneIdentity: true, ...evidence })).toMatchObject({ ok: true });
            await pc.rpc(A2A_REMOTE_RPC.state, { taskId, state: to });
          }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const loop = tick();
    return async () => {
      stopped = true;
      await loop.catch(() => undefined);
    };
  }

  it('A\'s Moa asks B\'s Moa; B is woken (never a pane paste), answers; A is woken by the reply and the completion — both ways', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A');
    const linkId = await moaLinked(a, b);
    const stopB = fakeBrain(b, HQ_B);
    const stopA = fakeBrain(a, HQ_A);
    try {
      // Discover on A: B's Moa by its <PC>/Moa alias.
      const targets = (await a.rpc(A2A_REMOTE_RPC.targets)) as { targets: Array<{ alias: string; kind: string }> };
      expect(targets.targets).toMatchObject([{ alias: 'PC-B/Moa', kind: 'brain' }]);

      const taskId = await moaSend(a, HQ_A, linkId, 'how is the build?');
      await until(() => b.emitted.some((e) => e.taskId === taskId && e.item === 'task'));
      expect(b.emitted.find((e) => e.taskId === taskId)).toMatchObject({
        type: 'a2a.received', workspaceId: HQ_B, to: HQ_B, from: 'PC-A/Moa', host: 'PC-A', state: 'submitted',
      });
      expect(b.tasks.getTask(taskId)!.metadata.to).toEqual({ workspaceId: HQ_B, name: 'Moa' });

      // A: the reply wakes Moa as a2a.received, the completion as the ordinary receipt.
      await until(() => a.emitted.some((e) => e.type === 'a2a.task' && e.taskId === taskId && e.state === 'completed'));
      expect(a.emitted).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'a2a.received', taskId, item: 'reply', workspaceId: HQ_A, host: 'PC-B' }),
        expect.objectContaining({ type: 'a2a.task', taskId, from: HQ_A, to: `remote:${linkId}`, state: 'completed', workspaceId: HQ_A }),
      ]));
      expect(a.tasks.getTask(taskId)!.history.map((m) => (m.parts[0] as { text: string }).text))
        .toEqual(['how is the build?', 'answer to: how is the build?']);

      // Reverse: B's Moa asks A's Moa.
      const back = await moaSend(b, HQ_B, linkId, 'and yours?');
      await until(() => b.emitted.some((e) => e.type === 'a2a.task' && e.taskId === back && e.state === 'completed'));
      expect(a.emitted.find((e) => e.taskId === back && e.item === 'task')).toMatchObject({ workspaceId: HQ_A, host: 'PC-B' });

      // Nothing on a brain link ever went to a renderer, and nothing was held.
      expect(a.rendered).toEqual([]);
      expect(b.rendered).toEqual([]);
      expect(a.tasks.listRemoteHeld()).toEqual([]);
      expect(b.tasks.listRemoteHeld()).toEqual([]);
      // Exactly one wake per new task.
      expect(b.emitted.filter((e) => e.taskId === taskId && e.item === 'task')).toHaveLength(1);
    } finally {
      await stopA();
      await stopB();
    }
  }, 20_000);

  it('revoking the Moa link mid-task fails it on both sides', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A');
    const linkId = await moaLinked(a, b);
    const taskId = await moaSend(a, HQ_A, linkId, 'long job');
    await until(() => b.emitted.some((e) => e.taskId === taskId));
    expect(await a.rpc('a2a.remote.links.revoke', { linkId })).toMatchObject({ ok: true });
    await until(() => b.links.get(linkId)?.state === 'revoked');
    await until(() => a.tasks.getTask(taskId)?.status.state === 'failed' && b.tasks.getTask(taskId)?.status.state === 'failed');
  }, 20_000);

  it('Moa off on B: the task is held (not delivered) and B\'s Moa is woken exactly once when it comes on', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A');
    const linkId = await moaLinked(a, b);
    b.moa.ready = false;
    const taskId = await moaSend(a, HQ_A, linkId, 'are you there?');
    await until(() => (b.tasks.getTask(taskId)?.metadata.remote as { held?: string } | undefined)?.held === 'brain-unavailable');
    await new Promise((r) => setTimeout(r, 300));
    expect(b.emitted).toEqual([]);
    expect((b.tasks.getTask(taskId)!.metadata.remote as { delivered?: boolean }).delivered).toBe(false);
    b.moa.ready = true;
    b.moa.changed();
    await until(() => b.emitted.some((e) => e.taskId === taskId));
    await new Promise((r) => setTimeout(r, 300));
    expect(b.emitted.filter((e) => e.taskId === taskId)).toHaveLength(1);
    expect(b.tasks.getTask(taskId)!.metadata.remote).toMatchObject({ delivered: true });
    expect(b.tasks.getTask(taskId)!.metadata.remote).not.toHaveProperty('held');
  }, 20_000);

  it('a burst from A\'s Moa wakes B\'s Moa at most 3 times per 10 minutes, 5 tasks a wake, and none is lost', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A');
    const linkId = await moaLinked(a, b);
    // B's coalescer on a hand-driven clock, fed the way the deck feeds it.
    let clock = 0;
    let timers: Array<{ fn: () => void; at: number }> = [];
    const prompts: string[] = [];
    const coalescer = new CommanderEventCoalescer({
      runTurn: async (_ws, prompt) => { prompts.push(prompt); return { ok: true }; },
      isBusy: () => false,
      getAutonomy: () => ({ mode: 'assist', wakePolicy: 'value-filtered', summarize: true, continueInstruction: false, approvalPress: false }),
      getLoop: () => null,
      now: () => clock,
      setTimeoutFn: ((fn: () => void, ms: number) => { const t = { fn, at: clock + ms }; timers.push(t); return t; }) as unknown as typeof setTimeout,
      clearTimeoutFn: ((t: unknown) => { timers = timers.filter((x) => x !== t); }) as unknown as typeof clearTimeout,
      debounceMs: 10,
      maxWakesPerMin: 100,
      wakeBudget: 100,
      log: () => undefined,
    });
    const tick = async (ms: number): Promise<void> => {
      clock += ms;
      const due = timers.filter((t) => t.at <= clock);
      timers = timers.filter((t) => t.at > clock);
      for (const t of due) t.fn();
      await new Promise((r) => setTimeout(r, 0));
    };
    let fed = 0;
    let seq = 0;
    const feed = (): void => {
      for (const e of b.emitted.slice(fed)) {
        if (e.type !== 'a2a.received') continue;
        coalescer.push({
          workspaceId: HQ_B,
          ptyId: `a2a:${e.taskId as string}#${e.item as string}`,
          kind: 'a2a.received',
          source: 'a2a',
          agent: null,
          seq: ++seq,
          ts: clock,
          a2a: { taskId: e.taskId as string, from: e.from as string, to: HQ_B, state: 'submitted', remote: { host: e.host as string, item: 'task' } },
        } satisfies CoalescerInput);
      }
      fed = b.emitted.length;
    };

    const sent: string[] = [];
    for (let n = 0; n < 18; n++) sent.push(await moaSend(a, HQ_A, linkId, `job ${n}`));
    await until(() => b.emitted.filter((e) => e.type === 'a2a.received').length === 18, 15_000);
    feed();
    await tick(10);
    for (let i = 0; i < 4; i++) {
      coalescer.notifyIdle(HQ_B);
      await tick(0);
    }
    expect(prompts).toHaveLength(3); // the ceiling, though 3 more are waiting
    await tick(10 * 60_000);
    coalescer.notifyIdle(HQ_B);
    await tick(0);
    expect(prompts).toHaveLength(4);
    const all = prompts.join('\n');
    for (const id of sent) expect(all).toContain(id);
    coalescer.dispose?.();
  }, 30_000);

  it('receipts: the sender learns its task was handed over, then read; a sender that was away gets them once back', async () => {
    const b = await makePc('PC-B');
    let a = await makePc('PC-A');
    const linkId = await moaLinked(a, b);
    const marker = (pc: Pc, id: string): { remoteDeliveredAt?: string; remoteReadAt?: string } =>
      (pc.tasks.getTask(id)?.metadata.remote ?? {}) as { remoteDeliveredAt?: string; remoteReadAt?: string };

    // Online: delivered, then read (Moa queried it), while the task stays submitted.
    const first = await moaSend(a, HQ_A, linkId, 'status?');
    await until(() => !!marker(a, first).remoteDeliveredAt);
    expect(a.tasks.getTask(first)!.status.state).toBe('submitted');
    expect(marker(a, first).remoteReadAt).toBeUndefined();
    await b.rpc(A2A_REMOTE_RPC.read, { taskId: first, workspaceId: HQ_B });
    await until(() => !!marker(a, first).remoteReadAt);
    expect(a.tasks.queryTasks(HQ_A, {}).find((t) => t.id === first)!.status.state).toBe('submitted');
    // Only the receiving workspace may say it read it.
    expect(await b.rpc(A2A_REMOTE_RPC.read, { taskId: first, workspaceId: 'ws-other' })).toMatchObject({ ok: false });

    // Away: B holds the next task (Moa off), A goes down, B hands it over: nothing reaches A...
    b.moa.ready = false;
    const second = await moaSend(a, HQ_A, linkId, 'and now?');
    await until(() => (b.tasks.getTask(second)?.metadata.remote as { held?: string } | undefined)?.held === 'brain-unavailable');
    const aDir = a.dir;
    pcs.splice(pcs.indexOf(a), 1);
    await a.stop();
    b.moa.ready = true;
    b.moa.changed();
    await until(() => (b.tasks.getTask(second)?.metadata.remote as { delivered?: boolean }).delivered === true);
    // ...until A is back, then the receipt arrives from B's outbox.
    a = await makePc('PC-A', { dir: aDir });
    await until(() => !!marker(a, second).remoteDeliveredAt, 15_000);
  }, 40_000);

  it('a pane-to-pane task gets the same delivered receipt once B\'s pane took it', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A');
    const linkId = await linked(a, b);
    const taskId = await sendTask(a, linkId, 'pane receipt');
    await until(() => !!(a.tasks.getTask(taskId)?.metadata.remote as { remoteDeliveredAt?: string }).remoteDeliveredAt);
    expect(a.tasks.getTask(taskId)!.status.state).toBe('submitted');
  }, 20_000);
});

