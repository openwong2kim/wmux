import type * as net from 'net';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/constants', () => ({
  getPipeName: () => 'wmux-test-pipe',
  getAuthTokenPath: () => '\0wmux-test-token',
  getTcpPortPath: () => 'wmux-test-port',
}));
vi.mock('../../../shared/security', () => ({ secureWriteTokenFile: vi.fn(), scheduleTokenFileReHarden: vi.fn() }));

import { PipeServer } from '../PipeServer';
import { RpcRouter } from '../RpcRouter';
import { mcpSessionTracker } from '../../mcp/mcpSessionTracker';

function fakeSocket(): net.Socket {
  return { destroyed: false, write: vi.fn(), destroy: vi.fn(), once: vi.fn() } as unknown as net.Socket;
}

function send(server: PipeServer, request: Record<string, unknown>) {
  (server as unknown as { processLine(s: net.Socket, l: string): void }).processLine(fakeSocket(), JSON.stringify(request));
}

describe('PipeServer bundle session count', () => {
  it('counts a session only from a request that passed auth', async () => {
    const router = new RpcRouter();
    const seen = vi.fn(() => Promise.resolve({ ok: true }));
    router.register('system.identify', seen);
    const server = new PipeServer(router);

    send(server, { id: '1', method: 'system.identify', params: {}, token: 'wrong', mcpSession: 'a'.repeat(32) });
    send(server, { id: '2', method: 'system.identify', params: {}, token: server.getAuthToken(), mcpSession: 'b'.repeat(32) });
    await vi.waitFor(() => expect(seen).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(mcpSessionTracker.has('b'.repeat(32))).toBe(true);
    expect(mcpSessionTracker.has('a'.repeat(32))).toBe(false);
  });

  it('counts nothing from an in-process dispatch', async () => {
    const router = new RpcRouter();
    router.register('system.identify', () => Promise.resolve({ ok: true }));
    await router.dispatch({ id: '3', method: 'system.identify', params: {}, mcpSession: 'c'.repeat(32) });
    await router.dispatch({ id: '4', method: 'system.identify', params: {}, mcpSession: 'd'.repeat(32) }, { firstParty: true });
    expect(mcpSessionTracker.has('c'.repeat(32))).toBe(false);
    expect(mcpSessionTracker.has('d'.repeat(32))).toBe(false);
  });
});
