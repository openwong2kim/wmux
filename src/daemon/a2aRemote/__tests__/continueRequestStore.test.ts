// The store of conversations other PCs continue here: duplicates and
// conflicts, one open request per conversation, its caps, what survives a
// reload, how long a decided record is kept, and which answers are owed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTINUE_RECORD_KEEP_MS, parseContinueManifest, parseContinueRequest, type A2aContinueRequestV1 } from '../../../shared/a2aContinue';
import {
  CONTINUE_DECIDED_PER_HOST_MAX,
  CONTINUE_OPEN_PER_HOST_MAX,
  CONTINUE_REQUESTS_FILE,
  ContinueRequestStore,
} from '../continueRequestStore';

const HOST = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const HEAD = 'a'.repeat(40);
const quiet = (): void => undefined;

let dir: string;
let clock: number;

const open = (o: Partial<ConstructorParameters<typeof ContinueRequestStore>[0]> = {}): ContinueRequestStore =>
  new ContinueRequestStore({ dir, scheduleHarden: quiet, now: () => clock, ...o });

function request(over: Record<string, unknown> = {}): A2aContinueRequestV1 {
  const req = parseContinueRequest({
    v: 1, continueId: `ct-${crypto.randomUUID()}`, sessionId: crypto.randomUUID(), agent: 'claude',
    repo: { origin: 'github.com/acme/widget', branch: 'main', head: HEAD }, estimate: { bytes: 1024, files: 2 },
    expiresAt: new Date(clock + 3600_000).toISOString(), ...over,
  });
  if (!req) throw new Error('fixture: not a request');
  return req;
}

const manifestFor = (req: A2aContinueRequestV1) =>
  parseContinueManifest({ v: 1, continueId: req.continueId, head: HEAD, transcript: { sha256: 'b'.repeat(64), bytes: 10 }, files: [] })!;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-continue-store-'));
  clock = Date.parse('2026-10-29T12:00:00.000Z');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('receive', () => {
  it('a new request is pending; the same body again is a duplicate, another body a conflict', () => {
    const store = open();
    const req = request();
    expect(store.receive(HOST, req).kind).toBe('new');
    expect(store.receive(HOST, structuredClone(req))).toMatchObject({ kind: 'duplicate', rec: { state: 'pending', hostId: HOST } });
    expect(store.receive(HOST, { ...req, estimate: { bytes: 1, files: 0 } })).toEqual({ kind: 'conflict' });
    // The same id from another PC is another request.
    expect(store.receive(OTHER, { ...req, sessionId: crypto.randomUUID() }).kind).toBe('new');
  });

  it('only one open request carries a conversation, from any PC; once decided, another may', () => {
    const store = open();
    const req = request();
    store.receive(HOST, req);
    expect(store.receive(OTHER, request({ sessionId: req.sessionId }))).toEqual({ kind: 'busy' });
    store.decide(HOST, req.continueId, 'declined');
    expect(store.receive(OTHER, request({ sessionId: req.sessionId })).kind).toBe('new');
  });

  it('a PC with as many open requests as it may have, or as many decided ones as are kept, is full', () => {
    const store = open({ write: quiet });
    const reqs = Array.from({ length: CONTINUE_OPEN_PER_HOST_MAX }, () => request());
    for (const r of reqs) expect(store.receive(HOST, r).kind).toBe('new');
    expect(store.receive(HOST, request())).toEqual({ kind: 'full' });
    expect(store.receive(OTHER, request()).kind).toBe('new');
    for (const r of reqs) store.decide(HOST, r.continueId, 'declined');
    for (let i = reqs.length; i < CONTINUE_DECIDED_PER_HOST_MAX; i++) {
      const r = request();
      store.receive(HOST, r);
      store.decide(HOST, r.continueId, 'expired');
    }
    expect(store.receive(HOST, request())).toEqual({ kind: 'full' });
  });
});

