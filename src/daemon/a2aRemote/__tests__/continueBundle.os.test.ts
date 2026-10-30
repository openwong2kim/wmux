// The bytes of a conversation another PC continues here (this PC is B): the
// upload routes and their checks, the pull from a PC this one joined,
// staging's folders, and what a decision, a removed PC and a restart leave.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_PROTOCOL, A2A_ROUTES, type A2aRemoteEnvelope } from '../../../shared/a2aRemote';
import { defaultContinuePolicy, type A2aContinuePolicyV1 } from '../../../shared/a2aContinue';
import { defaultSpawnPolicy, type A2aSpawnPolicyV1 } from '../../../shared/a2aSpawn';
import { deliberateSleep } from '../../../test-utils/waitFor';
import { atomicWriteJSONSync } from '../../util/atomicWrite';
import { ContinueBundle, type ContinueBundleDeps } from '../continueBundle';
import { A2aContinueReceiver } from '../continueReceiver';
import { ContinueRequestStore } from '../continueRequestStore';
import { continuePartsDir, continueStagedFile, continueStagedTranscript, continueStagingDir } from '../continueStaging';
import { PinnedClientError } from '../pinnedClient';
import { A2aRouteTable } from '../routes';
import type { StreamedGet } from '../session';
import { SpawnChecks } from '../spawnChecks';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const HEAD = 'a'.repeat(40);
const ORIGIN = 'github.com/acme/widget';
const quiet = (): void => undefined;
const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');
const EMPTY = sha(Buffer.alloc(0));
/** `n` bytes that differ by `seed` and hardly compress. */
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
let a2aDir: string;
let clock: number;
let requests: ContinueRequestStore;
let continuePolicy: A2aContinuePolicyV1;
let spawn: A2aSpawnPolicyV1;
let receiver: A2aContinueReceiver;
let bundle: ContinueBundle;
let table: A2aRouteTable;
let fetchers: Map<string, StreamedGet>;
let calls: string[];
let server: http.Server;
let port: number;

function build(over: Partial<ContinueBundleDeps> = {}): void {
  bundle = new ContinueBundle({
    a2aDir,
    requests,
    policy: { get: () => continuePolicy },
    received: (h, c) => {
      calls.push(`received ${c}`);
      return receiver.received(h, c);
    },
    receiveFailed: (h, c) => {
      calls.push(`failed ${c}`);
      return receiver.receiveFailed(h, c);
    },
    fetchFrom: (h) => fetchers.get(h) ?? null,
    log: quiet,
    pullRetry: { minMs: 10, maxMs: 40 },
    ...over,
  });
  receiver = new A2aContinueReceiver({
    policy: { get: () => continuePolicy },
    spawnPolicy: { get: () => spawn },
    requests,
    enqueue: () => undefined,
    originKeyOf: async () => ORIGIN,
    isRepoTop: async () => true,
    freeBytes: async () => 1024 ** 4,
    sessionLive: () => false,
    cardAvailable: () => true,
    now: () => clock,
    checks: new SpawnChecks(8),
    resendCoalesceMs: 0,
    bytes: bundle,
    log: quiet,
  });
  table = new A2aRouteTable();
  bundle.registerRoutes(table);
}

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-bundle-')));
  a2aDir = path.join(root, 'a2a');
  clock = Date.now();
  requests = new ContinueRequestStore({ dir: a2aDir, scheduleHarden: quiet, now: () => clock });
  continuePolicy = { ...defaultContinuePolicy(), in: { enabled: true, permissionMode: 'acceptEdits' } };
  spawn = {
    ...defaultSpawnPolicy(), enabled: true, agents: ['claude'],
    hosts: { [A]: { allowed: true }, [B]: { allowed: true }, [C]: { allowed: true } },
    roots: [{ id: 'web', label: 'Web', path: '/repos/web' }],
  };
  fetchers = new Map();
  calls = [];
  build();
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    // The peer is named by a test header here (the real listener authenticates it).
    const hostId = typeof req.headers['x-test-host'] === 'string' ? req.headers['x-test-host'] : A;
    void table.handle(req, res, url, url.pathname, { peerId: 'p', hostId, name: 'A' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  bundle.stop();
  receiver.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await bundle.idle();
  fs.rmSync(root, { recursive: true, force: true });
});

