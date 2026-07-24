import * as net from 'net';
import { getMcpBrokerPipeName } from '../../shared/constants';

/**
 * One-shot connect probe against the shared MCP broker pipe. Resolves `true`
 * when the pipe accepts a connection within `timeoutMs`, `false` on timeout,
 * connection error, or refusal. Never rejects.
 *
 * The explicit socket timeout is load-bearing on Windows: a named-pipe connect
 * can hang indefinitely when the server process exists but has not yet called
 * `listen()`, so we arm `setTimeout()` and `destroy()` the socket ourselves
 * rather than wait on the OS to refuse.
 *
 * The pipe name is injectable purely so tests can point at a throwaway server;
 * production callers omit it and use the shared broker pipe.
 */
export function canConnectBrokerPipe(
  timeoutMs: number,
  pipeName: string = getMcpBrokerPipeName(),
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect(pipeName);
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    // Use on() (not once) so a stray post-destroy 'error' can never surface as
    // an unhandled exception in the main process.
    socket.on('error', () => finish(false));
  });
}
