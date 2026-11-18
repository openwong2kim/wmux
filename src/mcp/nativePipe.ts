/**
 * The native named-pipe listener (Windows; core/wmux-term, capability
 * `pipe-listener-v1`) and the server over it that hands each accepted
 * connection on as a NativePipeSocket.
 *
 * The native listener creates the pipe with an owner-only access list, a
 * handle child processes do not inherit, and a cap on its instances, and it
 * reads the client's identity at accept (NativePipeSocket.peer). Not used by
 * the broker yet.
 */
import { loadNativeTerminalCore, type NativeTerminalCore } from '../shared/nativeTerminalCore';
import { NativePipeSocket, type NativePipeConn } from './nativePipeSocket';

export const NATIVE_PIPE_CAPABILITY = 'pipe-listener-v1';

export interface NativePipeListener {
  /** The next accepted connection, or null. */
  takeAccepted(): NativePipeConn | null;
  /** Why accepting stopped, if it did. */
  failure(): string | null;
  /** Idempotent. Accepted connections stay open. */
  close(): void;
}

export interface NativePipeModule {
  /** Throws with code 'EADDRINUSE' when the name exists. `notify` is woken
   *  for the listener and for every connection it accepted. */
  NativePipeListener: new (name: string, maxInstances: number, notify: () => void) => NativePipeListener;
  /** Test hooks. */
  nativePipeWorkerCount?(): number;
  nativePipeHandleCount?(): number;
}

/**
 * The native pipe module on Windows, null elsewhere. On Windows a module
 * without the capability throws: the caller decides what to do without it.
 */
export function loadNativePipe(): NativePipeModule | null {
  if (process.platform !== 'win32') return null;
  const core = loadNativeTerminalCore(NATIVE_PIPE_CAPABILITY) as NativeTerminalCore & Partial<NativePipeModule>;
  if (typeof core.NativePipeListener !== 'function') throw new Error('Native terminal core lacks the pipe listener');
  return core as NativePipeModule;
}

export interface NativePipeServer {
  /** Stops accepting (idempotent). Sockets already handed on stay open. */
  close(): void;
  /** Why accepting stopped on its own, or null. */
  readonly failure: string | null;
}

export interface ListenNativePipeOptions {
  /** Accepted plus pending instances at a time. */
  maxInstances: number;
  onConnection(socket: NativePipeSocket): void;
  /** Called once when accepting stops on its own. */
  onFailure?(reason: string): void;
  /** The module to use; loadNativePipe() when absent. */
  module?: NativePipeModule;
}

/** Listen on `name` (a `\\.\pipe\...` path). Throws when the native module is
 *  unavailable, or with code 'EADDRINUSE' when the name exists. */
export function listenNativePipe(name: string, options: ListenNativePipeOptions): NativePipeServer {
  const module = options.module ?? loadNativePipe();
  if (!module) throw new Error('The native pipe listener is Windows only');
  const sockets = new Set<NativePipeSocket>();
  let listener: NativePipeListener | undefined;
  let closed = false;
  let failureReported = false;

  // One wake for the listener and all its connections. It keeps running
  // after close() for the connections still open.
  const wake = (): void => {
    if (!listener) return;
    if (!closed) {
      for (let conn = listener.takeAccepted(); conn !== null; conn = listener.takeAccepted()) {
        let socket: NativePipeSocket;
        try {
          socket = new NativePipeSocket(conn);
        } catch {
          // The connection is gone already (the constructor destroyed it).
          continue;
        }
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        try {
          options.onConnection(socket);
        } catch (error) {
          socket.destroy();
          throw error;
        }
      }
      const failure = listener.failure();
      if (failure && !failureReported) {
        failureReported = true;
        options.onFailure?.(failure);
      }
    }
    for (const socket of [...sockets]) socket.pump();
  };

  listener = new module.NativePipeListener(name, options.maxInstances, wake);
  const own = listener;
  return {
    close(): void {
      if (closed) return;
      closed = true;
      // Accepted since the last wake and never handed on: closed with it.
      for (let conn = own.takeAccepted(); conn !== null; conn = own.takeAccepted()) conn.destroy();
      own.close();
    },
    get failure(): string | null {
      return own.failure();
    },
  };
}