function env(state: string, continueId: string, body: Record<string, unknown>): A2aRemoteEnvelope {
  return {
    protocol: A2A_REMOTE_PROTOCOL, linkId: continueId, linkVersion: 0, messageId: `m-${state}`, kind: 'link',
    link: { state, version: 0 } as A2aRemoteEnvelope['link'], ...body, sentAt: new Date(clock).toISOString(),
  } as A2aRemoteEnvelope;
}

interface Asked {
  continueId: string;
  sessionId: string;
  dir: string;
  hostId: string;
}

/** A request approved here (`ready`), its manifest not sent yet. */
async function toReady(hostId = A): Promise<Asked> {
  const continueId = `ct-${crypto.randomUUID()}`;
  const sessionId = crypto.randomUUID();
  const req = {
    v: 1, continueId, sessionId, agent: 'claude', repo: { origin: ORIGIN, branch: 'main', head: HEAD },
    estimate: { bytes: 1024, files: 2 }, expiresAt: new Date(clock + 3600_000).toISOString(),
  };
  receiver.applyInbound(env('continue', continueId, { continue: req }), { hostId });
  await receiver.idle();
  expect(receiver.decide(hostId, continueId, 'once')).toEqual({ ok: true });
  return { continueId, sessionId, dir: continueStagingDir(a2aDir, hostId, continueId), hostId };
}

/** A request whose manifest (`transcript`, `files`) was taken: it receives, by upload or by pull. */
async function toReceiving(transcript: Buffer, files: Array<{ rel: string; body: Buffer }> = [], hostId = A, over: Record<string, unknown> = {}): Promise<Asked> {
  const asked = await toReady(hostId);
  const manifest = {
    v: 1, continueId: asked.continueId, head: HEAD, transcript: { sha256: sha(transcript), bytes: transcript.length },
    files: files.map((f) => ({ rel: f.rel, sha256: sha(f.body), bytes: f.body.length })), ...over,
  };
  await receiver.applyInbound(env('continue-manifest', asked.continueId, { continueManifest: manifest }), { hostId });
  await receiver.idle();
  await bundle.idle();
  return asked;
}

const stateOf = (a: Asked): string | undefined => requests.get(a.hostId, a.continueId)?.state;
const codeOf = (a: Asked): string | undefined => requests.get(a.hostId, a.continueId)?.code;
const partsOf = (a: Asked): string[] => (fs.existsSync(continuePartsDir(a.dir)) ? fs.readdirSync(continuePartsDir(a.dir)) : []);

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** One request to the routes; -1 when the connection was cut before an answer. */
function send(
  method: string,
  a: Asked,
  digest: string,
  opts: { body?: Buffer; host?: string; encoding?: string; chunked?: boolean } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = opts.chunked ? { 'Transfer-Encoding': 'chunked' } : opts.body ? { 'Content-Length': opts.body.length } : {};
    if (opts.host) headers['x-test-host'] = opts.host;
    if (opts.encoding) headers['Content-Encoding'] = opts.encoding;
    const req = http.request({ host: '127.0.0.1', port, method, path: `${A2A_ROUTES.continue}/${a.continueId}/${digest}`, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve({ status: -1, headers: {}, body: '' }));
    });
    req.on('error', (err) => (/ECONNRESET|EPIPE|socket hang up/.test(String(err)) ? resolve({ status: -1, headers: {}, body: '' }) : reject(err)));
    if (opts.body && opts.chunked) {
      for (let at = 0; at < opts.body.length; at += 16 * 1024) req.write(opts.body.subarray(at, at + 16 * 1024));
      req.end();
    } else {
      req.end(opts.body);
    }
  });
}

/** A PUT whose body starts and never finishes; `answer` settles if the server answers anyway. */
function stalled(a: Asked, digest: string, declared: number, host?: string): { req: http.ClientRequest; answer: Promise<Answer> } {
  let req!: http.ClientRequest;
  const answer = new Promise<Answer>((resolve) => {
    req = http.request(
      {
        host: '127.0.0.1', port, method: 'PUT', path: `${A2A_ROUTES.continue}/${a.continueId}/${digest}`, agent: false,
        headers: { 'Content-Length': declared, ...(host ? { 'x-test-host': host } : {}) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: '' }));
        res.on('error', () => resolve({ status: res.statusCode ?? -1, headers: res.headers, body: '' }));
      },
    );
    req.on('error', () => resolve({ status: -1, headers: {}, body: '' }));
    req.write(Buffer.alloc(1024));
  });
  return { req, answer };
}

