// JoinerSession pump, with a fake pinned client: what happens when this side
// cannot record the outcome of a send.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2A_FEATURE_STREAM_PING, A2A_FEATURE_STREAM_REFUSE, A2A_REMOTE_PROTOCOL, A2A_ROUTES, type A2aOutboxRecordV1, type A2aRemoteDeliverResponse } from '../../../shared/a2aRemote';
import { JoinerSession, type SessionClient } from '../session';
import { deliberateSleep } from '../../../test-utils/waitFor';

const HOST = '11111111-1111-4111-8111-111111111111';

function record(): A2aOutboxRecordV1 {
  return {
    v: 1, epoch: 'e', seq: 1, hostId: HOST, state: 'pending', attempts: 0, createdAt: 'x', updatedAt: 'x',
    envelope: { protocol: A2A_REMOTE_PROTOCOL, linkId: 'l', linkVersion: 2, messageId: 'm', kind: 'reply', taskId: 't', text: 'hi', sentAt: 'x' },
  };
}

const sessions: JoinerSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
});

function make(answer: unknown, failWrites: { ack?: boolean; refuse?: boolean }): { posts: () => number } {
  let posts = 0;
  const rec = record();
  const client: SessionClient = {
    requestJson: async (_m, p) => {
      if (p === A2A_ROUTES.messages) posts += 1;
      return { status: 200, json: answer };
    },
    // A stream that never yields: only the pump is under test.
    // eslint-disable-next-line require-yield -- a stream that never yields
    openStream: async function* (_p, { signal }) {
      await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
    },
  };
  const session = new JoinerSession({
    hostId: HOST,
    host: () => ({ v: 1, hostId: HOST, name: 'B', addresses: ['127.0.0.1'], port: 1, fingerprint256: 'AB', peerId: 'p', createdAt: 'x' }),
    credential: () => ({ peerId: '22222222-2222-4222-8222-222222222222', secret: 'a'.repeat(43) }),
    outbox: {
      epoch: 'e',
      head: () => structuredClone(rec),
      openCount: () => 1,
      markSent: () => rec,
      markOutcomeUnknown: () => rec,
      ack: () => { if (failWrites.ack) throw new Error('disk'); return 1; },
      refuse: () => { if (failWrites.refuse) throw new Error('disk'); return rec; },
    },
    accept: async () => ({ ok: true, duplicate: false }),
    onRefused: () => undefined,
    reconcileLinks: async () => undefined,
    onStatus: () => undefined,
    timing: { backoffMinMs: 100, backoffMaxMs: 400, livenessMs: 60_000 },
    client: () => client,
    log: () => undefined,
  });
  sessions.push(session);
  session.start();
  return { posts: () => posts };
}

describe('JoinerSession pump', () => {
  it('an ack it cannot record backs off instead of re-POSTing in a tight loop', async () => {
    const s = make({ ok: true, duplicate: false }, { ack: true });
    await deliberateSleep(600, 'real timer: counts re-POSTs inside a 600ms window of the backoff');
    expect(s.posts()).toBeGreaterThanOrEqual(1);
    expect(s.posts()).toBeLessThanOrEqual(5);
  });

  it('a refusal it cannot record backs off too', async () => {
    const s = make({ ok: false, error: 'conflict' }, { refuse: true });
    await deliberateSleep(600, 'real timer: counts re-POSTs inside a 600ms window of the backoff');
    expect(s.posts()).toBeGreaterThanOrEqual(1);
    expect(s.posts()).toBeLessThanOrEqual(5);
  });
});

