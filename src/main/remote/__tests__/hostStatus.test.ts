import { describe, it, expect, vi } from 'vitest';
import { HostStatusProber, combineHostStatus } from '../hostStatus';
import type { RemoteHost } from '../../../shared/remoteHosts';

const host = (id: string, token = `tok-${id}`): RemoteHost => ({
  id,
  label: id,
  origin: `https://${id}.tail.ts.net`,
  token,
  addedAt: 1,
});

const answer = (status: number): Response => ({ status, ok: status < 400, body: null } as unknown as Response);

describe('HostStatusProber', () => {
  it('maps a thrown request to unreachable, 401 to needs-repair, anything else to reachable', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.startsWith('https://off.')) throw new TypeError('fetch failed');
      if (url.startsWith('https://revoked.')) return answer(401);
      if (url.startsWith('https://gated.')) return answer(403);
      return answer(200);
    });
    const prober = new HostStatusProber({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await prober.probe([host('on'), host('off'), host('revoked'), host('gated')]);
    expect(out).toEqual({ on: 'reachable', off: 'unreachable', revoked: 'needs-repair', gated: 'reachable' });
    // Bearer-credentialed, never follows a redirect, always bounded in time.
    const init = fetchImpl.mock.calls[0][1] ?? {};
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-on');
  });

  it('serves a cached answer for 60 s, then probes again; force skips the cache', async () => {
    let clock = 1_000;
    const fetchImpl = vi.fn(async () => answer(200));
    const prober = new HostStatusProber({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock });
    await prober.probe([host('a')]);
    clock += 59_000;
    await prober.probe([host('a')]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += 2_000;
    await prober.probe([host('a')]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await prober.probe([host('a')], { force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('re-probes a host whose credential changed (re-paired) even inside the TTL', async () => {
    const fetchImpl = vi.fn(async () => answer(401));
    const prober = new HostStatusProber({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await prober.probe([host('a', 'old')])).a).toBe('needs-repair');
    fetchImpl.mockImplementation(async () => answer(200));
    expect((await prober.probe([host('a', 'new')])).a).toBe('reachable');
  });

  it('keeps at most `concurrency` probes in flight, so one dead host never holds up the rest', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return answer(200);
    });
    const prober = new HostStatusProber({ fetchImpl: fetchImpl as unknown as typeof fetch, concurrency: 3 });
    const hosts = Array.from({ length: 8 }, (_, i) => host(`h${i}`));
    const out = await prober.probe(hosts);
    expect(Object.keys(out)).toHaveLength(8);
    expect(peak).toBe(3);
  });

  it('times out a host that never answers and still reports the others', async () => {
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('https://hang.')) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')));
        });
      }
      return Promise.resolve(answer(200));
    });
    const prober = new HostStatusProber({ fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 30 });
    const out = await prober.probe([host('hang'), host('ok')]);
    expect(out).toEqual({ hang: 'unreachable', ok: 'reachable' });
  });
});

describe('combineHostStatus', () => {
  const client = (rejected: boolean, live: number) => ({
    isAuthRejected: () => rejected,
    liveAttachmentCount: () => live,
  });

  it('is connected only when reachable AND streams are live', () => {
    expect(combineHostStatus('reachable', client(false, 2))).toBe('connected');
    expect(combineHostStatus('reachable', client(false, 0))).toBe('reachable');
    expect(combineHostStatus('reachable', undefined)).toBe('reachable');
    // Streams reconnecting to a host that stopped answering: not "connected".
    expect(combineHostStatus('unreachable', client(false, 2))).toBe('unreachable');
  });

  it('lets the client latch win: a refused credential is needs-repair whatever an older probe said', () => {
    expect(combineHostStatus('reachable', client(true, 1))).toBe('needs-repair');
    expect(combineHostStatus(undefined, client(true, 0))).toBe('needs-repair');
  });
});
