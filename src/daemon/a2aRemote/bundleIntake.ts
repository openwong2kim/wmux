import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { A2A_ROUTES, A2A_SHA256_RE, isHostId, type HostId } from '../../shared/a2aRemote';
import { BUNDLE_TTL_DEFAULT_MS, bundleBytesMax, isBundleId, type A2aBundleManifestV1 } from '../../shared/a2aBundle';
import { ContinueStagingRefusal, continueParentsInside } from './continueStaging';
import { PinnedClientError } from './pinnedClient';
import type { A2aRouteContext, A2aRouteTable } from './routes';
import { continueTransferBudgetMs, continueWireMax, extendBodyDeadline, sendJson } from './server';
import type { StreamedGet } from './session';
import { errMsg } from './storeFile';
import { answerAndClose, isRefusalStatus, placePart, transferSlots, wireEncoding, writePart, type TransferOutcome } from './transferPart';

/**
 * A git bundle another PC made of the work its agent did for this one,
 * taken in here, whichever PC dialled:
 *
 *   This PC joined that one: it pulls with a GET through its session
 *     (`pull`; bundleOutbox.ts serves it there).
 *   That PC joined this one: this PC waits for it (`receive`) and that PC
 *     sends it with a PUT through its session (bundleOutbox.ts `send`):
 *     PUT /api/a2a/bundle/:bundleId/:sha256 — answered only for the PC this
 *     one waits on (its authenticated id, never a field it sent), for that
 *     id and hash, while the wait stands, with a raw body (no encoding) of
 *     exactly the manifest's size declared. Anything else is answered before
 *     any byte of the body is read, and its connection is closed: 404 when
 *     nothing is awaited. Once staged, the wait is over: the route takes
 *     that bundle no more. While the feature is off the route does not exist.
 *
 * What the bundle holds is not read here: it is bytes of a size and hash
 * the manifest names, staged as
 *
 *   <a2a dir>/bundle-in/<hostId>/<bundleId>.<sha256>.<bytes>.bundle
 *
 * for the import to read (and remove). The body streams through a count on
 * the wire and a count and hash of its bytes into a part file made with
 * O_EXCL, never past the manifest's size; only exactly that size with that
 * hash is renamed into place. Anything else leaves nothing behind.
 *
 * Refused before any byte (`fatal`): a manifest that is not well formed, a
 * size past this PC's limit (a setting, at most BUNDLE_BYTES_CEILING), an
 * answer of 404 or another refusal. Tried again by the caller (`again`): a
 * transfer that broke or ran past its budget. `busy`: a transfer from that
 * PC, or two in all, already runs. `not-joined`: this PC is that PC's server,
 * so it cannot fetch from it; it waits for that PC to send it (`receive`).
 */

/** Transfers at once: at most one per PC. */
const TRANSFERS_MAX = 2;
const BUNDLE_IN = 'bundle-in';
const PARTS = 'parts';
/** The longest a timer waits: past it, Node fires at once. */
const TIMER_MAX_MS = 2 ** 31 - 1;

export type BundlePull =
  | { kind: 'staged'; file: string }
  | Exclude<TransferOutcome, { kind: 'staged' }>
  | { kind: 'busy' }
  | { kind: 'not-joined' };

export interface BundleIntakeDeps {
  /** `<wmux dir>/a2a`: staging is its `bundle-in/`. */
  a2aDir: string;
  /** The bundle feature is on: else the PUT route does not exist. */
  enabled: () => boolean;
  /** A streamed GET from `hostId`, when this PC joined it; null when that PC joined this one. */
  fetchFrom: (hostId: HostId) => StreamedGet | null;
  /** The largest bundle taken (a setting); held to BUNDLE_BYTES_CEILING. */
  maxBytes?: () => number;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Test seam. */
  transferBudgetMs?: (bytes: number) => number;
}

