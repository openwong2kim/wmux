import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { A2A_ROUTES, A2A_SHA256_RE, isHostId, type HostId } from '../../shared/a2aRemote';
import { BUNDLE_BYTES_CEILING, BUNDLE_BYTES_DEFAULT, isBundleId, type A2aBundleManifestV1 } from '../../shared/a2aBundle';
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
 *   <a2a dir>/bundle-in/<hostId>/<bundleId>.bundle
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

/** Where a fetched bundle is staged. */
export function bundleStagedFile(a2aDir: string, hostId: HostId, bundleId: string): string {
  return path.join(bundleStagingHostDir(a2aDir, hostId), `${bundleId}.bundle`);
}

const key = (hostId: HostId, bundleId: string): string => `${hostId}:${bundleId}`;

export class BundleIntake {
  private readonly deps: BundleIntakeDeps;
  private readonly budget: (bytes: number) => number;
  private readonly slots = transferSlots(TRANSFERS_MAX);
  /** One pull per bundle at a time: a second call while one runs gets its answer. */
  private readonly running = new Map<string, Promise<BundlePull>>();

  constructor(deps: BundleIntakeDeps) {
    this.deps = deps;
    this.budget = deps.transferBudgetMs ?? continueTransferBudgetMs;
  }

  /** Fetch the bundle `manifest` names from `hostId` into staging, once. */
  pull(hostId: HostId, manifest: A2aBundleManifestV1, signal?: AbortSignal): Promise<BundlePull> {
    const k = key(hostId, manifest.bundleId);
    const running = this.running.get(k);
    if (running) return running;
    const run = this.pullOnce(hostId, manifest, signal ?? new AbortController().signal).finally(() => this.running.delete(k));
    this.running.set(k, run);
    return run;
  }

  /** A staged bundle is done with (imported, or refused there): it goes. */
  async discard(hostId: HostId, bundleId: string): Promise<void> {
    if (!isHostId(hostId) || !isBundleId(bundleId)) return;
    await fs.promises.rm(bundleStagedFile(this.deps.a2aDir, hostId, bundleId), { force: true });
  }

  /** A paired PC was removed: everything staged from it goes. */
  async forgetHost(hostId: HostId): Promise<void> {
    if (!isHostId(hostId)) return;
    await fs.promises.rm(bundleStagingHostDir(this.deps.a2aDir, hostId), { recursive: true, force: true });
  }

  /** After a restart: part files of transfers that never finished go (a link is removed, never followed). */
  async sweepParts(): Promise<void> {
    const root = path.join(this.deps.a2aDir, BUNDLE_IN);
    const hosts = await fs.promises.readdir(root).catch(() => [] as string[]);
    await Promise.all(hosts.filter(isHostId).map((h) => fs.promises.rm(path.join(root, h, PARTS), { recursive: true, force: true })));
  }

  private async pullOnce(hostId: HostId, m: A2aBundleManifestV1, signal: AbortSignal): Promise<BundlePull> {
    if (!isHostId(hostId) || !isBundleId(m.bundleId) || !A2A_SHA256_RE.test(m.sha256)) return { kind: 'fatal', why: 'not a bundle this PC can fetch' };
    const max = Math.min(this.deps.maxBytes?.() ?? BUNDLE_BYTES_DEFAULT, BUNDLE_BYTES_CEILING);
    if (!Number.isInteger(m.bytes) || m.bytes < 1) return { kind: 'fatal', why: 'not a bundle this PC can fetch' };
    if (m.bytes > max) return { kind: 'fatal', why: `${m.bytes} bytes, past the ${max} this PC takes` };
    const what = `bundle ${m.bundleId} from ${hostId}`;
    const target = bundleStagedFile(this.deps.a2aDir, hostId, m.bundleId);
    try {
      // Fetched before (a repeat after a restart, say): taken as it is when it still checks out.
      if (await holds(this.deps.a2aDir, target, m.sha256, m.bytes)) return { kind: 'staged', file: target };
    } catch (err) {
      return { kind: 'fatal', why: err instanceof ContinueStagingRefusal ? err.message : errMsg(err) };
    }
    const get = this.deps.fetchFrom(hostId);
    if (!get) return { kind: 'not-joined' };
    const release = this.slots.take(hostId);
    if (!release) return { kind: 'busy' };
    const cut = new AbortController();
    const timer = setTimeout(() => cut.abort(), this.budget(m.bytes));
    timer.unref?.();
    const both = AbortSignal.any([signal, cut.signal]);
    const part = path.join(bundleStagingHostDir(this.deps.a2aDir, hostId), PARTS, m.bundleId);
    try {
      await fs.promises.mkdir(this.deps.a2aDir, { recursive: true });
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
