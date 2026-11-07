import { describe, it, expect, vi } from 'vitest';
import { RemoteHostClient, isRemoteUnknownWorkspace } from '../RemoteHostClient';
import type { RemoteHost } from '../../../shared/remoteHosts';

// A pairing without the workspace grant may not start a pane in a workspace
// the host has no live pane in: the host answers 400 `unknown-workspace-id`
// (WebTerminalServer.rejectWorkspaceId). The code must reach the dialog as a
// reason it can word itself, never only as the host's English detail.

const host: RemoteHost = {
  id: 'host-1',
  label: 'office-mac',
  origin: 'https://office-mac.example:9600',
  token: 'device-token',
  addedAt: 0,
};

function badRequest(body: unknown): Response {
  return { ok: false, status: 400, body: null, json: async () => body } as unknown as Response;
}

describe('RemoteHostClient.createWorkspace — a workspace the host does not know', () => {
  it('throws a typed unknown-workspace-id error, keeping the host detail as its message', async () => {
    const detail = 'no live pane is running in that workspace — the daemon can only verify a workspace id it can see on a running session.';
    const fetchImpl = vi.fn(async () => badRequest({ error: 'unknown-workspace-id', detail }));
    const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);
    const err = await client.createWorkspace('remote-pane-x').then(() => null, (e: unknown) => e);
    expect(isRemoteUnknownWorkspace(err)).toBe(true);
    expect((err as { reason?: string }).reason).toBe('unknown-workspace-id');
    expect((err as Error).message).toBe(detail);
  });

  it('reads the code only on the host\'s own 400', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, body: null, json: async () => ({ error: 'unknown-workspace-id' }) }) as unknown as Response);
    const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);
    const err = await client.createWorkspace('remote-pane-x').then(() => null, (e: unknown) => e);
    expect(isRemoteUnknownWorkspace(err)).toBe(false);
  });

  it('leaves any other refusal an ordinary error', async () => {
    const fetchImpl = vi.fn(async () => badRequest({ error: 'invalid-workspace-id', detail: 'workspaceId must match ^[A-Za-z0-9_-]{1,64}$' }));
    const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);
    const err = await client.createWorkspace('bad id').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isRemoteUnknownWorkspace(err)).toBe(false);
  });
});
