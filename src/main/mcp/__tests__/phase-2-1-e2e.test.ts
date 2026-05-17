// Phase 2.1 dynamic verification — exercises the production wiring path
// in a single multi-step sequence, with assertions on the raw bytes on
// disk rather than the in-memory cache.
//
// This is NOT a unit test of any single module. It mirrors main/index.ts:
//
//   rpcRouter.setLegacyContactRecorder(() => {
//     void getPluginTrustStore().upsertLegacyContact().catch(...);
//   });
//
// and replays a realistic sequence of envelope-less + envelope-bearing
// RPCs against an isolated tmpdir trust DB, then verifies what landed on
// disk. Treat any failure here as a sign that the integration between
// RpcRouter, PluginTrustStore, and atomicWrite changed in a way the
// per-module suites would not catch.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcRouter } from '../../pipe/RpcRouter';
import {
  MAX_PLUGIN_NAME_LEN,
  PluginTrustStore,
} from '../PluginTrustStore';
import { registerMcpPluginRpc } from '../../pipe/handlers/mcp.rpc';
import type { McpIdentifyResult } from '../../../shared/rpc';

let tmpDir = '';
let dbPath = '';
let store: PluginTrustStore;
let router: RpcRouter;

// Tracks the fire-and-forget promises the legacy recorder enqueues so
// the test can await them between assertions. Production uses the same
// recorder shape minus the tracker — see main/index.ts.
let pendingWrites: Promise<unknown>[] = [];

async function drainWrites(): Promise<void> {
  // Pull and clear so a later RPC can enqueue a fresh batch without
  // re-awaiting the previous ones. settle() afterwards lets the next
  // microtask tick land any cache invalidation in PluginTrustStore.
  const batch = pendingWrites;
  pendingWrites = [];
  await Promise.all(batch);
}