describe('uploads (A joined this PC)', () => {
  it('stages a file sent raw and one gzipped, says so by HEAD while it receives, and is received once, after the last', async () => {
    const transcript = bytes(70_000, 1);
    const file = Buffer.from('tool output\n'.repeat(2_000));
    const a = await toReceiving(transcript, [{ rel: 'tool-results/1.txt', body: file }]);
    expect(stateOf(a)).toBe('receiving');
    expect((await send('HEAD', a, sha(transcript))).status).toBe(404);

    expect((await send('PUT', a, sha(transcript), { body: transcript })).status).toBe(200);
    expect((await send('HEAD', a, sha(transcript))).status).toBe(200);
    expect(calls).toEqual([]);
    expect(stateOf(a)).toBe('receiving');

    const gz = zlib.gzipSync(file);
    expect(gz.length).toBeLessThan(file.length);
    const last = await send('PUT', a, sha(file), { body: gz, encoding: 'gzip' });
    expect(last.status).toBe(200);
    expect(JSON.parse(last.body)).toEqual({ ok: true });
    expect(calls).toEqual([`received ${a.continueId}`]);
    expect(stateOf(a)).toBe('received');
    expect(fs.readFileSync(continueStagedTranscript(a.dir, a.sessionId)).equals(transcript)).toBe(true);
    expect(fs.readFileSync(continueStagedFile(a.dir, a.sessionId, 'tool-results/1.txt')).equals(file)).toBe(true);
    // Only the layout is left; and nothing more is taken for it.
    expect(fs.readdirSync(a.dir).sort()).toEqual([a.sessionId, `${a.sessionId}.jsonl`].sort());
    expect((await send('PUT', a, sha(file), { body: file })).status).toBe(404);
    // Received: HEAD answers 404 for a file it holds, and A hears of it from its continue-result.
    expect((await send('HEAD', a, sha(transcript))).status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it('refuses a gzip bomb as it inflates past its entry: small on the wire, before its body even ends', async () => {
    const transcript = bytes(64 * 1024, 2);
    const a = await toReceiving(transcript);
    const bomb = zlib.gzipSync(Buffer.alloc(10 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(transcript.length);
    // Half the bomb inflates to far more than the entry; the rest never comes.
    const res = await new Promise<number>((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'PUT', path: `${A2A_ROUTES.continue}/${a.continueId}/${sha(transcript)}`, agent: false, headers: { 'Content-Length': bomb.length, 'Content-Encoding': 'gzip' } },
        (r) => resolve(r.statusCode ?? 0),
      );
      req.on('error', () => resolve(-1));
      req.write(bomb.subarray(0, bomb.length >> 1));
    });
    expect([400, -1]).toContain(res);
    await bundle.idle();
    expect(calls).toEqual([`failed ${a.continueId}`]);
    expect(stateOf(a)).toBe('decided');
    expect(codeOf(a)).toBe('failed');
    expect(fs.existsSync(a.dir)).toBe(false);
  });

  it('fails the request on a hash that is not its entry’s', async () => {
    const transcript = bytes(4_000, 3);
    const a = await toReceiving(transcript);
    const res = await send('PUT', a, sha(transcript), { body: bytes(4_000, 4) });
    expect(res.status).toBe(400);
    await bundle.idle();
    expect(calls).toEqual([`failed ${a.continueId}`]);
    expect(codeOf(a)).toBe('failed');
    expect(fs.existsSync(a.dir)).toBe(false);
  });

  it('fails the request on a body past its entry, declared (before reading it) or counted', async () => {
    const transcript = bytes(1_000, 5);
    const declared = await toReceiving(transcript);
    const held = stalled(declared, sha(transcript), transcript.length + 1);
    const res = await held.answer;
    expect(res.status).toBe(413);
    expect(res.headers.connection).toBe('close');
    held.req.destroy();
    await bundle.idle();
    expect(codeOf(declared)).toBe('failed');

    const counted = await toReceiving(transcript);
    const chunked = await send('PUT', counted, sha(transcript), { body: Buffer.concat([transcript, bytes(64 * 1024, 6)]), chunked: true });
    expect([400, -1]).toContain(chunked.status);
    await bundle.idle();
    expect(codeOf(counted)).toBe('failed');
    expect(fs.existsSync(counted.dir)).toBe(false);
  });

  it('counts the wire too: gzip padded with members that inflate to nothing is refused', async () => {
    const transcript = bytes(2_000, 30);
    const a = await toReceiving(transcript);
    const empty = zlib.gzipSync(Buffer.alloc(0));
    const padded = Buffer.concat([...Array.from({ length: 1_000 }, () => empty), zlib.gzipSync(transcript)]);
    // It inflates to exactly the entry: only its size on the wire gives it away.
    expect(zlib.gunzipSync(padded).equals(transcript)).toBe(true);
    const res = await send('PUT', a, sha(transcript), { body: padded, encoding: 'gzip', chunked: true });
    expect([400, -1]).toContain(res.status);
    await bundle.idle();
    expect(codeOf(a)).toBe('failed');
  });

  it('refuses an encoding other than identity or gzip, and keeps the request for a good upload', async () => {
    const transcript = bytes(2_000, 7);
    const a = await toReceiving(transcript);
    const res = await send('PUT', a, sha(transcript), { body: transcript, encoding: 'br' });
    expect([415, -1]).toContain(res.status);
    expect(stateOf(a)).toBe('receiving');
    expect(calls).toEqual([]);
    expect((await send('PUT', a, sha(transcript), { body: transcript })).status).toBe(200);
    expect(stateOf(a)).toBe('received');
  });

  it('answers 404 before reading a body for another PC, a hash not in the manifest, or a request not receiving', async () => {
    const transcript = bytes(3_000, 8);
    const a = await toReceiving(transcript);
    const ready = await toReady();
    const cases: Array<[Asked, string, string | undefined]> = [
      [a, sha(transcript), B],
      [a, sha(bytes(3_000, 9)), undefined],
      [ready, sha(transcript), undefined],
    ];
    for (const [asked, digest, host] of cases) {
      // The body is never sent past its first KiB: an answer that waited for it would never come.
      const { req, answer } = stalled(asked, digest, 3_000, host);
      const got = await answer;
      expect(got.status).toBe(404);
      expect(got.headers.connection).toBe('close');
      req.destroy();
    }
    expect((await send('HEAD', a, sha(transcript), { host: B })).status).toBe(404);
    expect(partsOf(a)).toEqual([]);
    expect(stateOf(a)).toBe('receiving');
    expect(calls).toEqual([]);
  });

  it('keeps the connection after a HEAD, whatever it answers', async () => {
    const t = bytes(1_000, 43);
    const a = await toReceiving(t, [{ rel: 'f', body: bytes(10, 44) }]);
    expect((await send('PUT', a, sha(t), { body: t })).status).toBe(200);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const head = (digest: string, host?: string): Promise<{ status: number; reused: boolean }> =>
        new Promise((resolve, reject) => {
          const req = http.request(
            { host: '127.0.0.1', port, method: 'HEAD', agent, path: `${A2A_ROUTES.continue}/${a.continueId}/${digest}`, headers: host ? { 'x-test-host': host } : {} },
            (res) => {
              res.resume();
              res.on('end', () => resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket }));
            },
          );
          req.on('error', reject);
          req.end();
        });
      expect(await head(sha(bytes(10, 44)))).toEqual({ status: 404, reused: false });
      // A has up to a thousand files to ask about: no new handshake for each.
      expect(await head(sha(bytes(10, 45)), B)).toEqual({ status: 404, reused: true });
      expect(await head(sha(t))).toEqual({ status: 200, reused: true });
    } finally {
      agent.destroy();
    }
  });

  it('takes one transfer per PC and two in all: the others are refused, unread, with 429', async () => {
    const t = bytes(50_000, 10);
    const fromA = await toReceiving(t, [{ rel: 'x.txt', body: bytes(10, 11) }], A);
    const fromB = await toReceiving(t, [], B);
    const fromC = await toReceiving(t, [], C);
    const heldA = stalled(fromA, sha(t), t.length);
    await vi.waitFor(() => expect(partsOf(fromA)).toEqual([sha(t)]), { timeout: 5_000 });
    // A's slot is taken: A's next file waits.
    const second = await send('PUT', fromA, sha(bytes(10, 11)), { body: bytes(10, 11) });
    expect(second.status).toBe(429);
    expect(second.headers.connection).toBe('close');
    const heldB = stalled(fromB, sha(t), t.length, B);
    await vi.waitFor(() => expect(partsOf(fromB)).toEqual([sha(t)]), { timeout: 5_000 });
    expect((await send('PUT', fromC, sha(t), { body: t, host: C })).status).toBe(429);
    // A leaves mid-body: its part file goes, the request stays, and C gets the slot.
    heldA.req.destroy();
    await vi.waitFor(() => expect(partsOf(fromA)).toEqual([]), { timeout: 5_000 });
    await vi.waitFor(async () => expect((await send('PUT', fromC, sha(t), { body: t, host: C })).status).toBe(200), { timeout: 5_000 });
    expect(stateOf(fromA)).toBe('receiving');
    expect(stateOf(fromC)).toBe('received');
    heldB.req.destroy();
    // A takes the file again from the start.
    expect((await send('PUT', fromA, sha(t), { body: t })).status).toBe(200);
  });

  it('cuts a transfer past its budget, drops its part file, and takes the file again', async () => {
    build({ transferBudgetMs: (n) => (n > 10_000 ? 300 : 30_000) });
    const t = bytes(20_000, 12);
    const a = await toReceiving(t);
    const held = stalled(a, sha(t), t.length);
    await vi.waitFor(() => expect(partsOf(a)).toEqual([sha(t)]), { timeout: 5_000 });
    await vi.waitFor(() => expect(partsOf(a)).toEqual([]), { timeout: 5_000 });
    expect([503, -1]).toContain((await held.answer).status);
    expect(stateOf(a)).toBe('receiving');
    expect(calls).toEqual([]);
    build({ transferBudgetMs: () => 30_000 });
    expect((await send('PUT', a, sha(t), { body: t })).status).toBe(200);
    expect(stateOf(a)).toBe('received');
  });

  it('is not there while the continue policy is off: exactly what a path never registered answers', async () => {
    const t = bytes(1_000, 13);
    const a = await toReceiving(t);
    continuePolicy.in.enabled = false;
    const unknown = await new Promise<Answer>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/api/a2a/nowhere/x/y', headers: { 'Content-Length': t.length }, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(t);
    });
    expect(unknown.status).toBe(404);
    for (const method of ['PUT', 'HEAD']) {
      const off = await send(method, a, sha(t), method === 'PUT' ? { body: t } : {});
      expect(off.status, method).toBe(unknown.status);
      if (method === 'PUT') expect(off.body).toBe(unknown.body);
    }
    expect(stateOf(a)).toBe('receiving');
    continuePolicy.in.enabled = true;
    expect((await send('PUT', a, sha(t), { body: t })).status).toBe(200);
  });
});

