import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_CERT_RENEW_BEFORE_DAYS,
  HOST_CERT_VALID_DAYS,
  ISSUE_LOCK_STALE_MS,
  breakStaleIssueLock,
  isLockInTransition,
  loadOrCreateHostIdentity,
  readIssueLockState,
} from '../hostIdentity';
import { isHostId } from '../../../shared/a2aRemote';

const T0 = new Date('2026-10-07T00:00:00Z');
const DAY_MS = 86_400_000;
const NEAR_EXPIRY = new Date(T0.getTime() + (HOST_CERT_VALID_DAYS - HOST_CERT_RENEW_BEFORE_DAYS + 1) * DAY_MS);

let root: string;
let dir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hostid-'));
  dir = path.join(root, 'a2a');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const load = (over: Partial<Parameters<typeof loadOrCreateHostIdentity>[0]> = {}) =>
  loadOrCreateHostIdentity({ dir, hostname: 'DevBox', ipAddresses: ['10.0.0.5'], now: T0, ...over });

const hostJson = () => path.join(dir, 'host.json');
const pointer = () => path.join(dir, 'cert.json');
const genFiles = () => fs.readdirSync(dir).filter((n) => /^(cert|key)-.+\.pem$/.test(n)).sort();
const x509 = (certPath: string) => new crypto.X509Certificate(fs.readFileSync(certPath));

