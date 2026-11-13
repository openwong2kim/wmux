// A returned bundle on its way between two paired PCs, the asking PC being the
// joiner: the PC that made it serves it (bundleOutbox.ts, a real route table
// behind a real HTTP server) and the asking PC fetches it into its staging
// (bundleIntake.ts) through a streamed GET.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2A_ROUTES } from '../../../shared/a2aRemote';
import { BUNDLE_BYTES_CEILING, BUNDLE_BYTES_DEFAULT, bundleBytesMax, type A2aBundleManifestV1 } from '../../../shared/a2aBundle';
import { BundleIntake, bundleStagedFile, bundleStagingHostDir } from '../bundleIntake';
import { BundleOutbox } from '../bundleOutbox';
import { PinnedClientError } from '../pinnedClient';
import { A2aRouteTable } from '../routes';
import { CONTINUE_TRANSFER_MAX_MS, continueTransferBudgetMs } from '../server';
import type { StreamedGet } from '../session';

const ASKER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BOX = '33333333-3333-4333-8333-333333333333';
const quiet = (): void => undefined;
const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');
const bundleId = (): string => `bd-${crypto.randomUUID()}`;
/** `n` bytes that hardly compress. */
function bytes(n: number, seed = 1): Buffer {
  const out = Buffer.alloc(n);
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

let root: string;
let boxDir: string;
let askerA2a: string;
let clock: number;
let outbox: BundleOutbox;
let server: http.Server;
let port: number;
let gets: string[];

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-bundle-')));
  boxDir = path.join(root, 'box');
  askerA2a = path.join(root, 'asker', 'a2a');
  fs.mkdirSync(boxDir, { recursive: true });
  clock = Date.now();
  gets = [];
  outbox = new BundleOutbox({ enabled: () => true, log: quiet, now: () => clock });
  const table = new A2aRouteTable();
  outbox.registerRoutes(table);
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    // The peer is named by a test header here (the real listener authenticates it).
    const hostId = typeof req.headers['x-test-host'] === 'string' ? req.headers['x-test-host'] : ASKER;
    void table.handle(req, res, url, url.pathname, { peerId: 'p', hostId, name: 'asker' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});

/** A GET to the box as `hostId`, the way a joiner session streams one (a refusal throws as the pinned client does). */
function getAs(hostId: string): StreamedGet {
  return (p, o, consume) => new Promise((resolve, reject) => {
    gets.push(p);
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { 'x-test-host': hostId }, signal: o.signal }, (res) => {
      if ((res.statusCode ?? 0) >= 300) {
        res.resume();
        reject(new PinnedClientError('http', `HTTP ${res.statusCode}`, { sent: true, status: res.statusCode }));
        return;
      }
      consume({ headers: res.headers, body: res }).then(resolve, reject);
    });
    req.on('error', reject);
  });
}

function intake(over: { get?: StreamedGet | null; maxBytes?: number } = {}): BundleIntake {
  return new BundleIntake({
    a2aDir: askerA2a,
    fetchFrom: () => (over.get === undefined ? getAs(ASKER) : over.get),
    ...(over.maxBytes !== undefined ? { maxBytes: () => over.maxBytes as number } : {}),
    log: quiet,
  });
}

/** A bundle the box made and offers to `hostId`. */
function made(body: Buffer, hostId = ASKER): A2aBundleManifestV1 {
  const m = { bundleId: bundleId(), sha256: sha(body), bytes: body.length };
  const file = path.join(boxDir, `${m.bundleId}.bundle`);
  fs.writeFileSync(file, body);
  expect(outbox.offer({ hostId, file, ...m })).toBe(true);
  return m;
}

