// In-process end to end for layer 4: two "PCs" (server B, joiner A), each with
// its own stores, task ledger, delivery layer and a real A2aServer on loopback
// TLS. main is played by RemoteA2aBridge over the daemon RPCs; the renderer is
// a fake that records what it was handed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_PROTOCOL, A2A_ROUTES, formatPeerCredential, type A2aLinkRecordV1 } from '../../../shared/a2aRemote';
import { A2A_REMOTE_NOTIFY_METHOD, A2A_REMOTE_RPC } from '../../../shared/a2aRemoteDelivery';
import { applyTaskQueryView } from '../../../shared/a2aTaskQueryView';
import { COMPANY_BRIEF_KIND } from '../../../shared/company';
import type { DaemonConfig } from '../../types';
import { RemoteA2aBridge } from '../../../main/a2a/RemoteA2aBridge';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aRemoteController } from '../controller';
import { A2aRemoteDelivery, NO_AGENT_SUMMARY, WAITING_SUMMARY } from '../delivery';
import { ExposedPaneCache } from '../exposedPanes';
import { ExposureStore } from '../exposureStore';
import { remoteTaskId } from '../ids';
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
import { deliberateSleep } from '../../../test-utils/waitFor';

// Two PCs each mint a certificate and every step is a TLS handshake: slow CI
// runners (Windows) need far more than the default per-test budget.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });

const FAST = { connectMs: 5_000, requestMs: 10_000 };
const TIMING = { backoffMinMs: 30, backoffMaxMs: 150, livenessMs: 10_000, connectMs: 5_000, requestMs: 10_000 };

type Rpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** A structurally valid PNG (nothing decodes it on the way). */
function pngBytes(w: number, h: number, seed: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.alloc(8, seed)), chunk('IEND', Buffer.alloc(0))]);
}

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
  opts: { dir?: string; port?: number; client?: ClientHook; render?: (method: string) => Promise<unknown>; features?: string[]; images?: boolean } = {},
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
    ...(opts.features ? { features: opts.features } : {}),
    ...(opts.images ? { uploadsRoot: path.join(dir, 'uploads'), features: ['link-offer.1', 'images.1'] } : {}),
    // One terminal, `pty-a`, of workspace `ws-a`, spawned in `<dir>/proj`.
    spawnCwdOf: (ptyId: string, workspaceId: string) => (ptyId === 'pty-a' && workspaceId === 'ws-a' ? path.join(dir, 'proj') : undefined),
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
  const bridge = new RemoteA2aBridge({
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

  it('a copy staged for a send that was then refused stays until the local folder needs the room', async () => {
    const a = await makePc('PC-A', { images: true });
    const shots = path.join(a.dir, 'uploads', 'shots');
    fs.mkdirSync(shots, { recursive: true });
    const stage = async (seed: number): Promise<string> => {
      fs.writeFileSync(path.join(shots, `s${seed}.png`), pngBytes(3, 3, seed));
      const res = (await a.rpc(A2A_REMOTE_RPC.stageImages, { paths: [path.join(shots, `s${seed}.png`)] })) as { ok: boolean; images: Array<{ path: string }> };
      expect(res.ok).toBe(true);
      return res.images[0].path;
    };
    // Its send was refused: no task names it, and it is still there.
    const refused = await stage(1000);
    expect(fs.existsSync(refused)).toBe(true);
    // eslint-disable-next-line no-await-in-loop -- in order, so the first is the oldest
    for (let i = 0; i < 100; i += 1) await stage(i);
    expect(fs.existsSync(refused)).toBe(false);
    expect(fs.readdirSync(path.join(a.dir, 'uploads', 'a2a', 'local'))).toHaveLength(100);
  });

  it('a staging that fails takes back only its own copies, never one another staging was handed', async () => {
    const a = await makePc('PC-A', { images: true });
    const shots = path.join(a.dir, 'uploads', 'shots');
    fs.mkdirSync(shots, { recursive: true });
    const x = pngBytes(3, 3, 1);
    const y = pngBytes(4, 4, 2);
    fs.writeFileSync(path.join(shots, 'x.png'), x);
    fs.writeFileSync(path.join(shots, 'y.png'), y);
    const ySha = crypto.createHash('sha256').update(y).digest('hex');
    // The write of `y` waits for the test, then fails (the disk is full): the first staging fails after it kept `x`.
    let reach!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => (reach = r));
    const released = new Promise<void>((r) => (release = r));
    const writeFile = fs.promises.writeFile;
    const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      if (path.basename(String(file)).startsWith(`.${ySha}.`)) {
        reach();
        await released;
        throw new Error('ENOSPC: no space left on device');
      }
      return writeFile(file, data, options);
    });
    type Staged = { ok: boolean; images?: Array<{ path: string }> };
    try {
      const first = a.rpc(A2A_REMOTE_RPC.stageImages, { paths: [path.join(shots, 'x.png'), path.join(shots, 'y.png')] }) as Promise<Staged>;
      await reached;
      // Another agent stages `x` alone while the first is still at work.
      const second = a.rpc(A2A_REMOTE_RPC.stageImages, { paths: [path.join(shots, 'x.png')] }) as Promise<Staged>;
      await deliberateSleep(200, 'the second staging reaches the image store while the first is held');
      release();
      expect(await first).toMatchObject({ ok: false });
      const got = await second;
      expect(got.ok).toBe(true);
      // What the second agent was handed is there for its receiver to read.
      expect(fs.existsSync(got.images![0].path)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('each PC learns what the other takes, in both roles, and still knows it after a restart', async () => {
    // B can keep images (an uploads folder); A advertises offers only.
    const b = await makePc('PC-B', { images: true });
    const a = await makePc('PC-A', { features: ['link-offer.1'] });
    await pair(a, b);
    // A joined B: B's stream hello tells A; A's stream header tells B.
    await until(() => a.delivery.liveFeatures(b.hostId)?.has('images.1') === true);
    await until(() => b.delivery.liveFeatures(a.hostId)?.has('link-offer.1') === true);
    expect(a.delivery.status()).toMatchObject([{ hostId: b.hostId, role: 'joiner', features: ['link-offer.1', 'images.1'] }]);
    expect(b.delivery.peerFeatures(a.hostId)?.has('images.1')).toBe(false);
    // A new daemon on A, before B's stream is back: the last seen answer.
    const restarted = new A2aRemoteDelivery({
      dir: path.join(a.dir, 'a2a'),
      links: a.links,
      taskService: a.tasks,
      peers: a.peers,
      remoteHosts: a.remoteHosts,
      broadcast: () => undefined,
      refreshLink: async () => null,
      log: () => undefined,
    });
    expect(restarted.liveFeatures(b.hostId)).toBeUndefined();
    expect([...(restarted.peerFeatures(b.hostId) ?? [])].sort()).toEqual(['images.1', 'link-offer.1']);
  });

  it('images both ways: A stages and sends (uploaded to B), B replies with one (A fetches it)', async () => {
    const b = await makePc('PC-B', { images: true });
    const a = await makePc('PC-A', { images: true });
    const linkId = await linked(a, b);
    await until(() => a.delivery.liveFeatures(b.hostId)?.has('images.1') === true && b.delivery.liveFeatures(a.hostId)?.has('images.1') === true);

    // A's agent stages a screenshot from the uploads folder (no verified pane: uploads only).
    const shotDir = path.join(a.dir, 'uploads', 'shots');
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = pngBytes(12, 7, 1);
    fs.writeFileSync(path.join(shotDir, 'login.png'), shot);
    const staged = (await a.rpc(A2A_REMOTE_RPC.stageImages, { paths: [path.join(shotDir, 'login.png')] })) as {
      ok: boolean;
      images: Array<{ path: string; sha256: string; width: number; height: number }>;
    };
    expect(staged).toMatchObject({ ok: true, images: [{ width: 12, height: 7 }] });
    expect(staged.images[0].path).toBe(path.join(a.dir, 'uploads', 'a2a', 'local', `${staged.images[0].sha256}.png`));
    // The pane's own folder, but only for a terminal of the sender's workspace.
    fs.mkdirSync(path.join(a.dir, 'proj'));
    fs.writeFileSync(path.join(a.dir, 'proj', 'ui.png'), pngBytes(12, 7, 2));
    expect(await a.rpc(A2A_REMOTE_RPC.stageImages, { paths: [path.join(a.dir, 'proj', 'ui.png')], ptyId: 'pty-a', workspaceId: 'ws-a' })).toMatchObject({ ok: true });
    expect(await a.rpc(A2A_REMOTE_RPC.stageImages, { paths: [path.join(a.dir, 'proj', 'ui.png')], ptyId: 'pty-a', workspaceId: 'ws-other' })).toMatchObject({ ok: false });
    // Outside the allowed folders: refused with a reason the agent can act on.
    fs.writeFileSync(path.join(a.dir, 'elsewhere.png'), shot);
    expect(await a.rpc(A2A_REMOTE_RPC.stageImages, { paths: [path.join(a.dir, 'elsewhere.png')] })).toMatchObject({
      ok: false,
      error: expect.stringContaining('copy it there first'),
    });

    const sent = (await a.rpc(A2A_REMOTE_RPC.sendTask, {
      linkId,
      from: { workspaceId: 'ws-a', name: 'Web', paneId: 'pane-a' },
      title: 'look',
      text: 'see the login page',
      images: [staged.images[0].path],
    })) as { ok: boolean; taskId: string };
    expect(sent.ok).toBe(true);
    await until(() => taskSends(b).length === 1);
    const onB = b.tasks.getTask(sent.taskId)!.history[0].parts;
    const received = path.join(b.dir, 'uploads', 'a2a', a.hostId, `${staged.images[0].sha256}.png`);
    expect(onB).toEqual([
      { kind: 'text', text: 'see the login page' },
      { kind: 'file', file: { mimeType: 'image/png', uri: pathToFileURL(received).href }, metadata: expect.objectContaining({ sha256: staged.images[0].sha256, width: 12, height: 7 }) },
    ]);
    expect(fs.readFileSync(received).equals(fs.readFileSync(staged.images[0].path))).toBe(true);
    // Main hands B's renderer B's own file, to end the paste with.
    expect(taskSends(b)[0]['remoteImages']).toEqual([{ sha256: staged.images[0].sha256, mediaType: 'image/png', path: received }]);
    // The upload was claimed: nothing left in B's staging.
    expect(fs.readdirSync(path.join(b.dir, 'a2a', 'blobs-in', a.hostId))).toEqual([]);

    // B answers with an image of its own: it travels on B's stream and A fetches it.
    const reply = pngBytes(3, 5, 2);
    fs.mkdirSync(path.join(b.dir, 'uploads', 'out'), { recursive: true });
    fs.writeFileSync(path.join(b.dir, 'uploads', 'out', 'fixed.png'), reply);
    expect(await b.rpc(A2A_REMOTE_RPC.reply, { taskId: sent.taskId, workspaceId: 'ws-b', text: '', images: [path.join(b.dir, 'uploads', 'out', 'fixed.png')] })).toMatchObject({ ok: true });
    await until(() => (a.tasks.getTask(sent.taskId)?.history.length ?? 0) === 2);
    const onA = a.tasks.getTask(sent.taskId)!.history[1].parts;
    expect(onA).toHaveLength(1);
    const uri = (onA[0] as { file: { uri: string } }).file.uri;
    expect(uri.startsWith(pathToFileURL(path.join(a.dir, 'uploads', 'a2a', b.hostId)).href)).toBe(true);
    expect(fs.readFileSync(new URL(uri)).length).toBe(reply.length);
    await until(() => a.delivery.outbox.pending(b.hostId).length === 0 && b.delivery.outbox.pending(a.hostId).length === 0);
  });

  it('to a PC whose wmux does not take images, the text goes with a note; restarted, a PC still knows its joiner takes them', async () => {
    let b = await makePc('PC-B', { images: true });
    const a = await makePc('PC-A', { images: true });
    const linkId = await linked(a, b);
    await until(() => b.delivery.liveFeatures(a.hostId)?.has('images.1') === true);
    const bDir = b.dir;
    const bPort = b.port;
    const img = pngBytes(4, 4, 3);
    fs.mkdirSync(path.join(bDir, 'uploads', 'out'), { recursive: true });
    fs.writeFileSync(path.join(bDir, 'uploads', 'out', 'x.png'), img);

    // A goes away, then B restarts: nothing live, but B saw A take images before.
    pcs.splice(pcs.indexOf(a), 1);
    await a.stop();
    pcs.splice(pcs.indexOf(b), 1);
    await b.stop();
    b = await makePc('PC-B', { dir: bDir, port: bPort, images: true });
    expect(b.delivery.liveFeatures(a.hostId)).toBeUndefined();
    const queued = (await b.rpc(A2A_REMOTE_RPC.sendTask, {
      linkId, from: { workspaceId: 'ws-b', name: 'Backend', paneId: 'pane-b' }, title: 'x', text: 'for later', images: [path.join(bDir, 'uploads', 'out', 'x.png')],
    })) as { ok: boolean };
    expect(queued.ok).toBe(true);
    expect(b.delivery.outbox.pending(a.hostId).find((r) => r.envelope.kind === 'task')?.envelope.images).toEqual([
      { sha256: crypto.createHash('sha256').update(img).digest('hex'), mediaType: 'image/png', bytes: img.length },
    ]);
  });

  it('a PC with no image store does not advertise images.1, even when told to', async () => {
    const b = await makePc('PC-B', { features: ['link-offer.1', 'images.1'] });
    const a = await makePc('PC-A', { images: true });
    await pair(a, b);
    await until(() => a.delivery.liveFeatures(b.hostId) !== undefined);
    expect([...(a.delivery.liveFeatures(b.hostId) ?? [])]).toEqual(['link-offer.1']);
  });

  it('an older PC (no images.1) gets the text with a note instead of refs it would drop', async () => {
    const b = await makePc('PC-B', { features: ['link-offer.1'] });
    const a = await makePc('PC-A', { images: true });
    const linkId = await linked(a, b);
    await until(() => a.delivery.liveFeatures(b.hostId) !== undefined);
    fs.mkdirSync(path.join(a.dir, 'uploads', 'out'), { recursive: true });
    fs.writeFileSync(path.join(a.dir, 'uploads', 'out', 'x.png'), pngBytes(2, 2, 4));
    const res = (await a.rpc(A2A_REMOTE_RPC.sendTask, {
      linkId, from: { workspaceId: 'ws-a', name: 'Web', paneId: 'pane-a' }, title: 'x', text: 'hello', images: [path.join(a.dir, 'uploads', 'out', 'x.png')],
    })) as { ok: boolean; note?: string };
    expect(res).toMatchObject({ ok: true, note: expect.stringContaining('does not take images') });
    await until(() => taskSends(b).length === 1);
    expect(taskSends(b)[0]['message']).toBe("hello\n\n[1 image omitted: the receiving PC's wmux does not take images]");
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
    const saved = JSON.parse(fs.readFileSync(a.remoteHosts.filePath, 'utf8')) as { hosts: Array<{ hostId: string; addresses: string[] }> };
    expect(saved.hosts.find((h) => h.hostId === b.hostId)?.addresses).toEqual(['127.0.0.1', 'no-such-host.invalid']);
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
    await deliberateSleep(300, 'negative: the task stays queued while the peer is away');
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
    await deliberateSleep(300, 'negative: no extra task send arrives');
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
    await deliberateSleep(300, 'negative: the resend is not delivered twice');
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
    await deliberateSleep(400, 'negative: nothing leaves for a peer whose identity changed');
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

  it('B\'s pane waiting on a prompt tells A so once, not "no agent"; a cause B does not know tells nothing', async () => {
    // B's renderer never takes it, for a reason that is no waiting cause: main keeps trying.
    const b = await makePc('PC-B', { render: async () => ({ ok: true, delivered: false, reason: 'no_target_pty' }) });
    const a = await makePc('PC-A');
    const linkId = await linked(a, b);
    const taskId = await sendTask(a, linkId, 'run the migration');
    await until(() => b.tasks.getTask(taskId) !== undefined);
    const texts = (): string[] => a.tasks.getTask(taskId)!.history.map((m) => (m.parts[0] as { text: string }).text);
    // What a main of this version sends once the prompt outlasted the no-agent bound.
    expect(await b.rpc(A2A_REMOTE_RPC.mark, { taskId, attempted: false, waiting: 'agent-prompt' })).toEqual({ ok: true });
    expect(await b.rpc(A2A_REMOTE_RPC.mark, { taskId, attempted: false, waiting: 'agent-prompt' })).toEqual({ ok: true });
    await until(() => texts().length === 2);
    expect(texts()[1]).toBe(WAITING_SUMMARY['agent-prompt']);
    expect(texts()[1]).not.toBe(NO_AGENT_SUMMARY);
    // Not a hold: the task is still B's to deliver.
    expect((b.tasks.getTask(taskId)!.metadata.remote as { held?: string }).held).toBeUndefined();
    // A newer main's cause this daemon does not know: accepted, nothing said.
    expect(await b.rpc(A2A_REMOTE_RPC.mark, { taskId, attempted: false, waiting: 'agent-asleep' })).toEqual({ ok: true });
    // The no-agent hold still says no agent.
    expect(await b.rpc(A2A_REMOTE_RPC.mark, { taskId, held: 'no-agent' })).toEqual({ ok: true });
    await until(() => texts().length === 3);
    expect(texts()).toEqual(['run the migration', WAITING_SUMMARY['agent-prompt'], NO_AGENT_SUMMARY]);
  });

  it('a no-agent hold whose reply to the sender never went is told by maintenance, once', async () => {
    const b = await makePc('PC-B', { render: async () => ({ ok: true, delivered: false, reason: 'no_target_pty' }) });
    const a = await makePc('PC-A');
    const linkId = await linked(a, b);
    const taskId = await sendTask(a, linkId, 'rebuild the index');
    await until(() => b.tasks.getTask(taskId) !== undefined);
    // Held with no reply sent (as when the send failed at the time).
    expect((await b.tasks.markRemote({ taskId, held: 'no-agent' })).ok).toBe(true);
    await b.delivery.maintain();
    await b.delivery.maintain();
    const texts = (): string[] => a.tasks.getTask(taskId)!.history.map((m) => (m.parts[0] as { text: string }).text);
    await until(() => texts().length === 2);
    expect(texts()).toEqual(['rebuild the index', NO_AGENT_SUMMARY]);
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
      await deliberateSleep(400, 'negative: a held delivery is never re-rendered on its own');
      expect(reRendered).toEqual([]);
      // A person's "send again" is the only way it is written once more.
      expect(await fresh.retryHeld(taskId)).toMatchObject({ ok: true, results: [{ outcome: 'delivered' }] });
      expect(reRendered).toEqual(['a2a.task.send']);
    } finally {
      fresh.stop();
    }
  });
});

describe('cross-host receipts, end to end', () => {
  it('a pane-to-pane task gets the delivered receipt once B\'s pane took it, then the read receipt', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A');
    const linkId = await linked(a, b);
    const marker = (pc: Pc, id: string): { remoteDeliveredAt?: string; remoteReadAt?: string } =>
      (pc.tasks.getTask(id)?.metadata.remote ?? {}) as { remoteDeliveredAt?: string; remoteReadAt?: string };
    const taskId = await sendTask(a, linkId, 'pane receipt');
    await until(() => !!marker(a, taskId).remoteDeliveredAt);
    expect(a.tasks.getTask(taskId)!.status.state).toBe('submitted');
    expect(marker(a, taskId).remoteReadAt).toBeUndefined();
    // Only the receiving workspace may say it read it.
    expect(await b.rpc(A2A_REMOTE_RPC.read, { taskId, workspaceId: 'ws-other' })).toMatchObject({ ok: false });
    expect(await b.rpc(A2A_REMOTE_RPC.read, { taskId, workspaceId: 'ws-b' })).toMatchObject({ ok: true });
    await until(() => !!marker(a, taskId).remoteReadAt);
    expect(a.tasks.getTask(taskId)!.status.state).toBe('submitted');
  }, 20_000);

  it('#1922: once the other PC acked a reply, the replying side\'s task shows replyDeliveredAt', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A');
    const linkId = await linked(a, b);
    const delivered = (pc: Pc, id: string): string | undefined =>
      (pc.tasks.getTask(id)?.metadata.remote as { replyDeliveredAt?: string } | undefined)?.replyDeliveredAt;
    const taskId = await sendTask(a, linkId, 'q1');
    await until(() => (b.tasks.getTask(taskId)?.metadata.remote as { delivered?: boolean })?.delivered === true);
    expect(await b.rpc(A2A_REMOTE_RPC.reply, { taskId, workspaceId: 'ws-b', text: 'a1' })).toMatchObject({ ok: true });
    await until(() => b.delivery.outbox.pending(a.hostId).length === 0 && !!delivered(b, taskId));
    // What a2a_task_query shows the answering side.
    const row = applyTaskQueryView(b.tasks.queryTasks('ws-b', {}), { view: 'page' }).find((t) => (t as { id: string }).id === taskId);
    expect(row).toMatchObject({ replyDeliveredAt: delivered(b, taskId) });
    // A new reply of ours clears it until the peer acks that one too.
    const before = delivered(b, taskId);
    expect(await b.rpc(A2A_REMOTE_RPC.reply, { taskId, workspaceId: 'ws-b', text: 'one more thing' })).toMatchObject({ ok: true });
    await until(() => b.delivery.outbox.pending(a.hostId).length === 0 && !!delivered(b, taskId));
    expect(delivered(b, taskId)).not.toBe(before);
    expect(a.tasks.getTask(taskId)!.history.map((m) => (m.parts[0] as { text: string }).text)).toContain('one more thing');
  }, 30_000);
});

