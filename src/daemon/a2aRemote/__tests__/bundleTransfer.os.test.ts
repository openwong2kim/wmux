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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_ROUTES, type HostId } from '../../../shared/a2aRemote';
import { BUNDLE_BYTES_CEILING, BUNDLE_BYTES_DEFAULT, bundleBytesMax, type A2aBundleManifestV1 } from '../../../shared/a2aBundle';
import { BundleIntake, bundleStagedFile, bundleStagingHostDir } from '../bundleIntake';
import { deliberateSleep } from '../../../test-utils/waitFor';
import { BundleOutbox, type BundleSend } from '../bundleOutbox';
import { PinnedClientError } from '../pinnedClient';
import { A2aRouteTable } from '../routes';
import { A2A_REQUEST_BODY_MAX, CONTINUE_TRANSFER_MAX_MS, continueTransferBudgetMs, requestBodyMax } from '../server';
import type { StreamedGet, StreamedPut } from '../session';

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
let enabled: boolean;
let serveBudgetMs: number | null;
/** What the serving side logged. */
let served: string[];
let onServed: (line: string) => void;
let table: A2aRouteTable;
/** What the asking side logged. */
let onTaken: (line: string) => void;
/** The session the outbox sends by (its putTo). */
let putter: StreamedPut | null;

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-bundle-')));
  boxDir = path.join(root, 'box');
  askerA2a = path.join(root, 'asker', 'a2a');
  fs.mkdirSync(boxDir, { recursive: true });
  clock = Date.now();
  gets = [];
  enabled = true;
  serveBudgetMs = null;
  served = [];
  onServed = quiet;
  onTaken = quiet;
  putter = null;
  outbox = new BundleOutbox({
    enabled: () => enabled,
    putTo: () => putter,
    log: (_level, line) => { served.push(line); onServed(line); },
    now: () => clock,
    transferBudgetMs: (n) => serveBudgetMs ?? continueTransferBudgetMs(n),
  });
  table = new A2aRouteTable();
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

function intake(over: {
  get?: StreamedGet | null;
  maxBytes?: number;
  budgetMs?: number;
  takeSlot?: (hostId: HostId) => (() => void) | null;
  checkStaged?: (a2aDir: string, target: string, sha: string, bytes: number) => Promise<boolean>;
} = {}): BundleIntake {
  return new BundleIntake({
    ...(over.budgetMs !== undefined ? { transferBudgetMs: () => over.budgetMs as number } : {}),
    ...(over.takeSlot ? { takeSlot: over.takeSlot } : {}),
    ...(over.checkStaged ? { checkStaged: over.checkStaged } : {}),
    a2aDir: askerA2a,
    enabled: () => enabled,
    fetchFrom: () => (over.get === undefined ? getAs(ASKER) : over.get),
    ...(over.maxBytes !== undefined ? { maxBytes: () => over.maxBytes as number } : {}),
    log: (_level, line) => onTaken(line),
  });
}

/** A PUT to the asking PC as `hostId`, the way a joiner session streams one (exact length declared). */
function putAs(hostId: string): StreamedPut {
  return (p, body, o) => new Promise((resolve, reject) => {
    const req = http.request({
      method: 'PUT', host: '127.0.0.1', port, path: p, signal: o.signal,
      headers: { 'x-test-host': hostId, 'content-type': 'application/octet-stream', 'content-length': String(o.bytes) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) as unknown : null }));
    });
    req.on('error', reject);
    body.on('error', (err) => req.destroy(err));
    body.pipe(req);
  });
}

/** A raw PUT as `hostId` with `headers`: `body` written whole, or only its first `cutAt` bytes and the connection then held. */
function rawPut(p: string, headers: http.OutgoingHttpHeaders, body: Buffer, hostId = BOX, cutAt?: number): { status: Promise<number>; req: http.ClientRequest } {
  const req = http.request({ method: 'PUT', host: '127.0.0.1', port, path: p, headers: { 'x-test-host': hostId, ...headers } });
  const status = new Promise<number>((resolve) => {
    req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', () => resolve(0));
  });
  if (cutAt === undefined) req.end(body);
  else req.write(body.subarray(0, cutAt));
  return { status, req };
}

/** The box sends `m` to the asking PC through `put` (its session with that PC). */
function sendWith(put: StreamedPut, m: { bundleId: string }): Promise<BundleSend> {
  putter = put;
  return outbox.send(ASKER, m.bundleId);
}

/** Resolves once the asking side logs a line holding `text`. */
const takenLine = (text: string): Promise<void> => new Promise((r) => { onTaken = (line) => { if (line.includes(text)) r(); }; });