describe('JoinerSession: an approval refused rate-limited', () => {
  it('is final: refused once in the outbox, its sender told, and never posted again', async () => {
    let posts = 0;
    let owed: A2aOutboxRecordV1 | undefined = {
      ...record(),
      envelope: { protocol: A2A_REMOTE_PROTOCOL, linkId: 'l', linkVersion: 2, messageId: 'ap-1', kind: 'approval', taskId: 't', approval: { promptId: '0123456789abcdef', decision: 'deny' }, sentAt: 'x' } as A2aOutboxRecordV1['envelope'],
    };
    const refused: string[] = [];
    const told: string[] = [];
    const client: SessionClient = {
      requestJson: async (_m, p) => {
        if (p === A2A_ROUTES.messages) posts += 1;
        return { status: 409, json: { ok: false, error: 'rate-limited' } };
      },
      // eslint-disable-next-line require-yield -- a stream that never yields
      openStream: async function* (_p, { signal }) {
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
      },
    };
    const session = new JoinerSession({
      hostId: HOST,
      host: () => ({ v: 1, hostId: HOST, name: 'B', addresses: ['127.0.0.1'], port: 1, fingerprint256: 'AB', peerId: 'p', createdAt: 'x' }),
      credential: () => ({ peerId: '22222222-2222-4222-8222-222222222222', secret: 'a'.repeat(43) }),
      outbox: {
        epoch: 'e',
        head: () => (owed ? structuredClone(owed) : undefined),
        openCount: () => (owed ? 1 : 0),
        markSent: () => owed!,
        markOutcomeUnknown: () => owed!,
        ack: () => 1,
        refuse: (_h, _seq, code) => { refused.push(code); const r = owed!; owed = undefined; return r; },
      },
      accept: async () => ({ ok: true, duplicate: false }),
      onRefused: (rec, code) => { told.push(`${rec.envelope.messageId}:${code}`); },
      reconcileLinks: async () => undefined,
      onStatus: () => undefined,
      timing: { backoffMinMs: 100, backoffMaxMs: 400, livenessMs: 60_000 },
      client: () => client,
      log: () => undefined,
    });
    sessions.push(session);
    session.start();
    await vi.waitFor(() => expect(told).toEqual(['ap-1:rate-limited']), { timeout: 5_000 });
    expect(refused).toEqual(['rate-limited']);
    expect(posts).toBe(1);
  });
});

describe('JoinerSession status', () => {
  it('shows connected as soon as a send gets through, without waiting out the stream backoff', async () => {
    const states: string[] = [];
    let stream = 0;
    const rec = record();
    let open = 1;
    const client: SessionClient = {
      requestJson: async () => ({ status: 200, json: { ok: true, duplicate: false } }),
      // The first stream attempt fails (server down) and leaves a long backoff;
      // the redial afterwards hangs open without a hello yet.
      // eslint-disable-next-line require-yield -- this stream throws or hangs, never yields
      openStream: async function* (_p, { signal }) {
        stream += 1;
        if (stream === 1) throw new Error('stream refused');
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
      },
    };
    const session = new JoinerSession({
      hostId: HOST,
      host: () => ({ v: 1, hostId: HOST, name: 'B', addresses: ['127.0.0.1'], port: 1, fingerprint256: 'AB', peerId: 'p', createdAt: 'x' }),
      credential: () => ({ peerId: '22222222-2222-4222-8222-222222222222', secret: 'a'.repeat(43) }),
      outbox: {
        epoch: 'e',
        head: () => (open > 0 ? structuredClone(rec) : undefined),
        openCount: () => open,
        markSent: () => rec,
        markOutcomeUnknown: () => rec,
        ack: () => { open = 0; return 1; },
        refuse: () => rec,
      },
      accept: async () => ({ ok: true, duplicate: false }),
      onRefused: () => undefined,
      reconcileLinks: async () => undefined,
      onStatus: (s) => states.push(s.state),
      timing: { backoffMinMs: 5_000, backoffMaxMs: 5_000, livenessMs: 60_000 },
      client: () => client,
      log: () => undefined,
    });
    sessions.push(session);
    session.start();
    await vi.waitFor(() => expect(states).toContain('connected'), { timeout: 10_000 });
    expect(session.current()).toMatchObject({ state: 'connected', pending: 0 });
    // The send also cut the stream's long backoff short (a redial happened).
    expect(stream).toBeGreaterThanOrEqual(2);
  });
});

describe('JoinerSession server features', () => {
  function withHello(data: unknown): { session: JoinerSession; seen: string[][] } {
    const seen: string[][] = [];
    const client: SessionClient = {
      requestJson: async () => ({ status: 200, json: { ok: true, acked: 0 } }),
      openStream: async function* (_p, { signal }) {
        yield { event: 'hello', data };
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
      },
    };
    const session = new JoinerSession({
      hostId: HOST,
      host: () => ({ v: 1, hostId: HOST, name: 'B', addresses: ['127.0.0.1'], port: 1, fingerprint256: 'AB', peerId: 'p', createdAt: 'x' }),
      credential: () => ({ peerId: '22222222-2222-4222-8222-222222222222', secret: 'a'.repeat(43) }),
      outbox: { epoch: 'e', head: () => undefined, openCount: () => 0, markSent: () => record(), markOutcomeUnknown: () => record(), ack: () => 0, refuse: () => record() },
      accept: async () => ({ ok: true, duplicate: false }),
      onRefused: () => undefined,
      reconcileLinks: async () => undefined,
      onStatus: () => undefined,
      onServerFeatures: (f) => seen.push(f),
      timing: { backoffMinMs: 100, backoffMaxMs: 400, livenessMs: 60_000 },
      client: () => client,
      log: () => undefined,
    });
    sessions.push(session);
    return { session, seen };
  }

  it("keeps what the server's hello advertised, well-formed tokens only", async () => {
    const { session, seen } = withHello({ epoch: 'e', features: ['images.1', 'link-offer.1', 'Bad Token'] });
    expect(session.features()).toBeUndefined();
    session.start();
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5_000 });
    expect(seen[0]).toEqual(['images.1', 'link-offer.1']);
    expect(session.features()).toEqual(['images.1', 'link-offer.1']);
    expect(session.current().features).toEqual(['images.1', 'link-offer.1']);
  });

  it('reads a hello without features (an older server) as taking none', async () => {
    const { session, seen } = withHello({ epoch: 'e' });
    session.start();
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5_000 });
    expect(session.features()).toEqual([]);
  });
});

