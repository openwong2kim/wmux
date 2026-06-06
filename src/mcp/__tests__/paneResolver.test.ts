import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDefaultPtyId, __resetPaneResolverForTesting } from '../paneResolver';
import type { PaneResolverDeps } from '../paneResolver';

function makeDeps(overrides: Partial<PaneResolverDeps> = {}): PaneResolverDeps {
  return {
    sendRpc: overrides.sendRpc ?? vi.fn(),
    resolveWorkspaceId: overrides.resolveWorkspaceId ?? vi.fn().mockResolvedValue(''),
  };
}

describe('resolveDefaultPtyId', () => {
  beforeEach(() => {
    __resetPaneResolverForTesting();
  });

  it('returns null for internal callers so the main process falls through to the active pane', async () => {
    // Internal callers can resolve their host workspace via the PID-tree walk.
    const sendRpc = vi.fn();
    const resolveWorkspaceId = vi.fn().mockResolvedValue('ws-123');
    const deps = makeDeps({ sendRpc, resolveWorkspaceId });

    const result = await resolveDefaultPtyId(deps);

    expect(result).toBeNull();
    // Internal callers must NOT claim a new workspace — that would spawn a
    // surprise pane when the user just wanted to target their current one.
    expect(sendRpc).not.toHaveBeenCalled();
  });

  it('claims a workspace and returns the new ptyId for external callers', async () => {
    const sendRpc = vi.fn().mockResolvedValue({
      ptyId: 'pty-42',
      workspaceId: 'ws-new',
      workspaceName: 'MCP',
    });
    const resolveWorkspaceId = vi.fn().mockResolvedValue('');
    const deps = makeDeps({ sendRpc, resolveWorkspaceId });

    const result = await resolveDefaultPtyId(deps);

    expect(result).toBe('pty-42');
    expect(sendRpc).toHaveBeenCalledWith('mcp.claimWorkspace', { name: 'MCP' });
  });

  it('pins the claimed ptyId so subsequent calls reuse it without a second RPC', async () => {
    const sendRpc = vi.fn().mockResolvedValue({ ptyId: 'pty-7' });
    const deps = makeDeps({
      sendRpc,
      resolveWorkspaceId: vi.fn().mockResolvedValue(''),
    });

    const first = await resolveDefaultPtyId(deps);
    const second = await resolveDefaultPtyId(deps);
    const third = await resolveDefaultPtyId(deps);

    expect(first).toBe('pty-7');
    expect(second).toBe('pty-7');
    expect(third).toBe('pty-7');
    // All three calls must share a single claim RPC — re-claiming on every
    // tool call would spawn a new workspace each time and defeat the point.
    expect(sendRpc).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates concurrent first calls so only one claim RPC fires', async () => {
    // Simulate an RPC that takes a moment — three terminal tools invoked in
    // parallel on first startup must converge onto a single claim.
    let resolveRpc!: (value: unknown) => void;
    const sendRpc = vi.fn().mockImplementation(
      () => new Promise((r) => {
        resolveRpc = r;
      }),
    );
    const deps = makeDeps({
      sendRpc,
      resolveWorkspaceId: vi.fn().mockResolvedValue(''),
    });

    const p1 = resolveDefaultPtyId(deps);
    const p2 = resolveDefaultPtyId(deps);
    const p3 = resolveDefaultPtyId(deps);

    // Only one inflight claim, not three.
    await Promise.resolve();
    await Promise.resolve();
    expect(sendRpc).toHaveBeenCalledTimes(1);

    resolveRpc({ ptyId: 'pty-99' });

    await expect(p1).resolves.toBe('pty-99');
    await expect(p2).resolves.toBe('pty-99');
    await expect(p3).resolves.toBe('pty-99');
  });

  it('throws and does not pin when the claim RPC fails', async () => {
    const sendRpc = vi.fn().mockRejectedValueOnce(new Error('pipe closed'));
    const deps = makeDeps({
      sendRpc,
      resolveWorkspaceId: vi.fn().mockResolvedValue(''),
    });

    await expect(resolveDefaultPtyId(deps)).rejects.toThrow(
      'Unable to claim a dedicated MCP terminal workspace: pipe closed',
    );

    // Next call should retry — failures must not permanently disable the
    // external caller's default-pane resolution.
    sendRpc.mockResolvedValueOnce({ ptyId: 'pty-retry' });
    const retry = await resolveDefaultPtyId(deps);
    expect(retry).toBe('pty-retry');
    expect(sendRpc).toHaveBeenCalledTimes(2);
  });

  it('throws when the claim RPC returns a malformed response', async () => {
    const sendRpc = vi.fn().mockResolvedValue({ workspaceId: 'ws-1' }); // missing ptyId
    const deps = makeDeps({
      sendRpc,
      resolveWorkspaceId: vi.fn().mockResolvedValue(''),
    });

    await expect(resolveDefaultPtyId(deps)).rejects.toThrow(
      'Unable to claim a dedicated MCP terminal workspace: mcp.claimWorkspace returned no ptyId',
    );
  });

  it('does not treat unverified workspace identity as internal', async () => {
    const sendRpc = vi.fn().mockResolvedValue({ ptyId: 'pty-claimed' });
    const deps = makeDeps({
      sendRpc,
      resolveWorkspaceId: vi.fn().mockResolvedValue(''),
    });

    const result = await resolveDefaultPtyId(deps);

    expect(result).toBe('pty-claimed');
    expect(sendRpc).toHaveBeenCalledWith('mcp.claimWorkspace', { name: 'MCP' });
  });
});