describe('cross-host completion, end to end', () => {
  it('B completes A\'s task: A\'s copy gets B\'s status message and evidence, graded as B gave it', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A');
    const linkId = await linked(a, b);
    const taskId = await sendTask(a, linkId, 'review it');
    await until(() => (b.tasks.getTask(taskId)?.metadata.remote as { delivered?: boolean })?.delivered === true);

    expect((await b.tasks.transition({ taskId, to: 'working', callerWorkspaceId: 'ws-b' })).ok).toBe(true);
    expect(await b.rpc(A2A_REMOTE_RPC.state, { taskId, state: 'working' })).toMatchObject({ ok: true });
    await until(() => a.tasks.getTask(taskId)?.status.state === 'working');
    const evidence = {
      summary: 'no P1',
      items: [
        { kind: 'command' as const, status: 'passed' as const, command: 'npm test', summary: 'tests pass' },
        { kind: 'inspection' as const, status: 'verified' as const, summary: 'read the diff' },
      ],
    };
    expect((await b.tasks.transition({
      taskId, to: 'completed', callerWorkspaceId: 'ws-b', evidence,
      message: { kind: 'message', messageId: 'st-1', role: 'agent', parts: [{ kind: 'text', text: 'The full review.' }] },
    })).ok).toBe(true);
    expect(await b.rpc(A2A_REMOTE_RPC.state, { taskId, state: 'completed' })).toMatchObject({ ok: true });

    await until(() => a.tasks.getTask(taskId)?.status.state === 'completed');
    const status = a.tasks.getTask(taskId)!.status;
    expect(status.evidence).toEqual(evidence);
    expect(status.message?.parts).toEqual([{ kind: 'text', text: 'The full review.' }]);
    // A's bridge is told about the ending item, which names its state.
    await until(() => a.rendered.some((r) => r.method === A2A_REMOTE_NOTIFY_METHOD));
    const inbox = (a.tasks.getTask(taskId)!.metadata.remote as { inbox?: Array<{ kind: string; state?: string }> }).inbox ?? [];
    expect(inbox.filter((i) => i.kind === 'state').map((i) => i.state)).toEqual(['working', 'completed']);
  }, 20_000);

  it('a completion whose report is mostly control characters still reaches A (no 413, A is not left working)', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A');
    const linkId = await linked(a, b);
    const taskId = await sendTask(a, linkId, 'review it');
    await until(() => (b.tasks.getTask(taskId)?.metadata.remote as { delivered?: boolean })?.delivered === true);
    expect((await b.tasks.transition({ taskId, to: 'working', callerWorkspaceId: 'ws-b' })).ok).toBe(true);
    expect(await b.rpc(A2A_REMOTE_RPC.state, { taskId, state: 'working' })).toMatchObject({ ok: true });
    await until(() => a.tasks.getTask(taskId)?.status.state === 'working');
    const item = (n: number) => ({ kind: 'inspection' as const, status: 'verified' as const, summary: `${n} ${'\u0001'.repeat(1000)}` });
    expect((await b.tasks.transition({
      taskId, to: 'completed', callerWorkspaceId: 'ws-b',
      evidence: { summary: 'done', items: Array.from({ length: 10 }, (_, n) => item(n)) },
      message: { kind: 'message', messageId: 'st-2', role: 'agent', parts: [{ kind: 'text', text: `report ${'\u001b'.repeat(10_000)} end` }] },
    })).ok).toBe(true);
    expect(await b.rpc(A2A_REMOTE_RPC.state, { taskId, state: 'completed' })).toMatchObject({ ok: true });
    await until(() => a.tasks.getTask(taskId)?.status.state === 'completed');
    expect(a.tasks.getTask(taskId)!.status.evidence?.summary).toBe('done');
    await until(() => b.delivery.outbox.pending(a.hostId).length === 0);
  }, 20_000);
});

