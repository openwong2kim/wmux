import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteEnvelope } from '../../../shared/a2aRemote';
import { atomicWriteJSONSync } from '../../util/atomicWrite';
import { OUTBOX_FILE, OUTBOX_PENDING_MAX, OutboxStore, type OutboxStoreOptions } from '../outboxStore';

const HOST = '11111111-1111-4111-8111-111111111111';
const HOST2 = '22222222-2222-4222-8222-222222222222';

let dir: string;
let clock = 1_700_000_000_000;
let fail = false;
let epochs = 0;

const make = (o: Partial<OutboxStoreOptions> = {}): OutboxStore =>
  new OutboxStore({
    dir,
    now: () => clock,
    scheduleHarden: () => undefined,
    write: (p, d) => {
      if (fail) throw new Error('disk full');
      atomicWriteJSONSync(p, d);
    },
    mintEpoch: () => `epoch-${++epochs}`,
    ...o,
  });

const env = (messageId: string): A2aRemoteEnvelope => ({
  protocol: A2A_REMOTE_PROTOCOL,
  linkId: 'link-1',
  linkVersion: 2,
  messageId,
  kind: 'reply',
  taskId: 'rt-0',
  text: 'hi',
  sentAt: new Date(clock).toISOString(),
});

beforeEach(() => {
  clock = 1_700_000_000_000;
  fail = false;
  epochs = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-outbox-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('OutboxStore', () => {
  it('mints the epoch once, persists it at creation, and keeps it across restarts', () => {
    const a = make();
    expect(a.epoch).toBe('epoch-1');
    expect(fs.existsSync(path.join(dir, OUTBOX_FILE))).toBe(true);
    expect(make().epoch).toBe('epoch-1');
  });

  it('numbers each host on its own, strictly increasing, and never reuses a seq after a prune', () => {
    const s = make();
    expect(s.enqueue(HOST, env('a')).seq).toBe(1);
    expect(s.enqueue(HOST, env('b')).seq).toBe(2);
    expect(s.enqueue(HOST2, env('c')).seq).toBe(1);
    expect(s.ack(HOST, { epoch: s.epoch, seq: 2 })).toBe(2);
    clock += 2 * 60 * 60 * 1000;
    expect(s.prune()).toBe(2);
    expect(s.get(HOST, 1)).toBeUndefined();

    const reopened = make();
    expect(reopened.enqueue(HOST, env('d')).seq).toBe(3);
  });

  it('keeps unacked records across a restart, in order', () => {
    const s = make();
    s.enqueue(HOST, env('a'));
    s.enqueue(HOST, env('b'));
    s.markSent(HOST, 1);
    s.markOutcomeUnknown(HOST, 1, 'unavailable');

    const reopened = make();
    const pending = reopened.pending(HOST);
    expect(pending.map((r) => [r.seq, r.state, r.attempts])).toEqual([
      [1, 'outcome-unknown', 1],
      [2, 'pending', 0],
    ]);
    expect(pending[0].lastError).toBe('unavailable');
    expect(pending[0].envelope.messageId).toBe('a');
  });

  it('acks cumulatively up to the cursor, and ignores a cursor from another epoch', () => {
    const s = make();
    for (const m of ['a', 'b', 'c']) s.enqueue(HOST, env(m));
    s.enqueue(HOST2, env('x'));
    expect(s.ack(HOST, { epoch: 'other', seq: 3 })).toBe(0);
    expect(s.ack(HOST, { epoch: s.epoch, seq: 2 })).toBe(2);
    expect(s.pending(HOST).map((r) => r.seq)).toEqual([3]);
    expect(s.pending(HOST2).map((r) => r.seq)).toEqual([1]);
    expect(s.ack(HOST, { epoch: s.epoch, seq: 2 })).toBe(0);
  });

  it('tells onAck exactly the records an ack moved to acked, after it is stored; a throwing listener does not fail the ack', () => {
    const seen: Array<Array<[string, number, string]>> = [];
    const s = make({
      onAck: (recs) => {
        seen.push(recs.map((r) => [r.envelope.messageId, r.seq, r.state]));
        throw new Error('listener broke');
      },
    });
    for (const m of ['a', 'b', 'c']) s.enqueue(HOST, env(m));
    expect(s.ack(HOST, { epoch: s.epoch, seq: 2 })).toBe(2);
    expect(s.ack(HOST, { epoch: s.epoch, seq: 2 })).toBe(0);
    expect(s.ack(HOST, { epoch: s.epoch, seq: 3 })).toBe(1);
    expect(seen).toEqual([[['a', 1, 'acked'], ['b', 2, 'acked']], [['c', 3, 'acked']]]);
    expect(make().pending(HOST)).toEqual([]);
  });

  it('a refused record is no longer owed and cannot be marked again', () => {
    const s = make();
    s.enqueue(HOST, env('a'));
    expect(s.refuse(HOST, 1, 'conflict').state).toBe('refused');
    expect(s.pending(HOST)).toEqual([]);
    expect(() => s.markSent(HOST, 1)).toThrow(/refused/);
  });

  it('rolls back an enqueue whose write fails, without burning the seq', () => {
    const s = make();
    fail = true;
    expect(() => s.enqueue(HOST, env('a'))).toThrow(/disk full/);
    expect(s.pending(HOST)).toEqual([]);
    fail = false;
    expect(s.enqueue(HOST, env('b')).seq).toBe(1);
  });

  it('refuses a host past its unsent cap', () => {
    const s = make();
    for (let i = 0; i < OUTBOX_PENDING_MAX; i++) s.enqueue(HOST, env(`m${i}`));
    expect(() => s.enqueue(HOST, env('over'))).toThrow(/unsent/);
    expect(s.enqueue(HOST2, env('other')).seq).toBe(1);
  }, 30_000);

  it('a corrupt file is kept aside and the store starts empty under a new epoch', () => {
    const s = make();
    s.enqueue(HOST, env('a'));
    fs.writeFileSync(path.join(dir, OUTBOX_FILE), '{"v":1,"epoch":');
    const reopened = make();
    expect(reopened.epoch).toBe('epoch-2');
    expect(reopened.pending(HOST)).toEqual([]);
    expect(fs.readdirSync(dir).some((f) => f.startsWith(`${OUTBOX_FILE}.corrupt-`))).toBe(true);
  });

  it('rejects a file whose record seq is above the host high-water mark', () => {
    make().enqueue(HOST, env('a'));
    const file = JSON.parse(fs.readFileSync(path.join(dir, OUTBOX_FILE), 'utf-8'));
    file.seqByHost[HOST] = 0;
    fs.writeFileSync(path.join(dir, OUTBOX_FILE), JSON.stringify(file));
    expect(make().pending(HOST)).toEqual([]);
  });
});

describe('OutboxStore — the pump reads one record', () => {
  it('head is the oldest open record, openCount counts the open ones', () => {
    const s = make();
    expect(s.head(HOST)).toBeUndefined();
    s.enqueue(HOST, env('m1'));
    s.enqueue(HOST, env('m2'));
    s.enqueue(HOST, env('m3'));
    s.ack(HOST, { epoch: s.epoch, seq: 1 });
    expect(s.head(HOST)?.seq).toBe(2);
    expect(s.openCount(HOST)).toBe(2);
  });
});