/** The folder a PC's fetched bundles are staged in. */
export function bundleStagingHostDir(a2aDir: string, hostId: HostId): string {
  return path.join(a2aDir, BUNDLE_IN, hostId);
}

/** A manifest's name in staging: its id, hash and size, so a manifest that reuses an id with another hash or size never takes or removes what another staged. */
const stem = (m: A2aBundleManifestV1): string => `${m.bundleId}.${m.sha256}.${m.bytes}`;

/** Where a fetched bundle is staged. */
export function bundleStagedFile(a2aDir: string, hostId: HostId, m: A2aBundleManifestV1): string {
  return path.join(bundleStagingHostDir(a2aDir, hostId), `${stem(m)}.bundle`);
}

const NOT_FOUND = { ok: false, error: 'bad-request', message: 'not found' };

/** A bundle this PC waits for: taken once, by one PUT at a time. */
interface Wait {
  hostId: HostId;
  m: A2aBundleManifestV1;
  done: Promise<BundlePull>;
  settle: (r: BundlePull) => void;
  /** Ends a transfer of it under way when the wait ends. */
  abort: AbortController;
  receiving: boolean;
  /** Its staged check (receive): a PUT waits for it, so the check cannot remove what a PUT placed. */
  checked: Promise<void>;
  /** Cuts the PUT under way, for a newer PUT of it from the same PC (that one is the sender's retry). */
  cut: (() => void) | undefined;
  /** Its time ran out while a transfer of it ran: it ends once that transfer does. */
  late: boolean;
  /** Settles once a PUT of it under way has finished with its files. */
  landed: Promise<void>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const key = (hostId: HostId, m: A2aBundleManifestV1): string => `${hostId}:${stem(m)}`;
/** A wait, by what its PUT route names: the PC, the id and the hash (the size is the request's declared length). */
const waitKey = (hostId: HostId, m: Pick<A2aBundleManifestV1, 'bundleId' | 'sha256'>): string => `${hostId}:${m.bundleId}:${m.sha256}`;

export class BundleIntake {
  private readonly deps: BundleIntakeDeps;
  private readonly budget: (bytes: number) => number;
  private readonly slots = transferSlots(TRANSFERS_MAX);
  /** One pull per bundle at a time: a second call while one runs gets its answer. */
  private readonly running = new Map<string, { hostId: HostId; done: Promise<BundlePull>; abort: AbortController }>();
  /** Bundles this PC waits for a PC that joined it to send. */
  private readonly awaited = new Map<string, Wait>();

  constructor(deps: BundleIntakeDeps) {
    this.deps = deps;
    this.budget = deps.transferBudgetMs ?? continueTransferBudgetMs;
  }

  /**
   * Fetch the bundle `manifest` names from `hostId` into staging, once: a
   * second call while one runs gets its answer. A pull ends early only when
   * its PC is removed (forgetHost) or the intake stops.
   */
  pull(hostId: HostId, manifest: unknown): Promise<BundlePull> {
    const m = wellFormed(manifest);
    if (!isHostId(hostId) || !m) return Promise.resolve({ kind: 'fatal', why: 'not a bundle this PC can fetch' });
    const k = key(hostId, m);
    const running = this.running.get(k);
    if (running) return running.done;
    const abort = new AbortController();
    const done = this.pullOnce(hostId, m, abort.signal).finally(() => this.running.delete(k));
    this.running.set(k, { hostId, done, abort });
    return done;
  }

  registerRoutes(table: A2aRouteTable): void {
    // Off, this is a path never registered: a PC learns nothing of a feature switched off.
    table.add('PUT', `${A2A_ROUTES.bundle}/:bundleId/:sha256`, (ctx) => this.put(ctx), { when: () => this.deps.enabled() });
  }