describe('staging', () => {
  it.skipIf(process.platform === 'win32')('keeps its folders 0700, and fails the request at a link in the way', async () => {
    const t = bytes(500, 14);
    const file = bytes(600, 15);
    const a = await toReceiving(t, [{ rel: 'sub/f.txt', body: file }]);
    for (const d of [path.join(a2aDir, 'continue-in'), path.dirname(a.dir), a.dir, continuePartsDir(a.dir)]) {
      expect(fs.statSync(d).mode & 0o777, d).toBe(0o700);
    }
    // The conversation's folder is a link to somewhere else.
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(a.dir, a.sessionId), 'dir');
    const res = await send('PUT', a, sha(file), { body: file });
    expect([400, -1]).toContain(res.status);
    await bundle.idle();
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(codeOf(a)).toBe('failed');
    expect(fs.existsSync(a.dir)).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('flushes each file to disk before it takes its staged name', async () => {
    const events: string[] = [];
    const realOpen = fs.promises.open.bind(fs.promises);
    const realRename = fs.promises.rename.bind(fs.promises);
    const opened = vi.spyOn(fs.promises, 'open').mockImplementation((async (file: fs.PathLike, flags?: string, mode?: number) => {
      const handle = await realOpen(file, flags, mode);
      const realSync = handle.sync.bind(handle);
      handle.sync = async () => {
        events.push(`sync ${String(file)}`);
        return realSync();
      };
      return handle;
    }) as typeof fs.promises.open);
    const renamed = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      events.push(`rename ${String(from)}`);
      return realRename(from, to);
    });
    try {
      const t = bytes(3_000, 42);
      const a = await toReceiving(t, [{ rel: 'copy', body: t }, { rel: 'empty', body: Buffer.alloc(0) }]);
      expect((await send('PUT', a, sha(t), { body: t })).status).toBe(200);
      // The empty file, the transfer and its copy: each part flushed, then renamed.
      const parts = events.filter((e) => e.includes(continuePartsDir(a.dir)));
      expect(parts).toHaveLength(6);
      for (let i = 0; i < parts.length; i += 2) {
        expect(parts[i]).toBe(parts[i + 1].replace(/^rename /, 'sync '));
        expect(parts[i + 1]).toMatch(/^rename /);
      }
    } finally {
      opened.mockRestore();
      renamed.mockRestore();
    }
  });

  it('fills every entry of one hash from one transfer, and makes empty files with none', async () => {
    const t = bytes(9_000, 16);
    const a = await toReceiving(t, [
      { rel: 'copy.jsonl', body: t },
      { rel: 'empty', body: Buffer.alloc(0) },
      { rel: 'deep/er/empty', body: Buffer.alloc(0) },
    ]);
    expect(fs.statSync(continueStagedFile(a.dir, a.sessionId, 'empty')).size).toBe(0);
    expect(fs.statSync(continueStagedFile(a.dir, a.sessionId, 'deep/er/empty')).size).toBe(0);
    expect((await send('HEAD', a, EMPTY)).status).toBe(200);
    expect(calls).toEqual([]);
    expect((await send('PUT', a, sha(t), { body: t })).status).toBe(200);
    expect(calls).toEqual([`received ${a.continueId}`]);
    expect(fs.readFileSync(continueStagedFile(a.dir, a.sessionId, 'copy.jsonl')).equals(t)).toBe(true);
    expect(fs.readFileSync(continueStagedTranscript(a.dir, a.sessionId)).equals(t)).toBe(true);
  });

  it('is received at once when every entry is empty, and fails an empty entry that names another hash', async () => {
    const a = await toReceiving(Buffer.alloc(0), [{ rel: 'e', body: Buffer.alloc(0) }]);
    expect(stateOf(a)).toBe('received');
    expect(calls).toEqual([`received ${a.continueId}`]);

    calls.length = 0;
    const lying = await toReceiving(Buffer.alloc(0), [], A, { transcript: { sha256: sha(Buffer.from('x')), bytes: 0 } });
    expect(calls).toEqual([`failed ${lying.continueId}`]);
    expect(codeOf(lying)).toBe('failed');
    expect(fs.existsSync(lying.dir)).toBe(false);
  });
});

