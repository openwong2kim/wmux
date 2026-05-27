import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PLUGIN_NAME_LEN,
  MAX_PLUGIN_TRUST_ENTRIES,
  PLUGIN_TRUST_SCHEMA_VERSION,
  PluginTrustStore,
} from '../PluginTrustStore';

let tmpDir = '';
let dbPath = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-trust-test-'));
  dbPath = path.join(tmpDir, 'plugin-trust.json');
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('PluginTrustStore.upsertContact', () => {
  it('creates a fresh unconfirmed record on first contact', async () => {
    const store = new PluginTrustStore(dbPath);
    const identity = await store.upsertContact('claude-ai', '1.0.94');
    expect(identity.name).toBe('claude-ai');
    expect(identity.version).toBe('1.0.94');
    expect(identity.status).toBe('unconfirmed');
    expect(identity.firstSeen).toBeGreaterThan(0);
    expect(identity.lastSeen).toBe(identity.firstSeen);
  });

  it('persists the record atomically and is recoverable across instances', async () => {
    await new PluginTrustStore(dbPath).upsertContact('claude-ai', '1.0.94');
    const onDisk = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    expect(onDisk.schemaVersion).toBe(PLUGIN_TRUST_SCHEMA_VERSION);
    expect(onDisk.plugins['claude-ai'].name).toBe('claude-ai');

    // Fresh store instance reads the same data
    const fresh = new PluginTrustStore(dbPath);
    const list = await fresh.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('claude-ai');
  });

  it('refreshes lastSeen without resetting firstSeen on reconnect', async () => {
    const store = new PluginTrustStore(dbPath);
    const first = await store.upsertContact('claude-ai', '1.0.0');
    // Bump the clock perceptibly so lastSeen advances
    await new Promise((r) => setTimeout(r, 5));
    const second = await store.upsertContact('claude-ai', '1.0.1');
    expect(second.firstSeen).toBe(first.firstSeen);
    expect(second.lastSeen).toBeGreaterThanOrEqual(first.lastSeen);
    expect(second.version).toBe('1.0.1');
  });
});

describe('PluginTrustStore.upsertDeclaration', () => {
  it('records the declared capability list and rationale', async () => {
    const store = new PluginTrustStore(dbPath);
    await store.upsertContact('claude-ai');
    const identity = await store.upsertDeclaration(
      'claude-ai',
      ['pane.read', 'meta.write:custom.x.*'],
      'tracks pane lifecycle',
    );
    expect(identity.declaredCapabilities).toEqual([
      'pane.read',
      'meta.write:custom.x.*',
    ]);
    expect(identity.rationale).toBe('tracks pane lifecycle');
  });

  it('seeds an entry when no prior contact exists', async () => {
    const store = new PluginTrustStore(dbPath);
    const identity = await store.upsertDeclaration('orphan-tool', ['pane.read']);
    expect(identity.status).toBe('unconfirmed');
    expect(identity.declaredCapabilities).toEqual(['pane.read']);
  });

  it('overwrites the prior declaration (no merge)', async () => {
    const store = new PluginTrustStore(dbPath);
    await store.upsertDeclaration('claude-ai', ['pane.read', 'meta.write']);
    const second = await store.upsertDeclaration('claude-ai', ['events.subscribe']);
    expect(second.declaredCapabilities).toEqual(['events.subscribe']);
  });
});

