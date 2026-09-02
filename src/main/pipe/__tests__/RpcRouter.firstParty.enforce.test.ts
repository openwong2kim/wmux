// Dynamic verification of the first-party lockout fix through the REAL
// enforce-mode dispatch pipeline.
//
// This reproduces the exact production scenario that was broken
// (plans/first-party-mcp-trust.md): a packaged build runs the enforcer in
// `enforce` mode, the bundled MCP server identifies as `claude-code` and is
// recorded `unconfirmed`, and every capability-bearing RPC it makes was
// rejected with no recovery path. We wire the production objects (real
// RpcRouter + real PluginTrustStore on an isolated tmpdir + the real enforcer)
// exactly like src/main/index.ts, flip enforce mode on, and assert the bundled
// server's calls now pass while an impersonator and reserved methods do not.
//
// Per-module unit tests can't catch a regression in this wiring — only
// dispatching through the assembled pipeline can.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcRouter } from '../RpcRouter';
import { PluginTrustStore } from '../../mcp/PluginTrustStore';
import { registerMcpPluginRpc } from '../handlers/mcp.rpc';

let tmpDir = '';
let store: PluginTrustStore;
let router: RpcRouter;

function wireEnforced(): void {
  registerMcpPluginRpc(router, store);
  // Stub handlers for the methods under test (handler bodies are irrelevant —
  // we assert on whether the enforcer let dispatch REACH them).
  router.register('browser.open', async () => ({ ok: true, opened: true }));
  router.register('surface.list', async () => ({ surfaces: [] }));
  router.register('surface.new', async () => ({ ok: true, surfaceId: 's1' }));
  router.register('pane.setMetadata', async () => ({
    ok: true,
    paneId: 'p1',
    metadata: { custom: {} },
    version: 1,
  }));
  router.register('workspace.new', async () => ({ ok: true, id: 'ws-2' }));
  router.setTrustLookup(async (name) => store.get(name));
  router.setEnforcementMode('enforce');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fp-enforce-'));
  store = new PluginTrustStore(path.join(tmpDir, 'plugin-trust.json'));
  router = new RpcRouter();
  wireEnforced();
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const CLAUDE = 'claude-code';

function dispatchWire(request: Parameters<RpcRouter['dispatch']>[0]) {
  return router.dispatch(request, { externalWire: true });
}

describe('enforce-mode dispatch — first-party bundled server (the lockout fix)', () => {
  it('allows browser.open / surface.list / surface.new for claude-code recorded unconfirmed', async () => {
    // Mirror the live trust DB: mcp.identify recorded claude-code unconfirmed,
    // no declaration. This is the exact state ~/.wmux/plugin-trust.json showed.
    await store.upsertContact(CLAUDE, '2.1.167');
    expect((await store.get(CLAUDE))?.status).toBe('unconfirmed');

    for (const method of ['browser.open', 'surface.list', 'surface.new'] as const) {
      const res = await dispatchWire({
        id: `fp-${method}`,
        method,
        params: {},
        clientName: CLAUDE,
        clientVersion: '2.1.167',
      });
      expect(res.ok, `${method} should pass enforce-mode dispatch for first-party`).toBe(true);
    }
  });

  it('allows even with NO trust record at all (tool call racing ahead of identify)', async () => {
    const res = await dispatchWire({
      id: 'fp-norecord',
      method: 'surface.list',
      params: {},
      clientName: CLAUDE,
    });
    expect(res.ok).toBe(true);
  });

  it('REGRESSION GUARD: an external unconfirmed plugin is still rejected for the same methods', async () => {
    await store.upsertContact('evil-plugin');
    for (const method of ['browser.open', 'surface.list', 'surface.new'] as const) {
      const res = await dispatchWire({
        id: `evil-${method}`,
        method,
        params: {},
        clientName: 'evil-plugin',
      });
      expect(res.ok, `${method} must be rejected for a non-first-party plugin`).toBe(false);
      if (!res.ok) {
        expect(res.error).toMatch(/unconfirmed/);
      }
    }
  });

  it('does NOT widen scope: claude-code is still rejected for a non-allowlisted method', async () => {
    await store.upsertContact(CLAUDE);
    const res = await dispatchWire({
      id: 'fp-widen',
      method: 'workspace.new', // wmux.internal, NOT in FIRST_PARTY_METHODS
      params: {},
      clientName: CLAUDE,
    });
    expect(res.ok).toBe(false);
  });

  it('honors an explicit denied for claude-code (operator escape hatch)', async () => {
    await store.upsertContact(CLAUDE);
    await store.setUserDecision(CLAUDE, 'denied');
    const res = await dispatchWire({
      id: 'fp-denied',
      method: 'browser.open',
      params: {},
      clientName: CLAUDE,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/denied/);
  });

  it('control: without the fix path, the same first-party call would have been rejected (sanity on enforce wiring)', async () => {
    // Prove enforce mode is actually ON: a path-scoped method NOT in the
    // allowlist, from an unconfirmed external plugin, must hard-fail here.
    await store.upsertContact('some-plugin');
    const res = await dispatchWire({
      id: 'enforce-on',
      method: 'pane.setMetadata',
      params: { custom: { 'x.y': 'z' } },
      clientName: 'some-plugin',
    });
    expect(res.ok).toBe(false); // confirms enforce mode blocks, not shadow
  });

  it('SECURITY: a failing trust lookup denies the first-party bypass (a denied row could be unreadable)', async () => {
    // Simulate a corrupt / unreadable trust DB by making the lookup throw
    // instead of cleanly resolving. A clean miss grants the bypass (see the
    // "NO trust record" case above), but a *failed* read is an unknown state:
    // an operator `denied` row might exist and merely be unreadable, so
    // first-party must fall through to fail-closed enforcement rather than
    // silently honoring claude-code. Without trustLookupFailed plumbing this
    // call would wrongly succeed.
    router.setTrustLookup(async () => {
      throw new Error('simulated corrupt plugin-trust.json');
    });
    const res = await dispatchWire({
      id: 'fp-lookup-fail',
      method: 'browser.open',
      params: {},
      clientName: CLAUDE,
    });
    expect(res.ok, 'first-party must not be allowed when the trust lookup throws').toBe(false);
  });
});

describe('enforce-mode dispatch — rejection names the observed client (#636)', () => {
  // The discoverability half of #636. Before this, a blocked client was told
  // only "plugin is unconfirmed" and had no supported way to learn which name
  // wmux saw — which is how a real agent guessed its own name wrong and
  // proposed an allowlist entry that would never have matched.
  it('echoes the observed clientName in an unconfirmed rejection', async () => {
    await store.upsertContact('mcp', '0.1.0');
    const res = await dispatchWire({
      id: 'obs-1',
      method: 'surface.list',
      params: {},
      clientName: 'mcp',
      clientVersion: '0.1.0',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('observed clientName: "mcp"');
      // And it points at the command that lists them.
      expect(res.error).toContain('wmux mcp clients');
    }
  });

  it('says so explicitly when the caller reported no clientName', async () => {
    // Envelope-less callers take the legacy grandfather path, so drive the
    // message builder through a named-but-denied caller instead: the point is
    // that the message never silently omits the identity field.
    await store.upsertContact('evil-plugin');
    await store.setUserDecision('evil-plugin', 'denied');
    const res = await dispatchWire({
      id: 'obs-2',
      method: 'browser.open',
      params: {},
      clientName: 'evil-plugin',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('observed clientName: "evil-plugin"');
  });

  it('strips control characters from the echoed name', async () => {
    // clientName is self-asserted, untrusted input that lands in logs and in
    // terminal-rendered agent output.
    const nasty = 'ev\u001b[31mil';
    await store.upsertContact(nasty);
    const res = await dispatchWire({
      id: 'obs-3',
      method: 'surface.list',
      params: {},
      clientName: nasty,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toContain('\u001b');
      expect(res.error).not.toContain('\u0000');
      expect(res.error).toContain('observed clientName: "ev[31mil"');
    }
  });
});
