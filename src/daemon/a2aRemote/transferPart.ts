import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import type { HostId } from '../../shared/a2aRemote';
import { ContinueStagingRefusal, continueParentsInside } from './continueStaging';
import { continueWireMax, sendJson } from './server';
import { errMsg } from './storeFile';

/**
 * The pieces a file transfer between paired PCs is made of, shared by a
 * continued conversation's files (continueBundle.ts) and a returned bundle
 * (bundleIntake.ts, bundleOutbox.ts): the slots transfers take, the wire
 * encodings taken, a body streamed into a checked part file, and that part
 * file put in place.
 */

export type WireEncoding = 'identity' | 'gzip';

/** How one transfer ended. */
export type TransferOutcome =
  | { kind: 'staged' }
  /** A check failed: the transfer is not tried again. */
  | { kind: 'fatal'; why: string }
  /** It broke on the way (a reset, a cut, this disk): tried again. */
  | { kind: 'again'; why: string };

/** One transfer per PC and `max` in all; `take` answers its release, or null when there is no room. */
export function transferSlots(max: number): { take(hostId: HostId): (() => void) | null } {
  const perPeer = new Set<HostId>();
  return {
    take(hostId) {
      if (perPeer.has(hostId) || perPeer.size >= max) return null;
      perPeer.add(hostId);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        perPeer.delete(hostId);
      };
    },
  };
}

/** A body's Content-Encoding, when it is one taken here (identity or gzip). */
export function wireEncoding(header: string | string[] | undefined): WireEncoding | null {
  if (header === undefined) return 'identity';
  if (typeof header !== 'string') return null;
  const value = header.trim().toLowerCase();
  if (value === '' || value === 'identity') return 'identity';
  return value === 'gzip' ? 'gzip' : null;
}

/**
 * Stream a body into a new part file: counted on the wire (at most
 * continueWireMax of `bytes`), gunzipped when gzip, counted and hashed as it
 * inflates (at most `bytes`), then exactly `bytes` with hash `sha`. The part
 * file goes on anything but `staged`.
 */
export async function writePart(source: Readable, encoding: WireEncoding, sha: string, bytes: number, part: string, signal: AbortSignal): Promise<TransferOutcome> {
  const wireMax = continueWireMax(bytes, encoding);
  const hash = crypto.createHash('sha256');
  let wire = 0;
  let size = 0;
  let refused: string | null = null;
  const onWire = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      wire += chunk.length;
      if (wire > wireMax) {
        refused = 'more bytes on the wire than its entry allows';
        return done(new Error(refused));
      }
      done(null, chunk);
    },
  });
  const inflated = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > bytes) {
        refused = 'larger than its entry';
        return done(new Error(refused));
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  const out = fs.createWriteStream(part, { flags: 'wx', mode: 0o600 });
  try {
    await pipeline(encoding === 'gzip' ? [source, onWire, zlib.createGunzip(), inflated, out] : [source, onWire, inflated, out], { signal });
  } catch (err) {
    await fs.promises.rm(part, { force: true }).catch(() => undefined);
    if (refused) return { kind: 'fatal', why: refused };
    if (signal.aborted) return { kind: 'again', why: 'cut: past its budget, or the request ended' };
    // A body that arrived whole yet does not inflate (the first error is the inflater's: a cut body fails first).
    if (isZlibError(err)) return { kind: 'fatal', why: 'its gzip does not inflate' };
    return { kind: 'again', why: errMsg(err) };
  }
  const digest = hash.digest('hex');
  if (size === bytes && digest === sha) return { kind: 'staged' };
  await fs.promises.rm(part, { force: true }).catch(() => undefined);
  return { kind: 'fatal', why: size !== bytes ? `${size} bytes, not its entry's ${bytes}` : 'a hash other than its entry names' };
}

function isZlibError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('Z_');
}

/** Rename a checked part file to its staged path, made through plain folders only; refused over anything but a plain file. */
export async function placePart(dir: string, part: string, target: string): Promise<void> {
  try {
    await continueParentsInside(dir, target, true);
    const st = await fs.promises.lstat(target).catch(() => null);
    if (st && !st.isFile()) throw new ContinueStagingRefusal('something other than a plain file where a staged file goes');
    // On disk before it takes its name: a power cut after `received` never leaves a staged file cut short.
    await syncFile(part);
    await fs.promises.rename(part, target);
  } catch (err) {
    await fs.promises.rm(part, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Flush a written file's bytes to disk. */
async function syncFile(file: string): Promise<void> {
  const handle = await fs.promises.open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** An answer that refuses the bundle for good (a 4xx but 401, 408 and 429): not tried again. */
export function isRefusalStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}

/** Answer without reading the rest of the body, then cut the connection. */
export function answerAndClose(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown): void {
  res.setHeader('Connection', 'close');
  // The request, not its socket: a request whose connection already went has none.
  res.once('finish', () => req.destroy());
  sendJson(res, status, body);
}
