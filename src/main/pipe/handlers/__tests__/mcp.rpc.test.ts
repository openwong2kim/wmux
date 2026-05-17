import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import { registerMcpPluginRpc } from '../mcp.rpc';
import { PluginTrustStore } from '../../../mcp/PluginTrustStore';
import type { McpDeclarePermissionsResult, McpIdentifyResult } from '../../../../shared/rpc';

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

  it('refreshes lastSeen on subsequent calls', async () => {
    await router.dispatch({
      id: 'r-3a',
      method: 'mcp.identify',
      params: {},
      clientName: 'claude-ai',
    });
    await new Promise((r) => setTimeout(r, 5));
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
    expect(result.accepted).toEqual([
      'pane.read',
      'meta.write:custom.dashboard.*',
    ]);
    expect(result.identity.declaredCapabilities).toEqual(result.accepted);
    expect(result.identity.rationale).toBe('demo');
  });

  it('rejects the entire declaration on any grammar error', async () => {
    const response = await router.dispatch({
      id: 'r-5',
      method: 'mcp.declarePermissions',
      params: {
        permissions: ['pane.read', 'pane.teleport'],
      },
      clientName: 'demo-plugin',
    });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error).toMatch(/unknown capability/);
    // Nothing should have been persisted under the rejected name
    expect(await store.get('demo-plugin')).toBeUndefined();
  });

  it('records the caller as legacy when no clientName is present', async () => {
    // Plugin sends a valid permission declaration but no envelope identity —
    // the substrate records the call under "unknown" so audit logs surface it.
    const response = await router.dispatch({
      id: 'r-6',
      method: 'mcp.declarePermissions',
      params: { permissions: ['pane.read'] },
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const result = response.result as McpDeclarePermissionsResult;
    expect(result.identity.name).toBe('unknown');
  });
});
