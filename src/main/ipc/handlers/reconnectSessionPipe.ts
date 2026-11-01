/**
 * The session-pipe step of `pty:reconnect` (daemon mode): give a pane whose
 * renderer is (re)attaching a writable session pipe in main, and the screen
 * replay its freshly registered listeners need.
 *
 * Extracted from pty.handler (electron-free) so the pipe hand-off has direct
 * unit coverage; the handler keeps the session lookup, the suspended/promote
 * branch and the bookkeeping around it.
 */
import type { DaemonClient } from '../../DaemonClient';

export type ReconnectPipeClient = Pick<DaemonClient, 'rpc' | 'connectSessionPipe' | 'isSessionPipeWritable'>;

export type ReconnectPipeOutcome =
  /** A fresh daemon attach and a fresh main-side socket. */
  | { kind: 'attached' }
  /** The daemon holds the session as a pending recovery again (#2398). */
  | { kind: 'pending' }
  /** The new socket is not writable yet. */
  | { kind: 'not-writable' };

export interface ReconnectPipeOptions {
  /** May the attach promote a pending recovery (#2398)? */
  promote: boolean;
  /** Install this reconnect's session:data forwarder (replace semantics). */
  installListener: () => void;
}

export async function reconnectSessionPipe(
  client: ReconnectPipeClient,
  id: string,
  opts: ReconnectPipeOptions,
): Promise<ReconnectPipeOutcome> {
  // Set up data forwarding BEFORE attachSession, not after. attachSession
  // makes the daemon replay the session's historical screen (the recovered
  // RingBuffer) the instant the pipe connects — for an IDLE recovered pane
  // (a shell sitting at its prompt) that replay is the ONLY paint it will
  // get, because no new output is coming. Registering the handler after
  // attach+connect (the old order) left a window where DaemonClient could
  // read+emit that replay before a handler existed, dropping it — the pane
  // then sat blank until a focus/reveal forced a resync. Registering first
  // closes the window; replace-semantics keep a repeat reconnect from
  // stacking a duplicate.
  opts.installListener();

  // Reconnect is an explicit fresh-attach intent — pass forceFresh
  // so a stale sessionPipes entry (left over from a prior daemon
  // pipe replacement) is torn down rather than silently reused.
  // Without this, attach+connect can return success while the
  // underlying socket is moments away from receiving its close
  // event, and every subsequent write silently disappears.
  // #2398 — the attach promotes only as `promote` says: a daemon that
  // restarted since the list holds a WSL session as a pending recovery
  // again, and a caller that may not start it leaves it pending (held).
  const attached = await client.rpc('daemon.attachSession', { id, promote: opts.promote }) as { pending?: boolean } | undefined;
  if (attached?.pending) return { kind: 'pending' };
  await client.connectSessionPipe(id, { forceFresh: true });

  // Health probe: confirm the freshly connected pipe is actually
  // writable before reporting success. A truthy reconnect that
  // points at a dead socket is the exact shape of the input-mute
  // bug we're trying to prevent here.
  if (!client.isSessionPipeWritable(id)) return { kind: 'not-writable' };
  return { kind: 'attached' };
}
