import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountStore, AccountError, getAccountsPath } from '../accountStore';

// Each test gets an isolated temp data dir so the store's accounts.json never
// touches the real wmux data dir.
let dir: string;
let store: AccountStore;

function mkConfigDir(name: string): string {
  const p = path.join(dir, 'configs', name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-acct-'));
  store = new AccountStore(dir);
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('AccountStore CRUD', () => {
  it('adds an account and persists it', async () => {
    const cfg = mkConfigDir('work');
    const acc = await store.addAccount({ name: '회사 Max', vendor: 'claude', configDir: cfg });
    expect(acc.id).toBeTruthy();
    expect(acc.name).toBe('회사 Max');
    expect(fs.existsSync(getAccountsPath(dir))).toBe(true);
    // Reload from disk in a fresh instance — persistence round-trips.
    const fresh = new AccountStore(dir);
    expect(fresh.listAccounts().map((a) => a.id)).toEqual([acc.id]);
  });

  it('renames an account', async () => {
    const acc = await store.addAccount({ name: 'old', vendor: 'claude', configDir: mkConfigDir('a') });
    await store.renameAccount(acc.id, 'new');
    expect(store.getAccount(acc.id)?.name).toBe('new');
  });

  it('rejects a duplicate configDir by canonical identity', async () => {
    const cfg = mkConfigDir('shared');
    await store.addAccount({ name: 'first', vendor: 'claude', configDir: cfg });
    // Same dir via a different lexical form (trailing separator + '.') must dedupe.
    await expect(
      store.addAccount({ name: 'second', vendor: 'claude', configDir: path.join(cfg, '.') + path.sep }),
    ).rejects.toMatchObject({ code: 'duplicate-dir' });
    expect(store.listAccounts()).toHaveLength(1);
  });

  it('rejects an empty name', async () => {
    await expect(
      store.addAccount({ name: '   ', vendor: 'claude', configDir: mkConfigDir('a') }),
    ).rejects.toBeInstanceOf(AccountError);
  });

  it('rejects a non-existent configDir (no lexical fallback → no alias dupes)', async () => {
    await expect(
      store.addAccount({ name: 'ghost', vendor: 'claude', configDir: path.join(dir, 'does-not-exist') }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rejects a configDir that is a file, not a directory', async () => {
    const filePath = path.join(dir, 'afile');
    fs.writeFileSync(filePath, 'x');
    await expect(
      store.addAccount({ name: 'f', vendor: 'claude', configDir: filePath }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('remove clears bindings and reports affected workspaces', async () => {
    const acc = await store.addAccount({ name: 'w', vendor: 'claude', configDir: mkConfigDir('w') });
    await store.setBinding('ws-1', 'claude', acc.id);
    await store.setBinding('ws-2', 'claude', acc.id);
    const affected = await store.removeAccount(acc.id);
    expect(affected.sort()).toEqual(['ws-1', 'ws-2']);
    expect(store.getBinding('ws-1', 'claude')).toBeUndefined();
    expect(store.listAccounts()).toHaveLength(0);
  });
});

describe('AccountStore bindings', () => {
  it('binds claude and codex to one workspace simultaneously', async () => {
    const c = await store.addAccount({ name: 'c', vendor: 'claude', configDir: mkConfigDir('c') });
    const x = await store.addAccount({ name: 'x', vendor: 'codex', configDir: mkConfigDir('x') });
    await store.setBinding('ws-1', 'claude', c.id);
    await store.setBinding('ws-1', 'codex', x.id);
    expect(store.getBinding('ws-1', 'claude')).toBe(c.id);
    expect(store.getBinding('ws-1', 'codex')).toBe(x.id);
  });

  it('rejects binding an account to the wrong vendor slot', async () => {
    const c = await store.addAccount({ name: 'c', vendor: 'claude', configDir: mkConfigDir('c') });
    await expect(store.setBinding('ws-1', 'codex', c.id)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('unbinds when accountId is undefined', async () => {
    const c = await store.addAccount({ name: 'c', vendor: 'claude', configDir: mkConfigDir('c') });
    await store.setBinding('ws-1', 'claude', c.id);
    await store.setBinding('ws-1', 'claude', undefined);
    expect(store.getBinding('ws-1', 'claude')).toBeUndefined();
  });

  it('rejects a prototype-pollution workspaceId (does not touch Object.prototype)', async () => {
    const c = await store.addAccount({ name: 'c', vendor: 'claude', configDir: mkConfigDir('c') });
    await expect(store.setBinding('__proto__', 'claude', c.id)).rejects.toMatchObject({ code: 'invalid' });
    // Prototype stayed clean.
    expect(({} as Record<string, unknown>).claude).toBeUndefined();
  });

  it('drops a binding whose account vendor does not match the slot (recovered file)', async () => {
    const c = await store.addAccount({ name: 'c', vendor: 'claude', configDir: mkConfigDir('c') });
    // Hand-edit the file: put the claude account in the codex slot.
    const p = getAccountsPath(dir);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    raw.bindings = { 'ws-1': { codex: c.id } };
    fs.writeFileSync(p, JSON.stringify(raw));
    const fresh = new AccountStore(dir);
    fresh.load();
    expect(fresh.getBinding('ws-1', 'codex')).toBeUndefined(); // vendor mismatch → dropped
  });

  it('lazily prunes bindings for unknown workspaces on load', async () => {
    const c = await store.addAccount({ name: 'c', vendor: 'claude', configDir: mkConfigDir('c') });
    await store.setBinding('ws-gone', 'claude', c.id);
    // Reload constraining to a known-workspace set that excludes ws-gone.
    const fresh = new AccountStore(dir);
    fresh.load(new Set(['ws-live']));
    expect(fresh.getBinding('ws-gone', 'claude')).toBeUndefined();
  });

  it('drops dangling accountId references on load (account removed out of band)', async () => {
    const c = await store.addAccount({ name: 'c', vendor: 'claude', configDir: mkConfigDir('c') });
    await store.setBinding('ws-1', 'claude', c.id);
    // Corrupt the file: remove the account but leave the binding.
    const p = getAccountsPath(dir);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    raw.accounts = [];
    fs.writeFileSync(p, JSON.stringify(raw));
    const fresh = new AccountStore(dir);
    fresh.load();
    expect(fresh.getBinding('ws-1', 'claude')).toBeUndefined();
  });
});

describe('AccountStore.resolveAccountEnv (spawn hot path)', () => {
  it('returns the vendor env var when a binding exists and the dir is present', async () => {
    const cfg = mkConfigDir('work');
    const c = await store.addAccount({ name: 'c', vendor: 'claude', configDir: cfg });
    await store.setBinding('ws-1', 'claude', c.id);
    const env = store.resolveAccountEnv('ws-1', 'claude');
    const stored = store.getAccount(c.id);
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: stored?.configDir });
  });

  it('uses CODEX_HOME for codex accounts', async () => {
    const cfg = mkConfigDir('cx');
    const x = await store.addAccount({ name: 'x', vendor: 'codex', configDir: cfg });
    await store.setBinding('ws-1', 'codex', x.id);
    expect(store.resolveAccountEnv('ws-1', 'codex')).toHaveProperty('CODEX_HOME');
  });

  it('returns empty env (no binding) → caller falls back to default', () => {
    expect(store.resolveAccountEnv('ws-unbound', 'claude')).toEqual({});
  });

  it('falls back + reports onMissing when the bound dir was deleted on disk', async () => {
    const cfg = mkConfigDir('doomed');
    const c = await store.addAccount({ name: 'c', vendor: 'claude', configDir: cfg });
    await store.setBinding('ws-1', 'claude', c.id);
    fs.rmSync(cfg, { recursive: true, force: true });
    let missing: string | undefined;
    const env = store.resolveAccountEnv('ws-1', 'claude', (a) => { missing = a.name; });
    expect(env).toEqual({});           // default-credential fallback, not an empty logged-out config
    expect(missing).toBe('c');         // caller can warn
  });
});

describe('AccountStore concurrency (eng-review P1: serialized write queue)', () => {
  it('does not lose writes under overlapping mutations', async () => {
    // Fire many binds concurrently on ONE store instance; the serialized write
    // chain must apply every one (plain last-writer-wins would drop most).
    // Three overlapping writers per phase already make last-writer-wins lose
    // two of them; five meant ten durable writes, which timed out on Windows.
    const accs = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        store.addAccount({ name: `a${i}`, vendor: 'claude', configDir: mkConfigDir(`a${i}`) }),
      ),
    );
    await Promise.all(accs.map((a, i) => store.setBinding(`ws-${i}`, 'claude', a.id)));
    const fresh = new AccountStore(dir);
    fresh.load();
    for (let i = 0; i < accs.length; i++) {
      expect(fresh.getBinding(`ws-${i}`, 'claude')).toBe(accs[i].id);
    }
    expect(fresh.listAccounts()).toHaveLength(3);
  });

  it('a rejected mutation does not wedge the write chain', async () => {
    const c = await store.addAccount({ name: 'c', vendor: 'claude', configDir: mkConfigDir('c') });
    await expect(store.renameAccount('nope', 'x')).rejects.toBeInstanceOf(AccountError);
    // The chain survives — a subsequent mutation still lands.
    await store.renameAccount(c.id, 'after');
    expect(store.getAccount(c.id)?.name).toBe('after');
  });
});

describe('AccountStore corrupt file', () => {
  it('loads a torn file as empty (fail open — never brick spawning)', () => {
    fs.writeFileSync(getAccountsPath(dir), '{ this is not json');
    const s = new AccountStore(dir);
    expect(s.load().accounts).toEqual([]);
    expect(s.resolveAccountEnv('ws-1', 'claude')).toEqual({});
  });
});
