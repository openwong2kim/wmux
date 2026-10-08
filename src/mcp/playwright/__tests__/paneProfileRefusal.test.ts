import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Per-pane browser profiles: main fails closed with PANE_PROFILE_UNRESOLVED
 * when the caller's workspace binds profiles per pane but the caller's pane
 * cannot be told. The agent must read WHY and must not be steered to another
 * browser — falling back would act as a different signed-in account. So every
 * MCP layer that used to swallow, retry, or relabel a failed RPC has to pass
 * this one through, explained.
 */

const { mockSendRpc, mockConnectOverCDP } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  mockConnectOverCDP: vi.fn(),
}));
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));
vi.mock('../lazyPlaywright', () => ({
  loadPlaywright: () => ({ chromium: { connectOverCDP: mockConnectOverCDP }, devices: {} }),
}));

import {
  allowScopedRpcFallback,
  PaneProfileUnresolvedError,
  paneProfileRefusal,
  requireBrowserTargetScope,
  sendScopedBrowserRpc,
} from '../browserScope';
import { describeToolError } from '../toolError';
import { toolErrorCodeFor } from '../resultTrailer';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { __resetSurfaceRoutingForTesting, noteOpenedSurface } from '../surfaceRouting';

// What attemptRpc rejects with: RpcRouter returns the handler's err.message.
const RAW = 'PANE_PROFILE_UNRESOLVED: pty-9 is not owned by any pane of ws-1';
const refuseAll = () => mockSendRpc.mockRejectedValue(new Error(RAW));

beforeEach(() => {
  mockSendRpc.mockReset();
  mockConnectOverCDP.mockReset();
  __resetSurfaceRoutingForTesting();
  (PlaywrightEngine as unknown as { instance: PlaywrightEngine | null }).instance = null;
});

describe('paneProfileRefusal', () => {
  it('explains main\'s raw refusal once, without repeating main\'s own text', () => {
    const refusal = paneProfileRefusal(new Error(RAW));
    expect(refusal).toBeInstanceOf(PaneProfileUnresolvedError);
    expect(refusal?.message).toMatch(/^PANE_PROFILE_UNRESOLVED: the browser profile for this pane could not be resolved/);
    expect(refusal?.message).toMatch(/Do not retry through another browser, profile or account/);
    expect(refusal?.message).not.toContain('pty-9');
    expect(refusal?.message.match(/PANE_PROFILE_UNRESOLVED/g)).toHaveLength(1);
  });

  it('recognizes main\'s `<method>: CODE:` shape and the typed error', () => {
    expect(paneProfileRefusal(new Error(`browser.cdp.info: ${RAW}`))).toBeInstanceOf(PaneProfileUnresolvedError);
    const typed = new PaneProfileUnresolvedError();
    expect(paneProfileRefusal(typed)).toBe(typed);
  });

  it('never reclassifies an error that merely quotes the code', () => {
    expect(paneProfileRefusal(new Error(`Timeout waiting for title "${RAW}"`))).toBeNull();
    expect(paneProfileRefusal(new Error(`a: b.c: ${RAW}`))).toBeNull();
    expect(paneProfileRefusal(new Error('WORKSPACE_SCOPE_UNRESOLVED: nope'))).toBeNull();
    expect(paneProfileRefusal(undefined)).toBeNull();
  });

  it('renders as the explanation with no call-path noise, classified as a scope refusal', () => {
    const text = describeToolError(new Error(`automationLease: ${RAW}`));
    expect(text).toMatch(/^PANE_PROFILE_UNRESOLVED: the browser profile for this pane/);
    expect(text).not.toMatch(/automationLease|\n\s+at /);
    expect(toolErrorCodeFor(new Error(RAW))).toBe('scope_refused');
  });
});

describe('browser scope layers pass the refusal through', () => {
  it('the scoped RPC funnel rejects with the explained refusal', async () => {
    refuseAll();
    await expect(
      sendScopedBrowserRpc('browser.navigate', { workspaceId: 'ws-1', surfaceId: 's-1' }, { url: 'https://a.test/' }),
    ).rejects.toBeInstanceOf(PaneProfileUnresolvedError);
  });

  it('routing refuses instead of proceeding on this connection\'s pin', async () => {
    noteOpenedSurface('ws-1', 's-pinned');
    refuseAll();
    await expect(requireBrowserTargetScope({ resolveWorkspaceId: async () => 'ws-1' })).rejects.toBeInstanceOf(
      PaneProfileUnresolvedError,
    );
  });

  it('never falls back to the RPC lane', () => {
    expect(() => allowScopedRpcFallback(new Error(RAW))).toThrow(PaneProfileUnresolvedError);
  });

  it('the engine stops at the first refusal instead of retrying the connection', async () => {
    refuseAll();
    await expect(PlaywrightEngine.getInstance().ensureConnected('ws-1')).rejects.toBeInstanceOf(
      PaneProfileUnresolvedError,
    );
    expect(mockSendRpc).toHaveBeenCalledTimes(1);
    expect(mockConnectOverCDP).not.toHaveBeenCalled();
  });

  it('page selection surfaces the refusal, not "cannot determine the workspace"', async () => {
    refuseAll();
    const engine = PlaywrightEngine.getInstance();
    const error = await engine.getPageForScope({ workspaceId: 'ws-1' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaneProfileUnresolvedError);
    expect((error as Error).message).not.toMatch(/cannot determine which workspace/);
  });
});
