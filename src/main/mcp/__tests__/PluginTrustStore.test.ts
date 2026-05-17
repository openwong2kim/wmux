import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
    expect(db.plugins).toEqual({});
    expect(db.schemaVersion).toBe(PLUGIN_TRUST_SCHEMA_VERSION);
  });

  it('tolerates a corrupt file by starting empty', async () => {
    fs.writeFileSync(dbPath, '{not valid json');
    const store = new PluginTrustStore(dbPath);
    const db = await store.load();
    expect(db.plugins).toEqual({});
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
