import type { RingBuffer } from './RingBuffer';
import type { OutputModeTracker } from './util/outputModeTracker';
import { enqueueSnapshotJob, generateTextSnapshotUnqueued, type TextSnapshotOutcome } from './HeadlessSnapshot';
import { snapshotRingTextUnqueued } from './nativeRingSnapshot';
import { readSessionTextReplay } from './sessionTextReplay';
import { fencedRead, identityTag, noteScreenParse } from './screenReadCache';
import { guardedTailRead, type TailInputs, type TailOutcome, type TailSite } from './guardedTailRead';

/** What a queued text read needs of a session (a ManagedSession). */
export interface TextReadSession {
  meta: { cols: number; rows: number };
  ringBuffer: RingBuffer;
  bridge: { readonly outputModes: Pick<OutputModeTracker, 'preamble'> | null };
}

/** The session manager's lookup (DaemonSessionManager.getSession). */
export interface TextReadSessions {
  getSession(id: string): TextReadSession | undefined;
}

// One token per session object. A session id is not an identity: a supervised
// restart re-creates a dead pane under the same id (removeTombstone), and so
// does any create that reuses a closed pane's id.
const sessionTokens = new WeakMap<TextReadSession, number>();
let nextSessionToken = 0;

function sessionToken(session: TextReadSession): number {
  let token = sessionTokens.get(session);
  if (token === undefined) {
    token = ++nextSessionToken;
    sessionTokens.set(session, token);
  }
  return token;
}

/**
 * Run `read` on the session `sessionId` names NOW, in the shared
 * concurrency-1 snapshot queue. The session is pinned at the call, the way the
 * phone's scrollback search pins its pane: if it closed, or another session
 * took its id, while the job waited, the read answers null (what a closed
 * pane reads as) instead of the other session's screen. The coalesce key
 * carries the session's token, so a read joins only a waiting read of the
 * same session, never one of an earlier session under the same id.
 * With `reuse`, a read whose ring bytes and size have not moved since the
 * session's last answer of the same kind gets that answer without queueing
 * (screenReadCache).
 */
function queuedSessionRead<T extends TextSnapshotOutcome>(
  sessions: TextReadSessions,
  sessionId: string,
  kind: string,
  read: (session: TextReadSession) => Promise<T>,
  reuse = true,
): Promise<T | null> {
  const pinned = sessions.getSession(sessionId);
  // Already gone: the answer the job would give at its turn, without the wait.
  if (!pinned) return Promise.resolve(null);
  let readAt: string | null = null;
  const queued = () => {
    const askedAt = performance.now();
    return enqueueSnapshotJob(async () => {
      if (sessions.getSession(sessionId) !== pinned) return null;
      // `read` copies the ring before its first await, so this names exactly
      // the bytes and size the answer describes.
      readAt = readFence(pinned);
      const answer = read(pinned);
      // A ring that failed to wake read only its pending bytes: answer, but
      // don't keep it, or it would stand once the stored history reads again.
      if (pinned.ringBuffer.isHibernated) readAt = null;
      const outcome = await answer;
      noteScreenParse(kind, performance.now() - askedAt, outcome.ok ? outcome.bytesIn : 0);
      return outcome;
    }, `${kind}:${sessionId}#${sessionToken(pinned)}`);
  };
  if (!reuse) return queued();
  return fencedRead(pinned, kind, readFence(pinned), queued, (outcome) => (outcome?.ok ? readAt : null));
}

/** The deepest text read kept for reuse: deeper ones are rare and large. */
const REUSE_MAX_SCROLLBACK = 2000;

function readFence(session: TextReadSession): string {
  const { ringBuffer, meta, bridge } = session;
  return `${ringBuffer.totalBytesWritten}:${meta.cols ?? 80}x${meta.rows ?? 24}:${identityTag(bridge.outputModes)}`;
}

/**
 * A plain-text parse of a session's ring on the shared concurrency-1 snapshot
 * queue. The ring is copied only when the job's turn comes, so a job waiting
 * behind attach snapshots pins no ring copy. A read of the same session and
 * depth still waiting joins the queued one (enqueueSnapshotJob's coalesceKey).
 */
export function queuedTextSnapshot(sessions: TextReadSessions, sessionId: string, scrollback: number): Promise<TextSnapshotOutcome | null> {
  return queuedSessionRead(sessions, sessionId, `text:${scrollback}`, (managed) =>
    snapshotRingTextUnqueued(managed.ringBuffer, managed.bridge.outputModes, {
      // Dims backstop parity with the attach flush (?? 80 / ?? 24): a recovered
      // session may not have real dims yet, and a 0-wide headless terminal would
      // fail soft instead of reading.
      cols: managed.meta.cols ?? 80,
      rows: managed.meta.rows ?? 24,
      scrollback,
    }), scrollback <= REUSE_MAX_SCROLLBACK);
}

/**
 * The visible grid of a pane (no scrollback), for the approval check, the chat
 * bridge and automation. Read in the slot like queuedTextSnapshot, so the
 * pollers that call this many times while the queue is busy share one parse
 * per pane instead of each queueing a whole-ring parse of its own.
 */
export function queuedScreenText(sessions: TextReadSessions, sessionId: string, undimmed = false): Promise<TextSnapshotOutcome | null> {
  return queuedSessionRead(sessions, sessionId, `screen:${undimmed ? 'undimmed' : 'plain'}`, (managed) =>
    generateTextSnapshotUnqueued({
      cols: managed.meta.cols ?? 80,
      rows: managed.meta.rows ?? 24,
      scrollback: 0,
      initial: readSessionTextReplay(managed.ringBuffer, managed.bridge.outputModes),
      ...(undimmed ? { undimmed: true } : {}),
    }));
}

/**
 * queuedTextSnapshot from the ring's newest 256 KiB when that gives the same
 * rows (guardedTailRead.ts), else from the whole ring. For display only (the
 * Fleet preview): its own kind, so its answers are never reused by, or joined
 * to, a whole-ring read.
 */
export function queuedTextTail(sessions: TextReadSessions, sessionId: string, scrollback: number, site: TailSite): Promise<TailOutcome | null> {
  return queuedSessionRead(sessions, sessionId, `text-tail:${scrollback}`, (managed) => {
    const request = { cols: managed.meta.cols ?? 80, rows: managed.meta.rows ?? 24, scrollback };
    return guardedTailRead(managed, { site, parse: (initial) => generateTextSnapshotUnqueued({ ...request, initial }) });
  }, scrollback <= REUSE_MAX_SCROLLBACK);
}

/**
 * queuedScreenText (plain) from the ring's newest 256 KiB when that gives the
 * same rows, else from the whole ring. For estimates only (StallWatch), never
 * for a safety gate: its own kind, as queuedTextTail. `inputs` are the site's
 * decisions over the rows, which the real-data check compares by count.
 */
export function queuedScreenTail(sessions: TextReadSessions, sessionId: string, site: TailSite, inputs?: TailInputs): Promise<TailOutcome | null> {
  return queuedSessionRead(sessions, sessionId, 'screen-tail:plain', (managed) => {
    const request = { cols: managed.meta.cols ?? 80, rows: managed.meta.rows ?? 24, scrollback: 0 };
    return guardedTailRead(managed, { site, inputs, parse: (initial) => generateTextSnapshotUnqueued({ ...request, initial }) });
  });
}
