import type * as net from 'net';
import { describe, expect, it, vi } from 'vitest';
import type { RpcRequest, RpcResponse } from '../../../shared/rpc';
import type { RpcRouter } from '../RpcRouter';

vi.mock('../../../shared/constants', () => ({
  getPipeName: () => 'wmux-test-pipe',
  getAuthTokenPath: () => '\0wmux-test-token',
  getTcpPortPath: () => 'wmux-test-port',
}));
vi.mock('../../../shared/security', () => ({ secureWriteTokenFile: vi.fn(), scheduleTokenFileReHarden: vi.fn() }));

import { PipeServer } from '../PipeServer';
import { mcpSessionTracker } from '../../mcp/mcpSessionTracker';

function fakeSocket(): net.Socket {
  return { destroyed: false, write: vi.fn(), destroy: vi.fn(), once: vi.fn() } as unknown as net.Socket;
}

function send(server: PipeServer, request: Record<string, unknown>) {
  (server as unknown as { processLine(s: net.Socket, l: string): void }).processLine(fakeSocket(), JSON.stringify(request));
}

describe('PipeServer bundle session count', () => {
  it('counts a session only from a request that passed auth', async () => {
    const dispatch = vi.fn(async (r: RpcRequest): Promise<RpcResponse> => ({ id: r.id, ok: true, result: null }));
    const server = new PipeServer({ dispatch } as unknown as RpcRouter);
    const before = mcpSessionTracker.summary().recent;

    send(server, { id: '1', method: 'pane.list', params: {}, token: 'wrong', mcpSession: 'a'.repeat(32) });
    expect(mcpSessionTracker.summary().recent).toBe(before);

    send(server, { id: '2', method: 'pane.list', params: {}, token: server.getAuthToken(), mcpSession: 'b'.repeat(32) });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(mcpSessionTracker.has('b'.repeat(32))).toBe(true);
    expect(mcpSessionTracker.has('a'.repeat(32))).toBe(false);
  });
});