describe('JoinerSession stream ping', () => {
  function pinging(features: string[]): { acks: () => unknown[] } {
    const acks: unknown[] = [];
    const client: SessionClient = {
      requestJson: async (_m, p, body) => {
        if (p === A2A_ROUTES.ack) acks.push(body);
        return { status: 200, json: { ok: true, acked: 0 } };
      },
      openStream: async function* (_p, { signal }) {
        yield { event: 'hello', data: { epoch: 'e7', features } };
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
      },
    };
    const session = new JoinerSession({
      hostId: HOST,
      host: () => ({ v: 1, hostId: HOST, name: 'B', addresses: ['127.0.0.1'], port: 1, fingerprint256: 'AB', peerId: 'p', createdAt: 'x' }),
      credential: () => ({ peerId: '22222222-2222-4222-8222-222222222222', secret: 'a'.repeat(43) }),
      outbox: { epoch: 'e', head: () => undefined, openCount: () => 0, markSent: () => record(), markOutcomeUnknown: () => record(), ack: () => 0, refuse: () => record() },
      accept: async () => ({ ok: true, duplicate: false }),
      onRefused: () => undefined,
      reconcileLinks: async () => undefined,
      onStatus: () => undefined,
      timing: { livenessMs: 60_000, pingMs: 50 },
      client: () => client,
      log: () => undefined,
    });
    sessions.push(session);
    session.start();
    return { acks: () => acks };
  }

  it('acks the stream cursor on a timer to a server that takes stream-ping.1, and never to one that does not', async () => {
    const yes = pinging([A2A_FEATURE_STREAM_PING]);
    const no = pinging([]);
    await deliberateSleep(300, 'real timer: several ping intervals');
    expect(yes.acks().length).toBeGreaterThanOrEqual(3);
    // Nothing applied yet on this stream: seq 0 of its epoch, which acks nothing.
    expect(yes.acks()[0]).toEqual({ cursor: { epoch: 'e7', seq: 0 } });
    expect(no.acks()).toHaveLength(0);
  });
});