describe('pulls (this PC joined A)', () => {
  /** A fake GET from A, serving `bodies` by hash (gzipped when asked), each in chunks. */
  function serve(bodies: Map<string, Buffer>, opts: { failFirst?: boolean; status?: number; extra?: number } = {}) {
    const seen: Array<{ path: string; acceptEncoding?: string }> = [];
    let tries = 0;
    const get: StreamedGet = async (p, o, consume) => {
      seen.push({ path: p, ...(o.acceptEncoding ? { acceptEncoding: o.acceptEncoding } : {}) });
      tries += 1;
      if (opts.status) throw new PinnedClientError('http', `HTTP ${opts.status}`, { sent: true, status: opts.status });
      const body = bodies.get(p.split('/').pop() ?? '') ?? Buffer.alloc(0);
      const wire = zlib.gzipSync(Buffer.concat([body, Buffer.alloc(opts.extra ?? 0)]));
      const half = wire.subarray(0, Math.floor(wire.length / 2));
      const stream = opts.failFirst && tries === 1
        ? new Readable({ read() { this.push(half); this.destroy(new Error('connection reset')); } })
        : Readable.from([wire.subarray(0, 100), wire.subarray(100)]);
      return consume({ headers: { 'content-encoding': 'gzip' }, body: stream as unknown as http.IncomingMessage });
    };
    return { get, seen, tries: () => tries };
  }

  it('pulls each file streamed and gzipped, and is received once', async () => {
    const t = bytes(30_000, 17);
    const f = bytes(5_000, 18);
    const a2 = serve(new Map([[sha(t), t], [sha(f), f]]));
    fetchers.set(A, a2.get);
    const a = await toReceiving(t, [{ rel: 'f', body: f }]);
    expect(calls).toEqual([`received ${a.continueId}`]);
    expect(stateOf(a)).toBe('received');
    expect(a2.seen.map((s) => s.path).sort()).toEqual([sha(t), sha(f)].map((d) => `${A2A_ROUTES.continue}/${a.continueId}/${d}`).sort());
    expect(a2.seen.every((s) => s.acceptEncoding === 'gzip')).toBe(true);
    expect(fs.readFileSync(continueStagedFile(a.dir, a.sessionId, 'f')).equals(f)).toBe(true);
  });

  it('pulls a file again after a broken transfer, and fails on a 404', async () => {
    const t = bytes(30_000, 19);
    const again = serve(new Map([[sha(t), t]]), { failFirst: true });
    fetchers.set(A, again.get);
    const a = await toReceiving(t);
    expect(again.tries()).toBe(2);
    expect(stateOf(a)).toBe('received');

    calls.length = 0;
    fetchers.set(A, serve(new Map(), { status: 404 }).get);
    const gone = await toReceiving(t);
    expect(calls).toEqual([`failed ${gone.continueId}`]);
    expect(codeOf(gone)).toBe('failed');
  });

  it('fails a pulled body past its entry', async () => {
    const t = bytes(2_000, 20);
    fetchers.set(A, serve(new Map([[sha(t), t]]), { extra: 1 }).get);
    const a = await toReceiving(t);
    expect(codeOf(a)).toBe('failed');
    expect(fs.existsSync(a.dir)).toBe(false);
  });

  it('leaves no part file behind a body that fails at once, however soon', async () => {
    const t = bytes(2_000, 31);
    let tries = 0;
    fetchers.set(A, async (_p, _o, consume) => {
      tries += 1;
      // After a few tries this PC is no longer joined to A: the pull stops there.
      if (tries === 4) fetchers.delete(A);
      return consume({ headers: {}, body: new Readable({ read() { this.destroy(new Error('connection reset')); } }) as unknown as http.IncomingMessage });
    });
    const a = await toReceiving(t);
    expect(tries).toBe(4);
    expect(stateOf(a)).toBe('receiving');
    expect(partsOf(a)).toEqual([]);
  });

  it('writes nothing for a request decided while its pull was on the way', async () => {
    const t = bytes(2_000, 32);
    let asked = 0;
    fetchers.set(A, async (_p, _o, consume) => {
      asked += 1;
      clock += 2 * 3600_000;
      receiver.sweep();
      // A body that never ends: only a transfer that knows its request ended returns.
      return consume({ headers: {}, body: new Readable({ read() { /* never */ } }) as unknown as http.IncomingMessage });
    });
    const a = await toReceiving(t);
    expect(asked).toBe(1);
    expect(codeOf(a)).toBe('expired');
    expect(fs.existsSync(a.dir)).toBe(false);
  });

  it('pulls nothing from a PC that joined this one: that PC uploads', async () => {
    const t = bytes(2_000, 21);
    const b = serve(new Map([[sha(t), t]]));
    fetchers.set(B, b.get);
    const a = await toReceiving(t);
    expect(b.tries()).toBe(0);
    expect(stateOf(a)).toBe('receiving');
  });
});

