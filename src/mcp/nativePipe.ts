/**
 * The native named-pipe listener (Windows; core/wmux-term, capability
 * `pipe-listener-v2`) and the server over it that hands each accepted
 * connection on as a NativePipeSocket.
 *
 * The native listener creates the pipe with an owner-only access list, a
 * handle child processes do not inherit, and a cap on its instances, and it
 * reads the client's identity at accept (NativePipeSocket.peer) and, on
 * request, from the client's own token (NativePipeSocket.tokenFacts). The MCP
 * broker listens with it on Windows (src/mcp/broker.ts).
 */
import { loadNativeTerminalCore, type NativeTerminalCore } from '../shared/nativeTerminalCore';
import { NativePipeSocket, type NativePipeConn } from './nativePipeSocket';

/** The listener, its connections' token reads (requestTokenFacts /
 *  takeTokenFacts) and nativePipeOwnedByUs. The core lists v1 beside it. */
export const NATIVE_PIPE_CAPABILITY = 'pipe-listener-v2';

/**
 * Who holds a named pipe, compared with this process's user:
 * - 'ours': its owner is this process's user;
 * - 'foreign': another owner, or this user may not open it at all;
 * - 'busy': every instance is in use (unknown; ask again later);
 * - 'none': no pipe has this name.
 */
export type PipeOwnerVerdict = 'ours' | 'foreign' | 'busy' | 'none';
/** The most accepted connections a listener takes at a time (the native
 *  limit of 254 pipe instances, less the one kept listening). */
export const NATIVE_PIPE_MAX_INSTANCES = 253;

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
  /** Who holds the pipe `name` (a `\\.\pipe\...` path). Opens a client
   *  handle that reads the owner and writes nothing, then closes it. Throws
   *  on an error other than the ones the verdicts cover. */
  nativePipeOwnedByUs(name: string): PipeOwnerVerdict;
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
  if (typeof core.nativePipeOwnedByUs !== 'function') throw new Error('Native terminal core lacks the pipe owner check');
  return core as NativePipeModule;
}

export interface NativePipeServer {
  /** Stops accepting (idempotent). Sockets already handed on stay open. */
  close(): void;
  /** Why accepting stopped on its own, or null. */
  readonly failure: string | null;
}

export interface ListenNativePipeOptions {
  /** Accepted connections at a time, an integer in 1..=NATIVE_PIPE_MAX_INSTANCES.
   *  The native side keeps one more instance listening on top of these. */
  maxInstances: number;
  onConnection(socket: NativePipeSocket): void;
  /** A listener failure: once when accepting stops on its own (the native
   *  failure() reason), and whenever reading the listener throws (the reason
   *  names the call). Logged to stderr when absent, or when it throws. */
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
  const max = options.maxInstances;
  if (!Number.isInteger(max) || max < 1 || max > NATIVE_PIPE_MAX_INSTANCES) {
    throw new RangeError(`maxInstances must be an integer from 1 to ${NATIVE_PIPE_MAX_INSTANCES} (accepted connections at a time), got ${String(max)}`);
  }
  const module = options.module ?? loadNativePipe();
  if (!module) throw new Error('The native pipe listener is Windows only');
  const sockets = new Set<NativePipeSocket>();
  let closed = false;
  let failureReported = false;

  // The native callback runs from the event loop, never during the
  // constructor, so `listener` is set by the time it does.
  const listener: NativePipeListener = new module.NativePipeListener(name, max, () => wake());

  const listenerFailure = (reason: string): void => {
    if (options.onFailure) {
      try {
        options.onFailure(reason);
        return;
      } catch (error) {
        console.error('[native-pipe] onFailure threw:', error);
      }
    }
    console.error(`[native-pipe] listener failure: ${reason}`);
  };
  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
      // Each step on its own: a throw in one never skips the others. A
      // takeAccepted() that throws ends this wake's draining (calling it
      // again could throw forever); the next wake drains the rest.
      for (;;) {
        let conn: NativePipeConn | null;
        try {
          conn = listener.takeAccepted();
        } catch (error) {
          listenerFailure(`takeAccepted() threw: ${message(error)}`);
          break;
        }
        if (conn === null) break;
        accept(conn);
      }
      let failure: string | null = null;
      try {
        failure = listener.failure();
      } catch (error) {
        listenerFailure(`failure() threw: ${message(error)}`);
      }
      if (failure && !failureReported) {
        failureReported = true;
        listenerFailure(failure);
      }
    }
    // A native error destroys that socket inside pump(). A consumer callback
    // that throws propagates out of pump(): every other socket is still
    // pumped, and the error is rethrown on its own (an uncaught exception, as
    // from a net.Socket's callback), never out of this native callback.
    for (const socket of [...sockets]) {
      try {
        socket.pump();
      } catch (error) {
        setImmediate(() => { throw error; });
      }
    }
  }

  return {
    close(): void {
      if (closed) return;
      closed = true;
      try {
        // Accepted since the last wake and never handed on: closed with it.
        for (let conn = listener.takeAccepted(); conn !== null; conn = listener.takeAccepted()) conn.destroy();
      } catch (error) {
        listenerFailure(`takeAccepted() threw during close: ${message(error)}`);
      } finally {
        // The native side also destroys conns it never handed off.
        listener.close();
      }
    },
    get failure(): string | null {
      return listener.failure();
    },
  };
}
