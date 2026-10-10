import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { ProtectedProxy, parseAuthority } from '../ProtectedProxy';
import { compileHostPolicy } from '../../../shared/browserHostPolicy';

// The filtering proxy against a real loopback origin. Hostnames a.test and
// blocked.test resolve to that origin only through the proxy's resolve seam.

let origin: http.Server;
let originPort = 0;
const hits: string[] = [];
let allow = ['a.test'];
let proxy: ProtectedProxy;
let proxyPort = 0;

beforeEach(async () => {
  hits.length = 0;
  allow = ['a.test'];
  origin = http.createServer((req, res) => {
    hits.push(`${req.headers.host} ${req.url}`);
    res.end('ok');
  });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  originPort = (origin.address() as net.AddressInfo).port;
  proxy = new ProtectedProxy({
    matcher: () => compileHostPolicy({ mode: 'allowlist', allow, block: [] }),
    resolve: (_host, port) => ({ host: '127.0.0.1', port: port === 1 ? originPort : port }),
  });
  proxyPort = await proxy.start();
});
afterEach(() => {
  proxy.close();
  origin.close();
});

function viaProxy(absoluteUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: absoluteUrl, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

function connect(authority: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    s.once('data', (d) => {
      resolve(d.toString().split('\r\n')[0]);
      s.destroy();
    });
    s.on('error', () => resolve('error'));
  });
}

describe('ProtectedProxy', () => {
  it('forwards an allowed plain-HTTP request and refuses a blocked one without contacting it', async () => {
    expect(await viaProxy(`http://a.test:${originPort}/x`)).toBe(200);
    expect(await viaProxy(`http://blocked.test:${originPort}/y`)).toBe(403);
    expect(hits).toEqual([`a.test:${originPort} /x`]);
  });

  it('decides CONNECT tunnels on the host, and applies a policy edit on the next request', async () => {
    expect(await connect('a.test:1')).toContain('200');
    expect(await connect('blocked.test:1')).toContain('403');
    allow = [];
    expect(await connect('a.test:1')).toContain('403');
  });

  it('refuses origin-form requests, malformed authorities and its own address', async () => {
    expect(await viaProxy('/not-absolute')).toBe(400);
    expect(await connect('no-port')).toContain('403');
    allow = ['127.0.0.1'];
    expect(await connect(`127.0.0.1:${proxyPort}`)).toContain('403');
  });

  it('is fail-closed when stopped', async () => {
    proxy.close();
    await expect(viaProxy(`http://a.test:${originPort}/`)).rejects.toBeTruthy();
  });
});

describe('parseAuthority', () => {
  it('reads host:port and bracketed IPv6, and nothing else', () => {
    expect(parseAuthority('a.test:443')).toEqual({ host: 'a.test', port: 443 });
    expect(parseAuthority('[::1]:8080')).toEqual({ host: '[::1]', port: 8080 });
    expect(parseAuthority('a.test')).toBeNull();
    expect(parseAuthority('u@a.test:443')).toBeNull();
    expect(parseAuthority('a.test:99999')).toBeNull();
  });
});
