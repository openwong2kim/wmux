import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteHostsStore } from '../RemoteHostsStore';

const { secureWriteTokenFileMock } = vi.hoisted(() => ({
  secureWriteTokenFileMock: vi.fn(),
}));

vi.mock('../../../shared/security', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/security')>('../../../shared/security');
  // Defaults to the real implementation so every pre-existing test in this
  // file (persistence, permissions, corrupt-file tolerance) is unaffected —
  // only the M4 test below overrides it to simulate a persist failure.
  secureWriteTokenFileMock.mockImplementation(actual.secureWriteTokenFile);
  return {
    ...actual,
    secureWriteTokenFile: secureWriteTokenFileMock,
  };
});

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

  // M4 — add()/remove() used to mutate `this.hosts` BEFORE persist(), so a
  // secureWriteTokenFile throw (fail-closed on a chmod/ACL failure) left
  // memory and disk desynced: list() would show a host that was never
  // actually saved. Build-then-persist-then-assign fixes that.
  it('a persist failure during add() leaves list() unchanged', () => {
    const store = new RemoteHostsStore(filePath);
    secureWriteTokenFileMock.mockImplementationOnce(() => {
      throw new Error('EACCES: chmod failed');
    });

    expect(() => store.add('https://office-mac.example:9600/?token=secret-abc')).toThrow();
    expect(store.list()).toEqual([]);
  });

  it('a persist failure during remove() leaves list() unchanged', () => {
    const store = new RemoteHostsStore(filePath);
    const result = store.add('https://office-mac.example:9600/?token=secret-abc');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    secureWriteTokenFileMock.mockImplementationOnce(() => {
      throw new Error('EACCES: chmod failed');
    });

    expect(() => store.remove(result.host.id)).toThrow();
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.id).toBe(result.host.id);
  });

  it('writes the token file with owner-only permissions (POSIX)', () => {
    if (process.platform === 'win32') return; // ACL semantics differ on Windows — see security.test.ts
    const store = new RemoteHostsStore(filePath);
    store.add('https://office-mac.example:9600/?token=secret-abc');

    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
