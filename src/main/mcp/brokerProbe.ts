import * as net from 'net';
import { getMcpBrokerPipeName } from '../../shared/constants';
import type { PipeOwnerVerdict } from '../../mcp/nativePipe';
import { brokerNativePipe } from './brokerNativePipe';

/**
 * What a probe of the broker pipe found:
 * - 'ours': a broker of this user serves it;
 * - 'foreign': another owner holds the name (Windows), which no restart frees;
 * - 'busy': unknown this time (every instance in use, or the owner could not
 *   be read); ask again later;
 * - 'none': nothing serves it.
 */
export type BrokerPipeState = PipeOwnerVerdict;

/** Who holds a pipe on Windows; 'unknown' when it cannot be told. */
export type PipeOwnerCheck = (pipeName: string) => PipeOwnerVerdict | 'unknown';

/**
 * The owner check for the broker pipe on Windows (core/wmux-term
 * nativePipeOwnedByUs: it opens the pipe to read its owner and writes
 * nothing); null elsewhere. 'unknown' without the native module, or when the
 * check throws.
 */
export function nativePipeOwnerCheck(platform: NodeJS.Platform = process.platform): PipeOwnerCheck | null {
  if (platform !== 'win32') return null;
  return (pipeName) => {
    const { module } = brokerNativePipe();
    if (!module) return 'unknown';
    try {
      return module.nativePipeOwnedByUs(pipeName);
    } catch {
      return 'unknown';
    }
  };
}

/**
 * Probe the broker pipe. On Windows it reads the pipe's owner, so a pipe
 * at the broker's name that another owner holds is never taken for a broker;
 * elsewhere it connects (the socket path is under this user's home).
 * Never rejects.
 *
 * The pipe name and the owner check are injectable for tests; production
 * callers omit them.
 */
export async function probeBrokerPipe(
  timeoutMs: number,
  pipeName: string = getMcpBrokerPipeName(),
  ownerOf: PipeOwnerCheck | null = nativePipeOwnerCheck(),
): Promise<BrokerPipeState> {
  if (ownerOf) {
    const owner = ownerOf(pipeName);
    return owner === 'unknown' ? 'busy' : owner;
  }
  return (await connectProbe(timeoutMs, pipeName)) ? 'ours' : 'none';
}

/**
 * Whether a broker of this user serves the pipe (probeBrokerPipe is 'ours').
 * Resolves `false` on timeout, connection error, refusal, or (Windows) a pipe
 * another owner holds. Never rejects.
 */
export async function canConnectBrokerPipe(
  timeoutMs: number,
  pipeName: string = getMcpBrokerPipeName(),
  ownerOf: PipeOwnerCheck | null = nativePipeOwnerCheck(),
): Promise<boolean> {
  return (await probeBrokerPipe(timeoutMs, pipeName, ownerOf)) === 'ours';
}

/**
 * One-shot connect probe. Resolves `true` when the pipe accepts a connection
 * within `timeoutMs`, `false` on timeout, connection error, or refusal.
 *
 * The explicit socket timeout is load-bearing on Windows: a named-pipe connect
 * can hang indefinitely when the server process exists but has not yet called
 * `listen()`, so we arm `setTimeout()` and `destroy()` the socket ourselves
 * rather than wait on the OS to refuse.
 */
function connectProbe(timeoutMs: number, pipeName: string): Promise<boolean> {
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
