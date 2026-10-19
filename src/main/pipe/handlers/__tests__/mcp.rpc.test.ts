import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import { registerMcpPluginRpc } from '../mcp.rpc';
import { PluginTrustStore } from '../../../mcp/PluginTrustStore';
import type { McpDeclarePermissionsResult, McpIdentifyResult } from '../../../../shared/rpc';
import { deliberateSleep } from '../../../../test-utils/waitFor';

let tmpDir = '';
let dbPath = '';
let store: PluginTrustStore;
let router: RpcRouter;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-mcp-rpc-test-'));
  dbPath = path.join(tmpDir, 'plugin-trust.json');
  store = new PluginTrustStore(dbPath);
  router = new RpcRouter();
  registerMcpPluginRpc(router, store);
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('mcp.identify', () => {
  it('records the caller from the request envelope', async () => {
    const response = await router.dispatch({
      id: 'r-1',
      method: 'mcp.identify',
      params: { version: '1.0.94' },
      clientName: 'claude-ai',
      clientVersion: '1.0.94',
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const result = response.result as McpIdentifyResult;
    expect(result.identity.name).toBe('claude-ai');
    expect(result.identity.version).toBe('1.0.94');
    expect(result.identity.status).toBe('unconfirmed');

    // Trust DB persisted the entry
    const persisted = await store.get('claude-ai');
    expect(persisted?.name).toBe('claude-ai');
  });

  it('falls back to params.name when envelope is missing', async () => {
    const response = await router.dispatch({
      id: 'r-2',
      method: 'mcp.identify',
      params: { name: 'cursor-ai' },
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const result = response.result as McpIdentifyResult;
    expect(result.identity.name).toBe('cursor-ai');
  });

  it('envelope clientName wins over params.name when both are present', async () => {
    // Spec contract (mcp.rpc.ts:23-24): the wire envelope is authoritative
    // so a plugin can't claim a different identity per-call by stuffing
    // params.name with someone else's name.
    const response = await router.dispatch({
      id: 'r-2b',
      method: 'mcp.identify',
      params: { name: 'forged-name' },
      clientName: 'envelope-name',
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const result = response.result as McpIdentifyResult;
    expect(result.identity.name).toBe('envelope-name');
    expect(await store.get('forged-name')).toBeUndefined();
  });

  it('refreshes lastSeen on subsequent calls', async () => {
    await router.dispatch({
      id: 'r-3a',
      method: 'mcp.identify',
      params: {},
      clientName: 'claude-ai',
    });
    await deliberateSleep(5, 'clock: the second identify gets a later timestamp');
    const second = await router.dispatch({
      id: 'r-3b',
      method: 'mcp.identify',
      params: {},
      clientName: 'claude-ai',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const result = second.result as McpIdentifyResult;
    expect(result.identity.lastSeen).toBeGreaterThanOrEqual(result.identity.firstSeen);
  });
});

describe('mcp.declarePermissions', () => {
  it('records the declared capability set', async () => {
    const response = await router.dispatch({
      id: 'r-4',
      method: 'mcp.declarePermissions',
      params: {
        permissions: ['pane.read', 'meta.write:custom.dashboard.*'],
        rationale: 'demo',
      },
      clientName: 'demo-plugin',
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const result = response.result as McpDeclarePermissionsResult;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accepted).toEqual([
      'pane.read',
      'meta.write:custom.dashboard.*',
    ]);
    expect(result.identity.declaredCapabilities).toEqual(result.accepted);
    expect(result.identity.rationale).toBe('demo');
  });

  it('rejects the entire declaration with structured per-entry errors', async () => {
    // RPC envelope stays ok=true (the call itself succeeded); application
    // outcome is `result.ok=false` with per-entry rejection detail.
    const response = await router.dispatch({
      id: 'r-5',
      method: 'mcp.declarePermissions',
      params: {
        permissions: ['pane.read', 'pane.teleport', 42],
      },
      clientName: 'demo-plugin',
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const result = response.result as McpDeclarePermissionsResult;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].index).toBe(1);
    expect(result.errors[0].permission).toBe('pane.teleport');
    expect(result.errors[0].reason).toMatch(/unknown capability/);
    expect(result.errors[1].index).toBe(2);
    expect(result.errors[1].permission).toBe(42);
    // Nothing should have been persisted under the rejected name
    expect(await store.get('demo-plugin')).toBeUndefined();
  });

  it('trims wire-form whitespace before persisting the declaration', async () => {
    // The handler must normalize leading/trailing whitespace so that a
    // trusted plugin re-declaring `'pane.read '` doesn't trigger spurious
    // widening demotion (set-diff would see the formatted-vs-unformatted
    // strings as different capabilities). Spec §4.2 — substrate stores the
    // trimmed form, not the wire form.
    const response = await router.dispatch({
      id: 'r-trim',
      method: 'mcp.declarePermissions',
      params: {
        permissions: ['  pane.read', 'meta.write:custom.x.*  ', '\tevents.subscribe\n'],
      },
      clientName: 'demo-plugin',
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const result = response.result as McpDeclarePermissionsResult;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accepted).toEqual([
      'pane.read',
      'meta.write:custom.x.*',
      'events.subscribe',
    ]);
    expect(result.identity.declaredCapabilities).toEqual(result.accepted);
  });

  it('does not demote a trusted plugin when re-declaring with whitespace differences', async () => {
    // F-1 end-to-end: declare → forge trusted on disk → re-declare with
    // cosmetic whitespace changes → assert still trusted. This guards the
    // template-reformat regression path the cross-model review surfaced.
    await router.dispatch({
      id: 'r-trim-1',
      method: 'mcp.declarePermissions',
      params: { permissions: ['pane.read', 'meta.write:custom.x.*'] },
      clientName: 'trim-test',
    });
    // Forge trusted on disk (no user-approval UI yet in this PR).
    const persisted = await store.get('trim-test');
    expect(persisted).toBeDefined();
    if (!persisted) return;
    // Write through the store's mutate path to keep cache/disk consistent.
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    raw.plugins['trim-test'].status = 'trusted';
    fs.writeFileSync(dbPath, JSON.stringify(raw));
    store.invalidateCache();

    // Same capability set, just reformatted with whitespace.
    const reDeclare = await router.dispatch({
      id: 'r-trim-2',
      method: 'mcp.declarePermissions',
      params: { permissions: ['  pane.read  ', '\tmeta.write:custom.x.*\n'] },
      clientName: 'trim-test',
    });
    expect(reDeclare.ok).toBe(true);
    if (!reDeclare.ok) return;
    const result = reDeclare.result as McpDeclarePermissionsResult;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Trust survives the cosmetic re-declaration.
    expect(result.identity.status).toBe('trusted');
  });

  it('returns a structured rejection when permissions is not an array', async () => {
    const response = await router.dispatch({
      id: 'r-5b',
      method: 'mcp.declarePermissions',
      params: { permissions: 'pane.read' as unknown as string[] },
      clientName: 'demo-plugin',
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const result = response.result as McpDeclarePermissionsResult;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].index).toBe(-1);
    expect(result.errors[0].reason).toBe('permissions must be an array');
  });

  it('records the caller under "unknown" when no clientName is present', async () => {
    // Plugin sends a valid permission declaration but no envelope identity.
    // mcp.declarePermissions is an identity-owning method (the handler is
    // the one writing to the trust DB), so the resulting record is
    // 'unconfirmed' — the spec's `legacy` status is reserved for the
    // RpcRouter-level audit row produced by envelope-less calls to NON-mcp
    // methods (see RpcRouter.legacyRecorder).
    const response = await router.dispatch({
      id: 'r-6',
      method: 'mcp.declarePermissions',
      params: { permissions: ['pane.read'] },
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const result = response.result as McpDeclarePermissionsResult;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.name).toBe('unknown');
    expect(result.identity.status).toBe('unconfirmed');
  });
});