describe('PluginTrustStore.load', () => {
  it('tolerates a missing file as an empty DB', async () => {
    const store = new PluginTrustStore(dbPath);
    const db = await store.load();
    expect(Object.keys(db.plugins)).toEqual([]);
    expect(db.schemaVersion).toBe(PLUGIN_TRUST_SCHEMA_VERSION);
  });

  it('tolerates a corrupt file by starting empty', async () => {
    fs.writeFileSync(dbPath, '{not valid json');
    const store = new PluginTrustStore(dbPath);
    const db = await store.load();
    expect(Object.keys(db.plugins)).toEqual([]);
  });

  it('serialises concurrent writes without losing entries', async () => {
    const store = new PluginTrustStore(dbPath);
    await Promise.all([
      store.upsertContact('a'),
      store.upsertContact('b'),
      store.upsertContact('c'),
    ]);
    const list = await store.list();
    expect(list.map((p) => p.name).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('PluginTrustStore.upsertLegacyContact', () => {
  it('records an envelope-less contact as legacy', async () => {
    const store = new PluginTrustStore(dbPath);
    const identity = await store.upsertLegacyContact();
    expect(identity.name).toBe('unknown');
    expect(identity.status).toBe('legacy');
  });

  it('upgrades a legacy entry to unconfirmed when applyContact runs again', async () => {
    // Two passes through the legacy path simulate a second envelope-less
    // RPC reaching the substrate after the audit row already exists.
    const store = new PluginTrustStore(dbPath);
    await store.upsertLegacyContact();
    const second = await store.upsertLegacyContact();
    expect(second.status).toBe('unconfirmed');
  });

  it('preserves a user-issued trust state when the same name re-appears as legacy', async () => {
    // If a name was previously approved by the user (trusted), an
    // envelope-less call must NOT regress that decision.
    const store = new PluginTrustStore(dbPath);
    await store.upsertContact('claude-ai');
    // Forge a trusted state by overwriting on disk — the public API has no
    // user-approval surface yet (planned for the enforcement PR).
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    raw.plugins['claude-ai'].status = 'trusted';
    fs.writeFileSync(dbPath, JSON.stringify(raw));
    const fresh = new PluginTrustStore(dbPath);
    const next = await fresh.upsertLegacyContact('claude-ai');
    expect(next.status).toBe('trusted');
  });
});

describe('PluginTrustStore hostile-input hardening', () => {
  it('does not collide with Object.prototype keys', async () => {
    const store = new PluginTrustStore(dbPath);
    // Sending `__proto__` as a clientName must not mutate Object.prototype
    // nor allow inherited values to leak through `get`.
    await store.upsertContact('__proto__');
    expect(({} as Record<string, unknown>).poisoned).toBeUndefined();
    const stored = await store.get('__proto__');
    expect(stored?.name).toBe('__proto__');
    expect(stored?.status).toBe('unconfirmed');
    // Built-in keys like `toString` must not return Object.prototype's method.
    expect(await store.get('toString')).toBeUndefined();
  });

  it('truncates oversize plugin names instead of rejecting them', async () => {
    const store = new PluginTrustStore(dbPath);
    const huge = 'a'.repeat(MAX_PLUGIN_NAME_LEN + 50);
    const stored = await store.upsertContact(huge);
    expect(stored.name.length).toBe(MAX_PLUGIN_NAME_LEN);
    // The truncated key is what subsequent lookups will use.
    expect(await store.get(huge)).toBeDefined();
  });

  it('drops on-disk entries with an invalid status during normalize', async () => {
    // A future schema version or hand edit might put a status outside the
    // known union onto disk. load() must drop such entries rather than
    // surface them — otherwise downstream branching on PluginTrustStatus
    // sees `undefined` and the trust-status invariant cannot hold.
    const corrupt = {
      schemaVersion: PLUGIN_TRUST_SCHEMA_VERSION,
      plugins: {
        good: {
          name: 'good',
          status: 'unconfirmed',
          firstSeen: 1,
          lastSeen: 1,
        },
        bad: {
          name: 'bad',
          status: 'future-state',
          firstSeen: 1,
          lastSeen: 1,
        },
      },
    };
    fs.writeFileSync(dbPath, JSON.stringify(corrupt));
    const store = new PluginTrustStore(dbPath);
    const list = await store.list();
    expect(list.map((p) => p.name)).toEqual(['good']);
  });
});

describe('PluginTrustStore LRU eviction', () => {
  // Forge an on-disk DB so we can plant entries with arbitrary lastSeen +
  // status without going through the upsert helpers (which always stamp
  // lastSeen = now()). This lets us assert eviction order deterministically.
  function writeDb(
    plugins: Array<{
      name: string;
      status: 'unconfirmed' | 'legacy' | 'trusted' | 'denied';
      lastSeen: number;
      firstSeen?: number;
    }>,
  ): void {
    const db = {
      schemaVersion: PLUGIN_TRUST_SCHEMA_VERSION,
      plugins: Object.fromEntries(
        plugins.map((p) => [
          p.name,
          {
            name: p.name,
            status: p.status,
            firstSeen: p.firstSeen ?? p.lastSeen,
            lastSeen: p.lastSeen,
          },
        ]),
      ),
    };
    fs.writeFileSync(dbPath, JSON.stringify(db));
  }

  it('evicts the oldest unconfirmed entry when the cap is exceeded', async () => {
    writeDb([
      { name: 'oldest', status: 'unconfirmed', lastSeen: 100 },
      { name: 'middle', status: 'unconfirmed', lastSeen: 200 },
      { name: 'newest', status: 'unconfirmed', lastSeen: 300 },
    ]);
    const store = new PluginTrustStore(dbPath, { entryCap: 3 });
    // Adding a fourth entry pushes the DB to 4; LRU brings it back to 3.
    await store.upsertContact('fresh');
    const list = await store.list();
    const names = list.map((p) => p.name).sort();
    expect(names).toEqual(['fresh', 'middle', 'newest']);
  });

  it('evicts legacy entries before unconfirmed regardless of lastSeen', async () => {
    // 'legacy' rank < 'unconfirmed' rank — a very-recent legacy still goes
    // first because the substrate trusts envelope-bearing contacts more.
    writeDb([
      { name: 'old-unconfirmed', status: 'unconfirmed', lastSeen: 100 },
      { name: 'fresh-legacy', status: 'legacy', lastSeen: 999 },
    ]);
    const store = new PluginTrustStore(dbPath, { entryCap: 2 });
    await store.upsertContact('newcomer');
    const list = await store.list();
    expect(list.map((p) => p.name).sort()).toEqual(['newcomer', 'old-unconfirmed']);
  });

  it('skips trusted entries when picking the eviction victim', async () => {
    // Cap is 3, DB starts at 3, adding one tips it over by 1. The only
    // evictable record (unconfirmed-c) goes; both trusted entries survive.
    writeDb([
      { name: 'trusted-a', status: 'trusted', lastSeen: 100 },
      { name: 'trusted-b', status: 'trusted', lastSeen: 200 },
      { name: 'unconfirmed-c', status: 'unconfirmed', lastSeen: 300 },
    ]);
    const store = new PluginTrustStore(dbPath, { entryCap: 3 });
    await store.upsertContact('newcomer');
    const list = await store.list();
    const names = list.map((p) => p.name).sort();
    expect(names).toEqual(['newcomer', 'trusted-a', 'trusted-b']);
  });

  it('never evicts denied entries (user decision is sticky)', async () => {
    writeDb([
      { name: 'denied-a', status: 'denied', lastSeen: 100 },
      { name: 'unconfirmed-b', status: 'unconfirmed', lastSeen: 200 },
    ]);
    const store = new PluginTrustStore(dbPath, { entryCap: 1 });
    await store.upsertContact('fresh');
    const list = await store.list();
    const names = list.map((p) => p.name).sort();
    expect(names).toContain('denied-a');
    expect(names).not.toContain('unconfirmed-b');
  });

  it('allows the DB to exceed the cap when only protected entries remain', async () => {
    writeDb([
      { name: 't1', status: 'trusted', lastSeen: 100 },
      { name: 't2', status: 'trusted', lastSeen: 200 },
      { name: 'd1', status: 'denied', lastSeen: 300 },
    ]);
    const store = new PluginTrustStore(dbPath, { entryCap: 1 });
    // Touch one of the records via upsertContact (which mutates → triggers
    // eviction). No evictable entry exists, so the DB stays as-is.
    await store.upsertContact('t1');
    const list = await store.list();
    expect(list).toHaveLength(3);
  });
});

describe('PluginTrustStore.setUserDecision (Phase 2.2 pre-commit 5)', () => {
  it('persists a trusted decision on a fresh plugin (no prior record)', async () => {
    const store = new PluginTrustStore(dbPath);
    const rec = await store.setUserDecision('fresh-plugin', 'trusted');
    expect(rec.status).toBe('trusted');
    expect(rec.name).toBe('fresh-plugin');
    expect(rec.firstSeen).toBeGreaterThan(0);
    expect(rec.lastSeen).toBe(rec.firstSeen);
  });

  it('persists a denied decision and survives a fresh store instance', async () => {
    const store = new PluginTrustStore(dbPath);
    await store.upsertContact('p1', '1.0.0');
    await store.setUserDecision('p1', 'denied');
    const reincarnated = new PluginTrustStore(dbPath);
    const reloaded = await reincarnated.get('p1');
    expect(reloaded?.status).toBe('denied');
    expect(reloaded?.version).toBe('1.0.0');
  });

  it('overwrites prior trusted/denied/unconfirmed state explicitly', async () => {
    const store = new PluginTrustStore(dbPath);
    await store.upsertDeclaration('p1', ['pane.read']);
    expect((await store.get('p1'))?.status).toBe('unconfirmed');
    await store.setUserDecision('p1', 'trusted');
    expect((await store.get('p1'))?.status).toBe('trusted');
    await store.setUserDecision('p1', 'denied');
    expect((await store.get('p1'))?.status).toBe('denied');
    // declaredCapabilities preserved across decisions.
    expect((await store.get('p1'))?.declaredCapabilities).toEqual(['pane.read']);
  });

  it('clamps oversized plugin names like every other write path', async () => {
    const store = new PluginTrustStore(dbPath);
    const huge = 'X'.repeat(MAX_PLUGIN_NAME_LEN + 100);
    const rec = await store.setUserDecision(huge, 'trusted');
    expect(rec.name.length).toBeLessThanOrEqual(MAX_PLUGIN_NAME_LEN);
  });
});
