import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { A2A_ROUTES, A2A_SHA256_RE, isHostId, type HostId } from '../../shared/a2aRemote';
import { BUNDLE_BYTES_CEILING, BUNDLE_TTL_DEFAULT_MS, isBundleId } from '../../shared/a2aBundle';
import type { A2aRouteContext, A2aRouteTable } from './routes';
import { continueTransferBudgetMs, sendJson } from './server';
import { PinnedClientError } from './pinnedClient';
import type { StreamedPut } from './session';
import { errMsg } from './storeFile';
import { isRefusalStatus, transferSlots } from './transferPart';

/**
 * The bundles this PC made for other PCs, handed to them whichever PC
 * dialled:
 *
 *   The asking PC joined this one: it fetches with a GET.
 *     GET /api/a2a/bundle/:bundleId — the bundle's bytes, raw, with its
 *          exact Content-Length.
 *   This PC joined the asking one: `send` puts it there with a PUT through
 *     this PC's session (bundleIntake.ts takes it; the asking PC asked for
 *     it, and waits for that id and hash only). Its answer: `sent` (also
 *     when it was taken already); `again` when the transfer broke or the
 *     other PC was busy; `fatal` when it was refused (nothing awaited there,
 *     or not that bundle); `busy` when a transfer to that PC, or two in all,
 *     already runs here. A refusal that
 *     closes the connection before its answer is read reads as `again`: the
 *     caller tries a bounded number of times.
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

/** Transfers at once, fetches and sends together: at most one per PC. */
const TRANSFERS_MAX = 2;

export type BundleSend =
  | { kind: 'sent' }
  | { kind: 'again'; why: string }
  | { kind: 'fatal'; why: string }
  | { kind: 'busy' };

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
  /** Transfers of each offer under way (how to end each): ended when the offer ends. */
  private readonly sending = new Map<string, Set<() => void>>();
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
    for (const end of this.sending.get(k) ?? []) end();
    this.sending.delete(k);
  }

  /** A transfer of `k` under way, ended by `end` when its offer ends; the returned call forgets it. */
  private track(k: string, end: () => void): () => void {
    const live = this.sending.get(k) ?? new Set<() => void>();
    live.add(end);
    this.sending.set(k, live);
    return () => {
      live.delete(end);
      if (live.size === 0 && this.sending.get(k) === live) this.sending.delete(k);
    };
  }

  /**
   * Open the offered file as it is now, never through a link and never waiting on one that is not a plain file (a
   * FIFO): the one offered, else null, and the offer ends. An error that says nothing of the file (too many open
   * files, a lock held for a moment) is thrown, and the offer stands. (Windows has neither flag; its check is the
   * identity compared below.)
   */
  private async openOffered(offered: Offered, what: string): Promise<fs.promises.FileHandle | null> {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    const pre = await fs.promises.lstat(offered.file).catch(goneOrThrow);
    const handle = pre?.isFile() ? await fs.promises.open(offered.file, flags).catch(goneOrThrow) : null;
    const st = handle ? await handle.stat().catch(async (err: unknown) => {
      await handle.close().catch(() => undefined);
      throw err;
    }) : null;
    if (handle && st?.isFile() && st.size === offered.bytes && st.ino === offered.ino && st.mtimeMs === offered.mtimeMs) return handle;
    await handle?.close().catch(() => undefined);
    this.deps.log('warn', `[a2a-remote] ${what}: its file is not the one offered; the offer ends`);
    this.withdraw(offered.hostId, offered.bundleId);
    return null;
  }

  /**
   * Send an offered bundle to the PC it was made for, which asked for it, when this PC joined that one: a PUT of
   * its bytes through this PC's session (`put`), within its size's budget.
   */
  async send(hostId: HostId, bundleId: string, put: StreamedPut): Promise<BundleSend> {
    if (!this.deps.enabled()) return { kind: 'fatal', why: 'bundles are off on this PC' };
    const offered = this.standing(hostId, bundleId);
    if (!offered) return { kind: 'fatal', why: 'not offered to that PC' };
    const release = this.slots.take(hostId);
    if (!release) return { kind: 'busy' };
    const what = `bundle ${offered.bundleId} for ${offered.hostId}`;
    const k = key(offered.hostId, offered.bundleId);
    const abort = new AbortController();
    const forget = this.track(k, () => abort.abort());
    let handle: fs.promises.FileHandle | null = null;
    let stream: fs.ReadStream | null = null;
    try {
      handle = await this.openOffered(offered, what);
      if (!handle) return { kind: 'fatal', why: 'its file is not the one offered' };
      // Withdrawn while the file was opened: not sent.
      if (this.offers.get(k) !== offered || abort.signal.aborted) return { kind: 'fatal', why: 'not offered to that PC' };
      stream = handle.createReadStream({ start: 0, end: offered.bytes - 1, autoClose: false });
      const { status } = await put(`${A2A_ROUTES.bundle}/${offered.bundleId}/${offered.sha256}`, stream, {
        bytes: offered.bytes,
        timeoutMs: this.budget(offered.bytes),
        signal: abort.signal,
      });
      if (status === 200) {
        this.deps.log('info', `[a2a-remote] ${what}: sent`);
        return { kind: 'sent' };
      }
      // As for a fetch: a refusal of this bundle (a 4xx but 401, 408 and 429) is final; anything else is tried again.
      const refused = isRefusalStatus(status);
      const why = `the other PC answered HTTP ${status}`;
      this.deps.log(refused ? 'warn' : 'info', `[a2a-remote] ${what}: not sent: ${why}`);
      return { kind: refused ? 'fatal' : 'again', why };
    } catch (err) {
      const why = err instanceof PinnedClientError ? `${err.code}: ${err.message}` : errMsg(err);
      this.deps.log('info', `[a2a-remote] ${what}: not sent whole: ${why}`);
      return { kind: 'again', why };
    } finally {
      forget();
      // Not read to its end when the request failed first: never left on a closed handle.
      stream?.destroy();
      await handle?.close().catch(() => undefined);
      release();
    }
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
    let forget = (): void => undefined;
    try {
      // An error that says nothing of the file is a 503 and the offer stands; a file that is not the one offered is 404.
      handle = await this.openOffered(offered, what);
      // Withdrawn while the file was opened (or just now): not served.
      if (!handle || this.offers.get(k) !== offered) return sendJson(res, 404, { ok: false, error: 'bad-request', message: 'not found' });
      forget = this.track(k, () => res.destroy());
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
      forget();
      await handle?.close().catch(() => undefined);
      release();
    }
  }
}
