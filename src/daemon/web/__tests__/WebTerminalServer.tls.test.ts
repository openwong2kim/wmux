import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import { WebTerminalServer } from '../WebTerminalServer';
import { createTlsTestFixture, findOpenSsl } from './tlsTestFixture';

const HAVE_OPENSSL = findOpenSsl() !== undefined;

if (!HAVE_OPENSSL) {
  // eslint-disable-next-line no-console
  console.warn('[native TLS test] SKIPPED handshake test — OpenSSL is unavailable');
}

function makeServer(): WebTerminalServer {
  const sessionManager = Object.assign(new EventEmitter(), {
    getSession: () => undefined,
    listLiveSessions: () => [],
  }) as unknown as DaemonSessionManager;
  return new WebTerminalServer({
    sessionManager,
    assetsDir: os.tmpdir(),
    log: () => {
      /* silent in tests */
    },
  });
}

function getConfig(
  port: number,
  token: string,
  secure: boolean,
  hostHeader?: string,
): Promise<{ status?: number; error?: string }> {
  return new Promise((resolve) => {
    const options = {
      host: '127.0.0.1',
      port,
      path: '/api/config',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(hostHeader ? { Host: hostHeader } : {}),
      },
    };
    const onResponse = (res: http.IncomingMessage): void => {
      res.resume();
      resolve({ status: res.statusCode });
    };
    const req = secure
      ? https.request({ ...options, rejectUnauthorized: false }, onResponse)
      : http.request(options, onResponse);
    req.on('error', (error: NodeJS.ErrnoException) => {
      resolve({ error: error.code ?? error.message });
    });
    req.end();
  });
}

const servers: WebTerminalServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.stop();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('WebTerminalServer native TLS (#764)', () => {
  it.skipIf(!HAVE_OPENSSL)(
    'terminates HTTPS, advertises only https URLs, and permits secure pairing',
    async () => {
      const fixture = createTlsTestFixture();
      tempDirs.push(fixture.dir);
      const server = makeServer();
      servers.push(server);

      const info = await server.start({
        port: 0,
        host: '0.0.0.0',
        allowInput: false,
        allowUpload: false,
        allowedHosts: ['box.example.test'],
        tls: { certPath: fixture.certPath, keyPath: fixture.keyPath },
      });

      expect(info.tls).toBe(true);
      expect(info.pairCode).toMatch(/^[A-Z0-9]+$/);
      expect(info.pairRefusal).toBeUndefined();
      expect(info.urls?.length).toBeGreaterThan(0);
      expect(info.urls?.every((url) => url.startsWith('https://'))).toBe(true);
      expect(info.urls?.[0]).toBe(
        `https://box.example.test:${info.port}/?token=${info.token}`,
      );
      expect(
        await getConfig(info.port as number, info.token as string, true, 'box.example.test'),
      ).toEqual({ status: 200 });
    },
  );

  it('rejects bad TLS material before interrupting an existing HTTP listener', async () => {
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-web-bad-tls-'));
    tempDirs.push(badDir);
    const certPath = path.join(badDir, 'cert.pem');
    const keyPath = path.join(badDir, 'key.pem');
    fs.writeFileSync(certPath, 'not a certificate', 'utf8');
    fs.writeFileSync(keyPath, 'not a private key', 'utf8');

    const server = makeServer();
    servers.push(server);
    const before = await server.start({
      port: 0,
      host: '127.0.0.1',
      allowInput: false,
      allowUpload: false,
    });

    await expect(
      server.start({
        port: 0,
        host: '127.0.0.1',
        allowInput: false,
        allowUpload: false,
        tls: { certPath, keyPath },
      }),
    ).rejects.toThrow('TLS certificate/key could not be loaded');

    const after = server.status();
    expect(after.running).toBe(true);
    expect(after.tls).toBe(false);
    expect(after.port).toBe(before.port);
    expect(after.token).toBe(before.token);
    expect(await getConfig(before.port as number, before.token as string, false)).toEqual({
      status: 200,
    });
  });

  it.skipIf(!HAVE_OPENSSL)('rejects a certificate and private key that do not match', async () => {
    const certificate = createTlsTestFixture();
    const otherKey = createTlsTestFixture();
    tempDirs.push(certificate.dir, otherKey.dir);
    const server = makeServer();
    servers.push(server);

    await expect(
      server.start({
        port: 0,
        host: '0.0.0.0',
        allowInput: false,
        allowUpload: false,
        tls: { certPath: certificate.certPath, keyPath: otherKey.keyPath },
      }),
    ).rejects.toThrow('TLS certificate/key could not be loaded');
    expect(server.isRunning).toBe(false);
  });

  it('requires absolute paths and rejects native TLS combined with Tailscale', async () => {
    const server = makeServer();
    servers.push(server);
    const options = {
      port: 0,
      host: '127.0.0.1',
      allowInput: false,
      allowUpload: false,
      tls: { certPath: 'cert.pem', keyPath: 'key.pem' },
    };

    await expect(server.start(options)).rejects.toThrow(
      'TLS certificate path must be absolute',
    );
    await expect(server.start({ ...options, tailscale: true })).rejects.toThrow(
      'native TLS cannot be combined with the Tailscale transport',
    );
    expect(server.isRunning).toBe(false);
  });
});
