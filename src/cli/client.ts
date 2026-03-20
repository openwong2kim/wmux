#!/usr/bin/env node
import * as net from 'net';
import * as crypto from 'crypto';
import type { RpcRequest, RpcResponse, RpcMethod } from '../shared/rpc';

const PIPE_NAME = process.env.WMUX_SOCKET_PATH || (process.platform === 'win32' ? '\\\\.\\pipe\\wmux' : '/tmp/wmux.sock');
const TIMEOUT_MS = 5000;

export function sendRequest(
  method: RpcMethod,
  params: Record<string, unknown> = {}
): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const token = process.env.WMUX_AUTH_TOKEN;
    const request: RpcRequest = { id, method, params, token };

    const socket = net.connect(PIPE_NAME);
    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error('Request timed out after 5 seconds.'));
      }
    }, TIMEOUT_MS);

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
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
            resolve(response);
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
