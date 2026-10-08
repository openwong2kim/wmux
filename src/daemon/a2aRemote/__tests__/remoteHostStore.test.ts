import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteJSONSync } from '../../util/atomicWrite';
import {
  ADDRESSES_MAX,
  REMOTE_HOSTS_FILE,
  RemoteHostStore,
  addressPromoter,
  orderAddresses,
  type NewRemoteHost,
  type RemoteHostStoreOptions,
} from '../remoteHostStore';

const HOST = '11111111-1111-4111-8111-111111111111';
const HOST2 = '22222222-2222-4222-8222-222222222222';
const PEER = '33333333-3333-4333-8333-333333333333';
const PEER2 = '44444444-4444-4444-8444-444444444444';
const SECRET = 'A'.repeat(43);
const SECRET2 = 'b'.repeat(43);
const FP = Array.from({ length: 32 }, () => 'AB').join(':');
const FP2 = Array.from({ length: 32 }, () => 'cd').join('');

let dir: string;
let fail = false;
const clock = 1_700_000_000_000;
const flakyWrite = (p: string, d: unknown): void => {
  if (fail) throw new Error('disk full');
  atomicWriteJSONSync(p, d);
};
const make = (o: Partial<RemoteHostStoreOptions> = {}): RemoteHostStore =>
  new RemoteHostStore({ dir, now: () => clock, write: flakyWrite, reHarden: () => 'hardened', win32: false, ...o });

const host = (o: Partial<NewRemoteHost> = {}): NewRemoteHost => ({
  hostId: HOST,
  name: 'DESK-PC',
  addresses: ['10.0.0.5', 'DESK-PC'],
  port: 7443,
  fingerprint256: FP,
  peerId: PEER,
  ...o,
});

