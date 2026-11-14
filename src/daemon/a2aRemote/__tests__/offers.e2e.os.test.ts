// In-process end to end for share offers: server B shares a pane, the offer
// travels B outbox -> stream -> A, A's human accepts with one of its panes,
// and both PCs hold the same active link. Real listeners on loopback TLS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2A_FEATURE_LINK_OFFER, A2A_FEATURE_REOPEN, type A2aLinkOfferRecordV1 } from '../../../shared/a2aRemote';
import type { A2aRemoteOfferCreateResult, A2aRemoteOfferResult } from '../../../shared/rpc';
import type { DaemonConfig } from '../../types';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aRemoteController } from '../controller';
import { A2aRemoteDelivery, shareOfferFeatures } from '../delivery';
import { ExposedPaneCache } from '../exposedPanes';
import { ExposureStore } from '../exposureStore';
import { joinRemoteHost } from '../joiner';
import { registerA2aLinkRpc } from '../linkRpc';
import { LinkStore } from '../linkStore';
import { OfferStore } from '../offerStore';
import { A2aOffers } from '../offers';
import { PeerStore } from '../peerStore';
import { RemoteHostStore } from '../remoteHostStore';
import { createA2aRoutes } from '../routes';
import { A2aServer } from '../server';
import { freePort } from './a2aServerRig';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });

const FAST = { connectMs: 5_000, requestMs: 10_000 };
const TIMING = { backoffMinMs: 30, backoffMaxMs: 150, livenessMs: 10_000, connectMs: 5_000, requestMs: 10_000 };

type Rpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

interface Pc {
  name: string;
  hostId: string;
  links: LinkStore;
  exposures: ExposureStore;
  offers: A2aOffers;
  remoteHosts: RemoteHostStore;
  delivery: A2aRemoteDelivery;
  server: A2aServer;
  rpc: Rpc;
  stop: () => Promise<void>;
}

