import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { A2A_ROUTES, A2A_SHA256_RE, isHostId, type HostId } from '../../shared/a2aRemote';
import { BUNDLE_BYTES_CEILING, BUNDLE_TTL_DEFAULT_MS, isBundleId } from '../../shared/a2aBundle';
import type { A2aRouteContext, A2aRouteTable } from './routes';
import { continueTransferBudgetMs, sendJson } from './server';
import { errMsg } from './storeFile';
import { transferSlots } from './transferPart';

/**
 * The bundles this PC made for other PCs, served to them (this PC is the
 * server; the asking PC joined it and fetches with a GET):
 *
 *   GET /api/a2a/bundle/:bundleId — the bundle's bytes, raw, with its exact
 *        Content-Length.
 *
 * Only the PC a bundle was made for gets it (its authenticated id, never a
 * field it sent), only while its offer stands (until it is withdrawn or its
 * time is up), and only when the file is still a plain file of the size
 * offered. Anything else is 404, as for a path never registered. While the
 * feature is off the route does not exist. The file itself is the maker's:
 * nothing here writes or removes it.
 *
 * One transfer per PC and TRANSFERS_MAX in all (else 429), each within its
 * size's budget; a fetch past it is cut, and the asking PC fetches again.
 */

/** Transfers at once: at most one per PC. */
const TRANSFERS_MAX = 2;

export interface BundleOffer {
  /** The PC it was made for: the only one that may fetch it. */
  hostId: HostId;
  bundleId: string;
  /** Where the maker keeps it. */
  file: string;
  sha256: string;
  bytes: number;
}

interface Offered extends BundleOffer {
  expiresAt: number;
}

export interface BundleOutboxDeps {
  /** The route exists only while this holds. */
  enabled: () => boolean;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Test seams. */
  now?: () => number;
  transferBudgetMs?: (bytes: number) => number;
}

const key = (hostId: HostId, bundleId: string): string => `${hostId}:${bundleId}`;

export class BundleOutbox {
  private readonly deps: BundleOutboxDeps;
  private readonly now: () => number;
  private readonly budget: (bytes: number) => number;
  private readonly offers = new Map<string, Offered>();
  private readonly slots = transferSlots(TRANSFERS_MAX);

  constructor(deps: BundleOutboxDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.budget = deps.transferBudgetMs ?? continueTransferBudgetMs;
  }

  registerRoutes(table: A2aRouteTable): void {
    // Off, this is a path never registered: a PC learns nothing of a feature switched off.
    table.add('GET', `${A2A_ROUTES.bundle}/:bundleId`, (ctx) => this.get(ctx), { when: () => this.deps.enabled() });
  }

  /** Offer a made bundle to the PC it was made for, for `ttlMs`. False when the offer is not one this serves. */
  offer(o: BundleOffer, ttlMs = BUNDLE_TTL_DEFAULT_MS): boolean {
    if (!isHostId(o.hostId) || !isBundleId(o.bundleId) || !A2A_SHA256_RE.test(o.sha256)) return false;
    if (!Number.isInteger(o.bytes) || o.bytes < 1 || o.bytes > BUNDLE_BYTES_CEILING || !(ttlMs > 0)) return false;
    this.offers.set(key(o.hostId, o.bundleId), { ...o, expiresAt: this.now() + ttlMs });
    return true;
  }

  /** The offer ends (the maker removes the file after). */
  withdraw(hostId: HostId, bundleId: string): void {
    this.offers.delete(key(hostId, bundleId));
  }

  /** A paired PC was removed: its offers end. */
  forgetHost(hostId: HostId): void {
    for (const [k, o] of this.offers) if (o.hostId === hostId) this.offers.delete(k);
  }

  /** The offer `hostId` may fetch, while it stands. */
  private standing(hostId: HostId, bundleId: string): Offered | null {
    if (!isBundleId(bundleId)) return null;
    const k = key(hostId, bundleId);
    const o = this.offers.get(k);
    if (!o) return null;
    if (this.now() >= o.expiresAt) {
      this.offers.delete(k);
      return null;
    }
    return o;
  }

  private async get({ res, params, peer }: A2aRouteContext): Promise<void> {
    const offered = this.standing(peer.hostId, params['bundleId'] ?? '');
    if (!offered) return sendJson(res, 404, { ok: false, error: 'bad-request', message: 'not found' });
    const release = this.slots.take(peer.hostId);
    if (!release) return sendJson(res, 429, { ok: false, error: 'unavailable' });
    // Before any wait: a client gone mid-transfer still gives the slot back.
    res.once('close', release);
    const what = `bundle ${offered.bundleId} for ${offered.hostId}`;
    let handle: fs.promises.FileHandle | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The file as it is now, never through a link: a plain file of the size offered, else not served.
      handle = await fs.promises.open(offered.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)).catch(() => null);
      const st = handle ? await handle.stat() : null;
      if (!handle || !st?.isFile() || st.size !== offered.bytes) {
        this.deps.log('warn', `[a2a-remote] ${what}: its file is not the one offered; the offer ends`);
        this.withdraw(offered.hostId, offered.bundleId);
        return sendJson(res, 404, { ok: false, error: 'bad-request', message: 'not found' });
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': offered.bytes, 'Cache-Control': 'no-store' });
      // Within its size's budget: a fetch that reads too slowly is cut, and its slot freed.
      timer = setTimeout(() => res.destroy(), this.budget(offered.bytes));
      timer.unref?.();
      const stream = handle.createReadStream({ start: 0, end: offered.bytes - 1, autoClose: false });
      await pipeline(stream, res);
      this.deps.log('info', `[a2a-remote] ${what}: sent`);
    } catch (err) {
      this.deps.log('info', `[a2a-remote] ${what}: not sent whole: ${errMsg(err)}`);
      if (!res.headersSent) sendJson(res, 503, { ok: false, error: 'unavailable' });
      else res.destroy();
    } finally {
      clearTimeout(timer);
      await handle?.close().catch(() => undefined);
      release();
    }
  }
}