  /**
   * Wait, for `ttlMs`, for `hostId` (a PC that joined this one) to send the
   * bundle `manifest` names, and take it once. A second call while it waits
   * gets the same answer. Resolves `staged` once it is in, `fatal` when what
   * came is not that bundle, and `again` when nothing came in time or the
   * wait ended (the PC removed, the intake stopped).
   */
  receive(hostId: HostId, manifest: unknown, ttlMs = BUNDLE_TTL_DEFAULT_MS): Promise<BundlePull> {
    const m = wellFormed(manifest);
    if (!isHostId(hostId) || !m || !(ttlMs > 0 && ttlMs <= TIMER_MAX_MS)) return Promise.resolve({ kind: 'fatal', why: 'not a bundle this PC can take' });
    // Off, the route it would come by does not exist: nothing is waited for.
    if (!this.deps.enabled()) return Promise.resolve({ kind: 'fatal', why: 'bundles are off on this PC' });
    const max = bundleBytesMax(this.deps.maxBytes?.());
    if (m.bytes > max) return Promise.resolve({ kind: 'fatal', why: `${m.bytes} bytes, past the ${max} this PC takes` });
    const k = waitKey(hostId, m);
    const waiting = this.awaited.get(k);
    // The same manifest waited for twice is one wait; the same id and hash with another size is not that bundle.
    if (waiting) return waiting.m.bytes === m.bytes ? waiting.done : Promise.resolve({ kind: 'fatal', why: 'another size is awaited for that bundle' });
    let settle: (r: BundlePull) => void = () => undefined;
    const done = new Promise<BundlePull>((r) => { settle = r; });
    const w: Wait = { hostId, m, done, settle, abort: new AbortController(), receiving: false, checked: Promise.resolve(), cut: undefined, late: false, landed: Promise.resolve(), timer: undefined };
    // A transfer under way when the time is up still lands, within its own budget; the wait ends after it.
    w.timer = setTimeout(() => {
      if (w.receiving) w.late = true;
      else this.endWait(k, { kind: 'again', why: 'not sent in time' }, w);
    }, ttlMs);
    w.timer.unref?.();
    this.awaited.set(k, w);
    // Taken before (a repeat after a restart, say): the wait is over at once when it still checks out. Something
    // other than a plain file where it goes is final at once, as for a pull.
    const target = bundleStagedFile(this.deps.a2aDir, hostId, m);
    w.checked = holds(this.deps.a2aDir, target, m.sha256, m.bytes).then(
      (held) => { if (held) this.endWait(k, { kind: 'staged', file: target }, w); },
      (err: unknown) => { if (err instanceof ContinueStagingRefusal) this.endWait(k, { kind: 'fatal', why: err.message }, w); },
    );
    return done;
  }

  /** Every pull and wait ends (the daemon stops). */
  stop(): void {
    for (const r of this.running.values()) r.abort.abort();
    for (const k of [...this.awaited.keys()]) this.endWait(k, { kind: 'again', why: 'stopped' });
  }

  /** The wait for `k` (only `only`, when named: a later wait for the same bundle is not this one's) ends with `r`, and a transfer of it under way with it. */
  private endWait(k: string, r: BundlePull, only?: Wait): void {
    const w = this.awaited.get(k);
    if (!w || (only && w !== only)) return;
    this.awaited.delete(k);
    clearTimeout(w.timer);
    w.abort.abort();
    w.settle(r);
  }