const pcs: Pc[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(pcs.splice(0).map((pc) => Promise.race([pc.stop(), new Promise<void>((r) => setTimeout(r, 15_000))])));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/**
 * One PC. `advertise`: the features its joiner sessions send (an older build
 * sends none). `routeOffers: false`: its listener ignores `offerId`, as an
 * older build's does.
 */
async function makePc(name: string, opts: { advertise?: string[]; routeOffers?: boolean } = {}): Promise<Pc> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-offer-e2e-'));
  dirs.push(dir);
  const a2aDir = path.join(dir, 'a2a');
  const port = await freePort();
  const quiet = (): void => undefined;
  const store = { dir: a2aDir, scheduleHarden: quiet };
  const log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  const tasks = new A2aTaskService({ log, origin: { machineId: name, daemonEpoch: 1 } });
  tasks.restoreFromLog();
  let delivery: A2aRemoteDelivery | null = null;
  let offersRef: A2aOffers | null = null;
  const links = new LinkStore({ ...store, onTransition: (l) => { delivery?.onLinkTransition(l); offersRef?.onLinkTransition(l); } });
  const exposures = new ExposureStore(store);
  const panes = new ExposedPaneCache();
  const peers = new PeerStore(store);
  const remoteHosts = new RemoteHostStore({ dir: a2aDir });
  const offers = new A2aOffers({
    store: new OfferStore(store),
    links,
    exposures,
    isPeer: (h) => peers.list().some((p) => p.hostId === h && !p.revokedAt),
    isJoined: (h) => remoteHosts.get(h) !== undefined,
    features: shareOfferFeatures(() => delivery),
    enqueue: (h, env) => void delivery!.outbox.enqueue(h, env),
    notifyLinkChange: (...args) => delivery?.notifyLinkChange(...args),
    broadcast: quiet,
    log: quiet,
  });
  offersRef = offers;
  const routes = createA2aRoutes({ exposures, panes, links, broadcast: quiet, log: quiet, ...(opts.routeOffers === false ? {} : { offers }) });
  const config = { a2aRemote: { enabled: true, port } } as unknown as DaemonConfig;
  const server = new A2aServer({
    controller: new A2aRemoteController({ config, persist: quiet }),
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
    links, exposures, panes, remoteHosts, broadcast: quiet, offers, log: quiet, timeouts: FAST,
    notifyLinkChange: (...args) => delivery?.notifyLinkChange(...args),
  });
  delivery = new A2aRemoteDelivery({
    dir: a2aDir,
    links,
    taskService: tasks,
    peers,
    remoteHosts,
    broadcast: quiet,
    refreshLink: (linkId) => handlers.get('a2a.remote.links.refresh')!({ linkId }),
    offers,
    ...(opts.advertise ? { features: opts.advertise } : {}),
    log: quiet,
    timing: TIMING,
    heartbeatMs: 200,
    syncMs: 50,
  });
  delivery.registerRoutes(routes);
  delivery.registerRpc(onRpc);
  delivery.start();
  const pc: Pc = {
    name,
    hostId: server.ensureIdentity().hostId,
    links,
    exposures,
    offers,
    remoteHosts,
    delivery,
    server,
    rpc: (method, params = {}) => handlers.get(method)!(params),
    stop: async () => {
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

async function until(cond: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const B_PANE = { kind: 'pane', workspaceId: 'ws-api', workspaceName: 'API', paneId: 'pane-1', label: 'w1-1(claude)', agent: 'claude', gitRemote: 'github.com/acme/api' };
const A_PANE = { kind: 'pane', workspaceId: 'ws-web', workspaceName: 'Web', paneId: 'pane-a', label: 'w1-1(codex)' };
const both = { outbound: true, inbound: true };

const share = (b: Pc, a: Pc): Promise<A2aRemoteOfferCreateResult> =>
  b.rpc('a2a.remote.offers.create', { hostId: a.hostId, end: B_PANE, allow: both }) as Promise<A2aRemoteOfferCreateResult>;
const inOffers = (a: Pc): A2aLinkOfferRecordV1[] => a.offers.store.list().filter((o) => o.side === 'in');

describe('share offers, end to end', () => {
  it('B shares, the offer reaches A over the stream, A accepts with its pane: one active link on both', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A', { advertise: [A2A_FEATURE_LINK_OFFER] });
    await pair(a, b);
    await until(() => b.delivery.hub.featuresOf(a.hostId)?.has(A2A_FEATURE_LINK_OFFER) === true);
    const statuses = (await b.rpc('a2a.remote.hosts.status')) as { hosts: Array<{ hostId: string; features?: string[] }> };
    expect(statuses.hosts.find((h) => h.hostId === a.hostId)?.features).toEqual([A2A_FEATURE_LINK_OFFER, A2A_FEATURE_REOPEN]);

    const made = await share(b, a);
    expect(made).toMatchObject({ ok: true, offer: { state: 'open', addedExposure: true } });
    if (!made.ok) throw new Error('unreachable');
    await until(() => inOffers(a).length === 1);
    expect(inOffers(a)[0]).toMatchObject({ offerId: made.offer.offerId, hostId: b.hostId, end: { paneId: 'pane-1', label: 'w1-1(claude)' }, state: 'open' });

    const accepted = (await a.rpc('a2a.remote.offers.accept', { offerId: made.offer.offerId, local: A_PANE, allow: both })) as A2aRemoteOfferResult;
    expect(accepted).toMatchObject({ ok: true, offer: { state: 'accepted' }, link: { state: 'active', version: 2 } });
    if (!accepted.ok) throw new Error('unreachable');
    const linkId = accepted.link!.linkId;
    expect(b.links.get(linkId)).toMatchObject({ state: 'active', version: 2, proposer: 'remote', local: { paneId: 'pane-1' }, remote: { hostId: a.hostId, paneId: 'pane-a' } });
    expect(b.offers.store.get(made.offer.offerId)).toMatchObject({ state: 'accepted', linkId });

    // Unlink on B hides the pane the share showed, and A hears of it.
    expect(await b.rpc('a2a.remote.links.revoke', { linkId })).toMatchObject({ ok: true });
    expect(b.exposures.isPaneExposed(a.hostId, 'ws-api', 'pane-1')).toBe(false);
    await until(() => a.links.get(linkId)?.state === 'revoked');
  });

  it('an older joiner advertises nothing: the share is refused and nothing is shown or sent', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A');
    await pair(a, b);
    await until(() => b.delivery.hub.featuresOf(a.hostId) !== undefined);
    expect(await share(b, a)).toEqual({ ok: false, error: 'receiver-unsupported' });
    expect(b.exposures.isPaneExposed(a.hostId, 'ws-api', 'pane-1')).toBe(false);
    expect(b.delivery.outbox.openCount(a.hostId)).toBe(0);
  });

  it('a PC that only joined the other has no stream from it yet: its share is refused as not connected', async () => {
    const b = await makePc('PC-B', { advertise: [A2A_FEATURE_LINK_OFFER] });
    const a = await makePc('PC-A', { advertise: [A2A_FEATURE_LINK_OFFER] });
    await pair(a, b);
    // B pairs with A too, but keeps the result where its daemon never dials it.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-offer-e2e-'));
    dirs.push(elsewhere);
    const res = await joinRemoteHost(a.server.beginPairing().invite, {
      self: () => b.server.ensureIdentity(),
      selfName: b.name,
      remoteHosts: new RemoteHostStore({ dir: elsewhere }),
      timeouts: FAST,
    });
    expect(res.ok).toBe(true);
    // A's session to B is up and has B's hello; B has no stream to A.
    await until(() => a.delivery.liveFeatures(b.hostId)?.has(A2A_FEATURE_LINK_OFFER) === true);
    expect(await a.rpc('a2a.remote.offers.create', { hostId: b.hostId, end: A_PANE, allow: both })).toEqual({ ok: false, error: 'not-connected' });
    expect(a.exposures.isPaneExposed(b.hostId, 'ws-web', 'pane-a')).toBe(false);
    expect(a.delivery.outbox.openCount(b.hostId)).toBe(0);
  });

  it('a share to a PC whose stream has closed is refused as not connected', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A', { advertise: [A2A_FEATURE_LINK_OFFER] });
    await pair(a, b);
    await until(() => b.delivery.hub.featuresOf(a.hostId)?.has(A2A_FEATURE_LINK_OFFER) === true);
    // A goes away: its stream to B closes, and B still remembers what it took.
    await a.delivery.stop();
    await until(() => !b.delivery.hub.isConnected(a.hostId));
    expect(b.delivery.hub.featuresOf(a.hostId)?.has(A2A_FEATURE_LINK_OFFER)).toBe(true);
    expect(await share(b, a)).toEqual({ ok: false, error: 'not-connected' });
    expect(b.exposures.isPaneExposed(a.hostId, 'ws-api', 'pane-1')).toBe(false);
    expect(b.delivery.outbox.openCount(a.hostId)).toBe(0);
  });

  it('an older sharer’s listener takes the answer as an ordinary proposal for its human', async () => {
    const b = await makePc('PC-B', { routeOffers: false });
    const a = await makePc('PC-A', { advertise: [A2A_FEATURE_LINK_OFFER] });
    await pair(a, b);
    await until(() => b.delivery.hub.featuresOf(a.hostId)?.has(A2A_FEATURE_LINK_OFFER) === true);
    const made = await share(b, a);
    if (!made.ok) throw new Error('share failed');
    await until(() => inOffers(a).length === 1);
    // The older listener also checks the snapshot, which main publishes.
    await b.rpc('a2a.remote.exposure.publish', { panes: [B_PANE] });
    const accepted = (await a.rpc('a2a.remote.offers.accept', { offerId: made.offer.offerId, local: A_PANE, allow: both })) as A2aRemoteOfferResult;
    expect(accepted).toMatchObject({ ok: true, link: { state: 'proposed-out' } });
    if (!accepted.ok) throw new Error('unreachable');
    const linkId = accepted.link!.linkId;
    expect(b.links.get(linkId)?.state).toBe('proposed-in');
    expect(await b.rpc('a2a.remote.links.accept', { linkId })).toMatchObject({ ok: true });
    await until(() => a.links.get(linkId)?.state === 'active');
  });

  it('a withdrawn share disappears on A, and A’s late accept is refused as closed', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A', { advertise: [A2A_FEATURE_LINK_OFFER] });
    await pair(a, b);
    await until(() => b.delivery.hub.featuresOf(a.hostId)?.has(A2A_FEATURE_LINK_OFFER) === true);
    const made = await share(b, a);
    if (!made.ok) throw new Error('share failed');
    await until(() => inOffers(a).length === 1);
    // Withdraw on B, and accept on A before the withdrawal arrives.
    b.offers.withdraw(made.offer.offerId);
    const late = (await a.rpc('a2a.remote.offers.accept', { offerId: made.offer.offerId, local: A_PANE, allow: both })) as A2aRemoteOfferResult;
    expect(late).toMatchObject({ ok: false, error: 'offer-closed', reason: 'withdrawn' });
    expect(a.links.list()).toEqual([]);
    expect(b.links.list()).toEqual([]);
    await until(() => a.offers.store.get(made.offer.offerId)?.state === 'withdrawn');
  });

  it('A declines: B ends its share and hides the pane again', async () => {
    const b = await makePc('PC-B');
    const a = await makePc('PC-A', { advertise: [A2A_FEATURE_LINK_OFFER] });
    await pair(a, b);
    await until(() => b.delivery.hub.featuresOf(a.hostId)?.has(A2A_FEATURE_LINK_OFFER) === true);
    const made = await share(b, a);
    if (!made.ok) throw new Error('share failed');
    await until(() => inOffers(a).length === 1);
    expect(await a.rpc('a2a.remote.offers.decline', { offerId: made.offer.offerId })).toMatchObject({ ok: true, offer: { state: 'declined' } });
    expect(b.offers.store.get(made.offer.offerId)?.state).toBe('declined');
    expect(b.exposures.isPaneExposed(a.hostId, 'ws-api', 'pane-1')).toBe(false);
  });
});
