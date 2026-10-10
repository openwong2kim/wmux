import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

import { resetProtectionMemoryForTests, withAutomationLease } from '../automationLease';
import { allowScopedRpcFallback, isProtectedScope } from '../browserScope';
import { __resetSurfaceRoutingForTesting } from '../surfaceRouting';
import { BrowserPolicyError } from '../../../shared/browserPolicy';

// Protected panes on the MCP lane: every operation is authorized by main; a
// refusal is final, and once a pane is known protected a transport failure
// denies. An unprotected pane keeps today's fail-open exactly.

const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };
const PROTECTED = { protected: true, epoch: 3, hosts: { mode: 'allowlist', allow: ['a.test'], block: [] } };

function answer(acquire: () => unknown) {
  mockSendRpc.mockImplementation((method: string) => {
    if (method === 'browser.lease.acquire') return acquire();
    return Promise.resolve({});
  });
}

beforeEach(() => {
  mockSendRpc.mockReset();
  __resetSurfaceRoutingForTesting();
  resetProtectionMemoryForTests();
});

describe('withAutomationLease — protected panes', () => {
  it('hands the body a scope carrying main’s protected authorization', async () => {
    answer(() => Promise.resolve({ token: 't', policy: PROTECTED }));
    const body = vi.fn(async (scope) => isProtectedScope(scope));
    await expect(withAutomationLease(deps, 'surface-1', body)).resolves.toBe(true);
    expect(body.mock.calls[0][0]).toMatchObject({ protection: PROTECTED });
  });

  it('rethrows policy_denied from main and never runs the body', async () => {
    answer(() => Promise.reject(new Error('browser.lease.acquire: policy_denied: not on this pane. Do not retry')));
    const body = vi.fn(async () => 'ran');
    await expect(withAutomationLease(deps, 'surface-1', body)).rejects.toBeInstanceOf(BrowserPolicyError);
    expect(body).not.toHaveBeenCalled();
  });

  it('authorizes a surface-less operation too (authorization-only acquire)', async () => {
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.lease.acquire') return Promise.reject(new Error('policy_denied: refused'));
      if (method === 'browser.cdp.info') return Promise.resolve({ targetsScoped: true, targets: [] });
      if (method === 'browser.tabs') return Promise.resolve({ ok: false });
      return Promise.resolve({});
    });
    const body = vi.fn(async () => 'ran');
    await expect(withAutomationLease(deps, undefined, body)).rejects.toBeInstanceOf(BrowserPolicyError);
    expect(body).not.toHaveBeenCalled();
  });

  it('denies on a transport error once the pane is known protected', async () => {
    answer(() => Promise.resolve({ token: null, policy: PROTECTED }));
    await withAutomationLease(deps, 'surface-1', async () => 'ok');
    answer(() => Promise.reject(new Error('ECONNRESET')));
    const body = vi.fn(async () => 'ran');
    await expect(withAutomationLease(deps, 'surface-1', body)).rejects.toMatchObject({ code: 'policy_denied' });
    expect(body).not.toHaveBeenCalled();
  });

  it('an unprotected pane stays fail-open on a transport error, exactly as before', async () => {
    answer(() => Promise.resolve({ token: null, policy: { protected: false } }));
    await withAutomationLease(deps, 'surface-1', async () => 'ok');
    answer(() => Promise.reject(new Error('ECONNRESET')));
    const body = vi.fn(async (scope) => isProtectedScope(scope));
    await expect(withAutomationLease(deps, 'surface-1', body)).resolves.toBe(false);
  });

  it('a first authorization that gets no answer at all runs the operation under deny-all checks', async () => {
    answer(() => Promise.reject(new Error('ECONNRESET')));
    const body = vi.fn(async (scope) => scope.protection);
    await expect(withAutomationLease(deps, 'surface-1', body)).resolves.toMatchObject({
      protected: true,
      hosts: { mode: 'allowlist', allow: [] },
    });
  });

  it('an older main (no policy field) is legacy, and an unnamed lease it grants is released', async () => {
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'stray' });
      if (method === 'browser.cdp.info') return Promise.resolve({ targetsScoped: true, targets: [] });
      if (method === 'browser.tabs') return Promise.resolve({ ok: false });
      return Promise.resolve({});
    });
    await expect(withAutomationLease(deps, undefined, async (scope) => isProtectedScope(scope))).resolves.toBe(false);
    expect(mockSendRpc).toHaveBeenCalledWith('browser.lease.release', { token: 'stray' });
  });
});

describe('allowScopedRpcFallback', () => {
  it('rethrows a policy refusal instead of falling back', () => {
    expect(() => allowScopedRpcFallback(new Error('browser.cdp.info: policy_denied: no'))).toThrow(BrowserPolicyError);
    expect(allowScopedRpcFallback(new Error('no page'))).toBeNull();
  });
});
