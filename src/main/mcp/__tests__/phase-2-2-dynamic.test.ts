// Phase 2.2 dynamic verification — exercises the production wiring for the
// shadow-mode enforcement substrate against a real on-disk PluginTrustStore
// + ShadowRejectionLogger + LegacyTrafficCounter in an isolated tmpdir.
//
// Mirrors src/main/index.ts:
//
//   rpcRouter.setLegacyContactRecorder(...);
//   rpcRouter.setTrustLookup((n) => store.get(n));
//   rpcRouter.setShadowRejectionSink((e) => logger.append(e));
//   rpcRouter.setLegacyTrafficCounter(counter);
//
// Then replays a realistic plugin lifecycle and reads back what landed on
// disk in `shadow-rejections.log` to confirm the enforcer + side-channels
// produce the expected audit trail. Any failure here means the integration
// between RpcRouter, PluginTrustStore, the enforcer, and the shadow log
// drifted in a way the per-module suites would not catch.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcRouter } from '../../pipe/RpcRouter';
import { PluginTrustStore } from '../PluginTrustStore';
import { registerMcpPluginRpc } from '../../pipe/handlers/mcp.rpc';
import {
  ShadowRejectionLogger,
  type ShadowAuditEntry,
  type ShadowRejectionEntry,
  type LegacyTrafficEntry,
} from '../../audit/shadowRejectionLog';
import { LegacyTrafficCounter } from '../../audit/legacyTrafficCounter';

let tmpDir = '';
let dbPath = '';
let logPath = '';
let store: PluginTrustStore;
let router: RpcRouter;
let shadowLogger: ShadowRejectionLogger;
let counter: LegacyTrafficCounter;

let pendingWrites: Promise<unknown>[] = [];

async function drainWrites(): Promise<void> {
  const batch = pendingWrites;
  pendingWrites = [];
  await Promise.all(batch);
}

const settle = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

function readLog(): ShadowAuditEntry[] {
  return shadowLogger.readAll();
}

function rejectionEntries(): ShadowRejectionEntry[] {
  return readLog().filter(
    (e): e is ShadowRejectionEntry => e.entryKind === 'rejection',
  );
}

function legacyEntries(): LegacyTrafficEntry[] {
  return readLog().filter(
    (e): e is LegacyTrafficEntry => e.entryKind === 'legacy-traffic',
  );
}

