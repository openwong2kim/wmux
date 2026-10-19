import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { generateSelfSignedCert } from '../selfSignedCert';
import { normalizeFingerprint256 } from '../../../shared/a2aRemote';

const NOW = new Date('2026-10-07T12:34:56.789Z');

const OPENSSL_TIMEOUT_MS = 20_000;

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore', timeout: OPENSSL_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function make(overrides: Partial<Parameters<typeof generateSelfSignedCert>[0]> = {}) {
  return generateSelfSignedCert({
    commonName: 'devbox',
    dnsNames: ['devbox', 'devbox.corp.example'],
    ipAddresses: ['10.1.2.3', '192.168.0.42'],
    validDays: 825,
    now: NOW,
    ...overrides,
  });
}

describe('generateSelfSignedCert', () => {
  it('produces a certificate Node parses, with the requested names, validity and fingerprint', () => {
    const c = make();
    const x = new crypto.X509Certificate(c.certPem);

    expect(x.subject).toBe('CN=devbox');
    expect(x.issuer).toBe('CN=devbox');
    expect(x.subjectAltName).toBe(
      'DNS:devbox, DNS:devbox.corp.example, IP Address:10.1.2.3, IP Address:192.168.0.42',
    );
    expect(new Date(x.validFrom).toISOString()).toBe('2026-10-06T12:34:56.000Z');
    expect(new Date(x.validTo).toISOString()).toBe(c.notAfter);
    expect(c.notAfter).toBe(new Date(Math.floor(NOW.getTime() / 1000) * 1000 + 825 * 86_400_000).toISOString());
    expect(x.fingerprint256).toBe(c.fingerprint256);
    expect(normalizeFingerprint256(c.fingerprint256)).toBe(c.fingerprint256);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.checkPrivateKey(crypto.createPrivateKey(c.keyPem))).toBe(true);
    expect(x.ca).toBe(false);
    expect(x.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    // 16-byte positive serial: 32 hex digits, high bit clear.
    expect(x.serialNumber).toMatch(/^[0-7][0-9A-F]{31}$/);
  });

  it('mints a fresh key, serial and fingerprint every call', () => {
    const a = make();
    const b = make();
    expect(a.fingerprint256).not.toBe(b.fingerprint256);
    expect(a.keyPem).not.toBe(b.keyPem);
  });

  it('serves a TLS handshake whose peer certificate matches the fingerprint', async () => {
    const c = make({ dnsNames: ['localhost'], ipAddresses: ['127.0.0.1'] });
    const server = tls.createServer({ cert: c.certPem, key: c.keyPem }, (sock) => sock.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const peerFp = await new Promise<string>((resolve, reject) => {
        const sock = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
          const fp = sock.getPeerX509Certificate()?.fingerprint256 ?? '';
          sock.end();
          resolve(fp);
        });
        sock.on('error', reject);
      });
      expect(peerFp).toBe(c.fingerprint256);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('accepts a 64-character CN and rejects 65 or empty', () => {
    const cn = 'h'.repeat(64);
    const x = new crypto.X509Certificate(make({ commonName: cn }).certPem);
    expect(x.subject).toBe(`CN=${cn}`);
    expect(() => make({ commonName: 'h'.repeat(65) })).toThrow(RangeError);
    expect(() => make({ commonName: '' })).toThrow(RangeError);
  });

  it('counts the CN limit in characters, not UTF-16 units', () => {
    const astral = '😀'.repeat(64); // 128 UTF-16 units
    expect(new crypto.X509Certificate(make({ commonName: astral }).certPem).verify).toBeTypeOf('function');
    expect(() => make({ commonName: '😀'.repeat(65) })).toThrow(RangeError);
  });

  it('encodes a non-ASCII CN as UTF8String', () => {
    const x = new crypto.X509Certificate(make({ commonName: '개발-PC' }).certPem);
    expect(x.subject).toBe('CN=개발-PC');
  });

  it('handles zero IPs, and omits SAN entirely when there are no names at all', () => {
    expect(new crypto.X509Certificate(make({ ipAddresses: [] }).certPem).subjectAltName).toBe(
      'DNS:devbox, DNS:devbox.corp.example',
    );
    const bare = new crypto.X509Certificate(make({ dnsNames: [], ipAddresses: [] }).certPem);
    expect(bare.subjectAltName).toBeUndefined();
    expect(bare.verify(bare.publicKey)).toBe(true);
  });

  it('rejects non-IPv4 addresses and non-ASCII DNS names', () => {
    expect(() => make({ ipAddresses: ['::1'] })).toThrow(RangeError);
    expect(() => make({ ipAddresses: ['10.0.0'] })).toThrow(RangeError);
    expect(() => make({ ipAddresses: ['010.001.002.003'] })).toThrow(RangeError);
    expect(() => make({ dnsNames: ['개발'] })).toThrow(RangeError);
    expect(() => make({ dnsNames: ['bad host'] })).toThrow(RangeError);
    expect(() => make({ validDays: 0 })).toThrow(RangeError);
  });

  it('switches notAfter from UTCTime (2049) to GeneralizedTime (2050+)', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const daysTo = (iso: string) => Math.round((Date.parse(iso) - now.getTime()) / 86_400_000);

    const c2049 = make({ now, validDays: daysTo('2049-12-31T00:00:00Z') });
    expect(c2049.notAfter).toBe('2049-12-31T00:00:00.000Z');
    expect(new Date(new crypto.X509Certificate(c2049.certPem).validTo).toISOString()).toBe(c2049.notAfter);

    const c2050 = make({ now, validDays: daysTo('2050-01-01T00:00:00Z') });
    expect(new Date(new crypto.X509Certificate(c2050.certPem).validTo).toISOString()).toBe('2050-01-01T00:00:00.000Z');

    const c2051 = make({ now, validDays: daysTo('2051-06-15T00:00:00Z') });
    const x = new crypto.X509Certificate(c2051.certPem);
    expect(new Date(x.validTo).toISOString()).toBe(c2051.notAfter);
    expect(x.verify(x.publicKey)).toBe(true);
    // Raw DER check: GeneralizedTime (tag 0x18) with a 4-digit year is present.
    const der = x.raw;
    expect(der.includes(Buffer.from([0x18, 0x0f, ...Buffer.from('20510615000000Z')]))).toBe(true);
    expect(c2049.certPem).not.toBe(c2051.certPem);
    const der2049 = new crypto.X509Certificate(c2049.certPem).raw;
    expect(der2049.includes(Buffer.from([0x17, 0x0d, ...Buffer.from('491231000000Z')]))).toBe(true);
  });

  // Skipped on win32: the only openssl on the Windows runners is the one bundled
  // with Git, which ran past the 10s test timeout there. The DER is
  // platform-independent and the macOS/Linux runners cover this cross-check;
  // Node's own X509Certificate/TLS checks above run everywhere.
  it.skipIf(process.platform === 'win32' || !hasOpenssl())('is accepted by `openssl x509 -text`', () => {
    const c = make();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cert-'));
    const file = path.join(dir, 'cert.pem');
    fs.writeFileSync(file, c.certPem);
    try {
      const text = execFileSync('openssl', ['x509', '-noout', '-text', '-in', file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: OPENSSL_TIMEOUT_MS,
      });
      expect(text).toMatch(/Version: 3 \(0x2\)/);
      expect(text).toMatch(/Signature Algorithm: ecdsa-with-SHA256/);
      expect(text).toMatch(/CA:FALSE/);
      expect(text).toMatch(/Digital Signature/);
      expect(text).toMatch(/TLS Web Server Authentication/);
      expect(text).toMatch(/DNS:devbox, DNS:devbox\.corp\.example, IP Address:10\.1\.2\.3, IP Address:192\.168\.0\.42/);
      expect(text).toMatch(/Subject Key Identifier/);
    } finally {
      fs.unlinkSync(file);
      fs.rmdirSync(dir);
    }
  }, 30_000);
});
