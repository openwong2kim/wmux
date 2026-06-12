import * as net from 'net';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { RpcRequest, RpcResponse, RpcMethod } from '../shared/rpc';
import { getPipeName, getAuthTokenPath, getTcpPortPath } from '../shared/constants';

// 서버(PipeServer)와 동일한 경로 해석을 사용한다. 과거에는 '/tmp/wmux.sock'을
// 하드코딩해 macOS/Linux에서 서버('~/.wmux.sock')와 어긋나 항상 "not running"이
// 떴고, Windows에서도 username 없는 '\\.\pipe\wmux'로 빗나갔다. getPipeName()이
// win32/unix·username을 모두 처리한다. WMUX_SOCKET_PATH로 오버라이드 가능하되,
// PTY env는 세션 생성 시점에 동결되므로 env 경로 실패 시 파생 경로로 재시도한다.
const TIMEOUT_MS = 5000;

// 인증 토큰: 서버는 토큰을 ~/.wmux-auth-token 파일에 쓴다. CLI가 이 파일을
// 자동으로 읽지 않아 매번 WMUX_AUTH_TOKEN을 수동 주입해야 했다(인증 실패).
// 파일 우선 — PTY env의 토큰은 PipeServer.rotateToken() 이후 stale일 수 있다.
function resolveAuthToken(): string | undefined {
  try {
    const fromFile = fs.readFileSync(getAuthTokenPath(), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch {
    // 파일 없음/권한 없음 — env로 폴백
  }
  if (process.env.WMUX_AUTH_TOKEN) return process.env.WMUX_AUTH_TOKEN;
  return undefined;
}

function readTcpPort(): number | undefined {
  try {
    const port = parseInt(fs.readFileSync(getTcpPortPath(), 'utf8').trim(), 10);
    return Number.isFinite(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

function attemptRequest(
  target: string | { host: string; port: number },
  method: RpcMethod,
  params: Record<string, unknown>,
  token: string | undefined,
): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const request: RpcRequest = { id, method, params, token };

    const socket =
      typeof target === 'string' ? net.connect(target) : net.connect(target.port, target.host);
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
        const wrapped = new Error(
          err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
            ? 'wmux is not running. Start the app first.'
            : `Connection error: ${err.message}`,
        ) as Error & { code?: string };
        wrapped.code = err.code;
        reject(wrapped);
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

/**
 * Only connection-level failures trigger the next transport in the fallback
 * chain. A TIMEOUT deliberately does NOT: by then the request bytes may have
 * reached the server (connect succeeded), so replaying it over TCP could
 * double-apply a non-idempotent call — `input.send` would type the text into
 * the terminal twice. Timeouts fail hard instead.
 */
function isConnectFailure(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EPERM';
}

export async function sendRequest(
  method: RpcMethod,
  params: Record<string, unknown> = {},
): Promise<RpcResponse> {
  const token = resolveAuthToken();

  // env 경로(WMUX_SOCKET_PATH)는 stale할 수 있으므로(데이터 suffix 변경 등),
  // 실패 시 파생 경로로 폴백한다. wmux-client.ts(MCP)와 동일 전략.
  const envPath = process.env.WMUX_SOCKET_PATH;
  const derivedPath = getPipeName();
  const pipePaths = envPath && envPath !== derivedPath ? [envPath, derivedPath] : [derivedPath];

  let lastError: unknown;
  for (const pipePath of pipePaths) {
    try {
      return await attemptRequest(pipePath, method, params, token);
    } catch (err) {
      lastError = err;
      if (!isConnectFailure(err)) throw err;
    }
  }

  // TCP localhost 폴백 — Windows named pipe EPERM/ACL 이슈 우회 (서버가
  // 127.0.0.1 랜덤 포트를 열고 포트를 ~/.wmux-tcp-port에 기록한다).
  if (process.platform === 'win32') {
    const tcpPort = readTcpPort();
    if (tcpPort) {
      try {
        return await attemptRequest({ host: '127.0.0.1', port: tcpPort }, method, params, token);
      } catch {
        // fall through to the pipe error — it names the real failure
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('wmux is not running. Start the app first.');
}