// Mirror the wiring from src/main/index.ts. The recorder closure captures
// the tmpdir-backed store instead of the singleton so the test does not
// touch ~/.wmux on the dev box. The only deviation from production is
// the `pendingWrites.push` — we instrument the awaitable so the test
// can deterministically inspect disk state after each RPC.
function wireProductionPath(): void {
  registerMcpPluginRpc(router, store);
  // Same handler used in production for any non-mcp RPC. We pick pane.list
  // because it is the most-frequently-called handler and exercises the
  // exact dispatch path the legacy-recorder gates on.
  router.register('pane.list', async () => ({ panes: [] }));
  router.setLegacyContactRecorder(() => {
    const p = store.upsertLegacyContact().catch(() => {
      /* swallow — best-effort audit, never blocks RPC */
    });
    pendingWrites.push(p);
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-phase21-e2e-'));
  dbPath = path.join(tmpDir, 'plugin-trust.json');
  store = new PluginTrustStore(dbPath);
  router = new RpcRouter();
  pendingWrites = [];
  wireProductionPath();
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// Sleep long enough that lastSeen advances perceptibly between RPCs.
// PluginIdentity uses Date.now() so the resolution is millisecond.
const settle = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

// Read raw bytes from disk (bypassing PluginTrustStore's cache) so the
// assertions reflect what survived atomicWriteJSON, not the in-memory
// state. Fails if the file is missing or unparseable — caller decides.
function readDbFromDisk(): {
  schemaVersion: number;
  plugins: Record<string, { status: string; name: string }>;
} {
  const raw = fs.readFileSync(dbPath, 'utf8');
  return JSON.parse(raw);
}

describe('phase 2.1 production wiring — multi-step RPC sequence', () => {
  it('replays a realistic plugin lifecycle and verifies disk state at each step', async () => {
    // === Step 1: envelope-less RPC (pre-v2.10 caller or pre-handshake race)
    // Expected: legacy 'unknown' entry persisted, status === 'legacy'.
    await router.dispatch({ id: 's1', method: 'pane.list', params: {} });
    // Fire-and-forget audit write — let the next tick land it on disk.
    await drainWrites();
    await settle();

    expect(fs.existsSync(dbPath)).toBe(true);
    {
      const onDisk = readDbFromDisk();
      expect(Object.keys(onDisk.plugins)).toEqual(['unknown']);
      expect(onDisk.plugins.unknown.status).toBe('legacy');
    }

    // === Step 2: second envelope-less RPC — process-once flag must
    // suppress a second trust-DB write. We watch mtime instead of the
    // record itself because applyContact would advance lastSeen.
    const mtimeAfterStep1 = fs.statSync(dbPath).mtimeMs;
    await settle(10);
    await router.dispatch({ id: 's2', method: 'pane.list', params: {} });
    await drainWrites();
    await settle();
    const mtimeAfterStep2 = fs.statSync(dbPath).mtimeMs;
    expect(mtimeAfterStep2).toBe(mtimeAfterStep1);

    // === Step 3: envelope-bearing mcp.identify — distinct entry recorded
    // as 'unconfirmed', the bundled MCP server's handshake path.
    const response = await router.dispatch({
      id: 's3',
      method: 'mcp.identify',
      params: {},
      clientName: 'claude-ai',
      clientVersion: '1.0.94',
    });
    expect(response.ok).toBe(true);
    if (response.ok) {
      const result = response.result as McpIdentifyResult;
      expect(result.identity.status).toBe('unconfirmed');
      expect(result.identity.name).toBe('claude-ai');
    }
    await drainWrites();
    await settle();
    {
      const onDisk = readDbFromDisk();
      expect(Object.keys(onDisk.plugins).sort()).toEqual(
        ['claude-ai', 'unknown'].sort(),
      );
      expect(onDisk.plugins['claude-ai'].status).toBe('unconfirmed');
      expect(onDisk.plugins.unknown.status).toBe('legacy');
    }

    // === Step 4: hostile clientName — '__proto__' must NOT pollute the
    // global Object prototype and MUST land as an own-key in the DB.
    await router.dispatch({
      id: 's4',
      method: 'mcp.identify',
      params: {},
      clientName: '__proto__',
    });
    await drainWrites();
    await settle();
    // Process-wide Object prototype must remain clean.
    expect(({} as Record<string, unknown>).status).toBeUndefined();
    expect(({} as Record<string, unknown>).declaredCapabilities).toBeUndefined();
    {
      const onDisk = readDbFromDisk();
      expect(
        Object.prototype.hasOwnProperty.call(onDisk.plugins, '__proto__'),
      ).toBe(true);
    }

    // === Step 5: oversize clientName — substrate clamps to MAX length;
    // the audit row is preserved (truncated) rather than rejected.
    const huge = 'X'.repeat(MAX_PLUGIN_NAME_LEN + 100);
    await router.dispatch({
      id: 's5',
      method: 'mcp.identify',
      params: {},
      clientName: huge,
    });
    await drainWrites();
    await settle();
    {
      const onDisk = readDbFromDisk();
      const truncated = 'X'.repeat(MAX_PLUGIN_NAME_LEN);
      expect(
        Object.prototype.hasOwnProperty.call(onDisk.plugins, truncated),
      ).toBe(true);
      // The full-length key must NOT exist — clamp, not store-twice.
      expect(
        Object.prototype.hasOwnProperty.call(onDisk.plugins, huge),
      ).toBe(false);
    }

    // === Step 6: malformed declarePermissions must NOT corrupt the DB.
    // The entire declaration is rejected; no plugin entry is mutated.
    const beforeMalformed = readDbFromDisk();
    const malformed = await router.dispatch({
      id: 's6',
      method: 'mcp.declarePermissions',
      params: {
        permissions: ['pane.read', 'made.up.capability'],
      },
      clientName: 'claude-ai',
    });
    expect(malformed.ok).toBe(false);
    await drainWrites();
    await settle();
    const afterMalformed = readDbFromDisk();
    // Identity entry exists from step 3, but capabilities must still be
    // undefined — the malformed call did NOT seed anything.
    expect(afterMalformed.plugins['claude-ai']).toEqual(
      beforeMalformed.plugins['claude-ai'],
    );

    // === Step 7: well-formed declarePermissions — capability list is
    // recorded verbatim and survives a fresh PluginTrustStore instance.
    const goodDeclare = await router.dispatch({
      id: 's7',
      method: 'mcp.declarePermissions',
      params: {
        permissions: ['pane.read', 'meta.write:custom.dash.*'],
        rationale: 'demo dashboard',
      },
      clientName: 'claude-ai',
    });
    expect(goodDeclare.ok).toBe(true);
    await drainWrites();
    await settle();

    // Round-trip through a brand new store instance — the cache from
    // the original store is bypassed entirely.
    const reincarnated = new PluginTrustStore(dbPath);
    const reloaded = await reincarnated.get('claude-ai');
    expect(reloaded?.declaredCapabilities).toEqual([
      'pane.read',
      'meta.write:custom.dash.*',
    ]);
    expect(reloaded?.rationale).toBe('demo dashboard');
    // Trust-status invariant — the prior 'unconfirmed' from step 3 was
    // preserved across the declaration (no regression, no upgrade).
    expect(reloaded?.status).toBe('unconfirmed');
  });

  it('survives a corrupt disk file by loading empty and overwriting on next write', async () => {
    // Plant a corrupt file under the test path. The store must boot
    // (return empty DB) and the next write must succeed without
    // throwing — even though atomicWriteJSON rotates the bad file to
    // .bak first.
    fs.writeFileSync(dbPath, '{this is not valid json');
    const localRouter = new RpcRouter();
    const localStore = new PluginTrustStore(dbPath);
    registerMcpPluginRpc(localRouter, localStore);
    localRouter.setLegacyContactRecorder(() =>
      void localStore.upsertLegacyContact().catch(() => undefined),
    );
    localRouter.register('pane.list', async () => ({ panes: [] }));

    const response = await localRouter.dispatch({
      id: 'recovery',
      method: 'mcp.identify',
      params: {},
      clientName: 'recovery-test',
    });
    expect(response.ok).toBe(true);
    await drainWrites();
    await settle();

    const onDisk = readDbFromDisk();
    expect(onDisk.plugins['recovery-test']?.status).toBe('unconfirmed');
  });
});
