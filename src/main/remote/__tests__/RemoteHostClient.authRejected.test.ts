import { describe, it, expect, vi, afterEach } from 'vitest';
import { RemoteHostClient, isRemoteAuthRejected } from '../RemoteHostClient';
import type { RemoteHost } from '../../../shared/remoteHosts';

// A host that no longer accepts this desktop's credential (`wmux web` was
// restarted or stopped — which revokes paired devices — or the device was
// revoked) answers 401. That must reach the caller as a typed reason the UI can
// turn into "pair again", never as a raw "HTTP 401", and a live stream must stop
// retrying instead of hammering a host that has already said no.

const host: RemoteHost = {
  id: 'host-1',
  label: 'office-mac',
  origin: 'https://office-mac.example:9600',
  token: 'stale-token',
  addedAt: 0,
};

function unauthorized(): Response {
  return {
    ok: false,
    status: 401,
    body: null,
    json: async () => ({ error: 'unauthorized', reason: 'revoked' }),
  } as unknown as Response;
}

function unauthorizedBody(body: unknown): Response {
  return {
    ok: false,
    status: 401,
    body: null,
    json: async () => {
      if (body === undefined) throw new SyntaxError('not JSON');
      return body;
    },
  } as unknown as Response;
}

function forbidden(error: string): Response {
  return {
    ok: false,
    status: 403,
    body: null,
    json: async () => ({ error }),
  } as unknown as Response;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RemoteHostClient — credential rejected (401)', () => {
  it('listWorkspaces maps 401 to an auth-rejected error, not a raw status', async () => {
    const client = new RemoteHostClient(host, vi.fn(async () => unauthorized()) as unknown as typeof fetch);
    const err = await client.listWorkspaces().then(() => null, (e: unknown) => e);
    expect(isRemoteAuthRejected(err)).toBe(true);
    expect((err as Error).message).not.toContain('HTTP 401');
  });

  it('createWorkspace, closeSession and write map 401 the same way', async () => {
    const client = new RemoteHostClient(host, vi.fn(async () => unauthorized()) as unknown as typeof fetch);
    expect(isRemoteAuthRejected(await client.createWorkspace('ws-1').catch((e: unknown) => e))).toBe(true);
    expect(isRemoteAuthRejected(await client.closeSession('sess-1').catch((e: unknown) => e))).toBe(true);
    expect(isRemoteAuthRejected(await client.write('sess-1', 'x').catch((e: unknown) => e))).toBe(true);
    const resize = await client.resizeSession('sess-1', 80, 24);
    expect(resize).toEqual({ ok: false, reason: 'auth-rejected' });
  });

  it('a 403 feature gate is NOT treated as a rejected credential', async () => {
    const client = new RemoteHostClient(
      host,
      vi.fn(async () => forbidden('input disabled')) as unknown as typeof fetch,
    );
    const err = await client.createWorkspace('ws-1').catch((e: unknown) => e);
    expect(isRemoteAuthRejected(err)).toBe(false);
    expect((err as Error).message).toBe('input disabled');
  });

  it('a stream answered 401 stops reconnecting and reports auth-rejected at once', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => unauthorized());
    const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);
    const errors: Array<{ attachId: string; message: string; reason?: string }> = [];
    client.onError((e) => errors.push(e));

    const attachId = client.attach('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    // Reported immediately — not after the 5-attempt reconnect budget.
    expect(errors).toEqual([expect.objectContaining({ attachId, reason: 'auth-rejected' })]);

    // Well past every backoff step: still exactly the one request.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
  });

  it('the host\'s authorization-expired 401 is a rejected credential too', async () => {
    const client = new RemoteHostClient(
      host,
      vi.fn(async () => unauthorizedBody({ error: 'authorization-expired' })) as unknown as typeof fetch,
    );
    expect(isRemoteAuthRejected(await client.listWorkspaces().catch((e: unknown) => e))).toBe(true);
  });

  it('a 401 that is not the host\'s own credential answer (a proxy in front) stays an ordinary error', async () => {
    const client = new RemoteHostClient(host, vi.fn(async () => unauthorizedBody(undefined)) as unknown as typeof fetch);
    const err = await client.listWorkspaces().catch((e: unknown) => e);
    expect(isRemoteAuthRejected(err)).toBe(false);
    expect(err).toBeInstanceOf(Error);
  });

  it('a stream answered by a non-credential 401 keeps the normal reconnect loop', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => unauthorizedBody(undefined));
    const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);
    const errors: Array<{ reason?: string }> = [];
    client.onError((e) => errors.push(e));
    client.attach('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(7000);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
  });

  it('after a rejected write, queued input is dropped and later writes never reach the host', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchImpl = vi.fn(async () => { await gate; return unauthorized(); });
    const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

    const first = client.write('sess-1', 'a').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10); // first POST now in flight
    const queued = client.write('sess-1', 'b').catch((e: unknown) => e);
    release();
    await vi.advanceTimersByTimeAsync(50);

    expect(isRemoteAuthRejected(await first)).toBe(true);
    expect(isRemoteAuthRejected(await queued)).toBe(true);
    const later = client.write('sess-1', 'c').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(50);
    expect(isRemoteAuthRejected(await later)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
