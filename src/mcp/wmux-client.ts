import * as net from 'net';
import * as crypto from 'crypto';
import type { RpcMethod, RpcResponse } from '../shared/rpc';

const TIMEOUT_MS = 10000;

export function sendRpc(
  method: RpcMethod,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const pipePath = process.env.WMUX_SOCKET_PATH;
  const token = process.env.WMUX_AUTH_TOKEN;

  if (!pipePath) {
    return Promise.reject(new Error('WMUX_SOCKET_PATH not set. Is this running inside wmux?'));
  }
  if (!token) {
    return Promise.reject(new Error('WMUX_AUTH_TOKEN not set. Is this running inside wmux?'));
  }

  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const request = JSON.stringify({ id, method, params, token }) + '\n';

    const socket = net.connect(pipePath);
    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`RPC timeout: ${method} (${TIMEOUT_MS}ms)`));
      }
    }, TIMEOUT_MS);

    socket.on('connect', () => {
      socket.write(request);
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const response = JSON.parse(trimmed) as RpcResponse;
          if (response.id === id && !settled) {
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            if (response.ok) {
              resolve(response.result);
            } else {
              reject(new Error(response.error));
            }
          }
        } catch {
          // ignore malformed lines
        }
      }
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
          reject(new Error('wmux is not running. Start the app first.'));
        } else {
          reject(new Error(`Connection error: ${err.message}`));
        }
      }
    });

    socket.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('Connection closed before response was received.'));
      }
    });
  });
}