beforeEach(() => {
  fail = false;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-rhosts-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('orderAddresses', () => {
  it('keeps the given (dial) order and dedupes case-insensitively', () => {
    // No names-first regrouping: an IP promoted ahead of a name must stay
    // ahead, or a name that resolves to an unreachable LAN address would be
    // waited out on every reconnect.
    expect(orderAddresses(['10.0.0.5', 'desk-pc', ' DESK-PC ', '10.0.0.5', '', '10.0.0.9', 'desk.corp'])).toEqual([
      '10.0.0.5',
      'desk-pc',
      '10.0.0.9',
      'desk.corp',
    ]);
  });
});

describe('RemoteHostStore', () => {
  it('add stores the record (addresses in dial order) and the credential separately', () => {
    const s = make();
    const rec = s.add(host(), { peerId: PEER, secret: SECRET });
    expect(rec).toMatchObject({ v: 1, hostId: HOST, addresses: ['10.0.0.5', 'DESK-PC'], createdAt: new Date(clock).toISOString() });
    expect(s.credentialFor(HOST)).toEqual({ peerId: PEER, secret: SECRET });
    expect(s.credentialFor(HOST2)).toBeNull();
  });

  it('list and get never carry the secret', () => {
    const s = make();
    s.add(host(), { peerId: PEER, secret: SECRET });
    expect(JSON.stringify(s.list())).not.toContain(SECRET);
    expect(JSON.stringify(s.get(HOST))).not.toContain(SECRET);
  });

  it('round-trips through a new instance', () => {
    const s = make();
    s.add(host(), { peerId: PEER, secret: SECRET });
    s.add(host({ hostId: HOST2, peerId: PEER2, name: 'LAB' }), { peerId: PEER2, secret: SECRET2 });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, REMOTE_HOSTS_FILE), 'utf-8'));
    expect(raw.v).toBe(1);
    const t = make();
    expect(t.list()).toEqual(s.list());
    expect(t.credentialFor(HOST2)).toEqual({ peerId: PEER2, secret: SECRET2 });
  });

  it('refuses a credential whose peerId does not match, or a malformed secret', () => {
    const s = make();
    expect(() => s.add(host(), { peerId: PEER2, secret: SECRET })).toThrow(/credential/);
    expect(() => s.add(host(), { peerId: PEER, secret: 'short' })).toThrow(/credential/);
    expect(() => s.add(host({ fingerprint256: 'nope' }), { peerId: PEER, secret: SECRET })).toThrow(/fingerprint/);
    expect(s.list()).toEqual([]);
  });

  it('updateAddresses reorders and dedupes; updateFingerprint keeps the hostId', () => {
    const s = make();
    s.add(host(), { peerId: PEER, secret: SECRET });
    expect(s.updateAddresses(HOST, ['10.0.0.7', 'desk-pc', 'DESK-PC']).addresses).toEqual(['10.0.0.7', 'desk-pc']);
    const updated = s.updateFingerprint(HOST, FP2);
    expect(updated.hostId).toBe(HOST);
    expect(updated.fingerprint256).toBe(FP2.toUpperCase().match(/.{2}/g)?.join(':'));
    expect(make().get(HOST)?.fingerprint256).toBe(updated.fingerprint256);
    expect(() => s.updateFingerprint(HOST, 'bad')).toThrow();
    expect(() => s.updateAddresses(HOST2, ['x'])).toThrow(/unknown/);
  });

  it('promoteAddress moves the address that answered to the front, and the order survives a reload', () => {
    const s = make();
    s.add(host({ addresses: ['desk-pc', '10.0.0.5', '100.64.0.2'] }), { peerId: PEER, secret: SECRET });
    expect(s.promoteAddress(HOST, '100.64.0.2')).toBe(true);
    expect(s.get(HOST)?.addresses).toEqual(['100.64.0.2', 'desk-pc', '10.0.0.5']);
    expect(make().get(HOST)?.addresses).toEqual(['100.64.0.2', 'desk-pc', '10.0.0.5']);
    // Already first, unknown address, unknown host: nothing changes, nothing is written.
    const writes = vi.fn(flakyWrite);
    const t = make({ write: writes });
    expect(t.promoteAddress(HOST, '100.64.0.2')).toBe(false);
    expect(t.promoteAddress(HOST, '203.0.113.9')).toBe(false);
    expect(t.promoteAddress(HOST2, '10.0.0.5')).toBe(false);
    expect(writes).not.toHaveBeenCalled();
    // Case-insensitive for names.
    expect(t.promoteAddress(HOST, 'DESK-PC')).toBe(true);
    expect(t.get(HOST)?.addresses).toEqual(['desk-pc', '100.64.0.2', '10.0.0.5']);
  });

  it('addressPromoter logs a failed write instead of throwing into the connect', () => {
    const s = make();
    s.add(host({ addresses: ['10.0.0.5', '100.64.0.2'] }), { peerId: PEER, secret: SECRET });
    const log = vi.fn();
    fail = true;
    expect(() => addressPromoter(s, HOST, log)('100.64.0.2')).not.toThrow();
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('could not move'));
    expect(s.get(HOST)?.addresses).toEqual(['10.0.0.5', '100.64.0.2']);
  });

  it('remove forgets the record and the credential', () => {
    const s = make();
    s.add(host(), { peerId: PEER, secret: SECRET });
    expect(s.remove(HOST)).toBe(true);
    expect(s.remove(HOST)).toBe(false);
    const t = make();
    expect(t.get(HOST)).toBeUndefined();
    expect(t.credentialFor(HOST)).toBeNull();
    // The rotated previous generation must not keep the removed bearer.
    for (const f of fs.readdirSync(dir)) {
      expect(fs.readFileSync(path.join(dir, f), 'utf-8')).not.toContain(SECRET);
    }
  });

  it('add / updates roll back on a failed write', () => {
    const s = make();
    s.add(host(), { peerId: PEER, secret: SECRET });
    fail = true;
    expect(() => s.add(host({ hostId: HOST2, peerId: PEER2 }), { peerId: PEER2, secret: SECRET2 })).toThrow('disk full');
    expect(s.get(HOST2)).toBeUndefined();
    expect(s.credentialFor(HOST2)).toBeNull();
    // Re-pair over an existing host: old record AND old secret come back.
    expect(() => s.add(host({ peerId: PEER2 }), { peerId: PEER2, secret: SECRET2 })).toThrow();
    expect(s.credentialFor(HOST)).toEqual({ peerId: PEER, secret: SECRET });
    expect(() => s.updateAddresses(HOST, ['other'])).toThrow();
    expect(s.get(HOST)?.addresses).toEqual(['10.0.0.5', 'DESK-PC']);
    expect(() => s.updateFingerprint(HOST, FP2)).toThrow();
    expect(s.get(HOST)?.fingerprint256).toBe(FP);
  });

  it('remove keeps its in-memory effect on a failed write', () => {
    const s = make();
    s.add(host(), { peerId: PEER, secret: SECRET });
    fail = true;
    expect(() => s.remove(HOST)).toThrow('disk full');
    expect(s.credentialFor(HOST)).toBeNull();
  });

  it('win32: a failed credential write removes primary and .bak, empties memory, and disables the store', () => {
    const file = path.join(dir, REMOTE_HOSTS_FILE);
    const log = vi.fn();
    const s = make({ win32: true, log });
    s.add(host(), { peerId: PEER, secret: SECRET });
    fs.writeFileSync(`${file}.bak`, 'older generation');
    fail = true;
    expect(() => s.add(host({ hostId: HOST2, peerId: PEER2 }), { peerId: PEER2, secret: SECRET2 })).toThrow('disk full');
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
    // Memory matches the (now empty) disk: no host survives in memory only.
    expect(s.list()).toEqual([]);
    expect(s.credentialFor(HOST)).toBeNull();
    fail = false;
    expect(() => s.add(host(), { peerId: PEER, secret: SECRET })).toThrow(/unavailable/);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('store is unavailable'));
    // A restart starts clean from the empty disk.
    expect(make().list()).toEqual([]);
  });

  it('win32: the same holds when the scrub cannot remove a file', () => {
    const s = make({ win32: true, remove: () => { throw new Error('EPERM'); } });
    s.add(host(), { peerId: PEER, secret: SECRET });
    fail = true;
    expect(() => s.updateAddresses(HOST, ['other'])).toThrow('disk full');
    fail = false;
    expect(s.credentialFor(HOST)).toBeNull();
    expect(() => s.add(host(), { peerId: PEER, secret: SECRET })).toThrow(/unavailable/);
    expect(() => s.remove(HOST)).not.toThrow();
  });

  it('off win32 a failed write leaves the previous file in place', () => {
    const file = path.join(dir, REMOTE_HOSTS_FILE);
    const s = make({ win32: false });
    s.add(host(), { peerId: PEER, secret: SECRET });
    fail = true;
    expect(() => s.add(host({ hostId: HOST2, peerId: PEER2 }), { peerId: PEER2, secret: SECRET2 })).toThrow();
    expect(fs.existsSync(file)).toBe(true);
    expect(make().credentialFor(HOST)).toEqual({ peerId: PEER, secret: SECRET });
  });

  it('load re-hardens the file; on win32 a failed harden means not loaded and unavailable', () => {
    make().add(host(), { peerId: PEER, secret: SECRET });
    const reHarden = vi.fn((): 'hardened' | 'failed' => 'hardened');
    expect(make({ reHarden, win32: true }).credentialFor(HOST)).not.toBeNull();
    expect(reHarden).toHaveBeenCalledWith(path.join(dir, REMOTE_HOSTS_FILE));
    reHarden.mockReturnValue('failed');
    const s = make({ reHarden, win32: true });
    expect(s.credentialFor(HOST)).toBeNull();
    expect(() => s.add(host({ hostId: HOST2, peerId: PEER2 }), { peerId: PEER2, secret: SECRET2 })).toThrow(/unavailable/);
    expect(fs.existsSync(path.join(dir, REMOTE_HOSTS_FILE))).toBe(true);
    // Off win32 the outcome is advisory (the file is already 0600).
    expect(make({ reHarden, win32: false }).credentialFor(HOST)).not.toBeNull();
  });

  it('sanitizes the name and validates addresses against the hostname rule', () => {
    const s = make();
    const rec = s.add(host({ name: ' Desk\u0000PC ', addresses: ['999.1.1.1', 'bad host', '-x', 'ok-host', '10.0.0.1', `${'a'.repeat(64)}.corp`] }), {
      peerId: PEER,
      secret: SECRET,
    });
    expect(rec.name).toBe('Desk PC');
    expect(rec.addresses).toEqual(['ok-host', '10.0.0.1']);
    expect(() => s.updateAddresses(HOST, ['bad host', '300.0.0.1'])).toThrow(/no usable address/);
    const many = Array.from({ length: 20 }, (_, i) => `h${i}`);
    expect(s.updateAddresses(HOST, many).addresses).toHaveLength(ADDRESSES_MAX);
  });

  it('writes the file owner-only on POSIX (default writer)', () => {
    if (process.platform === 'win32') return;
    const s = make({ write: undefined, reHarden: undefined, win32: undefined });
    s.add(host(), { peerId: PEER, secret: SECRET });
    expect(fs.statSync(path.join(dir, REMOTE_HOSTS_FILE)).mode & 0o777).toBe(0o600);
  });

  describe('corrupt file is fail-closed', () => {
    const corruptWith = (mutate: (raw: Record<string, unknown>) => void): RemoteHostStore => {
      const s = make();
      s.add(host(), { peerId: PEER, secret: SECRET });
      s.add(host({ hostId: HOST2, peerId: PEER2 }), { peerId: PEER2, secret: SECRET2 });
      const file = path.join(dir, REMOTE_HOSTS_FILE);
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      mutate(raw);
      fs.writeFileSync(file, JSON.stringify(raw));
      return make({ log: vi.fn() });
    };

    it('malformed JSON: no host, no credential, original kept, error logged', () => {
      const file = path.join(dir, REMOTE_HOSTS_FILE);
      fs.writeFileSync(file, '{"v":1,');
      const log = vi.fn();
      const s = make({ log });
      expect(s.list()).toEqual([]);
      expect(fs.existsSync(`${file}.corrupt-${clock}`)).toBe(true);
      expect(log).toHaveBeenCalledWith('error', expect.stringContaining('corrupt'));
    });

    it('a host whose secret is missing rejects every host (no .bak resurrection)', () => {
      const s = corruptWith((raw) => {
        delete (raw.secrets as Record<string, string>)[HOST2];
      });
      expect(s.list()).toEqual([]);
      expect(s.credentialFor(HOST)).toBeNull();
    });

    it('an orphan secret rejects the file', () => {
      const s = corruptWith((raw) => {
        (raw.secrets as Record<string, string>)['55555555-5555-4555-8555-555555555555'] = SECRET;
      });
      expect(s.credentialFor(HOST)).toBeNull();
    });

    it('a bad fingerprint on one host rejects the file', () => {
      const s = corruptWith((raw) => {
        (raw.hosts as Array<Record<string, unknown>>)[1].fingerprint256 = 'zz';
      });
      expect(s.credentialFor(HOST)).toBeNull();
    });
  });
});
