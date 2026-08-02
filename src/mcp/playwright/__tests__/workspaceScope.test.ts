import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

import {
  allowScopedRpcFallback,
  isWorkspaceScopeUnresolvedError,
  requireBrowserTargetScope,
  sendScopedBrowserRpc,
  WorkspaceScopeUnresolvedError,
} from '../browserScope';

describe('browser tool workspace scope', () => {
  it('refuses an empty strict-resolver result', async () => {
    await expect(
      requireBrowserTargetScope({ resolveWorkspaceId: async () => '' }, 'surface-1'),
    ).rejects.toThrow('WORKSPACE_SCOPE_UNRESOLVED');
  });

  it('never converts a workspace-scope refusal into an RPC fallback', () => {
    const refusal = new WorkspaceScopeUnresolvedError(
      'legacy main cannot prove ownership',
    );
    expect(isWorkspaceScopeUnresolvedError(refusal)).toBe(true);
    expect(isWorkspaceScopeUnresolvedError(
      new Error('WORKSPACE_SCOPE_UNRESOLVED: message text is not the type contract'),
    )).toBe(false);
    expect(() => allowScopedRpcFallback(
      refusal,
    )).toThrow('WORKSPACE_SCOPE_UNRESOLVED');
    expect(allowScopedRpcFallback(new Error('Playwright page unavailable'))).toBeNull();
  });

  it('makes the verified scope authoritative over caller-supplied RPC params', async () => {
    mockSendRpc.mockResolvedValueOnce({ ok: true });

    await sendScopedBrowserRpc(
      'browser.evaluate',
      { workspaceId: 'ws-caller' },
      {
        expression: 'document.title',
        workspaceId: 'ws-foreign',
        surfaceId: 'surface-not-leased',
      },
    );

    expect(mockSendRpc).toHaveBeenCalledWith('browser.evaluate', {
      expression: 'document.title',
      workspaceId: 'ws-caller',
    });
  });

  it('refuses a hand-built empty scope before issuing an RPC', async () => {
    mockSendRpc.mockClear();

    await expect(sendScopedBrowserRpc(
      'browser.evaluate',
      { workspaceId: '' },
      { expression: 'document.title' },
    )).rejects.toThrow('WORKSPACE_SCOPE_UNRESOLVED');
    expect(mockSendRpc).not.toHaveBeenCalled();
  });

  it('keeps direct browser fallback RPCs behind the scope-required helper', () => {
    const root = path.join(__dirname, '..');
    const files = [
      'automationLease.ts',
      'dom-intelligence.ts',
      'page-eval.ts',
      'markdown-extractor.ts',
      'snapshot.ts',
      ...fs.readdirSync(path.join(root, 'tools'))
        .filter((name) => name.endsWith('.ts'))
        .map((name) => `tools/${name}`),
    ];
    for (const relative of files) {
      const source = fs.readFileSync(path.join(root, relative), 'utf8');
      const directBrowserCalls = source.match(/sendRpc\(\s*['"]browser\.[^'"]+/g) ?? [];
      if (relative === 'tools/navigation.ts') {
        // browser.tabs has its own typed workspace contract; every other
        // navigation RPC goes through sendScopedBrowserRpc.
        expect(directBrowserCalls).toEqual(["sendRpc('browser.tabs"]);
      } else if (relative === 'automationLease.ts') {
        // Once acquired with a workspace scope, the opaque token is the
        // capability used by renew/release. Keep this allowlist exact.
        expect(directBrowserCalls).toEqual([
          "sendRpc('browser.lease.release",
          "sendRpc('browser.lease.renew",
          "sendRpc('browser.lease.release",
          "sendRpc('browser.lease.renew",
          "sendRpc('browser.lease.release",
        ]);
      } else {
        expect(directBrowserCalls, `${relative} must not bypass sendScopedBrowserRpc`).toEqual([]);
      }

      // Tool code may only use the required scope-taking engine entry point.
      expect(source, `${relative} must not call optional-scope getPage`).not.toMatch(
        /await\s+engine\.getPage\(/,
      );
    }
  });
});