const partsOf = (): string[] => {
  const dir = path.join(bundleStagingHostDir(askerA2a, ASKER), 'parts');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

describe('a returned bundle, fetched by the asking PC', () => {
  it('streams the offered bundle into staging exactly, and a repeat takes the staged file without fetching again', async () => {
    const body = bytes(300_000, 7);
    const m = made(body);
    const got = await intake().pull(ASKER, m);
    expect(got).toEqual({ kind: 'staged', file: bundleStagedFile(askerA2a, ASKER, m.bundleId) });
    expect(fs.readFileSync(bundleStagedFile(askerA2a, ASKER, m.bundleId)).equals(body)).toBe(true);
    expect(gets).toEqual([`${A2A_ROUTES.bundle}/${m.bundleId}`]);
    expect(partsOf()).toEqual([]);
    expect(await intake().pull(ASKER, m)).toMatchObject({ kind: 'staged' });
    expect(gets).toHaveLength(1);
  });

  it('serves a bundle only to the PC it was made for, only while its offer stands, and only as the file offered', async () => {
    const body = bytes(4096, 8);
    const m = made(body);
    // Another paired PC asking for it gets what a path never registered gets.
    expect(await intake({ get: getAs(OTHER) }).pull(ASKER, m)).toEqual({ kind: 'fatal', why: 'the other PC answered HTTP 404' });
    // Past its time: gone.
    const late = made(body);
    clock += 61 * 60_000;
    expect(await intake().pull(ASKER, late)).toEqual({ kind: 'fatal', why: 'the other PC answered HTTP 404' });
    // A file that changed after it was offered is not served, and its offer ends.
    clock = Date.now();
    const changed = made(body);
    fs.appendFileSync(path.join(boxDir, `${changed.bundleId}.bundle`), 'x');
    expect(await intake().pull(ASKER, changed)).toMatchObject({ kind: 'fatal' });
    fs.truncateSync(path.join(boxDir, `${changed.bundleId}.bundle`), body.length);
    expect(await intake().pull(ASKER, changed)).toEqual({ kind: 'fatal', why: 'the other PC answered HTTP 404' });
    expect(fs.existsSync(bundleStagedFile(askerA2a, ASKER, m.bundleId))).toBe(false);
  });

  it('refuses bytes whose hash is not the manifest\'s, and leaves nothing behind', async () => {
    const body = bytes(50_000, 9);
    const m = made(body);
    const got = await intake().pull(ASKER, { ...m, sha256: sha(Buffer.from('another')) });
    expect(got).toEqual({ kind: 'fatal', why: 'a hash other than its entry names' });
    expect(fs.existsSync(bundleStagedFile(askerA2a, ASKER, m.bundleId))).toBe(false);
    expect(partsOf()).toEqual([]);
  });

  it('refuses a bundle past the size this PC takes before any byte, and holds a setting to the ceiling', async () => {
    const body = bytes(10_000, 10);
    const m = made(body);
    expect(await intake({ maxBytes: 9_999 }).pull(ASKER, m)).toEqual({ kind: 'fatal', why: '10000 bytes, past the 9999 this PC takes' });
    expect(gets).toEqual([]);
    expect(bundleBytesMax(undefined)).toBe(BUNDLE_BYTES_DEFAULT);
    expect(bundleBytesMax(BUNDLE_BYTES_CEILING * 2)).toBe(BUNDLE_BYTES_CEILING);
    expect(bundleBytesMax(0)).toBe(BUNDLE_BYTES_DEFAULT);
    // The ceiling is the most bytes whose transfer budget still fits under the budget's own cap.
    expect(continueTransferBudgetMs(BUNDLE_BYTES_CEILING)).toBeLessThanOrEqual(CONTINUE_TRANSFER_MAX_MS);
    expect(30_000 + Math.ceil(((BUNDLE_BYTES_CEILING + 1_000) * 8) / 1_000)).toBeGreaterThan(CONTINUE_TRANSFER_MAX_MS);
  });

  it('a transfer cut half way leaves no part file and is fetched whole on the next try', async () => {
    const body = bytes(80_000, 11);
    const m = made(body);
    const cut: StreamedGet = async (_p, _o, consume) => consume({
      headers: { 'content-length': String(body.length) },
      body: new Readable({ read() { this.push(body.subarray(0, 30_000)); this.destroy(new Error('connection reset')); } }) as unknown as http.IncomingMessage,
    });
    const first = await intake({ get: cut }).pull(ASKER, m);
    expect(first).toMatchObject({ kind: 'again' });
    expect(partsOf()).toEqual([]);
    expect(fs.existsSync(bundleStagedFile(askerA2a, ASKER, m.bundleId))).toBe(false);
    expect(await intake().pull(ASKER, m)).toMatchObject({ kind: 'staged' });
    expect(fs.readFileSync(bundleStagedFile(askerA2a, ASKER, m.bundleId)).equals(body)).toBe(true);
  });

  it('one transfer per PC: a second bundle from the same PC is busy while the first runs; the same bundle twice is one pull', async () => {
    const a = made(bytes(20_000, 12));
    const b = made(bytes(20_000, 13));
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    let entered: () => void = () => undefined;
    const inGet = new Promise<void>((r) => { entered = r; });
    const real = getAs(ASKER);
    const slow: StreamedGet = async (p, o, consume) => {
      entered();
      await held;
      return real(p, o, consume);
    };
    const one = intake({ get: slow });
    const first = one.pull(ASKER, a);
    expect(one.pull(ASKER, a)).toBe(first);
    // The first holds its slot once its GET has started.
    await inGet;
    expect(await one.pull(ASKER, b)).toEqual({ kind: 'busy' });
    release();
    expect(await first).toMatchObject({ kind: 'staged' });
    expect(await one.pull(ASKER, b)).toMatchObject({ kind: 'staged' });
  });

  it('a PC this one does not join cannot be fetched from; a manifest that is not well formed is refused before anything', async () => {
    const m = made(bytes(1000, 14));
    expect(await intake({ get: null }).pull(ASKER, m)).toEqual({ kind: 'not-joined' });
    for (const bad of [{ ...m, bundleId: 'bd-x' }, { ...m, sha256: 'z'.repeat(64) }, { ...m, bytes: 0 }, { ...m, bytes: 1.5 }]) {
      // eslint-disable-next-line no-await-in-loop -- one at a time
      expect(await intake().pull(ASKER, bad)).toEqual({ kind: 'fatal', why: 'not a bundle this PC can fetch' });
    }
    expect(gets).toEqual([]);
    // The box offers nothing it would not serve.
    expect(outbox.offer({ hostId: BOX, bundleId: 'bd-x', file: '/x', sha256: m.sha256, bytes: 1 })).toBe(false);
    expect(outbox.offer({ hostId: BOX, bundleId: bundleId(), file: '/x', sha256: m.sha256, bytes: BUNDLE_BYTES_CEILING + 1 })).toBe(false);
  });

  it('a staged bundle goes when discarded, and all of a removed PC\'s staging goes with it', async () => {
    const m = made(bytes(2000, 15));
    const one = intake();
    expect(await one.pull(ASKER, m)).toMatchObject({ kind: 'staged' });
    await one.discard(ASKER, m.bundleId);
    expect(fs.existsSync(bundleStagedFile(askerA2a, ASKER, m.bundleId))).toBe(false);
    expect(await one.pull(ASKER, m)).toMatchObject({ kind: 'staged' });
    await one.forgetHost(ASKER);
    expect(fs.existsSync(bundleStagingHostDir(askerA2a, ASKER))).toBe(false);
  });
});
