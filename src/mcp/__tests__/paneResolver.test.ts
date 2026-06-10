import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimPinnedRoute,
  getPinnedRoute,
  __resetPaneResolverForTesting,
} from '../paneResolver';
import type { ClaimDeps } from '../paneResolver';

function makeDeps(overrides: Partial<ClaimDeps> = {}): ClaimDeps {
  return {
    sendRpc: overrides.sendRpc ?? vi.fn(),
  };
}

describe('claimPinnedRoute / getPinnedRoute', () => {
  beforeEach(() => {
    __resetPaneResolverForTesting();
  });

  it('returns null from getPinnedRoute before any claim', () => {
    expect(getPinnedRoute()).toBeNull();
  });

  it('claims a dedicated workspace and pins BOTH ids', async () => {
    const sendRpc = vi.fn().mockResolvedValue({
      ptyId: 'pty-42',
      workspaceId: 'ws-new',
      workspaceName: 'MCP',
    });
    const deps = makeDeps({ sendRpc });

    const route = await claimPinnedRoute(deps);

    expect(route).toEqual({ ptyId: 'pty-42', workspaceId: 'ws-new' });
    expect(sendRpc).toHaveBeenCalledWith('mcp.claimWorkspace', { name: 'MCP' });
    // The pin must carry the workspaceId so terminal RPCs have a verified id to
    // assert against — never the spoofable env hint.
    expect(getPinnedRoute()).toEqual({ ptyId: 'pty-42', workspaceId: 'ws-new' });
  });

  it('pins the claimed route so subsequent claims reuse it without a second RPC', async () => {
    const sendRpc = vi.fn().mockResolvedValue({ ptyId: 'pty-7', workspaceId: 'ws-7' });
    const deps = makeDeps({ sendRpc });

    const first = await claimPinnedRoute(deps);
    const second = await claimPinnedRoute(deps);
    const third = await claimPinnedRoute(deps);

    expect(first).toEqual({ ptyId: 'pty-7', workspaceId: 'ws-7' });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // All three calls share a single claim RPC — re-claiming on every tool call
    // would spawn a new workspace each time.
    expect(sendRpc).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates concurrent first calls so only one claim RPC fires', async () => {
    let resolveRpc!: (value: unknown) => void;
    const sendRpc = vi.fn().mockImplementation(
      () => new Promise((r) => {
        resolveRpc = r;
      }),
    );
    const deps = makeDeps({ sendRpc });

    const p1 = claimPinnedRoute(deps);
    const p2 = claimPinnedRoute(deps);
    const p3 = claimPinnedRoute(deps);

    await Promise.resolve();
    await Promise.resolve();
    expect(sendRpc).toHaveBeenCalledTimes(1);

    resolveRpc({ ptyId: 'pty-99', workspaceId: 'ws-99' });

    await expect(p1).resolves.toEqual({ ptyId: 'pty-99', workspaceId: 'ws-99' });
    await expect(p2).resolves.toEqual({ ptyId: 'pty-99', workspaceId: 'ws-99' });
    await expect(p3).resolves.toEqual({ ptyId: 'pty-99', workspaceId: 'ws-99' });
  });

  it('throws and does not pin when the claim RPC fails', async () => {
    const sendRpc = vi.fn().mockRejectedValueOnce(new Error('pipe closed'));
    const deps = makeDeps({ sendRpc });

    await expect(claimPinnedRoute(deps)).rejects.toThrow(
      'Unable to claim a dedicated MCP terminal workspace: pipe closed',
    );
    expect(getPinnedRoute()).toBeNull();

    // Next call should retry — failures must not permanently disable resolution.
    sendRpc.mockResolvedValueOnce({ ptyId: 'pty-retry', workspaceId: 'ws-retry' });
    const retry = await claimPinnedRoute(deps);
    expect(retry).toEqual({ ptyId: 'pty-retry', workspaceId: 'ws-retry' });
    expect(sendRpc).toHaveBeenCalledTimes(2);
  });

  it('throws and does not pin when the claim response is missing ptyId', async () => {
    const sendRpc = vi.fn().mockResolvedValue({ workspaceId: 'ws-1' }); // no ptyId
    const deps = makeDeps({ sendRpc });

    await expect(claimPinnedRoute(deps)).rejects.toThrow(
      'Unable to claim a dedicated MCP terminal workspace: mcp.claimWorkspace returned no ptyId',
    );
    expect(getPinnedRoute()).toBeNull();
  });

  it('throws and does not pin when the claim response is missing workspaceId', async () => {
    // Pinning a ptyId without its owning workspaceId would force terminal RPCs
    // back onto the spoofable env hint — fail closed instead (issue #163).
    const sendRpc = vi.fn().mockResolvedValue({ ptyId: 'pty-1' }); // no workspaceId
    const deps = makeDeps({ sendRpc });

    await expect(claimPinnedRoute(deps)).rejects.toThrow(
      'Unable to claim a dedicated MCP terminal workspace: mcp.claimWorkspace returned no workspaceId',
    );
    expect(getPinnedRoute()).toBeNull();
  });
});