  private async put({ req, res, params, peer }: A2aRouteContext): Promise<void> {
    const k = waitKey(peer.hostId, { bundleId: params['bundleId'] ?? '', sha256: params['sha256'] ?? '' });
    let w = this.awaited.get(k);
    if (w) {
      await w.checked;
      // Found staged by that check: taken already.
      if (this.awaited.get(k) !== w) w = undefined;
    }
    if (!w) return this.takenAlready(req, res, params, peer.hostId);
    if (wireEncoding(req.headers['content-encoding']) !== 'identity') {
      return answerAndClose(req, res, 415, { ok: false, error: 'bad-request', message: 'raw bytes only' });
    }
    // Exactly the manifest's size, declared up front: never chunked, never more or less.
    if (req.headers['content-length'] !== String(w.m.bytes)) {
      return answerAndClose(req, res, 411, { ok: false, error: 'bad-request', message: 'the manifest\'s length only' });
    }
    if (w.receiving) {
      // The same PC sends it again: the PUT under way is one it gave up on (a connection this side has not seen
      // drop yet). That one is cut, and this one taken.
      w.cut?.();
      await w.landed;
      if (this.awaited.get(k) !== w || w.receiving) return answerAndClose(req, res, 429, { ok: false, error: 'unavailable' });
    }
    const release = this.slots.take(peer.hostId);
    if (!release) return answerAndClose(req, res, 429, { ok: false, error: 'unavailable' });
    // Before any wait: a client gone mid-request still gives the slot back.
    res.once('close', release);
    w.receiving = true;
    let landed: () => void = () => undefined;
    w.landed = new Promise((r) => { landed = r; });
    const { m } = w;
    const what = `bundle ${m.bundleId} from ${w.hostId}`;
    const target = bundleStagedFile(this.deps.a2aDir, w.hostId, m);
    const part = path.join(bundleStagingHostDir(this.deps.a2aDir, w.hostId), PARTS, stem(m));
    const cut = new AbortController();
    w.cut = () => cut.abort();
    const timer = setTimeout(() => cut.abort(), this.budget(m.bytes));
    timer.unref?.();
    const both = AbortSignal.any([w.abort.signal, cut.signal]);
    // A wait that ends meanwhile (the PC removed) cuts the connection.
    const onEnd = (): void => { req.destroy(); };
    w.abort.signal.addEventListener('abort', onEnd, { once: true });
    let outcome: TransferOutcome;
    try {
      // Its own budget, not the listener's 30 s: a file of megabytes takes longer.
      extendBodyDeadline(req, this.budget(m.bytes));
      await fs.promises.mkdir(path.join(this.deps.a2aDir, BUNDLE_IN), { recursive: true, mode: 0o700 });
      await continueParentsInside(this.deps.a2aDir, part, true);
      await fs.promises.rm(part, { force: true });
      outcome = await writePart(req, 'identity', m.sha256, m.bytes, part, both);
      if (outcome.kind === 'staged') await placePart(this.deps.a2aDir, part, target);
    } catch (err) {
      outcome = err instanceof ContinueStagingRefusal ? { kind: 'fatal', why: err.message } : { kind: 'again', why: errMsg(err) };
    } finally {
      clearTimeout(timer);
      w.cut = undefined;
      w.abort.signal.removeEventListener('abort', onEnd);
      release();
    }
    if (outcome.kind !== 'staged') await fs.promises.rm(part, { force: true }).catch(() => undefined);
    landed();
    if (outcome.kind === 'staged') {
      this.deps.log('info', `[a2a-remote] ${what}: received (${m.bytes} bytes)`);
      this.endWait(k, { kind: 'staged', file: target }, w);
      return sendJson(res, 200, { ok: true });
    }
    this.deps.log(outcome.kind === 'fatal' ? 'warn' : 'info', `[a2a-remote] ${what}: not received: ${outcome.why}`);
    // What came is not that bundle: the wait is over. A transfer that broke may come again while the wait stands.
    if (outcome.kind === 'fatal') {
      this.endWait(k, outcome, w);
      return answerAndClose(req, res, 400, { ok: false, error: 'bad-request' });
    }
    w.receiving = false;
    // Its time ran out while this transfer ran: the wait ends now.
    if (w.late) this.endWait(k, { kind: 'again', why: 'not sent in time' }, w);
    // The body may be read only in part: never drained.
    return answerAndClose(req, res, 503, { ok: false, error: 'unavailable' });
  }