describe('a company task on another PC, end to end', () => {
  it('B completes: A holds a report, keeps it once across a restart, and the CEO\'s done on A never reaches B', async () => {
    const b = await makePc('PC-B');
    let a = await makePc('PC-A');
    const linkId = await linked(a, b);

    // A's copy carries the brief, as the sending side records it; the wire carries the text only.
    const briefId = 'brief-1';
    const taskId = remoteTaskId(linkId, briefId);
    expect((await a.tasks.createTask({
      id: taskId,
      title: 'ship the fix',
      from: { workspaceId: 'ws-a', name: 'Web', paneId: 'pane-a' },
      to: { workspaceId: `remote:${linkId}`, name: 'PC-B/Backend/codex' },
      history: [{
        kind: 'message',
        messageId: briefId,
        role: 'user',
        parts: [
          { kind: 'text', text: 'ship the fix' },
          { kind: 'data', data: { kind: COMPANY_BRIEF_KIND, v: 1, goal: 'g', scope: 's', acceptance: 'a', verify: 'v', report: 'r' } },
        ],
      }],
      remote: { v: 1, linkId, hostId: b.hostId, messageId: briefId, direction: 'outbound', kind: 'pane' },
    })).ok).toBe(true);
    a.delivery.outbox.enqueue(b.hostId, {
      protocol: A2A_REMOTE_PROTOCOL, linkId, linkVersion: a.links.get(linkId)!.version, messageId: briefId, kind: 'task', text: 'ship the fix', sentAt: new Date().toISOString(),
    });
    await until(() => (b.tasks.getTask(taskId)?.metadata.remote as { delivered?: boolean })?.delivered === true);

    // B has no company: its agent finishes the task itself.
    expect((await b.tasks.transition({ taskId, to: 'working', callerWorkspaceId: 'ws-b' })).ok).toBe(true);
    expect(await b.rpc(A2A_REMOTE_RPC.state, { taskId, state: 'working' })).toMatchObject({ ok: true });
    await until(() => a.tasks.getTask(taskId)?.status.state === 'working');
    const evidence = {
      summary: 'PR #7 merged',
      items: [{ kind: 'command' as const, status: 'passed' as const, command: 'npm test', summary: 'tests pass' }],
    };
    expect((await b.tasks.transition({
      taskId, to: 'completed', callerWorkspaceId: 'ws-b', evidence,
      message: { kind: 'message', messageId: 'st-b', role: 'agent', parts: [{ kind: 'text', text: 'PR #7 merged at abc123.' }] },
    })).ok).toBe(true);
    expect(await b.rpc(A2A_REMOTE_RPC.state, { taskId, state: 'completed' })).toMatchObject({ ok: true });

    // On A it is a report: input-required with B's message and evidence.
    const marker = (pc: Pc) => pc.tasks.getTask(taskId)!.metadata.remote as { reported?: string; inbox?: Array<{ kind: string; state?: string; reported?: true }> };
    await until(() => marker(a).reported !== undefined);
    expect(a.tasks.getTask(taskId)!.status).toMatchObject({ state: 'input-required', evidence });
    expect(a.tasks.getTask(taskId)!.history.at(-1)?.parts).toEqual([{ kind: 'text', text: 'PR #7 merged at abc123.' }]);
    expect(marker(a).inbox?.filter((i) => i.kind === 'state')).toMatchObject([{ state: 'working' }, { state: 'completed', reported: true }]);
    await until(() => b.delivery.outbox.pending(a.hostId).length === 0);
    const isReport = (e: unknown): boolean => {
      const env = e as { kind?: string; taskId?: string; state?: string };
      return env.kind === 'state' && env.taskId === taskId && env.state === 'completed';
    };
    const report = a.received.find(isReport);
    expect(report).toBeDefined();
    const reportId = (report as { messageId: string }).messageId;

    // A's daemon restarts; B's envelope redelivered reads as a duplicate.
    const aDir = a.dir;
    const aPort = a.port;
    pcs.splice(pcs.indexOf(a), 1);
    await a.stop();
    a = await makePc('PC-A', { dir: aDir, port: aPort });
    expect(a.tasks.getTask(taskId)!.status.state).toBe('input-required');
    expect(marker(a).reported).toBeDefined();
    expect(await a.delivery.accept(report, { hostId: b.hostId })).toMatchObject({ ok: true, duplicate: true });
    expect(a.tasks.getTask(taskId)!.history.filter((m) => m.messageId === reportId)).toHaveLength(1);

    // A's CEO pane marks it done on A.
    const done = await a.tasks.transition({
      taskId, to: 'completed', callerWorkspaceId: 'ws-a', callerAddr: { paneId: 'pane-a' }, callerCompanySeat: 'coordinator',
      evidence: { summary: 'PR checked', items: [{ kind: 'inspection', status: 'verified', summary: 'PR head matches the report' }] },
    });
    expect(done.ok).toBe(true);
    expect(await a.delivery.accept(report, { hostId: b.hostId })).toMatchObject({ ok: true, duplicate: true });

    // Nothing goes to B for that task: not queued, not received.
    await a.delivery.syncAll();
    await deliberateSleep(300, 'negative: the done on A is never sent to B');
    const statesFor = (envs: unknown[]): unknown[] => envs.filter((e) => (e as { kind?: string; taskId?: string }).kind === 'state' && (e as { taskId?: string }).taskId === taskId);
    expect(statesFor(a.delivery.outbox.pending(b.hostId).map((r) => r.envelope))).toEqual([]);
    expect(statesFor(b.received)).toEqual([]);
    expect(a.tasks.getTask(taskId)!.status.state).toBe('completed');
    expect(b.tasks.getTask(taskId)!.status.state).toBe('completed');
  });
});
