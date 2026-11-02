// JoinerSession.fetchStream, with a fake pinned client: a GET whose body is
// read as it arrives, ended by the session's stop.
import type http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JoinerSession, type SessionClient } from '../session';

const HOST = '11111111-1111-4111-8111-111111111111';

const sessions: JoinerSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
});

describe('JoinerSession streamed fetch', () => {
  it('streams a GET through a pinned client to the host, and its stop ends the fetch', async () => {
    let seen: { path: string; signal?: AbortSignal; acceptEncoding?: string } | undefined;
    const client: SessionClient = {
      requestJson: async () => ({ status: 200, json: { ok: true, duplicate: false } }),
      // A stream that never yields: only the fetch is under test.
      openStream: async function* (_p, { signal }) {
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
        yield* [];
      },
      getStream: async (path, opts, consume) => {
        seen = { path, signal: opts.signal, ...(opts.acceptEncoding ? { acceptEncoding: opts.acceptEncoding } : {}) };
        return consume({ headers: {}, body: Readable.from([Buffer.from('ab'), Buffer.from('c')]) as unknown as http.IncomingMessage });
      },
    };
    const session = new JoinerSession({
      hostId: HOST,
      host: () => ({ v: 1, hostId: HOST, name: 'B', addresses: ['127.0.0.1'], port: 1, fingerprint256: 'AB', peerId: 'p', createdAt: 'x' }),
      credential: () => ({ peerId: '22222222-2222-4222-8222-222222222222', secret: 'a'.repeat(43) }),
      outbox: { epoch: 'e', head: () => undefined, openCount: () => 0, markSent: vi.fn(), markOutcomeUnknown: vi.fn(), ack: vi.fn(), refuse: vi.fn() },
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
    const own = new AbortController();
    const got = await session.fetchStream('/api/a2a/continue/x/y', { timeoutMs: 1_000, signal: own.signal, acceptEncoding: 'gzip' }, async ({ body }) => {
      let text = '';
      for await (const chunk of body) text += (chunk as Buffer).toString('utf8');
      return text;
    });
    expect(got).toBe('abc');
    expect(seen).toMatchObject({ path: '/api/a2a/continue/x/y', acceptEncoding: 'gzip' });
    expect(seen?.signal?.aborted).toBe(false);
    await session.stop();
    expect(seen?.signal?.aborted).toBe(true);
  });
});
