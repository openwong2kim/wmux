import { describe, it, expect, vi } from 'vitest';
import { RemoteHostClient, RemoteInsecureTransportError } from '../RemoteHostClient';
import { RemoteAttentionSubscriber } from '../RemoteAttentionSubscriber';
import type { RemoteHost } from '../../../shared/remoteHosts';

/**
 * A host registered over plain http to ANOTHER machine (before pairing
 * required HTTPS) must never receive its bearer token: every call that would
 * carry it is refused before any network I/O. Loopback http still works, and
 * the origin is never "upgraded" to https.
 */
const lan: RemoteHost = { id: 'lan', label: 'lan', origin: 'http://192.168.1.5:7681', token: 'T0K3N', addedAt: 0 };
const loop: RemoteHost = { id: 'loop', label: 'loop', origin: 'http://127.0.0.1:7681', token: 'T0K3N', addedAt: 0 };

const settle = () => new Promise((r) => setTimeout(r, 20));

function jsonOk(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, body: null } as unknown as Response;
}

describe('RemoteHostClient on a plain-http host to another machine', () => {
  it('refuses every token-carrying call before any fetch', async () => {
    const fetchImpl = vi.fn();
    const client = new RemoteHostClient(lan, fetchImpl as unknown as typeof fetch);
    expect(client.isInsecure()).toBe(true);

    await expect(client.listWorkspaces()).rejects.toBeInstanceOf(RemoteInsecureTransportError);
    await expect(client.createWorkspace('ws')).rejects.toBeInstanceOf(RemoteInsecureTransportError);
    await expect(client.closeSession('s1')).rejects.toBeInstanceOf(RemoteInsecureTransportError);
    await expect(client.resizeSession('s1', 80, 24)).resolves.toEqual({ ok: false, reason: 'insecure-transport' });

    const errors: Array<{ reason?: string }> = [];
    client.onError((e) => errors.push(e));
    const attachId = client.attach('s1');
    await expect(client.write(attachId, 'ls\n')).rejects.toBeInstanceOf(RemoteInsecureTransportError);
    await settle();
    // The stream reports the refusal once and never retries.
    expect(errors).toEqual([expect.objectContaining({ reason: 'insecure-transport' })]);
    await settle();
    expect(errors).toHaveLength(1);
    expect(client.liveAttachmentCount()).toBe(0);
    client.detach(attachId);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('the attention stream never opens either', async () => {
    const fetchImpl = vi.fn();
    const sub = new RemoteAttentionSubscriber({ host: lan, onNotification: vi.fn(), fetchImpl: fetchImpl as unknown as typeof fetch });
    sub.start();
    await settle();
    sub.stop();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('RemoteHostClient on loopback http', () => {
  it('still sends requests to this same machine, at the origin it was given', async () => {
    const fetchImpl = vi.fn(async () => jsonOk({ workspaces: [] }));
    const client = new RemoteHostClient(loop, fetchImpl as unknown as typeof fetch);
    expect(client.isInsecure()).toBe(false);
    await client.listWorkspaces();
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:7681/api/workspaces', expect.anything());
  });

  it('never upgrades an https host or rewrites its origin', async () => {
    const fetchImpl = vi.fn(async () => jsonOk({ workspaces: [] }));
    const client = new RemoteHostClient({ ...lan, origin: 'https://192.168.1.5:7681' }, fetchImpl as unknown as typeof fetch);
    await client.listWorkspaces();
    expect(fetchImpl).toHaveBeenCalledWith('https://192.168.1.5:7681/api/workspaces', expect.anything());
  });
});
