import { describe, expect, it, vi } from 'vitest';
import { RelayTransport } from '../RelayTransport';

describe('RelayTransport URL safety', () => {
  it('refuses unsafe URLs before any secret-bearing fetch or retry', async () => {
    for (const relayUrl of [
      'http://relay.example', 'ftp://localhost', 'not a URL',
      'http://localhost.example', 'http://127.0.0.1.example',
      'http://[::ffff:192.0.2.1]',
    ]) {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const sleep = vi.fn(async () => undefined);
      const transport = new RelayTransport({ relayUrl, relaySecret: 'secret', fetchImpl, sleep });
      expect(transport.enabled).toBe(false);
      expect(await transport.post('/push', {})).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it('allows HTTPS and HTTP loopback while retaining manual redirects', async () => {
    for (const relayUrl of ['https://relay.example', 'http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const transport = new RelayTransport({ relayUrl, relaySecret: 'secret', fetchImpl });
      expect(transport.enabled).toBe(true);
      expect(await transport.post('/push', {})).toBe(200);
      expect(fetchImpl).toHaveBeenCalledWith(`${relayUrl}/push`, expect.objectContaining({
        redirect: 'manual', headers: expect.objectContaining({ authorization: 'Bearer secret' }),
      }));
    }
  });
});
