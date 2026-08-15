import type * as net from 'net';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcRequest, RpcResponse } from '../../../shared/rpc';
import type { RpcRouter } from '../RpcRouter';

const securityMocks = vi.hoisted(() => ({
  secureWriteTokenFile: vi.fn(),
  scheduleTokenFileReHarden: vi.fn(),
}));

vi.mock('../../../shared/constants', () => ({
  getPipeName: () => 'wmux-test-pipe',
  getAuthTokenPath: () => '\0wmux-test-token',
  getTcpPortPath: () => 'wmux-test-port',
}));

vi.mock('../../../shared/security', () => securityMocks);

import { PipeServer } from '../PipeServer';

type ProcessLineAccess = {
  processLine(socket: net.Socket, line: string): void;
  rateLimits: Map<net.Socket, { count: number; resetAt: number }>;
  globalRate: { count: number; resetAt: number };
};

function fakeSocket(): net.Socket {
  // `once` is real net.Socket surface, not decoration: processLine subscribes
  // to close/error to cancel a waiting handler when the client hangs up. A
  // double without it makes the suite fail on the wiring rather than on what it
  // is asserting.
  return {
    destroyed: false,
    write: vi.fn(),
    destroy: vi.fn(),
    once: vi.fn(),
  } as unknown as net.Socket;
}

function makeServer() {
  const dispatch = vi.fn(
    async (request: RpcRequest): Promise<RpcResponse> => ({
      id: request.id,
      ok: true,
      result: null,
    }),
  );
  const server = new PipeServer({ dispatch } as unknown as RpcRouter);
  return { server, dispatch };
}

function processLine(server: PipeServer, socket: net.Socket, request: Record<string, unknown>) {
  (server as unknown as ProcessLineAccess).processLine(socket, JSON.stringify(request));
}

beforeEach(() => {
  securityMocks.secureWriteTokenFile.mockClear();
  securityMocks.scheduleTokenFileReHarden.mockClear();
});

describe('PipeServer dispatch provenance', () => {
  it('marks an authenticated, in-budget request as external wire', async () => {
    const { server, dispatch } = makeServer();
    const socket = fakeSocket();

    processLine(server, socket, {
      id: 'authenticated',
      method: 'surface.new',
      params: {},
      clientName: 'claude-code',
      token: server.getAuthToken(),
      // Raw provenance keys remain ordinary envelope data. RpcRouter ignores
      // them; the second dispatch argument below is the sole trusted marker.
      externalWire: false,
      firstParty: true,
    });

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'authenticated', clientName: 'claude-code' }),
      // The trust lane is still the only provenance marker. `signal` rides
      // alongside it and carries no authority — it exists so a handler that
      // WAITS can stop when the client hangs up, instead of holding one of the
      // server's finite connection slots until its own deadline.
      expect.objectContaining({ externalWire: true, signal: expect.any(AbortSignal) }),
    );
    // Provenance must not be forgeable from the envelope, and adding `signal`
    // must not have introduced a second way in.
    const [, opts] = dispatch.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.firstParty).toBeUndefined();
    expect(opts.operator).toBeUndefined();
  });

  it('does not dispatch an unauthenticated request', () => {
    const { server, dispatch } = makeServer();
    const socket = fakeSocket();
    const token = server.getAuthToken();
    const wrongToken = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;

    processLine(server, socket, {
      id: 'unauthenticated',
      method: 'surface.new',
      params: {},
      token: wrongToken,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it('does not dispatch an authenticated request over the per-socket limit', () => {
    const { server, dispatch } = makeServer();
    const socket = fakeSocket();
    (server as unknown as ProcessLineAccess).rateLimits.set(socket, {
      count: 50,
      resetAt: Date.now() + 60_000,
    });

    processLine(server, socket, {
      id: 'rate-limited',
      method: 'surface.new',
      params: {},
      token: server.getAuthToken(),
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('rate limited'));
  });

  it('does not dispatch an authenticated request over the global limit', () => {
    const { server, dispatch } = makeServer();
    const socket = fakeSocket();
    const globalLimit = (
      PipeServer as unknown as { GLOBAL_RATE_LIMIT: number }
    ).GLOBAL_RATE_LIMIT;
    (server as unknown as ProcessLineAccess).globalRate = {
      count: globalLimit,
      resetAt: Date.now() + 60_000,
    };

    processLine(server, socket, {
      id: 'global-rate-limited',
      method: 'surface.new',
      params: {},
      token: server.getAuthToken(),
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('rate limited (global)'));
  });
});
