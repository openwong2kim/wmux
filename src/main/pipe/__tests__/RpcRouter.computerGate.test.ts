// The `computer` risk class is enforced in every mode. In shadow mode (the
// dev default, and what `mcp.mode: "shadow"` selects) a non-allow verdict is
// normally only logged and the handler still runs; for computer.* it is
// refused, like the commander gate. Real RpcRouter + real PluginTrustStore on
// a tmpdir + the real enforcer, the way src/main/index.ts wires them.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../RpcRouter';
import { PluginTrustStore } from '../../mcp/PluginTrustStore';
import { isAlwaysEnforcedMethod } from '../../mcp/methodCapabilityMap';

let tmpDir = '';
let store: PluginTrustStore;
let router: RpcRouter;
const reached = { listApps: 0, act: 0, browserOpen: 0 };
const shadowSink = vi.fn();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-computer-gate-'));
  store = new PluginTrustStore(path.join(tmpDir, 'plugin-trust.json'));
  router = new RpcRouter();
  reached.listApps = 0;
  reached.act = 0;
  reached.browserOpen = 0;
  shadowSink.mockReset();
  router.register('computer.listApps', async () => { reached.listApps++; return { apps: [] }; });
  router.register('computer.act', async () => { reached.act++; return { method: 'synthetic', verification: 'unverified' }; });
  router.register('browser.open', async () => { reached.browserOpen++; return { ok: true }; });
  router.setTrustLookup(async (name) => store.get(name));
  router.setShadowRejectionSink(shadowSink);
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const wire = (method: string, clientName: string) =>
  router.dispatch({ id: `${clientName}-${method}`, method: method as never, params: {}, clientName }, { externalWire: true });

describe('computer.* is enforced even in shadow mode', () => {
  it('marks only the computer methods as always enforced', () => {
    expect(isAlwaysEnforcedMethod('computer.listApps')).toBe(true);
    expect(isAlwaysEnforcedMethod('computer.act')).toBe(true);
    expect(isAlwaysEnforcedMethod('browser.open')).toBe(false);
    expect(isAlwaysEnforcedMethod('not.a.method')).toBe(false);
  });

  for (const mode of ['shadow', 'enforce'] as const) {
    describe(`${mode} mode`, () => {
      beforeEach(() => router.setEnforcementMode(mode));

      it('refuses an unapproved plugin before the handler runs', async () => {
        await store.upsertContact('probe-plugin', '1.0.0');
        const res = await wire('computer.listApps', 'probe-plugin');
        expect(res.ok).toBe(false);
        expect(reached.listApps).toBe(0);
        // The would-be rejection is still logged to the shadow sink.
        expect(shadowSink).toHaveBeenCalledWith(expect.objectContaining({ method: 'computer.listApps' }));
      });

      it('holds a plugin approved to observe to observation: computer.act needs computer.control', async () => {
        await store.setUserDecision('observer-plugin', 'trusted', ['computer.observe']);
        expect((await wire('computer.listApps', 'observer-plugin')).ok).toBe(true);
        expect(reached.listApps).toBe(1);
        expect((await wire('computer.act', 'observer-plugin')).ok).toBe(false);
        expect(reached.act).toBe(0);
      });

      it('still lets the bundled first-party server through', async () => {
        await store.upsertContact('claude-code', '2.1.167');
        expect((await wire('computer.listApps', 'claude-code')).ok).toBe(true);
        expect(reached.listApps).toBe(1);
      });
    });
  }

  it('leaves the shadow semantics of every other method alone', async () => {
    router.setEnforcementMode('shadow');
    await store.upsertContact('probe-plugin', '1.0.0');
    expect((await wire('browser.open', 'probe-plugin')).ok).toBe(true);
    expect(reached.browserOpen).toBe(1);
  });
});
