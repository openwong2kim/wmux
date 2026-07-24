import { describe, expect, it, vi } from 'vitest';

// `system.identify` reads from electron.app — stub the bits we touch so
// the registrar can be exercised in a pure Node test environment.
vi.mock('electron', () => ({
  app: {
    getVersion: () => '2.9.0-test',
  },
}));

import { RpcRouter } from '../../RpcRouter';
import { registerSystemRpc } from '../system.rpc';
import { ALL_RPC_METHODS } from '../../../../shared/rpc';
import { WMUX_EVENT_TYPES, RING_CAPACITY } from '../../../../shared/events';

function setupRouter(): RpcRouter {
  const router = new RpcRouter();
  registerSystemRpc(router);
  return router;
}

describe('system.rpc — system.capabilities', () => {
  it('returns methods + event surface + paneMetadata capability object (M0-f)', async () => {
    const router = setupRouter();
    const res = await router.dispatch({
      id: 'caps-1',
      method: 'system.capabilities',
      params: {},
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const result = res.result as {
      methods: readonly string[];
      features: {
        paneMetadata: {
          optimisticConcurrency: true;
          mergeModes: readonly string[];
        };
        events: { types: readonly string[]; maxRingSize: number; bootId: string };
      };
    };

    // capabilities advertises ONLY methods registered on this router. The test
    // router has just registerSystemRpc, so control-pipe-only RPCs (lanlink.* /
    // daemon.*) and every other unregistered method are correctly excluded — a
    // wire caller can't invoke them, so they shouldn't be advertised (codex review).
    const registered = router.getRegisteredMethods();
    expect(result.methods).toEqual(ALL_RPC_METHODS.filter((m) => registered.includes(m)));
    expect(result.methods).toContain('system.capabilities');
    expect(result.methods).not.toContain('lanlink.pair.begin');
    expect(result.methods).not.toContain('daemon.inbox.poll');
    expect(result.features.events.types).toEqual(WMUX_EVENT_TYPES);
    expect(result.features.events.maxRingSize).toBe(RING_CAPACITY);
    expect(typeof result.features.events.bootId).toBe('string');
    expect(result.features.events.bootId.length).toBeGreaterThan(0);
  });

  it('M0-f features.paneMetadata is the documented capability object', async () => {
    const router = setupRouter();
    const res = await router.dispatch({
      id: 'caps-2',
      method: 'system.capabilities',
      params: {},
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const features = (res.result as { features: { paneMetadata: unknown } }).features;
    expect(features.paneMetadata).toEqual({
      optimisticConcurrency: true,
      mergeModes: ['merge', 'replace', 'replaceShared'],
    });
  });

  it('M0-f paneMetadata stays truthy in boolean context (v2.8.x regression guard)', async () => {
    // v2.8.x clients did `if (caps.features.paneMetadata)` against the
    // legacy boolean. The M0-f object must still pass that check so old
    // code keeps working without recompilation.
    const router = setupRouter();
    const res = await router.dispatch({
      id: 'caps-3',
      method: 'system.capabilities',
      params: {},
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const features = (res.result as { features: { paneMetadata: unknown } }).features;
    expect(Boolean(features.paneMetadata)).toBe(true);
  });
});

describe('system.rpc — system.identify', () => {
  it('returns app identity from the mocked electron app', async () => {
    const router = setupRouter();
    const res = await router.dispatch({
      id: 'identify-1',
      method: 'system.identify',
      params: {},
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const result = res.result as {
      app: string;
      version: string;
      platform: string;
      electronVersion: string;
    };
    expect(result.app).toBe('fmux');
    expect(result.version).toBe('2.9.0-test');
    expect(typeof result.platform).toBe('string');
  });
});