describe('JoinerSession: a refusal of a streamed record (stream-refuse.1)', () => {
  /**
   * A server whose stream sends one event (seq 5) on every dial. `answers`: the status of each ack POST in turn
   * (then 200). Records each ack body and the resume id of each dial.
   */
  function streaming(
    features: string[],
    result: A2aRemoteDeliverResponse | (() => A2aRemoteDeliverResponse),
    answers: number[] = [],
    opts: { reconcileFails?: () => boolean } = {},
  ): { acks: unknown[]; resumes: Array<string | undefined>; applied: () => number; reconciled: () => number } {
    let reconciled = 0;
    const acks: unknown[] = [];
    const resumes: Array<string | undefined> = [];
    let applied = 0;
    const client: SessionClient = {
      requestJson: async (_m, p, body) => {
        if (p !== A2A_ROUTES.ack) return { status: 200, json: { ok: true } };
        acks.push(body);
        const status = answers.shift() ?? 200;
        return { status, json: status === 200 ? { ok: true, acked: 1, refused: 'applied' } : { ok: false, error: 'unavailable' } };
      },
      openStream: async function* (_p, { signal, lastEventId }) {
        resumes.push(lastEventId);
        yield { event: 'hello', data: { epoch: 'e7', features } };
        yield { event: 'message', data: { cursor: { epoch: 'e7', seq: 5 }, envelope: {} } };
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
      },
    };
    const session = new JoinerSession({
      hostId: HOST,
      host: () => ({ v: 1, hostId: HOST, name: 'B', addresses: ['127.0.0.1'], port: 1, fingerprint256: 'AB', peerId: 'p', createdAt: 'x' }),
      credential: () => ({ peerId: '22222222-2222-4222-8222-222222222222', secret: 'a'.repeat(43) }),
      outbox: { epoch: 'e', head: () => undefined, openCount: () => 0, markSent: () => record(), markOutcomeUnknown: () => record(), ack: () => 0, refuse: () => record() },
      accept: async () => {
        applied += 1;
        return typeof result === 'function' ? result() : result;
      },
      onRefused: () => undefined,
      reconcileLinks: async () => {
        reconciled += 1;
        if (opts.reconcileFails?.()) throw new Error('reconcile failed');
      },
      onStatus: () => undefined,
      timing: { livenessMs: 60_000, backoffMinMs: 10, backoffMaxMs: 20 },
      client: () => client,
      log: () => undefined,
    });
    sessions.push(session);
    session.start();
    return { acks, resumes, applied: () => applied, reconciled: () => reconciled };
  }

  it('tells a server that takes it, in the ack of that record', async () => {
    const s = streaming([A2A_FEATURE_STREAM_REFUSE], { ok: false, error: 'unknown-task' });
    await vi.waitFor(() => expect(s.acks).toHaveLength(1), { timeout: 5_000 });
    expect(s.acks[0]).toEqual({ cursor: { epoch: 'e7', seq: 5 }, refused: { seq: 5, code: 'unknown-task' } });
  });

  it('a server without it in its hello gets a plain ack, as before', async () => {
    const s = streaming([], { ok: false, error: 'unknown-task' });
    await vi.waitFor(() => expect(s.acks).toHaveLength(1), { timeout: 5_000 });
    expect(s.acks[0]).toEqual({ cursor: { epoch: 'e7', seq: 5 } });
  });

  it('a record applied fine is acked plainly, refusal feature or not', async () => {
    const s = streaming([A2A_FEATURE_STREAM_REFUSE], { ok: true, duplicate: false });
    await vi.waitFor(() => expect(s.acks).toHaveLength(1), { timeout: 5_000 });
    expect(s.acks[0]).toEqual({ cursor: { epoch: 'e7', seq: 5 } });
  });

  it('a refusal the server did not take acks nothing: the stream is dialled again from the previous event, and the record is refused again', async () => {
    const s = streaming([A2A_FEATURE_STREAM_REFUSE], { ok: false, error: 'conflict' }, [503]);
    await vi.waitFor(() => expect(s.acks).toHaveLength(2), { timeout: 5_000 });
    // The second dial resumed from before seq 5 (nothing was acked here), so the server sent it again.
    expect(s.resumes[0]).toBeUndefined();
    expect(s.resumes[1]).toBeUndefined();
    expect(s.applied()).toBe(2);
    expect(s.acks[1]).toEqual({ cursor: { epoch: 'e7', seq: 5 }, refused: { seq: 5, code: 'conflict' } });
  });
  it('a refusal from its own view of the link is applied once more after a reconcile, and not told when that takes it', async () => {
    let n = 0;
    const s = streaming([A2A_FEATURE_STREAM_REFUSE], () => (n++ === 0 ? { ok: false, error: 'unknown-link' } : { ok: true, duplicate: false }));
    await vi.waitFor(() => expect(s.acks).toHaveLength(1), { timeout: 5_000 });
    expect(s.applied()).toBe(2);
    expect(s.reconciled()).toBeGreaterThanOrEqual(1);
    expect(s.acks[0]).toEqual({ cursor: { epoch: 'e7', seq: 5 } });
  });
  it('a reconcile that fails keeps the event owed: nothing is refused, and the next dial applies it again', async () => {
    let n = 0;
    // Refused from the link view twice, then taken; the reconcile after the first refusal fails.
    const s = streaming([A2A_FEATURE_STREAM_REFUSE], () => (n++ < 2 ? { ok: false, error: 'stale-link-version' } : { ok: true, duplicate: false }), [], {
      reconcileFails: () => n === 1,
    });
    await vi.waitFor(() => expect(s.acks).toHaveLength(1), { timeout: 5_000 });
    // Never told: the first try ended the dial with nothing acked, the second was taken after a good reconcile.
    expect(s.acks[0]).toEqual({ cursor: { epoch: 'e7', seq: 5 } });
    expect(s.applied()).toBe(3);
    expect(s.resumes.length).toBeGreaterThanOrEqual(2);
  });
});
