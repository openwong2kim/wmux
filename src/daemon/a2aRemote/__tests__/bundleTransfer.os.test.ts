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
let enabled: boolean;
let serveBudgetMs: number | null;
/** What the serving side logged. */
let served: string[];
let onServed: (line: string) => void;

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
  outbox = new BundleOutbox({
    enabled: () => enabled,
    log: (_level, line) => { served.push(line); onServed(line); },
    now: () => clock,
    transferBudgetMs: (n) => serveBudgetMs ?? continueTransferBudgetMs(n),
  });
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