/** A bundle the box made and offers to `hostId`. */
function made(body: Buffer, hostId = ASKER): A2aBundleManifestV1 {
  const m = { bundleId: bundleId(), sha256: sha(body), bytes: body.length };
  const file = path.join(boxDir, `${m.bundleId}.bundle`);
  fs.writeFileSync(file, body);
  expect(outbox.offer({ hostId, file, ...m })).toBe(true);
  return m;
}

const partsOf = (hostId = ASKER): string[] => {
  const dir = path.join(bundleStagingHostDir(askerA2a, hostId), 'parts');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

describe('a returned bundle, fetched by the asking PC', () => {
  it('streams the offered bundle into staging exactly, and a repeat takes the staged file without fetching again', async () => {
    const body = bytes(300_000, 7);
    const m = made(body);
    const got = await intake().pull(ASKER, m);
    expect(got).toEqual({ kind: 'staged', file: bundleStagedFile(askerA2a, ASKER, m) });
    expect(fs.readFileSync(bundleStagedFile(askerA2a, ASKER, m)).equals(body)).toBe(true);
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
    expect(await intake().pull(ASKER, changed)).toEqual({ kind: 'fatal', why: 'the other PC answered HTTP 404' });
    fs.truncateSync(path.join(boxDir, `${changed.bundleId}.bundle`), body.length);
    expect(await intake().pull(ASKER, changed)).toEqual({ kind: 'fatal', why: 'the other PC answered HTTP 404' });
    // Another file of the same size put in its place is not served either.
    const swapped = made(body);
    const swappedFile = path.join(boxDir, `${swapped.bundleId}.bundle`);
    fs.writeFileSync(`${swappedFile}.new`, bytes(body.length, 99));
    fs.renameSync(`${swappedFile}.new`, swappedFile);
    expect(await intake().pull(ASKER, swapped)).toEqual({ kind: 'fatal', why: 'the other PC answered HTTP 404' });
    expect(fs.existsSync(bundleStagedFile(askerA2a, ASKER, m))).toBe(false);
    expect(fs.existsSync(bundleStagedFile(askerA2a, ASKER, swapped))).toBe(false);
  });

  it('refuses bytes whose hash is not the manifest\'s, and leaves nothing behind', async () => {
    const body = bytes(50_000, 9);
    const m = made(body);
    const claimed = { ...m, sha256: sha(Buffer.from('another')) };
    const got = await intake().pull(ASKER, claimed);
    expect(got).toEqual({ kind: 'fatal', why: 'a hash other than its entry names' });
    expect(fs.existsSync(bundleStagedFile(askerA2a, ASKER, claimed))).toBe(false);
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
    expect(bundleBytesMax(Number.NaN)).toBe(BUNDLE_BYTES_DEFAULT);
    expect(await intake({ maxBytes: Number.NaN }).pull(ASKER, m)).toMatchObject({ kind: 'staged' });
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
    expect(fs.existsSync(bundleStagedFile(askerA2a, ASKER, m))).toBe(false);
    expect(await intake().pull(ASKER, m)).toMatchObject({ kind: 'staged' });
    expect(fs.readFileSync(bundleStagedFile(askerA2a, ASKER, m)).equals(body)).toBe(true);
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
    for (const bad of [null, 'bd-x', {}, { ...m, bundleId: 'bd-x' }, { ...m, sha256: 'z'.repeat(64) }, { ...m, bytes: 0 }, { ...m, bytes: 1.5 }, { ...m, bytes: '1000' }]) {
      // eslint-disable-next-line no-await-in-loop -- one at a time
      expect(await intake().pull(ASKER, bad)).toEqual({ kind: 'fatal', why: 'not a bundle this PC can fetch' });
    }
    expect(gets).toEqual([]);
    // The box offers nothing it would not serve.
    expect(outbox.offer({ hostId: BOX, bundleId: 'bd-x', file: '/x', sha256: m.sha256, bytes: 1 })).toBe(false);
    expect(outbox.offer({ hostId: BOX, bundleId: bundleId(), file: '/x', sha256: m.sha256, bytes: BUNDLE_BYTES_CEILING + 1 })).toBe(false);
  });

  it('withdrawing an offer, or removing its PC, ends a transfer of it under way on the box', async () => {
    for (const end of ['withdraw', 'forgetHost'] as const) {
      // Large enough that it cannot all sit in the socket buffers by the time the headers arrive.
      const m = made(bytes(24 * 1024 * 1024, end === 'withdraw' ? 16 : 17));
      const real = getAs(ASKER);
      const ending: StreamedGet = (p, o, consume) => real(p, o, (r) => {
        if (end === 'withdraw') outbox.withdraw(ASKER, m.bundleId);
        else outbox.forgetHost(ASKER);
        return consume(r);
      });
      // eslint-disable-next-line no-await-in-loop -- one at a time
      expect(await intake({ get: ending }).pull(ASKER, m)).toMatchObject({ kind: 'again' });
      expect(fs.existsSync(bundleStagedFile(askerA2a, ASKER, m))).toBe(false);
      expect(partsOf()).toEqual([]);
      // eslint-disable-next-line no-await-in-loop -- one at a time
      expect(await intake().pull(ASKER, m)).toEqual({ kind: 'fatal', why: 'the other PC answered HTTP 404' });
    }
  });

  it('removing a PC ends a pull from it that is under way, then its staging goes', async () => {
    const m = made(bytes(20_000, 18));
    let entered: () => void = () => undefined;
    const inGet = new Promise<void>((r) => { entered = r; });
    const real = getAs(ASKER);
    // Waits until the pull is ended, then goes on as a GET would with the signal it was given.
    const held: StreamedGet = async (p, o, consume) => {
      entered();
      await new Promise((r) => o.signal.addEventListener('abort', r, { once: true }));
      return real(p, o, consume);
    };
    const one = intake({ get: held });
    const pulling = one.pull(ASKER, m);
    await inGet;
    await one.forgetHost(ASKER);
    expect(await pulling).toMatchObject({ kind: 'again' });
    expect(fs.existsSync(bundleStagingHostDir(askerA2a, ASKER))).toBe(false);
  });

  it('the route does not exist while the feature is off', async () => {
    const m = made(bytes(1000, 19));
    enabled = false;
    expect(await intake().pull(ASKER, m)).toEqual({ kind: 'fatal', why: 'the other PC answered HTTP 404' });
    enabled = true;
    expect(await intake().pull(ASKER, m)).toMatchObject({ kind: 'staged' });
  });

  // A mode bit does not refuse the owner on Windows, nor root anywhere.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an open error that says nothing of the file is a 503, and the offer stands', async () => {
    const m = made(bytes(1000, 20));
    const file = path.join(boxDir, `${m.bundleId}.bundle`);
    fs.chmodSync(file, 0o000);
    expect(await intake().pull(ASKER, m)).toMatchObject({ kind: 'again' });
    fs.chmodSync(file, 0o600);
    expect(await intake().pull(ASKER, m)).toMatchObject({ kind: 'staged' });
  });

  /** Resolves once the serving side logs a line holding `text`. */
  const servedLine = (text: string): Promise<void> => new Promise((r) => { onServed = (line) => { if (line.includes(text)) r(); }; });

  it('the serving side takes one transfer per PC (429 past it), and has the slot back once that client is gone', async () => {
    const a = made(bytes(24 * 1024 * 1024, 21));
    const b = made(bytes(2000, 22));
    let entered: () => void = () => undefined;
    const inBody = new Promise<void>((r) => { entered = r; });
    let leave: () => void = () => undefined;
    const left = new Promise<void>((r) => { leave = r; });
    const real = getAs(ASKER);
    // Takes the headers, then goes away without reading the body.
    const goesAway: StreamedGet = (p, o, consume) => real(p, o, async (r) => {
      entered();
      await left;
      r.body.destroy(new Error('went away'));
      return consume(r);
    });
    const first = intake({ get: goesAway }).pull(ASKER, a);
    await inBody;
    // Another intake (its own slots), the same PC: the box refuses it while the first is served.
    expect(await intake().pull(ASKER, b)).toEqual({ kind: 'again', why: 'http' });
    const gone = servedLine(`bundle ${a.bundleId} for ${ASKER}: not sent whole`);
    leave();
    expect(await first).toMatchObject({ kind: 'again' });
    await gone;
    expect(await intake().pull(ASKER, b)).toMatchObject({ kind: 'staged' });
  });

  it('the serving side cuts a reader too slow for the budget of its size', async () => {
    serveBudgetMs = 50;
    const m = made(bytes(24 * 1024 * 1024, 24));
    const real = getAs(ASKER);
    const cut = servedLine(`bundle ${m.bundleId} for ${ASKER}: not sent whole`);
    // Reads nothing until the box has given up on it.
    const slow: StreamedGet = (p, o, consume) => real(p, o, async (r) => {
      await cut;
      return consume(r);
    });
    expect(await intake({ get: slow }).pull(ASKER, m)).toMatchObject({ kind: 'again' });
    expect(partsOf()).toEqual([]);
    expect(fs.existsSync(bundleStagedFile(askerA2a, ASKER, m))).toBe(false);
  });

  it('refuses a body in an encoding it does not take, or declared longer than its manifest allows, before writing it', async () => {
    const body = bytes(4000, 23);
    const m = made(body);
    const answering = (headers: http.IncomingHttpHeaders): StreamedGet => async (_p, _o, consume) =>
      consume({ headers, body: Readable.from([body]) as unknown as http.IncomingMessage });
    expect(await intake({ get: answering({ 'content-encoding': 'br' }) }).pull(ASKER, m))
      .toEqual({ kind: 'fatal', why: 'sent in an encoding other than identity or gzip' });
    expect(await intake({ get: answering({ 'content-length': String(BUNDLE_BYTES_CEILING) }) }).pull(ASKER, m))
      .toEqual({ kind: 'fatal', why: 'its declared length is past its manifest' });
    expect(partsOf()).toEqual([]);
    expect(fs.existsSync(bundleStagedFile(askerA2a, ASKER, m))).toBe(false);
  });

  it('after a restart, part files left by unfinished transfers go', async () => {
    const parts = path.join(bundleStagingHostDir(askerA2a, ASKER), 'parts');
    fs.mkdirSync(parts, { recursive: true });
    fs.writeFileSync(path.join(parts, bundleId()), 'half');
    await intake().sweepParts();
    expect(partsOf()).toEqual([]);
  });

  it('an id reused with another hash or size neither takes nor removes what the first manifest staged, at once or after', async () => {
    const body = bytes(30_000, 25);
    const m = made(body);
    const other = { ...m, sha256: sha(bytes(30_000, 26)) };
    const one = intake();
    // At once: two pulls, not one answer for both (which of them takes the PC's one slot is not fixed).
    const first = one.pull(ASKER, m);
    const second = one.pull(ASKER, other);
    expect(second).not.toBe(first);
    expect(one.pull(ASKER, m)).toBe(first);
    const [a, b] = await Promise.all([first, second]);
    expect(['staged', 'busy']).toContain(a.kind);
    expect(b.kind).not.toBe('staged');
    expect(await one.pull(ASKER, m)).toEqual({ kind: 'staged', file: bundleStagedFile(askerA2a, ASKER, m) });
    // After: the staged file stays as it was, also for the same id and hash with another size.
    expect(await one.pull(ASKER, other)).toMatchObject({ kind: 'fatal' });
    const resized = { ...m, bytes: m.bytes + 1 };
    expect(await one.pull(ASKER, resized)).toMatchObject({ kind: 'fatal' });
    expect(fs.existsSync(bundleStagedFile(askerA2a, ASKER, resized))).toBe(false);
    expect(fs.readFileSync(bundleStagedFile(askerA2a, ASKER, m)).equals(body)).toBe(true);
    expect(fs.existsSync(bundleStagedFile(askerA2a, ASKER, other))).toBe(false);
  });

  it('removing a PC ends a transfer to it of an offer already past its time', async () => {
    const m = made(bytes(24 * 1024 * 1024, 27));
    const real = getAs(ASKER);
    const late: StreamedGet = (p, o, consume) => real(p, o, (r) => {
      clock += 61 * 60_000;
      // A later offer drops the expired one from the list while its transfer runs.
      made(bytes(10, 28), OTHER);
      outbox.forgetHost(ASKER);
      return consume(r);
    });
    expect(await intake({ get: late }).pull(ASKER, m)).toMatchObject({ kind: 'again' });
    expect(fs.existsSync(bundleStagedFile(askerA2a, ASKER, m))).toBe(false);
  });

  it('a file cut short while it is sent ends the body unfinished, never short of its length', async () => {
    const body = bytes(24 * 1024 * 1024, 29);
    const m = made(body);
    const file = path.join(boxDir, `${m.bundleId}.bundle`);
    const real = getAs(ASKER);
    const cutShort: StreamedGet = (p, o, consume) => real(p, o, (r) => {
      fs.truncateSync(file, 1024);
      return consume(r);
    });
    const sent = servedLine(`bundle ${m.bundleId} for ${ASKER}: not sent whole`);
    expect(await intake({ get: cutShort }).pull(ASKER, m)).toMatchObject({ kind: 'again' });
    await sent;
    expect(fs.existsSync(bundleStagedFile(askerA2a, ASKER, m))).toBe(false);
  });

  it('a staged bundle goes when discarded, and all of a removed PC\'s staging goes with it', async () => {
    const m = made(bytes(2000, 15));
    const one = intake();
    expect(await one.pull(ASKER, m)).toMatchObject({ kind: 'staged' });
    await one.discard(ASKER, m);
    expect(fs.existsSync(bundleStagedFile(askerA2a, ASKER, m))).toBe(false);
    expect(await one.pull(ASKER, m)).toMatchObject({ kind: 'staged' });
    await one.forgetHost(ASKER);
    expect(fs.existsSync(bundleStagingHostDir(askerA2a, ASKER))).toBe(false);
  });
});

