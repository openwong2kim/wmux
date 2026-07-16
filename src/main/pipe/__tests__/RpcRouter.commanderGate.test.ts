// BYOB P4 — dynamic verification of the commander role gate through the REAL
// enforce-mode dispatch pipeline (same wiring pattern as
// RpcRouter.firstParty.enforce.test.ts, which caught the first-party lockout
// only because it dispatched through the assembled objects).
//
// The production scenario under test: an EXTERNAL brain host (Hermes/OpenClaw)
// spawns the bundled MCP child in --commander mode. Its clientInfo name is NOT
// first-party, the trust DB has it unconfirmed at best — without the commander
// lane every call dies under enforce (eng review P0-1). With a VALID per-spawn
// token the curated commander methods must pass, teardown methods must be
// refused, and an invalid/stale token must fail the WHOLE request closed
// rather than demoting to an ordinary external caller (eng review P1).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcRouter } from '../RpcRouter';
import { PluginTrustStore } from '../../mcp/PluginTrustStore';
import { registerMcpPluginRpc } from '../handlers/mcp.rpc';
import { mintCommanderToken, revokeCommanderToken } from '../../deck/commanderTrust';
import type { RpcContext } from '../../../shared/rpc';

let tmpDir = '';
let store: PluginTrustStore;
let router: RpcRouter;
let seenCtx: RpcContext | undefined;

function wireEnforced(): void {
  registerMcpPluginRpc(router, store);
  seenCtx = undefined;
  router.register('pane.list', async (_params, ctx) => {
    seenCtx = ctx;
    return { panes: [] };
  });
  // Real confinement logic (mirrors pane.rpc): explicit foreign workspace
  // refused, omitted pinned to the commander's own.
  router.register('pane.split', async (params, ctx) => {
    let workspaceId = params['workspaceId'] as string | undefined;
    if (ctx?.commanderWorkspace) {
      if (workspaceId !== undefined && workspaceId !== ctx.commanderWorkspace) {
        throw new Error("pane.split: workspace is outside the commander's workspace");
      }
      workspaceId = ctx.commanderWorkspace;
    }
    return { ok: true, paneId: 'p2', workspaceId };
  });
  router.register('pane.close', async () => ({ ok: true }));
  router.register('surface.close', async () => ({ ok: true }));
  router.register('workspace.new', async () => ({ ok: true, id: 'ws-9' }));
  router.setTrustLookup(async (name) => store.get(name));
  router.setEnforcementMode('enforce');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cmdr-gate-'));
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

// An external brain host's self-declared clientInfo — deliberately NOT
// first-party and NOT present in the trust DB.
const HERMES = 'hermes-acp';

describe('commander role gate — validated token (the external-brain enable)', () => {
  it('allows curated commander methods for a non-first-party host under enforce', async () => {
    const token = mintCommanderToken('ws-brain');
    try {
      for (const method of ['pane.list', 'pane.split'] as const) {
        const res = await router.dispatch({
          id: `t-${method}`,
          method,
          params: {},
          clientName: HERMES,
          commanderToken: token,
        });
        expect(res.ok, `${method} should pass the commander lane`).toBe(true);
      }
      // The validated binding is on ctx for handlers (ownership confinement).
      expect(seenCtx?.commanderWorkspace).toBe('ws-brain');
    } finally {
      revokeCommanderToken(token);
    }
  });

  it('confines mutating creates to the commander workspace (explicit foreign id refused, omitted pinned)', async () => {
    const token = mintCommanderToken('ws-brain');
    try {
      const foreign = await router.dispatch({
        id: 't-split-foreign',
        method: 'pane.split',
        params: { direction: 'horizontal', workspaceId: 'ws-other' },
        clientName: HERMES,
        commanderToken: token,
      });
      expect(foreign.ok).toBe(false);
      expect(String((foreign as { error?: string }).error)).toMatch(/outside the commander/);

      const pinned = await router.dispatch({
        id: 't-split-pinned',
        method: 'pane.split',
        params: { direction: 'horizontal' },
        clientName: HERMES,
        commanderToken: token,
      });
      expect(pinned.ok).toBe(true);
      expect((pinned as { result?: { workspaceId?: string } }).result?.workspaceId).toBe('ws-brain');
    } finally {
      revokeCommanderToken(token);
    }
  });

  it('refuses teardown methods even WITH a valid token (Layer 2 backstop)', async () => {
    const token = mintCommanderToken('ws-brain');
    try {
      for (const method of ['pane.close', 'surface.close'] as const) {
        const res = await router.dispatch({
          id: `t-${method}`,
          method,
          params: {},
          clientName: HERMES,
          commanderToken: token,
        });
        expect(res.ok).toBe(false);
        expect(String((res as { error?: string }).error)).toMatch(/teardown gate/);
      }
    } finally {
      revokeCommanderToken(token);
    }
  });

  it('a method outside the commander lane falls through to normal enforcement (rejected)', async () => {
    const token = mintCommanderToken('ws-brain');
    try {
      const res = await router.dispatch({
        id: 't-outside',
        method: 'workspace.new',
        params: {},
        clientName: HERMES,
        commanderToken: token,
      });
      // Not in COMMANDER_RPC_METHODS and hermes-acp is not trusted → the
      // enforcer rejects. A coverage gap surfaces as rejection, never as
      // silent widening.
      expect(res.ok).toBe(false);
    } finally {
      revokeCommanderToken(token);
    }
  });
});

describe('commander role gate — claimed but invalid (fail closed, never demote)', () => {
  it('rejects EVERY request carrying a stale/unknown token — even read-only methods', async () => {
    const token = mintCommanderToken('ws-brain');
    revokeCommanderToken(token); // adapter disposed; child still running
    for (const method of ['pane.list', 'pane.close'] as const) {
      const res = await router.dispatch({
        id: `t-stale-${method}`,
        method,
        params: {},
        clientName: HERMES,
        commanderToken: token,
      });
      expect(res.ok).toBe(false);
      expect(String((res as { error?: string }).error)).toMatch(/commander token invalid/);
    }
  });

  it('rejects an EMPTY token claim (token env lost in a commander-mode child)', async () => {
    const res = await router.dispatch({
      id: 't-empty',
      method: 'pane.list',
      params: {},
      clientName: HERMES,
      commanderToken: '',
    });
    expect(res.ok).toBe(false);
  });

  it('a request WITHOUT the field is an ordinary caller — gate not involved', async () => {
    // Ordinary pane-agent path unchanged: no role claim, normal enforcement
    // decides (here: unknown client + enforce → rejected by the enforcer, but
    // NOT by the commander gate's error text).
    const res = await router.dispatch({
      id: 't-none',
      method: 'pane.list',
      params: {},
      clientName: HERMES,
    });
    if (!res.ok) {
      expect(String((res as { error?: string }).error)).not.toMatch(/commander token/);
    }
  });
});