  /**
   * A PUT of a bundle no wait stands for. Staged already (its answer was lost on the way, or the wait found it staged
   * when it began): its bytes are read and dropped, then 200, since an answer before them can reach the sender as a
   * broken connection. Anything else: 404.
   */
  private async takenAlready(req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, hostId: HostId): Promise<void> {
    const m = wellFormed({ bundleId: params['bundleId'], sha256: params['sha256'], bytes: Number(req.headers['content-length']) });
    const st = m ? await fs.promises.lstat(bundleStagedFile(this.deps.a2aDir, hostId, m)).catch(() => null) : null;
    if (!m || !st?.isFile() || st.size !== m.bytes || wireEncoding(req.headers['content-encoding']) !== 'identity') {
      return answerAndClose(req, res, 404, NOT_FOUND);
    }
    const release = this.slots.take(hostId);
    if (!release) return answerAndClose(req, res, 429, { ok: false, error: 'unavailable' });
    res.once('close', release);
    let n = 0;
    try {
      extendBodyDeadline(req, this.budget(m.bytes));
      await pipeline(req, new Writable({
        write(chunk: Buffer, _enc, done) {
          n += chunk.length;
          done(n > m!.bytes ? new Error('longer than declared') : null);
        },
      }), { signal: AbortSignal.timeout(this.budget(m.bytes)) });
    } catch {
      return answerAndClose(req, res, 503, { ok: false, error: 'unavailable' });
    } finally {
      release();
    }
    return sendJson(res, 200, { ok: true });
  }

  /** A staged bundle is done with (imported, or refused there): it goes. */
  async discard(hostId: HostId, manifest: unknown): Promise<void> {
    const m = wellFormed(manifest);
    if (!isHostId(hostId) || !m) return;
    await fs.promises.rm(bundleStagedFile(this.deps.a2aDir, hostId, m), { force: true });
  }

  /** A paired PC was removed: its pulls and waits end, then everything staged from it goes. */
  async forgetHost(hostId: HostId): Promise<void> {
    if (!isHostId(hostId)) return;
    const waits = [...this.awaited].filter(([, w]) => w.hostId === hostId);
    for (const [k] of waits) this.endWait(k, { kind: 'again', why: 'that PC was removed' });
    const ending = [...this.running.values()].filter((r) => r.hostId === hostId);
    for (const r of ending) r.abort.abort();
    await Promise.allSettled([...ending.map((r) => r.done), ...waits.map(([, w]) => w.landed)]);
    await fs.promises.rm(bundleStagingHostDir(this.deps.a2aDir, hostId), { recursive: true, force: true });
  }

  /** After a restart: part files of transfers that never finished go (a link is removed, never followed). */
  async sweepParts(): Promise<void> {
    const root = path.join(this.deps.a2aDir, BUNDLE_IN);
    const hosts = await fs.promises.readdir(root).catch(() => [] as string[]);
    await Promise.all(hosts.filter(isHostId).map((h) => fs.promises.rm(path.join(root, h, PARTS), { recursive: true, force: true })));
  }

