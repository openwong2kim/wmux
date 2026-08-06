import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteHostsStore } from '../RemoteHostsStore';

describe('RemoteHostsStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-remote-hosts-'));
    filePath = path.join(dir, 'remote-hosts.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('add → list roundtrip excludes the token', () => {
    const store = new RemoteHostsStore(filePath);
    const result = store.add('https://office-mac.example:9600/?token=secret-abc');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.host.label).toBe('office-mac.example');
    expect((result.host as { token?: string }).token).toBeUndefined();

    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(result.host.id);
    expect((listed[0] as { token?: string }).token).toBeUndefined();
  });

  it('get returns the full record including the token', () => {
    const store = new RemoteHostsStore(filePath);
    const result = store.add('https://office-mac.example:9600/?token=secret-abc');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const full = store.get(result.host.id);
    expect(full?.token).toBe('secret-abc');
    expect(full?.origin).toBe('https://office-mac.example:9600');
  });

  it('uses a custom label when provided, else defaults to the hostname', () => {
    const store = new RemoteHostsStore(filePath);
    const result = store.add('https://office-mac.example:9600/?token=secret-abc', 'My Desktop');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.host.label).toBe('My Desktop');
  });

  it('refuses a duplicate origin', () => {
    const store = new RemoteHostsStore(filePath);
    store.add('https://office-mac.example:9600/?token=secret-abc');
    const dup = store.add('https://office-mac.example:9600/?token=other-token');

    expect(dup).toEqual({ ok: false, error: 'already registered' });
    expect(store.list()).toHaveLength(1);
  });

  it('refuses a bad URL', () => {
    const store = new RemoteHostsStore(filePath);
    const result = store.add('not a url');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeTruthy();
    expect(store.list()).toHaveLength(0);
  });

  it('refuses a URL with no token', () => {
    const store = new RemoteHostsStore(filePath);
    const result = store.add('https://office-mac.example:9600/');

    expect(result.ok).toBe(false);
  });

  it('removes a host by id', () => {
    const store = new RemoteHostsStore(filePath);
    const result = store.add('https://office-mac.example:9600/?token=secret-abc');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(store.remove(result.host.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.get(result.host.id)).toBeNull();
  });

  it('remove returns false for an unknown id', () => {
    const store = new RemoteHostsStore(filePath);
    expect(store.remove('does-not-exist')).toBe(false);
  });

  it('tolerates a missing file on construct (empty list, never throws)', () => {
    expect(() => new RemoteHostsStore(filePath)).not.toThrow();
    const store = new RemoteHostsStore(filePath);
    expect(store.list()).toEqual([]);
  });

  it('tolerates a corrupt file on construct (empty list, never throws)', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, '{ not valid json', 'utf8');

    expect(() => new RemoteHostsStore(filePath)).not.toThrow();
    const store = new RemoteHostsStore(filePath);
    expect(store.list()).toEqual([]);
  });

  it('persists across instances', () => {
    const store1 = new RemoteHostsStore(filePath);
    const result = store1.add('https://office-mac.example:9600/?token=secret-abc');
    expect(result.ok).toBe(true);

    const store2 = new RemoteHostsStore(filePath);
    expect(store2.list()).toHaveLength(1);
  });

  it('writes the token file with owner-only permissions (POSIX)', () => {
    if (process.platform === 'win32') return; // ACL semantics differ on Windows — see security.test.ts
    const store = new RemoteHostsStore(filePath);
    store.add('https://office-mac.example:9600/?token=secret-abc');

    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