describe('lifecycle', () => {
  it('tells the receiver again, with a backoff, when it could not store `received`, until it does', async () => {
    let failWrites = 0;
    requests = new ContinueRequestStore({
      dir: a2aDir, scheduleHarden: quiet, now: () => clock,
      write: (p, d) => {
        if (failWrites > 0) {
          failWrites -= 1;
          throw new Error('EPERM: the rename was refused');
        }
        atomicWriteJSONSync(p, d);
      },
    });
    build({ receivedRetry: { minMs: 20, maxMs: 40 } });
    const t = bytes(1_000, 40);
    const a = await toReceiving(t);
    failWrites = 2;
    expect((await send('PUT', a, sha(t), { body: t })).status).toBe(200);
    expect(stateOf(a)).toBe('receiving');
    await vi.waitFor(() => expect(stateOf(a)).toBe('received'), { timeout: 5_000 });
    expect(calls).toEqual(Array.from({ length: 3 }, () => `received ${a.continueId}`));

    // One the receiver never stores is told again only until the request is decided.
    const stuck = await toReceiving(bytes(1_000, 41));
    calls.length = 0;
    failWrites = 1_000;
    expect((await send('PUT', stuck, sha(bytes(1_000, 41)), { body: bytes(1_000, 41) })).status).toBe(200);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(1), { timeout: 5_000 });
    failWrites = 0;
    clock += 2 * 3600_000;
    receiver.sweep();
    expect(codeOf(stuck)).toBe('expired');
    const told = calls.length;
    await deliberateSleep(150, 'real timer: no further try fires after the decision');
    expect(calls).toHaveLength(told);
  });

  it('removes a request’s staging on its decision', async () => {
    const t = bytes(2_000, 22);
    const a = await toReceiving(t, [{ rel: 'f', body: bytes(10, 23) }]);
    expect((await send('PUT', a, sha(t), { body: t })).status).toBe(200);
    expect(fs.existsSync(continueStagedTranscript(a.dir, a.sessionId))).toBe(true);
    clock += 2 * 3600_000;
    receiver.sweep();
    await bundle.idle();
    expect(codeOf(a)).toBe('expired');
    expect(fs.existsSync(a.dir)).toBe(false);
  });

  it('cuts a transfer when its request is decided, then removes its staging', async () => {
    const t = bytes(20_000, 33);
    const a = await toReceiving(t);
    const held = stalled(a, sha(t), t.length);
    await vi.waitFor(() => expect(partsOf(a)).toEqual([sha(t)]), { timeout: 5_000 });
    clock += 2 * 3600_000;
    receiver.sweep();
    await bundle.idle();
    expect(codeOf(a)).toBe('expired');
    expect(fs.existsSync(a.dir)).toBe(false);
    expect([503, -1]).toContain((await held.answer).status);
  });

  it('drops a removed PC’s staging', async () => {
    const t = bytes(2_000, 24);
    await toReceiving(t, [], A);
    const other = await toReceiving(t, [], B);
    requests.forgetHost(A);
    receiver.forgetHost(A);
    await bundle.idle();
    expect(fs.existsSync(path.join(a2aDir, 'continue-in', A))).toBe(false);
    expect(fs.existsSync(other.dir)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('after a restart, removes a link where continue-in goes, never walking into it', async () => {
    const otherDisk = path.join(root, 'other-disk');
    fs.mkdirSync(path.join(otherDisk, 'keep-me'), { recursive: true });
    fs.writeFileSync(path.join(otherDisk, 'note.txt'), 'x');
    fs.mkdirSync(a2aDir, { recursive: true });
    fs.symlinkSync(otherDisk, path.join(a2aDir, 'continue-in'), 'dir');
    receiver.recover();
    await receiver.idle();
    await bundle.idle();
    expect(fs.readdirSync(otherDisk).sort()).toEqual(['keep-me', 'note.txt']);
    expect(fs.existsSync(path.join(a2aDir, 'continue-in'))).toBe(false);
  });

  it('after a restart: staging of no open request goes; a receiving one keeps what checks out, drops part files, and takes the rest', async () => {
    const t = bytes(8_000, 25);
    const f1 = bytes(3_000, 26);
    const f2 = bytes(3_000, 27);
    const open = await toReceiving(t, [{ rel: 'f1', body: f1 }, { rel: 'f2', body: f2 }]);
    expect((await send('PUT', open, sha(t), { body: t })).status).toBe(200);
    expect((await send('PUT', open, sha(f1), { body: f1 })).status).toBe(200);
    const done = await toReceiving(bytes(100, 28));
    expect((await send('PUT', done, sha(bytes(100, 28)), { body: bytes(100, 28) })).status).toBe(200);
    const decided = await toReady();
    receiver.decide(A, decided.continueId, 'deny');
    // Left behind by a run that stopped: a part file, a staged file since damaged, a decided
    // request's folder, one of a request never heard of, and a folder that is no PC's.
    fs.writeFileSync(path.join(continuePartsDir(open.dir), sha(f2)), 'half');
    fs.writeFileSync(continueStagedFile(open.dir, open.sessionId, 'f1'), bytes(3_000, 99));
    fs.mkdirSync(decided.dir, { recursive: true });
    const stranger = continueStagingDir(a2aDir, A, `ct-${crypto.randomUUID()}`);
    fs.mkdirSync(stranger, { recursive: true });
    const junk = path.join(a2aDir, 'continue-in', 'not-a-pc');
    fs.mkdirSync(junk, { recursive: true });
    bundle.stop();
    receiver.stop();

    requests = new ContinueRequestStore({ dir: a2aDir, scheduleHarden: quiet, now: () => clock });
    calls = [];
    build();
    receiver.recover();
    await receiver.idle();
    await bundle.idle();
    expect(fs.existsSync(decided.dir)).toBe(false);
    expect(fs.existsSync(stranger)).toBe(false);
    expect(fs.existsSync(junk)).toBe(false);
    expect(fs.existsSync(continueStagedTranscript(done.dir, done.sessionId))).toBe(true);
    expect(partsOf(open)).toEqual([]);
    expect((await send('HEAD', open, sha(t))).status).toBe(200);
    expect((await send('HEAD', open, sha(f1))).status).toBe(404);
    expect(fs.existsSync(continueStagedFile(open.dir, open.sessionId, 'f1'))).toBe(false);
    expect((await send('PUT', open, sha(f1), { body: f1 })).status).toBe(200);
    expect(calls).toEqual([]);
    expect((await send('PUT', open, sha(f2), { body: f2 })).status).toBe(200);
    expect(calls).toEqual([`received ${open.continueId}`]);
  });
});