  private async pullOnce(hostId: HostId, m: A2aBundleManifestV1, signal: AbortSignal): Promise<BundlePull> {
    const max = bundleBytesMax(this.deps.maxBytes?.());
    if (m.bytes > max) return { kind: 'fatal', why: `${m.bytes} bytes, past the ${max} this PC takes` };
    const what = `bundle ${m.bundleId} from ${hostId}`;
    const target = bundleStagedFile(this.deps.a2aDir, hostId, m);
    try {
      // Fetched before (a repeat after a restart, say): taken as it is when it still checks out.
      if (await holds(this.deps.a2aDir, target, m.sha256, m.bytes)) return { kind: 'staged', file: target };
    } catch (err) {
      // A link or another kind of file where staging goes is final; a passing read error is tried again.
      return err instanceof ContinueStagingRefusal ? { kind: 'fatal', why: err.message } : { kind: 'again', why: errMsg(err) };
    }
    const get = this.deps.fetchFrom(hostId);
    if (!get) return { kind: 'not-joined' };
    const release = this.slots.take(hostId);
    if (!release) return { kind: 'busy' };
    const cut = new AbortController();
    const timer = setTimeout(() => cut.abort(), this.budget(m.bytes));
    timer.unref?.();
    const both = AbortSignal.any([signal, cut.signal]);
    const part = path.join(bundleStagingHostDir(this.deps.a2aDir, hostId), PARTS, stem(m));
    try {
      // Made at once, so two PCs fetching for the first time never race to make it; it is checked to be a plain folder next.
      await fs.promises.mkdir(path.join(this.deps.a2aDir, BUNDLE_IN), { recursive: true, mode: 0o700 });
      await continueParentsInside(this.deps.a2aDir, part, true);
      await fs.promises.rm(part, { force: true });
      const written = await get(
        `${A2A_ROUTES.bundle}/${m.bundleId}`,
        { timeoutMs: this.budget(m.bytes), signal: both },
        async ({ headers, body }): Promise<TransferOutcome> => {
          const encoding = wireEncoding(headers['content-encoding']);
          const declared = headers['content-length'];
          if (!encoding || (declared !== undefined && Number(declared) > continueWireMax(m.bytes, encoding))) {
            body.destroy();
            return { kind: 'fatal', why: encoding ? 'its declared length is past its manifest' : 'sent in an encoding other than identity or gzip' };
          }
          return writePart(body, encoding, m.sha256, m.bytes, part, both);
        },
      );
      if (written.kind !== 'staged') {
        this.deps.log(written.kind === 'fatal' ? 'warn' : 'info', `[a2a-remote] ${what}: not fetched: ${written.why}`);
        return written;
      }
      await placePart(this.deps.a2aDir, part, target);
      this.deps.log('info', `[a2a-remote] ${what}: fetched (${m.bytes} bytes)`);
      return { kind: 'staged', file: target };
    } catch (err) {
      await fs.promises.rm(part, { force: true }).catch(() => undefined);
      if (err instanceof ContinueStagingRefusal) return { kind: 'fatal', why: err.message };
      // Refused before any byte: for good when that PC no longer offers it (404) or will not give it.
      const status = err instanceof PinnedClientError && err.code === 'http' ? err.status : undefined;
      const outcome: Exclude<TransferOutcome, { kind: 'staged' }> = status !== undefined && isRefusalStatus(status)
        ? { kind: 'fatal', why: `the other PC answered HTTP ${status}` }
        : { kind: 'again', why: err instanceof PinnedClientError ? err.code : errMsg(err) };
      this.deps.log('info', `[a2a-remote] ${what}: not fetched: ${outcome.why}`);
      return outcome;
    } finally {
      clearTimeout(timer);
      release();
    }
  }
}

/** The manifest as taken: an id, a hash and a whole positive size, each of its type; null otherwise. */
function wellFormed(raw: unknown): A2aBundleManifestV1 | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { bundleId, sha256, bytes } = raw as Record<string, unknown>;
  if (!isBundleId(bundleId) || typeof sha256 !== 'string' || !A2A_SHA256_RE.test(sha256)) return null;
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1) return null;
  return { bundleId, sha256, bytes };
}

/** `target` is a plain file reached through plain folders, of exactly `bytes` with hash `sha`; one that is not goes. */
async function holds(a2aDir: string, target: string, sha: string, bytes: number): Promise<boolean> {
  if (!(await fs.promises.lstat(a2aDir).catch(() => null))) return false;
  if (!(await continueParentsInside(a2aDir, target, false))) return false;
  const st = await fs.promises.lstat(target).catch(() => null);
  if (!st) return false;
  if (!st.isFile()) throw new ContinueStagingRefusal('something other than a plain file where a staged bundle goes');
  if (st.size === bytes) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(target)) hash.update(chunk as Buffer);
    if (hash.digest('hex') === sha) return true;
  }
  await fs.promises.rm(target, { force: true });
  return false;
}
