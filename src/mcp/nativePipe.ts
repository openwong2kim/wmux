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
  /** onConnection threw: that socket was destroyed and the others are served
   *  on. Logged to stderr when absent. */
  onConnectionError?(error: unknown): void;
  /** The module to use; loadNativePipe() when absent. */
  module?: NativePipeModule;
}

/** Listen on `name` (a `\\.\pipe\...` path). Throws when the native module is
 *  unavailable, or with code 'EADDRINUSE' when the name exists. */
export function listenNativePipe(name: string, options: ListenNativePipeOptions): NativePipeServer {
  const module = options.module ?? loadNativePipe();
  if (!module) throw new Error('The native pipe listener is Windows only');
  const sockets = new Set<NativePipeSocket>();
  let closed = false;
  let failureReported = false;

  // The native callback runs from the event loop, never during the
  // constructor, so `listener` is set by the time it does.
  const listener: NativePipeListener = new module.NativePipeListener(name, options.maxInstances, () => wake());

  const report = (error: unknown): void => {
    try {
      if (options.onConnectionError) {
        options.onConnectionError(error);
        return;
      }
    } catch (inner) {
      error = inner;
    }
    console.error('[native-pipe] connection handler failed:', error);
  };

  /** Hand one accepted connection on. Never throws. */
  const accept = (conn: NativePipeConn): void => {
    let socket: NativePipeSocket;
    try {
      socket = new NativePipeSocket(conn);
    } catch {
      // The connection is gone already (the constructor destroyed it).
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    try {
      options.onConnection(socket);
    } catch (error) {
      socket.destroy();
      report(error);
    }
  };

  // One wake for the listener and all its connections. It keeps running
  // after close() for the connections still open. It never throws: a throw
  // would leave the rest undrained, and no other wake would come for them.
  function wake(): void {
    if (!closed) {
      try {
        for (let conn = listener.takeAccepted(); conn !== null; conn = listener.takeAccepted()) accept(conn);
        const failure = listener.failure();
        if (failure && !failureReported) {
          failureReported = true;
          options.onFailure?.(failure);
        }
      } catch (error) {
        report(error);
      }
    }
    // pump() catches its own errors (they destroy that socket).
    for (const socket of [...sockets]) socket.pump();
  }

  return {
    close(): void {
      if (closed) return;
      closed = true;
      // Accepted since the last wake and never handed on: closed with it.
      for (let conn = listener.takeAccepted(); conn !== null; conn = listener.takeAccepted()) conn.destroy();
      listener.close();
    },
    get failure(): string | null {
      return listener.failure();
    },
  };
}
