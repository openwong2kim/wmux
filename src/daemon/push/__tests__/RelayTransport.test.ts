import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayTransport } from '../RelayTransport';

describe('RelayTransport URL safety', () => {
  afterEach(() => vi.unstubAllEnvs());
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

  it('warns once about unsafe configuration without exposing the URL or secret', async () => {
    const log = vi.fn();
    const transport = new RelayTransport({ relayUrl: 'http://relay.example/private?token=hidden', relaySecret: 'sensitive-secret', log });
    await transport.post('/push', {});
    await transport.post('/push', {});
    expect(log).toHaveBeenCalledExactlyOnceWith('warn', '[push] relay disabled: URL must use HTTPS or HTTP loopback');
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/relay\.example|hidden|sensitive-secret/);
  });

  it('does not fetch or retry without a secret or with the push kill switch', async () => {
    for (const disabled of ['no-secret', 'kill-switch']) {
      vi.stubEnv('WMUX_PUSH', disabled === 'kill-switch' ? '0' : '1');
      const fetchImpl = vi.fn();
      const sleep = vi.fn();
      const log = vi.fn();
      const transport = new RelayTransport({ relayUrl: 'https://relay.example', relaySecret: disabled === 'no-secret' ? undefined : 'secret', fetchImpl, sleep, log });
      expect(transport.enabled).toBe(false);
      expect(await transport.post('/push', {})).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
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
