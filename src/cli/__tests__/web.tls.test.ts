import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const { sendDaemonStringRequestMock } = vi.hoisted(() => ({
  sendDaemonStringRequestMock: vi.fn(),
}));

vi.mock('../client', () => ({
  sendDaemonStringRequest: sendDaemonStringRequestMock,
}));

import { handleWeb, resolveWebTlsConfig } from '../commands/web';

let lines: string[];

beforeEach(() => {
  lines = [];
  sendDaemonStringRequestMock.mockReset();
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wmux web native TLS flags (#764)', () => {
  it('treats the certificate and key as one atomic option', () => {
    expect(() => resolveWebTlsConfig(['--tls-cert', 'certificate.pem'])).toThrow(
      '--tls-cert and --tls-key must be provided together',
    );
    expect(() => resolveWebTlsConfig(['--tls-key', 'private-key.pem'])).toThrow(
      '--tls-cert and --tls-key must be provided together',
    );
    expect(() =>
      resolveWebTlsConfig([
        '--tls-cert',
        'certificate.pem',
        '--tls-key',
        'private-key.pem',
        '--tailscale',
      ]),
    ).toThrow('native TLS cannot be combined with --tailscale');
  });

  it('resolves relative paths in the CLI working directory', () => {
    const cwd = path.join(path.parse(process.cwd()).root, 'operator', 'wmux');
    expect(
      resolveWebTlsConfig(
        ['--tls-cert', 'certs/full-chain.pem', '--tls-key', 'certs/private-key.pem'],
        cwd,
      ),
    ).toEqual({
      certPath: path.resolve(cwd, 'certs/full-chain.pem'),
      keyPath: path.resolve(cwd, 'certs/private-key.pem'),
    });
  });

  it('sends only absolute TLS paths and reports the HTTPS pairing origin', async () => {
    sendDaemonStringRequestMock.mockResolvedValue({
      id: 'tls-start',
      ok: true,
      result: {
        running: true,
        port: 8443,
        host: '0.0.0.0',
        allowInput: false,
        allowUpload: false,
        tls: true,
        token: 'token-for-test',
        urls: [
          'https://box.example.test:8443/?token=token-for-test',
          'https://127.0.0.1:8443/?token=token-for-test',
        ],
        pairCode: 'ABCD2345',
        allowedHosts: ['box.example.test'],
      },
    });

    await handleWeb(
      [
        '--port',
        '8443',
        '--expose',
        '--tls-cert',
        'certs/full-chain.pem',
        '--tls-key',
        'certs/private-key.pem',
        '--allow-host',
        'box.example.test',
      ],
      false,
    );

    expect(sendDaemonStringRequestMock).toHaveBeenCalledWith('daemon.web.start', {
      port: 8443,
      host: '0.0.0.0',
      allowInput: false,
      allowUpload: false,
      allowTranscript: false,
      allowedHosts: ['box.example.test'],
      newToken: false,
      tls: {
        certPath: path.resolve('certs/full-chain.pem'),
        keyPath: path.resolve('certs/private-key.pem'),
      },
      tailscale: false,
    });
    const output = lines.join('\n');
    expect(output).toContain('Native TLS enabled');
    expect(output).toContain('--allow-host <certificate-dns-name>');
    expect(output).toContain('IP URLs require matching IP SANs');
    expect(output).not.toContain('UNENCRYPTED');
    expect(output).toContain('https://box.example.test:8443/pair');
  });

  it('sends an explicit TLS-off value when the operator chooses plain HTTP', async () => {
    sendDaemonStringRequestMock.mockResolvedValue({
      id: 'http-start',
      ok: true,
      result: {
        running: true,
        port: 7681,
        host: '127.0.0.1',
        tls: false,
        token: 'token-for-test',
        urls: ['http://127.0.0.1:7681/?token=token-for-test'],
      },
    });

    await handleWeb([], true);

    expect(sendDaemonStringRequestMock).toHaveBeenCalledWith(
      'daemon.web.start',
      expect.objectContaining({ tls: false }),
    );
  });
});