describe('a returned bundle, sent by the PC that made it (it joined the asking PC)', () => {
  const route = (m: A2aBundleManifestV1): string => `${A2A_ROUTES.bundle}/${m.bundleId}/${m.sha256}`;

  it('the asking PC takes the bundle it waits for exactly, once, and a repeat wait is over at once', async () => {
    const body = bytes(300_000, 30);
    const m = made(body);
    const one = intake();
    one.registerRoutes(table);
    const waiting = one.receive(BOX, m);
    expect(one.receive(BOX, m)).toBe(waiting);
    expect(await sendWith(putAs(BOX), m)).toEqual({ kind: 'sent' });
    expect(await waiting).toEqual({ kind: 'staged', file: bundleStagedFile(askerA2a, BOX, m) });
    expect(fs.readFileSync(bundleStagedFile(askerA2a, BOX, m)).equals(body)).toBe(true);
    expect(partsOf(BOX)).toEqual([]);
    // Taken: sent again (its answer lost on the way), it is taken already; anything else is not awaited.
    expect(await sendWith(putAs(BOX), m)).toEqual({ kind: 'sent' });
    expect(await rawPut(route(m), { 'content-length': '0' }, Buffer.alloc(0)).status).toBe(404);
    expect(await intake().receive(BOX, m)).toEqual({ kind: 'staged', file: bundleStagedFile(askerA2a, BOX, m) });
  });

  it('refuses before any byte what it does not wait for: nothing awaited, another PC, another hash, another length, an encoding', async () => {
    const body = bytes(5000, 31);
    const m = made(body);
    const one = intake();
    one.registerRoutes(table);
    expect(await sendWith(putAs(BOX), m)).toEqual({ kind: 'fatal', why: 'the other PC answered HTTP 404' });
    const waiting = one.receive(BOX, m);
    // The same id and hash awaited with another size is not that bundle, and does not share its wait.
    expect(await one.receive(BOX, { ...m, bytes: m.bytes + 1 })).toEqual({ kind: 'fatal', why: 'another size is awaited for that bundle' });
    // A wait longer than a timer can hold is refused, not ended at once.
    expect(await one.receive(BOX, made(bytes(10, 43)), 2 ** 31)).toEqual({ kind: 'fatal', why: 'not a bundle this PC can take' });
    const ok = { 'content-length': String(body.length) };
    expect(await rawPut(route(m), ok, body, OTHER).status).toBe(404);
    expect(await rawPut(route({ ...m, sha256: sha(Buffer.from('x')) }), ok, body).status).toBe(404);
    expect(await rawPut(route(m), { 'content-length': String(body.length - 1) }, body.subarray(1)).status).toBe(400);
    expect(await rawPut(route(m), { 'transfer-encoding': 'chunked' }, body).status).toBe(411);
    expect(await rawPut(route(m), { ...ok, 'content-encoding': 'gzip' }, body).status).toBe(415);
    expect(partsOf(BOX)).toEqual([]);
    // The listener holds a bundle upload's body to the largest bundle, and only that route's.
    expect(requestBodyMax('PUT', route(m), true)).toBe(BUNDLE_BYTES_CEILING);
    // While bundles are off, a bundle upload's body is held as any other: nothing changes for a client.
    expect(requestBodyMax('PUT', route(m))).toBe(A2A_REQUEST_BODY_MAX);
    expect(requestBodyMax('POST', route(m))).toBe(A2A_REQUEST_BODY_MAX);
    // The wait still stands for the bundle itself.
    expect(await sendWith(putAs(BOX), m)).toEqual({ kind: 'sent' });
    expect(await waiting).toMatchObject({ kind: 'staged' });
  });

  it('bytes whose hash is not the manifest\'s end the wait, and leave nothing behind', async () => {
    const body = bytes(5000, 32);
    const claimed = { bundleId: bundleId(), sha256: sha(Buffer.from('another')), bytes: body.length };
    const one = intake();
    one.registerRoutes(table);
    const waiting = one.receive(BOX, claimed);
    expect(await rawPut(route(claimed), { 'content-length': String(body.length) }, body).status).toBe(400);
    expect(await waiting).toEqual({ kind: 'fatal', why: 'a hash other than its entry names' });
    expect(fs.existsSync(bundleStagedFile(askerA2a, BOX, claimed))).toBe(false);
    expect(partsOf(BOX)).toEqual([]);
  });

  it('a transfer cut half way leaves no part file, the wait stands, and the box sends it whole again', async () => {
    const body = bytes(80_000, 33);
    const m = made(body);
    const one = intake();
    one.registerRoutes(table);
    const waiting = one.receive(BOX, m);
    const broke = takenLine(`bundle ${m.bundleId} from ${BOX}: not received`);
    const { req } = rawPut(route(m), { 'content-length': String(body.length) }, body, BOX, 30_000);
    // Once the first bytes are in, the connection goes.
    await vi.waitFor(() => expect(partsOf(BOX)).toHaveLength(1), { timeout: 10_000 });
    req.destroy();
    await broke;
    expect(partsOf(BOX)).toEqual([]);
    expect(await sendWith(putAs(BOX), m)).toEqual({ kind: 'sent' });
    expect(await waiting).toMatchObject({ kind: 'staged' });
  });

  it('a wait ends when its time is up, when its PC is removed (also while it sends), and when the intake stops', async () => {
    const body = bytes(80_000, 34);
    const m = made(body);
    const one = intake();
    one.registerRoutes(table);
    expect(await one.receive(BOX, made(bytes(100, 35)), 20)).toEqual({ kind: 'again', why: 'not sent in time' });
    const waiting = one.receive(BOX, m);
    rawPut(route(m), { 'content-length': String(body.length) }, body, BOX, 30_000);
    await vi.waitFor(() => expect(partsOf(BOX)).toHaveLength(1), { timeout: 10_000 });
    await one.forgetHost(BOX);
    expect(await waiting).toEqual({ kind: 'again', why: 'that PC was removed' });
    expect(fs.existsSync(bundleStagingHostDir(askerA2a, BOX))).toBe(false);
    const stopped = one.receive(BOX, m);
    one.stop();
    expect(await stopped).toEqual({ kind: 'again', why: 'stopped' });
  });

  it('while the feature is off, the route does not exist, and nothing is waited for or sent', async () => {
    const m = made(bytes(1000, 36));
    const one = intake();
    one.registerRoutes(table);
    const waiting = one.receive(BOX, m);
    enabled = false;
    expect(await rawPut(route(m), { 'content-length': '0' }, Buffer.alloc(0)).status).toBe(404);
    expect(await one.receive(BOX, { bundleId: bundleId(), sha256: sha(Buffer.from('y')), bytes: 1 })).toEqual({ kind: 'fatal', why: 'bundles are off on this PC' });
    expect(await sendWith(putAs(BOX), m)).toEqual({ kind: 'fatal', why: 'bundles are off on this PC' });
    enabled = true;
    expect(await sendWith(putAs(BOX), m)).toEqual({ kind: 'sent' });
    expect(await waiting).toMatchObject({ kind: 'staged' });
  });

  it('a transfer under way when the wait\'s time is up still lands; one that then breaks ends the wait', async () => {
    const body = bytes(80_000, 39);
    const m = made(body);
    const one = intake();
    one.registerRoutes(table);
    const pastTtl = (): Promise<void> => new Promise((r) => setTimeout(r, 800));
    const waiting = one.receive(BOX, m, 500);
    const sending = rawPut(route(m), { 'content-length': String(body.length) }, body, BOX, 30_000);
    await vi.waitFor(() => expect(partsOf(BOX)).toHaveLength(1), { timeout: 10_000 });
    await pastTtl();
    sending.req.end(body.subarray(30_000));
    expect(await sending.status).toBe(200);
    expect(await waiting).toEqual({ kind: 'staged', file: bundleStagedFile(askerA2a, BOX, m) });

    const other = bytes(80_000, 40);
    const n = made(other);
    const late = one.receive(BOX, n, 500);
    const broken = rawPut(route(n), { 'content-length': String(other.length) }, other, BOX, 30_000);
    await vi.waitFor(() => expect(partsOf(BOX)).toHaveLength(1), { timeout: 10_000 });
    await pastTtl();
    broken.req.destroy();
    expect(await late).toEqual({ kind: 'again', why: 'not sent in time' });
    expect(partsOf(BOX)).toEqual([]);
  });

  it('something other than a plain file where the bundle would be staged ends the wait at once', async () => {
    const m = made(bytes(1000, 41));
    fs.mkdirSync(bundleStagedFile(askerA2a, BOX, m), { recursive: true });
    expect(await intake().receive(BOX, m)).toEqual({ kind: 'fatal', why: 'something other than a plain file where a staged bundle goes' });
  });

  it('send() takes a 5xx, 401, 408 or 429 as again, and another 4xx as final, as a fetch does', async () => {
    const m = made(bytes(1000, 42));
    const answer = (status: number): StreamedPut => (_p, body) => {
      body.destroy();
      return Promise.resolve({ status, json: null });
    };
    for (const status of [500, 503, 401, 408, 429]) {
      expect(await sendWith(answer(status), m)).toEqual({ kind: 'again', why: `the other PC answered HTTP ${status}` });
    }
    for (const status of [400, 404, 413]) {
      expect(await sendWith(answer(status), m)).toEqual({ kind: 'fatal', why: `the other PC answered HTTP ${status}` });
    }
  });

  it('a PUT that comes while the wait checks an old file where the bundle goes waits for that check, and lands', async () => {
    const body = bytes(8 * 1024 * 1024, 44);
    const m = made(body);
    // Same size, other bytes: the check hashes it all, then removes it.
    fs.mkdirSync(path.dirname(bundleStagedFile(askerA2a, BOX, m)), { recursive: true });
    fs.writeFileSync(bundleStagedFile(askerA2a, BOX, m), bytes(body.length, 45));
    const one = intake();
    one.registerRoutes(table);
    const waiting = one.receive(BOX, m);
    expect(await sendWith(putAs(BOX), m)).toEqual({ kind: 'sent' });
    expect(await waiting).toEqual({ kind: 'staged', file: bundleStagedFile(askerA2a, BOX, m) });
    expect(fs.readFileSync(bundleStagedFile(askerA2a, BOX, m)).equals(body)).toBe(true);
  });

  it('a PUT the sender gave up on (its connection held open) is cut when the same PC sends it again', async () => {
    const body = bytes(80_000, 46);
    const m = made(body);
    const one = intake();
    one.registerRoutes(table);
    const waiting = one.receive(BOX, m);
    const stalled = rawPut(route(m), { 'content-length': String(body.length) }, body, BOX, 30_000);
    await vi.waitFor(() => expect(partsOf(BOX)).toHaveLength(1), { timeout: 10_000 });
    expect(await sendWith(putAs(BOX), m)).toEqual({ kind: 'sent' });
    expect(await waiting).toMatchObject({ kind: 'staged' });
    expect(await stalled.status).not.toBe(200);
  });

  it('past its time with a transfer under way, the sender\'s retry takes over and lands; asked for again, the wait starts anew', async () => {
    const body = bytes(80_000, 48);
    const m = made(body);
    const one = intake();
    one.registerRoutes(table);
    const pastTtl = (): Promise<void> => new Promise((r) => setTimeout(r, 800));
    const waiting = one.receive(BOX, m, 500);
    const stalled = rawPut(route(m), { 'content-length': String(body.length) }, body, BOX, 30_000);
    await vi.waitFor(() => expect(partsOf(BOX)).toHaveLength(1), { timeout: 10_000 });
    await pastTtl();
    expect(await sendWith(putAs(BOX), m)).toEqual({ kind: 'sent' });
    expect(await waiting).toEqual({ kind: 'staged', file: bundleStagedFile(askerA2a, BOX, m) });
    expect(await stalled.status).not.toBe(200);

    const other = bytes(80_000, 49);
    const n = made(other);
    const first = one.receive(BOX, n, 500);
    const broken = rawPut(route(n), { 'content-length': String(other.length) }, other, BOX, 30_000);
    await vi.waitFor(() => expect(partsOf(BOX)).toHaveLength(1), { timeout: 10_000 });
    await pastTtl();
    // Asked for again while late: the same wait, with a time of its own from now.
    expect(one.receive(BOX, n, 60_000)).toBe(first);
    broken.req.destroy();
    await vi.waitFor(() => expect(partsOf(BOX)).toEqual([]), { timeout: 10_000 });
    expect(await sendWith(putAs(BOX), n)).toEqual({ kind: 'sent' });
    expect(await first).toMatchObject({ kind: 'staged' });
  });

  it('send() goes only through this PC\'s own session with that PC: none, and it is not sent', async () => {
    const m = made(bytes(1000, 50));
    putter = null;
    expect(await outbox.send(ASKER, m.bundleId)).toEqual({ kind: 'not-joined' });
  });

  it('PUTs that keep taking over from each other past the wait\'s time end with the wait, at its time plus one budget', async () => {
    const body = bytes(80_000, 51);
    const m = made(body);
    const one = intake({ budgetMs: 1500 });
    one.registerRoutes(table);
    const started = Date.now();
    let ended = false;
    const waiting = one.receive(BOX, m, 300).finally(() => { ended = true; });
    const puts: Array<ReturnType<typeof rawPut>> = [];
    // A new PUT takes over every 350 ms for as long as the wait stands (up to 6 s).
    while (!ended && Date.now() - started < 6000) {
      puts.push(rawPut(route(m), { 'content-length': String(body.length) }, body, BOX, 30_000));
      await new Promise((r) => setTimeout(r, 350));
    }
    expect(await waiting).toEqual({ kind: 'again', why: 'not sent in time' });
    // Its time (300 ms) plus one budget (1.5 s), not a fresh budget per PUT.
    expect(Date.now() - started).toBeLessThan(3000);
    for (const p of puts) p.req.destroy();
  });

  it('past its time, a retry that took over and finds no transfer slot ends the wait at once', async () => {
    const body = bytes(80_000, 52);
    const m = made(body);
    let takes = 0;
    const one = intake({ takeSlot: () => (takes++ === 0 ? () => undefined : null) });
    one.registerRoutes(table);
    const waiting = one.receive(BOX, m, 50);
    const stalled = rawPut(route(m), { 'content-length': String(body.length) }, body, BOX, 30_000);
    await vi.waitFor(() => expect(partsOf(BOX)).toHaveLength(1), { timeout: 10_000 });
    await deliberateSleep(100, 'past the wait\'s 50 ms time, with the first PUT still under way');
    // Headers and one byte: nothing is still being written when the refusal closes the connection.
    const retry = rawPut(route(m), { 'content-length': String(body.length) }, body, BOX, 1);
    expect(await retry.status).toBe(429);
    expect(await waiting).toEqual({ kind: 'again', why: 'not sent in time' });
    stalled.req.destroy();
    retry.req.destroy();
  });

  it('a PUT that waited on a staged check which ended its wait lands for a newer wait of the same bundle', async () => {
    const body = bytes(5000, 53);
    const m = made(body);
    let open: (held: boolean) => void = () => undefined;
    const gated = new Promise<boolean>((r) => { open = r; });
    let checks = 0;
    const one = intake({ checkStaged: () => (checks++ === 0 ? gated : Promise.resolve(false)) });
    one.registerRoutes(table);
    let second: Promise<unknown> | undefined;
    // The first wait finds it staged (the check says so); in its continuation the caller asks for it again.
    const first = one.receive(BOX, m).then((r) => {
      second = one.receive(BOX, m);
      return r;
    });
    const sending = sendWith(putAs(BOX), m);
    await deliberateSleep(50, 'the PUT reaches the route and waits on the held check');
    open(true);
    expect(await first).toMatchObject({ kind: 'staged' });
    expect(await sending).toEqual({ kind: 'sent' });
    expect(await second).toMatchObject({ kind: 'staged' });
    expect(fs.readFileSync(bundleStagedFile(askerA2a, BOX, m)).equals(body)).toBe(true);
  });

  it('send() leaves no read stream behind when the request fails before it is read', async () => {
    const m = made(bytes(1000, 47));
    let given: Readable | undefined;
    const failing: StreamedPut = (_p, body) => {
      given = body;
      return Promise.reject(new PinnedClientError('connect-failed', 'unreachable', { sent: false }));
    };
    expect(await sendWith(failing, m)).toMatchObject({ kind: 'again' });
    expect(given?.destroyed).toBe(true);
  });

  it('withdrawing the offer ends a send under way; an offer that does not stand is not sent', async () => {
    const m = made(bytes(24 * 1024 * 1024, 37));
    const one = intake();
    one.registerRoutes(table);
    void one.receive(BOX, m);
    const real = putAs(BOX);
    const ending: StreamedPut = (p, body, o) => {
      outbox.withdraw(ASKER, m.bundleId);
      return real(p, body, o);
    };
    expect(await sendWith(ending, m)).toMatchObject({ kind: 'again' });
    expect(await sendWith(putAs(BOX), m)).toEqual({ kind: 'fatal', why: 'not offered to that PC' });
    expect(fs.existsSync(bundleStagedFile(askerA2a, BOX, m))).toBe(false);
  });
});
