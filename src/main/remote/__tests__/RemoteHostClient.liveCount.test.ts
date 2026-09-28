import { describe, it, expect, vi, afterEach } from 'vitest';
import { RemoteHostClient } from '../RemoteHostClient';
import type { RemoteHost } from '../../../shared/remoteHosts';

/**
 * "Connected" in the Remote hub means a stream that is open right now, not an
 * attachment record that is waiting to reconnect to a host that went away.
 */
const host: RemoteHost = { id: 'h', label: 'h', origin: 'https://h.ts.net', token: 't', addedAt: 0 };

function openStream(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode('event: meta\ndata: {"cols":80,"rows":24}\n\n')); },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

const settle = () => new Promise((r) => setTimeout(r, 10));

afterEach(() => vi.useRealTimers());

describe('RemoteHostClient.liveAttachmentCount', () => {
  it('counts an attachment only while its stream is open', async () => {
    const client = new RemoteHostClient(host, vi.fn(async () => openStream()) as unknown as typeof fetch);
    client.onError(() => undefined);
    const id = client.attach('s1');
    await settle();
    expect(client.liveAttachmentCount()).toBe(1);
    client.detach(id);
    expect(client.liveAttachmentCount()).toBe(0);
  });

  it('does not count an attachment whose host refuses the connection (reconnecting)', async () => {
    const client = new RemoteHostClient(
      host,
      vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch,
    );
    client.onError(() => undefined);
    const id = client.attach('s1');
    await settle();
    expect(client.liveAttachmentCount()).toBe(0);
    client.detach(id);
  });

  it('drops the count when an open stream ends', async () => {
    let close: () => void = () => undefined;
    const fetchImpl = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({ start(c) { close = () => c.close(); } });
      return { ok: true, status: 200, body: stream } as unknown as Response;
    });
    const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);
    client.onError(() => undefined);
    const id = client.attach('s1');
    await settle();
    expect(client.liveAttachmentCount()).toBe(1);
    close();
    await settle();
    expect(client.liveAttachmentCount()).toBe(0);
    client.detach(id);
  });
});