describe('records', () => {
  it('survive a reload: state, root, manifest and the answer last sent', () => {
    const store = open();
    const req = request();
    store.receive(HOST, req);
    store.advance(HOST, req.continueId, ['pending'], 'awaiting', { rootId: 'web' });
    store.advance(HOST, req.continueId, ['awaiting'], 'ready');
    store.advance(HOST, req.continueId, ['ready'], 'receiving', { manifest: manifestFor(req) });
    store.markSent(HOST, req.continueId, 'ready');
    const again = open().get(HOST, req.continueId);
    expect(again).toMatchObject({ state: 'receiving', rootId: 'web', manifest: manifestFor(req), sent: 'ready', request: req });
  });

  it('only moves on from the states it names; a decision needs a final code and drops the manifest', () => {
    const store = open();
    const req = request();
    store.receive(HOST, req);
    expect(store.advance(HOST, req.continueId, ['ready'], 'receiving')).toBeUndefined();
    store.advance(HOST, req.continueId, ['pending'], 'awaiting');
    store.advance(HOST, req.continueId, ['awaiting'], 'ready');
    store.advance(HOST, req.continueId, ['ready'], 'receiving', { manifest: manifestFor(req) });
    expect(store.decide(HOST, req.continueId, 'received')).toBeUndefined();
    const decided = store.decide(HOST, req.continueId, 'failed');
    expect(decided).toMatchObject({ state: 'decided', code: 'failed', decidedAt: new Date(clock).toISOString() });
    expect(decided?.manifest).toBeUndefined();
    expect(store.decide(HOST, req.continueId, 'started')).toBeUndefined();
  });

  it('never writes a record a reload would skip: a state that needs a manifest without one, or one that takes none with one', () => {
    const store = open();
    const req = request();
    store.receive(HOST, req);
    expect(() => store.advance(HOST, req.continueId, ['pending'], 'awaiting', { manifest: manifestFor(req) })).toThrow('could not read back');
    store.advance(HOST, req.continueId, ['pending'], 'awaiting');
    store.advance(HOST, req.continueId, ['awaiting'], 'ready');
    expect(() => store.advance(HOST, req.continueId, ['ready'], 'receiving')).toThrow('could not read back');
    // Nothing was written: the record is still ready, here and after a reload.
    expect(store.get(HOST, req.continueId)?.state).toBe('ready');
    expect(open().get(HOST, req.continueId)?.state).toBe('ready');
  });

  it('a failed write changes nothing', () => {
    const store = open({ write: () => { throw new Error('disk full'); } });
    expect(() => store.receive(HOST, request())).toThrow('disk full');
    expect(store.inState('pending')).toEqual([]);
  });

  it('a record this build cannot read is skipped, not the whole file', () => {
    const store = open();
    const req = request();
    store.receive(HOST, req);
    const file = path.join(dir, CONTINUE_REQUESTS_FILE);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { records: unknown[] };
    raw.records.push({ v: 1, hostId: HOST, state: 'receiving', request: request(), receivedAt: 'x', updatedAt: 'x' });
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(open().inState('pending').map((r) => r.request.continueId)).toEqual([req.continueId]);
  });

  it('a decided record is kept for its window after the decision, then pruned; open ones stay', () => {
    const store = open();
    const decided = request();
    const waiting = request();
    store.receive(HOST, decided);
    store.receive(HOST, waiting);
    store.decide(HOST, decided.continueId, 'declined');
    clock += CONTINUE_RECORD_KEEP_MS - 1000;
    expect(store.prune()).toBe(0);
    clock += 2000;
    expect(store.prune()).toBe(1);
    expect(store.get(HOST, decided.continueId)).toBeUndefined();
    expect(open().get(HOST, waiting.continueId)?.state).toBe('pending');
  });
});

describe('answers owed', () => {
  it('a record whose answer moved on since the last one queued is owed one, across a reload', () => {
    const store = open();
    const req = request();
    store.receive(HOST, req);
    // Pending says nothing yet.
    expect(store.unsent()).toEqual([]);
    store.advance(HOST, req.continueId, ['pending'], 'awaiting');
    expect(store.unsent().map((r) => r.request.continueId)).toEqual([req.continueId]);
    store.markSent(HOST, req.continueId, 'waiting-for-approval');
    expect(store.unsent()).toEqual([]);
    store.advance(HOST, req.continueId, ['awaiting'], 'ready');
    store.markSent(HOST, req.continueId, 'ready');
    // `receiving` answers `ready` too: nothing new is owed.
    store.advance(HOST, req.continueId, ['ready'], 'receiving', { manifest: manifestFor(req) });
    expect(store.unsent()).toEqual([]);
    store.decide(HOST, req.continueId, 'failed');
    expect(open().unsent().map((r) => r.code)).toEqual(['failed']);
  });
});

describe('starts in flight, room, and PCs removed', () => {
  function toStarting(store: ContinueRequestStore, req: A2aContinueRequestV1): void {
    store.receive(HOST, req);
    store.advance(HOST, req.continueId, ['pending'], 'awaiting', { rootId: 'web' });
    store.advance(HOST, req.continueId, ['awaiting'], 'ready');
    store.advance(HOST, req.continueId, ['ready'], 'receiving', { manifest: manifestFor(req) });
    store.advance(HOST, req.continueId, ['receiving'], 'received');
    store.advance(HOST, req.continueId, ['received'], 'starting');
  }

  it('a claimed start holds its conversation but no slot of its PC', () => {
    const store = open();
    const starts = Array.from({ length: CONTINUE_OPEN_PER_HOST_MAX }, () => request());
    for (const r of starts) toStarting(store, r);
    expect(store.receive(HOST, request()).kind).toBe('new');
    expect(store.receive(HOST, request({ sessionId: starts[0].sessionId }))).toEqual({ kind: 'busy' });
  });

  it('only bytes still to come are reserved: a receiving manifest, not one already received', () => {
    const store = open();
    const req = request();
    store.receive(HOST, req);
    store.advance(HOST, req.continueId, ['pending'], 'awaiting', { rootId: 'web' });
    store.advance(HOST, req.continueId, ['awaiting'], 'ready');
    expect(store.reservedBytes()).toBe(0);
    store.advance(HOST, req.continueId, ['ready'], 'receiving', { manifest: manifestFor(req) });
    expect(store.reservedBytes()).toBe(10);
    store.advance(HOST, req.continueId, ['receiving'], 'received');
    expect(store.reservedBytes()).toBe(0);
  });

  it('forgetting a PC drops its records, on disk too; retaining drops those of PCs no longer paired', () => {
    const store = open();
    const mine = request();
    const theirs = request();
    store.receive(HOST, mine);
    store.receive(OTHER, theirs);
    expect(store.forgetHost(HOST)).toBe(1);
    expect(open().get(HOST, mine.continueId)).toBeUndefined();
    expect(open().get(OTHER, theirs.continueId)?.state).toBe('pending');
    const reloaded = open();
    expect(reloaded.retainHosts((h) => h === HOST)).toBe(1);
    expect(open().inState('pending')).toEqual([]);
  });
});
