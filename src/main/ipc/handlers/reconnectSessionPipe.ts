/**
 * The session-pipe step of `pty:reconnect` (daemon mode): give a pane whose
 * renderer is (re)attaching a writable session pipe in main, and the screen
 * replay its freshly registered listeners need.
 *
 * Extracted from pty.handler (electron-free) so the pipe hand-off has direct
 * unit coverage; the handler keeps the session lookup, the suspended/promote
 * branch and the bookkeeping around it.
 *
 * A pane main creates is attached by the create itself: pty:create runs
 * daemon.attachSession, connects the session pipe and schedules the startup
 * line on it (scheduleInitialCommand), behind a data listener that tells that
 * line when the shell first spoke. The Terminal that then mounts on the pane
 * reattaches ('active-at-mount'). A full attach there is the bug this step
 * avoids: the daemon stops the live pipe (input it had not read yet is gone),
 * forceFresh destroys main's socket (its unsent bytes with it) and the
 * listener swap drops the create-time one, so a launch line or keystroke
 * written around the swap was lost although writeToSession reported it
 * delivered. That pipe never detached (the same reasoning as the #1002
 * adoption skip in useTerminal), so it is kept, and the screen the mounting
 * Terminal missed is replayed over it by the daemon's live re-flush.
 */
import type { DaemonClient } from '../../DaemonClient';
import { SNAPSHOT_MAX_SCROLLBACK } from '../../../shared/terminal/attachSnapshot';
import type { SessionResync } from './sessionResync';

export type ReconnectPipeClient = Pick<DaemonClient, 'rpc' | 'connectSessionPipe' | 'isSessionPipeWritable' | 'sessionPipeFlushPending'>;

export type ReconnectPipeOutcome =
  /** The create-time pipe and listener kept; the screen replayed over them. */
  | { kind: 'kept'; replay: 'reflush' | 'initial-flush' }
  /** A fresh daemon attach and a fresh main-side socket. */
  | { kind: 'attached' }
  /** The daemon holds the session as a pending recovery again (#2398). */
  | { kind: 'pending' }
  /** The new socket is not writable yet. */
  | { kind: 'not-writable' };

export interface ReconnectPipeOptions {
  /** May the attach promote a pending recovery (#2398)? */
  promote: boolean;
  /**
   * main's pipe for this session is the one its own pty:create attached in
   * this DaemonClient generation, and nothing has attached since (the caller
   * consumes that mark). A new daemon generation, a supervised restart, a
   * death or a dispose clears it.
   */
  ownsCreatePipe: boolean;
  /** The session re-flush shared with pty:resync (sessionResync.ts). */
  resync: SessionResync;
  /** Install this reconnect's session:data forwarder (replace semantics). */
  installListener: () => void;
}

export async function reconnectSessionPipe(
  client: ReconnectPipeClient,
  id: string,
  opts: ReconnectPipeOptions,
): Promise<ReconnectPipeOutcome> {
  if (opts.ownsCreatePipe) {
    const kept = await keepCreatePipe(client, id, opts);
    if (kept) return kept;
  }

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

/**
 * Keep the pipe pty:create attached and replay the screen over it. Null when
 * there is no live create-time pipe to keep: a full attach is then the only
 * way to a working pipe.
 */
async function keepCreatePipe(
  client: ReconnectPipeClient,
  id: string,
  opts: ReconnectPipeOptions,
): Promise<ReconnectPipeOutcome | null> {
  // main saw the socket close: the daemon stopped that pipe.
  if (!client.isSessionPipeWritable(id)) return null;
  // This reconnect's listener takes over from the create-time one, as after
  // a full attach (the startup line hears the shell's first output through
  // either). The pipe stays, so nothing is in flight to lose.
  opts.installListener();
  // The attach flush is still on its way to main's listener, and the renderer
  // registered its own before reconnecting: that flush is the replay. (A
  // re-flush in progress also reads as a pending flush; it is joined below.)
  if (client.sessionPipeFlushPending(id) && !opts.resync.inFlight(id)) return { kind: 'kept', replay: 'initial-flush' };
  // The same live re-flush a reveal asks for, joined if one is running, at
  // the attach flush's scrollback bound (it replaces that flush). The socket
  // stays up, so input keeps flowing while the screen is replayed.
  const res = await opts.resync(id, SNAPSHOT_MAX_SCROLLBACK);
  if (res.success) return { kind: 'kept', replay: 'reflush' };
  // No live scanner on the pipe, no re-flush the daemon could give (it has no
  // flushed client on this pipe: stopped, its close not seen here yet), or no
  // such RPC: nothing live to keep.
  return null;
}