function wireProductionPath(): void {
  // Identity handlers
  registerMcpPluginRpc(router, store);
  // A representative gated handler — pane.list requires `pane.read`.
  router.register('pane.list', async () => ({ panes: [] }));
  // A multi-path handler — pane.setMetadata extracts paths from params.
  router.register('pane.setMetadata', async () => ({
    ok: true,
    paneId: 'p1',
    metadata: { custom: {} },
    version: 1,
  }));
  // events.poll for the multi-path partial scenario.
  router.register('events.poll', async () => ({ events: [], cursor: 0 }));
  // input.send for the terminal-content / terminal-input risk class.
  router.register('input.send', async () => ({ ok: true }));

  router.setLegacyContactRecorder(() => {
    const p = store.upsertLegacyContact().catch(() => undefined);
    pendingWrites.push(p);
  });
  router.setTrustLookup(async (name) => store.get(name));
  router.setShadowRejectionSink((entry) => shadowLogger.append(entry));
  router.setLegacyTrafficCounter(counter);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-phase22-dyn-'));
  dbPath = path.join(tmpDir, 'plugin-trust.json');
  logPath = path.join(tmpDir, 'shadow-rejections.log');
  store = new PluginTrustStore(dbPath);
  shadowLogger = new ShadowRejectionLogger({ path: logPath });
  counter = new LegacyTrafficCounter({
    sink: ({ method, count }) =>
      shadowLogger.appendLegacyTraffic({ method, count }),
    // Custom milestones so the test doesn't need 100+ RPCs to hit one.
    milestones: [1, 3, 5],
  });
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

describe('phase 2.2 dynamic — full plugin lifecycle against real disk', () => {
  it('replays the unconfirmed → trusted → capability-mismatch sequence', async () => {
    // === Step 1: envelope-less RPC. Legacy path runs — trust DB gets a
    // 'legacy' row, traffic counter ticks (milestone 1 → log entry), but
    // the enforcer ALLOWS legacy so no shadow rejection lands.
    await router.dispatch({ id: 's1', method: 'pane.list', params: {} });
    await drainWrites();
    await settle();

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(legacyEntries()).toHaveLength(1);
    expect(legacyEntries()[0].method).toBe('pane.list');
    expect(legacyEntries()[0].count).toBe(1);
    expect(rejectionEntries()).toHaveLength(0);

    // === Step 2: envelope-with-clientName but no trust record yet. Spec
    // says plugins must call mcp.identify first; if they don't, enforcer
    // returns identity-status:unconfirmed (no pendingApproval — nothing
    // declared). Shadow log records the would-be rejection.
    await router.dispatch({
      id: 's2',
      method: 'pane.list',
      params: {},
      clientName: 'fresh-plugin',
    });
    await drainWrites();
    await settle();

    const rejs = rejectionEntries();
    expect(rejs).toHaveLength(1);
    expect(rejs[0].clientName).toBe('fresh-plugin');
    expect(rejs[0].method).toBe('pane.list');
    expect(rejs[0].rejection.reason).toBe('identity-status');
    if (rejs[0].rejection.reason === 'identity-status') {
      expect(rejs[0].rejection.status).toBe('unconfirmed');
      expect(rejs[0].rejection.pendingApproval).toBeUndefined();
    }

    // === Step 3: proper handshake. mcp.identify + mcp.declarePermissions
    // are capability:null in the map, so the enforcer allows; trust DB
    // grows an 'unconfirmed' row with the declared capability set.
    await router.dispatch({
      id: 's3a',
      method: 'mcp.identify',
      params: {},
      clientName: 'demo-plugin',
      clientVersion: '0.1.0',
    });
    await router.dispatch({
      id: 's3b',
      method: 'mcp.declarePermissions',
      params: { permissions: ['pane.read', 'meta.write:custom.foo.*'] },
      clientName: 'demo-plugin',
    });
    await drainWrites();
    await settle();

    const onDiskAfterDeclare = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    expect(onDiskAfterDeclare.plugins['demo-plugin'].status).toBe(
      'unconfirmed',
    );
    expect(onDiskAfterDeclare.plugins['demo-plugin'].declaredCapabilities).toEqual([
      'pane.read',
      'meta.write:custom.foo.*',
    ]);
    // mcp.identify + mcp.declarePermissions don't emit rejections — still 1.
    expect(rejectionEntries()).toHaveLength(1);

    // === Step 4: unconfirmed plugin tries to use a declared capability.
    // Even though `pane.read` IS declared, the trust status is still
    // 'unconfirmed', so the enforcer rejects with identity-status. Shadow
    // mode logs but still runs the handler.
    const r4 = await router.dispatch({
      id: 's4',
      method: 'pane.list',
      params: {},
      clientName: 'demo-plugin',
    });
    expect(r4.ok).toBe(true); // shadow does not block
    await drainWrites();
    await settle();
    const rejsAfter4 = rejectionEntries();
    expect(rejsAfter4).toHaveLength(2);
    expect(rejsAfter4[1].clientName).toBe('demo-plugin');
    expect(rejsAfter4[1].rejection.reason).toBe('identity-status');

    // === Step 5: forge user-approved 'trusted' state (no UI in this PR).
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    raw.plugins['demo-plugin'].status = 'trusted';
    fs.writeFileSync(dbPath, JSON.stringify(raw));
    store.invalidateCache();

    // Now declared capability matches → allow → no new shadow entry.
    await router.dispatch({
      id: 's5',
      method: 'pane.list',
      params: {},
      clientName: 'demo-plugin',
    });
    await drainWrites();
    await settle();
    expect(rejectionEntries()).toHaveLength(2); // unchanged

    // === Step 6: trusted plugin tries an UNDECLARED capability
    // (input.send → terminal.send, not declared). Enforcer rejects with
    // capability-not-declared. Shadow logs.
    await router.dispatch({
      id: 's6',
      method: 'input.send',
      params: { text: 'hi' },
      clientName: 'demo-plugin',
    });
    await drainWrites();
    await settle();
    const rejsAfter6 = rejectionEntries();
    expect(rejsAfter6).toHaveLength(3);
    expect(rejsAfter6[2].method).toBe('input.send');
    expect(rejsAfter6[2].rejection.reason).toBe('capability-not-declared');
    if (rejsAfter6[2].rejection.reason === 'capability-not-declared') {
      expect(rejsAfter6[2].rejection.capability).toBe('terminal.send');
    }

    // === Step 7: trusted plugin tries setMetadata with a path NOT covered
    // by its declaration (`meta.write:custom.foo.*` covers custom.foo.X
    // but NOT 'label'). Multi-path 'all-or-nothing' → paths-partially-
    // allowed rejection variant with per-path detail.
    await router.dispatch({
      id: 's7',
      method: 'pane.setMetadata',
      params: { label: 'new-label', custom: { 'foo.x': 'val' } },
      clientName: 'demo-plugin',
    });
    await drainWrites();
    await settle();
    const rejsAfter7 = rejectionEntries();
    expect(rejsAfter7).toHaveLength(4);
    const r7 = rejsAfter7[3];
    expect(r7.method).toBe('pane.setMetadata');
    expect(r7.rejection.reason).toBe('paths-partially-allowed');
    if (r7.rejection.reason === 'paths-partially-allowed') {
      expect(r7.rejection.allowed).toEqual(['custom.foo.x']);
      expect(r7.rejection.rejected.map((x) => x.path)).toEqual(['label']);
    }

    // === Step 8: trusted plugin tries setMetadata with ONLY-allowed paths
    // (custom.foo.bar). Enforcer allows → no new shadow entry.
    await router.dispatch({
      id: 's8',
      method: 'pane.setMetadata',
      params: { custom: { 'foo.bar': 'val' } },
      clientName: 'demo-plugin',
    });
    await drainWrites();
    await settle();
    expect(rejectionEntries()).toHaveLength(4); // unchanged

    // === Step 9: identity-bootstrap RPCs (mcp.identify) always allowed.
    // No shadow log even though the caller is in a hostile trust state.
    raw.plugins['demo-plugin'].status = 'denied';
    fs.writeFileSync(dbPath, JSON.stringify(raw));
    store.invalidateCache();
    await router.dispatch({
      id: 's9',
      method: 'mcp.identify',
      params: {},
      clientName: 'demo-plugin',
    });
    await drainWrites();
    await settle();
    expect(rejectionEntries()).toHaveLength(4); // unchanged

    // === Step 10: denied plugin trying real RPC → identity-status:denied
    // shadow log entry, no pendingApproval (spec §4.3: denied never
    // regresses).
    await router.dispatch({
      id: 's10',
      method: 'pane.list',
      params: {},
      clientName: 'demo-plugin',
    });
    await drainWrites();
    await settle();
    const rejs10 = rejectionEntries();
    expect(rejs10).toHaveLength(5);
    expect(rejs10[4].rejection.reason).toBe('identity-status');
    if (rejs10[4].rejection.reason === 'identity-status') {
      expect(rejs10[4].rejection.status).toBe('denied');
      expect(rejs10[4].rejection.pendingApproval).toBeUndefined();
    }
  });

  it('produces legacy-traffic milestones at configured thresholds', async () => {
    // 6 envelope-less RPCs against `pane.list`. With milestones=[1,3,5],
    // log gets entries at calls 1, 3, 5 (3 entries).
    for (let i = 0; i < 6; i++) {
      await router.dispatch({
        id: `legacy-${i}`,
        method: 'pane.list',
        params: {},
      });
    }
    await drainWrites();
    await settle();

    const legacy = legacyEntries();
    expect(legacy).toHaveLength(3);
    expect(legacy.map((e) => e.count)).toEqual([1, 3, 5]);
    expect(legacy.every((e) => e.method === 'pane.list')).toBe(true);

    // No rejection entries — legacy is allowed.
    expect(rejectionEntries()).toHaveLength(0);
  });

  it('counts distinct methods separately', async () => {
    await router.dispatch({ id: 'a-1', method: 'pane.list', params: {} });
    await router.dispatch({ id: 'b-1', method: 'input.send', params: { text: 'x' } });
    await router.dispatch({ id: 'a-2', method: 'pane.list', params: {} });
    await drainWrites();
    await settle();

    // Each method's first call hits milestone 1 → 2 entries total.
    const legacy = legacyEntries();
    expect(legacy).toHaveLength(2);
    const byMethod = new Map(legacy.map((e) => [e.method, e.count]));
    expect(byMethod.get('pane.list')).toBe(1);
    expect(byMethod.get('input.send')).toBe(1);
  });
});
