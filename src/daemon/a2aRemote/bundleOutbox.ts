import fs from 'node:fs';
import type http from 'node:http';
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
 * time is up), and only while the file is still the plain file offered (the
 * same file, size and modification time). Anything else is 404, as for a path
 * never registered. While the feature is off the route does not exist. The
 * file itself is the maker's: nothing here writes or removes it. Withdrawing
 * an offer, or removing its PC, ends a transfer of it that is under way.
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
  /** The file as it was offered: a later file at that path is not served. */
  ino: number;
  mtimeMs: number;
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

/** The file is not there, or not one a plain open reaches (a link refused by O_NOFOLLOW): null. Anything else is thrown. */
function goneOrThrow(err: unknown): null {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'ENXIO') return null;
  throw err;
}

export class BundleOutbox {
  private readonly deps: BundleOutboxDeps;
  private readonly now: () => number;
  private readonly budget: (bytes: number) => number;
  private readonly offers = new Map<string, Offered>();
  /** Responses streaming each offer now: ended when the offer ends. */
  private readonly sending = new Map<string, Set<http.ServerResponse>>();
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

  /**
   * Offer a made bundle to the PC it was made for, for `ttlMs`: the plain
   * file at `file` now, of `bytes`. False when the offer is not one this
   * serves (or the file is not that).
   */
  offer(o: BundleOffer, ttlMs = BUNDLE_TTL_DEFAULT_MS): boolean {
    if (!isHostId(o.hostId) || !isBundleId(o.bundleId) || !A2A_SHA256_RE.test(o.sha256)) return false;
    if (!Number.isInteger(o.bytes) || o.bytes < 1 || o.bytes > BUNDLE_BYTES_CEILING || !(ttlMs > 0)) return false;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(o.file);
    } catch {
      return false;
    }
    if (!st.isFile() || st.size !== o.bytes) return false;
    // Offers past their time that were never fetched go here, so the list does not grow with them.
    const now = this.now();
    for (const [k, old] of this.offers) if (now >= old.expiresAt) this.offers.delete(k);
    this.offers.set(key(o.hostId, o.bundleId), { ...o, expiresAt: now + ttlMs, ino: st.ino, mtimeMs: st.mtimeMs });
    return true;
  }

  /** The offer ends, and a transfer of it under way with it (the maker removes the file after). */
  withdraw(hostId: HostId, bundleId: string): void {
    const k = key(hostId, bundleId);
    this.offers.delete(k);
    this.endSending(k);
  }

  /** A paired PC was removed: its offers end, and every transfer to it (also of an offer already past its time). */
  forgetHost(hostId: HostId): void {
    for (const [k, o] of this.offers) if (o.hostId === hostId) this.offers.delete(k);
    for (const k of [...this.sending.keys()]) if (k.startsWith(`${hostId}:`)) this.endSending(k);
  }

  private endSending(k: string): void {
    for (const res of this.sending.get(k) ?? []) res.destroy();
    this.sending.delete(k);
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
    const k = key(offered.hostId, offered.bundleId);
    let handle: fs.promises.FileHandle | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The file as it is now, never through a link and never waiting on one that is not a plain file (a FIFO):
      // the one offered, else not served. (Windows has neither flag; its check is the stat below.)
      // An error that says nothing of the file (too many open files, a lock held for a moment) is a 503 and the
      // offer stands; only a file that is gone or is another one ends it.
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
      const pre = await fs.promises.lstat(offered.file).catch(goneOrThrow);
      handle = pre?.isFile() ? await fs.promises.open(offered.file, flags).catch(goneOrThrow) : null;
      const st = handle ? await handle.stat() : null;
      if (!handle || !st?.isFile() || st.size !== offered.bytes || st.ino !== offered.ino || st.mtimeMs !== offered.mtimeMs) {
        this.deps.log('warn', `[a2a-remote] ${what}: its file is not the one offered; the offer ends`);
        this.withdraw(offered.hostId, offered.bundleId);
        return sendJson(res, 404, { ok: false, error: 'bad-request', message: 'not found' });
      }
      // Withdrawn while the file was opened: not served.
      if (this.offers.get(k) !== offered) return sendJson(res, 404, { ok: false, error: 'bad-request', message: 'not found' });
      const live = this.sending.get(k) ?? new Set<http.ServerResponse>();
      live.add(res);
      this.sending.set(k, live);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': offered.bytes, 'Cache-Control': 'no-store' });
      // Within its size's budget: a fetch that reads too slowly is cut, and its slot freed.
      timer = setTimeout(() => res.destroy(), this.budget(offered.bytes));
      timer.unref?.();
      const stream = handle.createReadStream({ start: 0, end: offered.bytes - 1, autoClose: false });
      // Ended here, not by the pipeline: a file cut short after its check must not end a body shorter than its Content-Length.
      await pipeline(stream, res, { end: false });
      if (stream.bytesRead !== offered.bytes) throw new Error(`the file gave ${stream.bytesRead} of ${offered.bytes} bytes`);
      await new Promise<void>((resolve) => res.end(resolve));
      this.deps.log('info', `[a2a-remote] ${what}: sent`);
    } catch (err) {
      this.deps.log('info', `[a2a-remote] ${what}: not sent whole: ${errMsg(err)}`);
      if (!res.headersSent) sendJson(res, 503, { ok: false, error: 'unavailable' });
      else res.destroy();
    } finally {
      clearTimeout(timer);
      const live = this.sending.get(k);
      live?.delete(res);
      if (live?.size === 0) this.sending.delete(k);
      await handle?.close().catch(() => undefined);
      release();
    }
  }
}
