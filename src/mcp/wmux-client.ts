import * as net from 'net';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { RpcMethod, RpcResponse } from '../shared/rpc';
import { getPipeName, getAuthTokenPath } from '../shared/constants';

const TIMEOUT_MS = 10000;
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 1000;

function readAuthToken(): string | undefined {
  // File takes priority — always read the latest token from disk.
  // Env vars may be stale (Claude Code caches them across MCP restarts).
  try {
    const fromFile = fs.readFileSync(getAuthTokenPath(), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* file doesn't exist */ }
  // Env var fallback (when running inside wmux terminal)
  if (process.env.WMUX_AUTH_TOKEN) return process.env.WMUX_AUTH_TOKEN;
  return undefined;
}

function attemptRpc(
  pipePath: string,
  token: string,
  method: RpcMethod,
  params: Record<string, unknown>,
): Promise<unknown> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function sendRpc(
  method: RpcMethod,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  // Try WMUX_SOCKET_PATH first (if set), then fall back to getPipeName().
  // Claude Code may cache a stale WMUX_SOCKET_PATH from a previous session,
  // so we must fall back to the derived name if the env path fails.
  const envPath = process.env.WMUX_SOCKET_PATH;
  const derivedPath = getPipeName();
  const pipePaths = envPath && envPath !== derivedPath ? [envPath, derivedPath] : [derivedPath];

  for (const pipePath of pipePaths) {
    for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
      const token = readAuthToken();
      if (!token) {
        throw new Error('wmux auth token not found. Is wmux running?');
      }

      try {
        return await attemptRpc(pipePath, token, method, params);
      } catch (err) {
        const msg = (err as Error).message;
        const isRetryable = msg.includes('not running') || msg.includes('unauthorized');
        if (isRetryable && attempt < RETRY_COUNT - 1) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        // If env path failed and we have a fallback, break to try derived path
        if (isRetryable && pipePaths.length > 1 && pipePath === envPath) {
          break;
        }
        throw err;
      }
    }
  }

  throw new Error('wmux is not running. Start the app first.');
}
