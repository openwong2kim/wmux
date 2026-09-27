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
});