describe('loadOrCreateHostIdentity', () => {
  it('fails closed on a corrupt host.json: throws, leaves the file in place, mints nothing', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(hostJson(), '{"v":1,"hostId":');
    expect(() => load()).toThrow(/corrupt/);
    expect(fs.readFileSync(hostJson(), 'utf8')).toBe('{"v":1,"hostId":');
    expect(genFiles()).toEqual([]);

    // Well-formed JSON with the wrong shape is just as corrupt.
    for (const bad of ['{"v":2,"hostId":"8f14e45f-ceea-4e67-a0e8-7a3b1a3b2c4d"}', '{"v":1,"hostId":"not-a-uuid"}', 'null']) {
      fs.writeFileSync(hostJson(), bad);
      expect(() => load()).toThrow(/corrupt/);
      expect(fs.readFileSync(hostJson(), 'utf8')).toBe(bad);
    }
  });

  it('refuses to mint a hostId when host.json is gone but a certificate remains', () => {
    const a = load();
    const before = genFiles();
    fs.unlinkSync(hostJson());
    expect(() => load()).toThrow(/missing/);
    expect(fs.existsSync(hostJson())).toBe(false);
    expect(genFiles()).toEqual(before);
    expect(fs.readFileSync(a.certPath, 'utf8')).toContain('BEGIN CERTIFICATE');
  });

  it('creates host.json, the pointer and one certificate generation on first run', () => {
    const id = load();
    expect(id.created).toBe(true);
    expect(isHostId(id.hostId)).toBe(true);
    expect(JSON.parse(fs.readFileSync(hostJson(), 'utf8'))).toEqual({ v: 1, hostId: id.hostId, createdAt: T0.toISOString() });

    const gen = JSON.parse(fs.readFileSync(pointer(), 'utf8')).gen as string;
    expect(path.basename(id.certPath)).toBe(`cert-${gen}.pem`);
    expect(path.basename(id.keyPath)).toBe(`key-${gen}.pem`);
    expect(genFiles()).toEqual([`cert-${gen}.pem`, `key-${gen}.pem`]);

    const x = x509(id.certPath);
    expect(x.fingerprint256).toBe(id.fingerprint256);
    expect(x.subject).toBe('CN=DevBox');
    expect(x.subjectAltName).toBe('DNS:devbox, IP Address:10.0.0.5');
    expect(x.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(id.keyPath)))).toBe(true);
    expect(id.notAfter).toBe(new Date(T0.getTime() + HOST_CERT_VALID_DAYS * DAY_MS).toISOString());
    expect(fs.existsSync(path.join(dir, 'issue.lock'))).toBe(false);
  });

  it('reuses everything on the next call', () => {
    const a = load();
    expect(load({ now: new Date(T0.getTime() + 100 * DAY_MS) })).toEqual({ ...a, created: false });
  });

  it('keeps the certificate (and so every pin) when the hostname or IPs change', () => {
    const a = load();
    const b = load({ hostname: 'renamed-box', ipAddresses: ['192.168.77.3', '172.17.0.1'] });
    expect(b).toEqual({ ...a, created: false });
    expect(load({ hostname: 'x', ipAddresses: [] })).toEqual({ ...a, created: false });
  });

  it('re-issues near expiry, keeps the hostId and removes the old generation', () => {
    const a = load();
    expect(load({ now: new Date(NEAR_EXPIRY.getTime() - 2 * DAY_MS) }).created).toBe(false);

    const b = load({ now: NEAR_EXPIRY, hostname: 'newbox', ipAddresses: ['10.9.9.9'] });
    expect(b.created).toBe(true);
    expect(b.hostId).toBe(a.hostId);
    expect(b.fingerprint256).not.toBe(a.fingerprint256);
    expect(x509(b.certPath).subjectAltName).toBe('DNS:newbox, IP Address:10.9.9.9');
    expect(genFiles()).toEqual([path.basename(b.certPath), path.basename(b.keyPath)].sort());
    expect(JSON.parse(fs.readFileSync(hostJson(), 'utf8')).createdAt).toBe(T0.toISOString());
  });

  it('re-issues when the active pair is missing, corrupt, mismatched or badly signed', () => {
    const a = load();
    fs.writeFileSync(a.certPath, 'garbage');
    const b = load();
    expect(b.created).toBe(true);
    expect(b.hostId).toBe(a.hostId);

    fs.unlinkSync(b.keyPath);
    const c = load();
    expect(c.created).toBe(true);

    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    fs.writeFileSync(c.keyPath, other.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const d = load();
    expect(d.created).toBe(true);

    // Tamper with the signature: key still matches, self-signature no longer verifies.
    const raw = Buffer.from(x509(d.certPath).raw);
    raw[raw.length - 1] ^= 0x01;
    const lines = raw.toString('base64').match(/.{1,64}/g) ?? [];
    fs.writeFileSync(d.certPath, `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`);
    const e = load();
    expect(e.created).toBe(true);
    expect(e.hostId).toBe(a.hostId);

    fs.writeFileSync(pointer(), '{"v":1,"gen":"../../etc"}');
    expect(load().created).toBe(true);
    expect(load().created).toBe(false);
  });

  it('leaves the previous pair active when writing the new certificate fails', () => {
    const a = load();
    const pointerBefore = fs.readFileSync(pointer(), 'utf8');
    const realOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (/^cert-.+\.pem$/.test(path.basename(String(p)))) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return (realOpen as (...args: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);

    expect(() => load({ now: NEAR_EXPIRY })).toThrow(/disk full/);
    vi.restoreAllMocks();

    expect(fs.readFileSync(pointer(), 'utf8')).toBe(pointerBefore);
    expect(genFiles()).toEqual([path.basename(a.certPath), path.basename(a.keyPath)].sort());
    expect(load()).toEqual({ ...a, created: false });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'throws instead of re-issuing when the key is unreadable for a non-ENOENT reason',
    () => {
      const a = load();
      fs.chmodSync(a.keyPath, 0o000);
      try {
        expect(() => load()).toThrow(/EACCES/);
        expect(genFiles()).toEqual([path.basename(a.certPath), path.basename(a.keyPath)].sort());
      } finally {
        fs.chmodSync(a.keyPath, 0o600);
      }
      expect(load()).toEqual({ ...a, created: false });
    },
  );

  it.skipIf(process.platform === 'win32')('keeps the private key owner-only (0600), repairing it on reuse', () => {
    const id = load();
    expect(fs.statSync(id.keyPath).mode & 0o777).toBe(0o600);
    fs.chmodSync(id.keyPath, 0o644);
    expect(load().created).toBe(false);
    expect(fs.statSync(id.keyPath).mode & 0o777).toBe(0o600);
  });

  it('omits an invalid SAN hostname and cuts a long CN by code point', () => {
    const id = load({ hostname: '개발_PC', ipAddresses: ['010.0.0.5', 'fe80::1', '10.0.0.5', '10.0.0.5'] });
    const x = x509(id.certPath);
    expect(x.subject).toBe('CN=개발_PC');
    expect(x.subjectAltName).toBe('IP Address:10.0.0.5');

    fs.rmSync(root, { recursive: true, force: true });
    const long = load({ hostname: '😀'.repeat(70) });
    expect(x509(long.certPath).subject).toBe(`CN=${'😀'.repeat(64)}`);
  });

  const lockState = (lock: string) => {
    const st = readIssueLockState(lock);
    if (!st) throw new Error(`no lock at ${lock}`);
    return st;
  };

  const ageLock = (lock: string) => {
    const old = new Date(Date.now() - ISSUE_LOCK_STALE_MS - 5_000);
    fs.utimesSync(lock, old, old);
  };

  it('takes over a stale issue lock left by a crashed process', () => {
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, 'issue.lock');
    fs.writeFileSync(lock, '99999\n');
    ageLock(lock);
    expect(load().created).toBe(true);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('issue.lock'))).toEqual([]);
  });

  it('lets only one of the waiters that saw the same stale lock break it', () => {
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, 'issue.lock');
    fs.writeFileSync(lock, '');
    ageLock(lock);
    const seenByA = lockState(lock);
    const seenByB = lockState(lock);
    expect(seenByA).toEqual(seenByB);

    // B is mid-takeover (holds the marker) when A tries: A must back off.
    fs.writeFileSync(`${lock}.takeover-${seenByB.key}`, '');
    expect(breakStaleIssueLock(lock, seenByA.key)).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
    fs.unlinkSync(`${lock}.takeover-${seenByB.key}`);

    expect(breakStaleIssueLock(lock, seenByB.key)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('never removes a fresh lock that replaced the stale one a late waiter saw', () => {
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, 'issue.lock');
    fs.writeFileSync(lock, '');
    ageLock(lock);
    const seen = lockState(lock);

    // Another waiter broke it and a new holder took the lock...
    expect(breakStaleIssueLock(lock, seen.key)).toBe(true);
    fs.writeFileSync(lock, '4242-0123456789abcdef', { flag: 'wx' });
    // ...so the late waiter's takeover of what it saw must be a no-op.
    expect(breakStaleIssueLock(lock, seen.key)).toBe(false);
    expect(fs.readFileSync(lock, 'utf8')).toBe('4242-0123456789abcdef');

    // Same content as the stale one but fresh (a holder mid-write): untouched too.
    fs.writeFileSync(lock, '');
    expect(breakStaleIssueLock(lock, seen.key)).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('cleans up against the pointer as re-read after the switch, not the generation it wrote', () => {
    const a = load();
    const pointerA = fs.readFileSync(pointer(), 'utf8');
    // Simulate another issuer flipping the pointer back right after ours.
    let flipped = false;
    const realRename = fs.renameSync;
    const realRead = fs.readFileSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      realRename(from, to);
      if (String(to) === pointer()) flipped = true;
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) =>
      flipped && String(p) === pointer()
        ? Buffer.from(pointerA)
        : (realRead as (...args: unknown[]) => string | Buffer)(p, ...rest)) as typeof fs.readFileSync);

    load({ now: NEAR_EXPIRY });
    vi.restoreAllMocks();
    expect(fs.existsSync(a.certPath)).toBe(true);
    expect(fs.existsSync(a.keyPath)).toBe(true);
  });

  it.each(['a clean directory', 'a stale lock from a crashed issuer'])(
    'agrees on one hostId and one certificate when several processes start at once (%s)',
    async (start) => {
      if (start !== 'a clean directory') {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'issue.lock'), '');
        ageLock(path.join(dir, 'issue.lock'));
      }
      const bundle = path.join(root, 'hostIdentity.cjs');
      buildSync({
        entryPoints: [path.join(__dirname, '..', 'hostIdentity.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: bundle,
        logLevel: 'silent',
      });
      const script =
        `const m = require(${JSON.stringify(bundle)});` +
        `const r = m.loadOrCreateHostIdentity({ dir: process.argv[1], hostname: 'devbox', ipAddresses: ['10.0.0.5'] });` +
        `process.stdout.write('\\nRESULT ' + JSON.stringify(r) + '\\n');`;
      const run = () =>
        new Promise<{ hostId: string; fingerprint256: string; created: boolean; certPath: string }>((resolve, reject) => {
          const child = spawn(process.execPath, ['-e', script, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          let errOut = '';
          child.stdout.on('data', (d) => (out += d));
          child.stderr.on('data', (d) => (errOut += d));
          child.on('error', reject);
          child.on('close', (code) => {
            const line = out.split('\n').find((l) => l.startsWith('RESULT '));
            if (code !== 0 || !line) reject(new Error(`child exited ${code}: ${errOut}`));
            else resolve(JSON.parse(line.slice(7)));
          });
        });

      const results = await Promise.all(Array.from({ length: 6 }, run));
      expect(new Set(results.map((r) => r.hostId)).size).toBe(1);
      expect(new Set(results.map((r) => r.fingerprint256)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(genFiles()).toHaveLength(2);
      expect(fs.existsSync(results[0].certPath)).toBe(true);
      expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp') || n.startsWith('issue.lock'))).toEqual([]);
      expect(JSON.parse(fs.readFileSync(hostJson(), 'utf8')).hostId).toBe(results[0].hostId);
    },
    30_000,
  );
});

describe('isLockInTransition', () => {
  const err = (code: string) => Object.assign(new Error(code), { code });

  it('reads a Windows delete-pending lock (EPERM/EACCES/EBUSY) as changing hands, not a fault', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) expect(isLockInTransition(err(code), 'win32')).toBe(true);
  });

  it('leaves every other error, and every POSIX error, to propagate', () => {
    for (const code of ['ENOENT', 'EEXIST', 'EIO', 'ENOSPC']) expect(isLockInTransition(err(code), 'win32')).toBe(false);
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      expect(isLockInTransition(err(code), 'linux')).toBe(false);
      expect(isLockInTransition(err(code), 'darwin')).toBe(false);
    }
  });
});
