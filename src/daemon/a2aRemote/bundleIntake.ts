import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { A2A_ROUTES, A2A_SHA256_RE, isHostId, type HostId } from '../../shared/a2aRemote';
import { bundleBytesMax, isBundleId, type A2aBundleManifestV1 } from '../../shared/a2aBundle';
import { ContinueStagingRefusal, continueParentsInside } from './continueStaging';
import { PinnedClientError } from './pinnedClient';
import { continueTransferBudgetMs, continueWireMax } from './server';
import type { StreamedGet } from './session';
import { errMsg } from './storeFile';
import { placePart, transferSlots, wireEncoding, writePart, type TransferOutcome } from './transferPart';

/**
 * A git bundle another PC made of the work its agent did for this one,
 * fetched here (this PC is the joiner: it pulls with a GET through its
 * session; bundleOutbox.ts serves it there). What the bundle holds is not
 * read here: it is bytes of a size and hash the manifest names, staged as
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
 * so it cannot fetch from it (the other direction is not built yet).
 */

/** Transfers at once: at most one per PC. */
const TRANSFERS_MAX = 2;
const BUNDLE_IN = 'bundle-in';
const PARTS = 'parts';

export type BundlePull =
  | { kind: 'staged'; file: string }
  | Exclude<TransferOutcome, { kind: 'staged' }>
  | { kind: 'busy' }
  | { kind: 'not-joined' };

export interface BundleIntakeDeps {
  /** `<wmux dir>/a2a`: staging is its `bundle-in/`. */
  a2aDir: string;
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

const key = (hostId: HostId, m: A2aBundleManifestV1): string => `${hostId}:${stem(m)}`;

export class BundleIntake {
  private readonly deps: BundleIntakeDeps;
  private readonly budget: (bytes: number) => number;
  private readonly slots = transferSlots(TRANSFERS_MAX);
  /** One pull per bundle at a time: a second call while one runs gets its answer. */
  private readonly running = new Map<string, { hostId: HostId; done: Promise<BundlePull>; abort: AbortController }>();

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

  /** Every pull in flight ends (the daemon stops). */
  stop(): void {
    for (const r of this.running.values()) r.abort.abort();
  }

  /** A staged bundle is done with (imported, or refused there): it goes. */
  async discard(hostId: HostId, manifest: unknown): Promise<void> {
    const m = wellFormed(manifest);
    if (!isHostId(hostId) || !m) return;
    await fs.promises.rm(bundleStagedFile(this.deps.a2aDir, hostId, m), { force: true });
  }

  /** A paired PC was removed: its pulls end, then everything staged from it goes. */
  async forgetHost(hostId: HostId): Promise<void> {
    if (!isHostId(hostId)) return;
    const ending = [...this.running.values()].filter((r) => r.hostId === hostId);
    for (const r of ending) r.abort.abort();
    await Promise.allSettled(ending.map((r) => r.done));
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
      const outcome: Exclude<TransferOutcome, { kind: 'staged' }> = status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429
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
