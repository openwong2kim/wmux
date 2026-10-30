import { readFolderTrustScreen } from './approvals/approvalKeystrokes';
import { AWAITING_RENDER_WINDOW_BYTES, liveGeometry, renderPaneScreen, type AwaitingFrame, type RenderablePane } from './AwaitingScreenVerifier';
import { createSnapshotLane, generateTextSnapshotUnqueued, runSmallSnapshotJob } from './HeadlessSnapshot';
import { UNKNOWN_CELL } from './sessionTextReplay';
import { joinWrappedRows } from './web/hostSearch';
import { FOLDER_TRUST_DEFAULT_BUDGET_MS } from '../shared/folderTrustWording';
import type { DaemonPipeServer } from './DaemonPipeServer';
import type { DaemonSessionState } from './types';

/**
 * Whether a session's own output shows an agent's folder-trust dialog:
 *   - 'trust': the dialog is the live screen;
 *   - 'clear': it is not, or nothing runs in the session;
 *   - 'unknown': the screen could not be read in time or whole, or it shows a
 *     trust question over choices a narrow pane cut too short to read.
 */
export type FolderTrustState = 'trust' | 'clear' | 'unknown';

/**
 * Why a verdict is 'unknown', for the refusal logs:
 *   - 'unseen-cells': cells no byte left in the ring drew lie where a dialog
 *     would be;
 *   - 'cut-choices': a trust question over choices cut too short to read;
 *   - 'unreadable': the screen could not be rebuilt (a failed parse, a resize
 *     during the read, a whole ring that did not parse within its own budget);
 *   - 'timeout': the read, or the whole-ring parse it waited for, outlasted
 *     the request's budget (that parse goes on, and its verdict answers a
 *     later request for the same output);
 *   - 'muted': a resize while muted dropped the output held for the pane.
 */
export type FolderTrustUnknownReason = 'unseen-cells' | 'cut-choices' | 'unreadable' | 'timeout' | 'muted';

/** A verdict, and for 'unknown' why. */
export interface FolderTrustReading {
  state: FolderTrustState;
  reason?: FolderTrustUnknownReason;
}

/** The longest budget a caller may ask for (`daemon.folderTrustState`'s
 *  `budgetMs` is clamped to it). */
export const FOLDER_TRUST_MAX_BUDGET_MS = 2000;

/**
 * Whole-ring parses run at most this many at once, across all panes, in a
 * lane of their own: not in the small-snapshot slots a new pane's attach
 * flush and the shell-prompt watcher use, and not behind the shared queue.
 * With one parse per session (wholeRingRun), at most this many ring copies
 * are held for it at a time.
 */
export const WHOLE_RING_CONCURRENCY = 2;
const runWholeRingJob = createSnapshotLane(WHOLE_RING_CONCURRENCY);

/**
 * A whole-ring parse's own budget, whatever its callers wait: an 8 MB ring at
 * 2 MB/s (measured at about 65 MB/s on a Mac). A ring that does not parse in
 * it is kept as 'unknown' ('unreadable') for its bytes: the same bytes would
 * parse no better, and parsing them on every request would hold the lane.
 */
const WHOLE_RING_BUDGET_MS = 4000;

/** Room above the tail window for the mode preamble and the unknown-cell fill. */
const TAIL_SLACK_BYTES = 64 * 1024;

/** Rows from a dialog's question to the last row with content: the tallest
 *  measured is 40 (Gemini CLI at 18 columns: 36 to its box's bottom edge, and
 *  4 more to the end of the notice a first Ctrl+C prints under it). A
 *  constant, since the question itself may be among the cells the ring lost. */
const DIALOG_SPAN_ROWS = 44;

/** What the verdict needs of a session (a ManagedSession). */
export type FolderTrustSession = RenderablePane & {
  meta: { state: DaemonSessionState };
  /** The lifetime byte count: the mark a whole-ring verdict was read at. */
  ringBuffer: { readonly totalBytesWritten: number };
  bridge: { heldOutput(): { total: number; read(): { data: Buffer; dropped: number } } | null };
  /** Resized while muted: the held output was dropped, or mixes sizes. */
  resizedWhileMuted?: boolean;
};

type Snapshot = Parameters<typeof renderPaneScreen>[1];

export interface FolderTrustDeps {
  getSession: (id: string) => FolderTrustSession | undefined;
  /** How long the request waits, for the tail and any whole-ring parse
   *  together (FOLDER_TRUST_DEFAULT_BUDGET_MS when omitted). */
  timeoutMs?: number;
  /** Injected in tests; defaults to a parse outside the shared snapshot
   *  queue: the tail's stopped at the request's deadline, the whole ring's
   *  at its own budget (WHOLE_RING_BUDGET_MS). */
  snapshot?: Snapshot;
  /** Where a whole-ring parse's timing line goes; defaults to the daemon log. */
  log?: (message: string) => void;
}

/**
 * What a parse of a session's whole ring decided, at the mark and the size it
 * was read at (for a muted session, the mark counts its held output too). The
 * bytes and the sizes they were written at fix the screen, so the verdict
 * holds while the mark, the mute and the size stay the same. A parse that
 * finished is kept, and one past its own budget (as 'unknown'); one the pane
 * was resized or closed under is not.
 */
interface WholeRingVerdict {
  mark: number;
  muted: boolean;
  cols: number;
  rows: number;
  reading: FolderTrustReading;
  /** When a parse past its own budget was kept; such a verdict is retried after OVER_BUDGET_RETRY_MS. */
  overBudgetAt?: number;
}

/** The last whole-ring verdict per session. */
const wholeRingVerdicts = new WeakMap<FolderTrustSession, WholeRingVerdict>();

/**
 * How long a parse that ran past its own budget keeps answering for the same
 * bytes. The budget is wall-clock time shared with the other lanes, so missing
 * it can mean load rather than size, and an idle pane may never print again.
 */
const OVER_BUDGET_RETRY_MS = 30_000;

/** Where a whole-ring parse's timing line goes when the caller passes no `log`. */
let wholeRingTimingLog: ((message: string) => void) | undefined;

/** Set by the daemon at start so timing lines reach its log file. */
export function setFolderTrustTimingLog(log: (message: string) => void): void {
  wholeRingTimingLog = log;
}

/** One whole-ring parse of a session. `mark`: where it read the ring; unset
 *  while it waits for its turn, when it will read bytes at least as new as
 *  those of any request that joins it. */
interface WholeRingRun {
  mark?: number;
  done: Promise<FolderTrustReading>;
}

/** The whole-ring parse under way per session, and the one queued behind it
 *  for bytes newer than it read. */
const wholeRingRuns = new WeakMap<FolderTrustSession, { running?: WholeRingRun; next?: WholeRingRun }>();

/**
 * The verdict for one session, read from the daemon's ring rather than a
 * renderer's screen, so it holds for a pane that is hidden, parked or not
 * attached yet. A session with no process ('suspended', 'dead', or a
 * recovery placeholder) shows no live dialog. A muted one (recovered, not
 * shown yet) holds its newest output outside the ring, so the ring and that
 * held output are read together, or, once the hold dropped some of it, the
 * newest held output alone (see withHeldOutput); after a resize dropped it,
 * the verdict is 'unknown'.
 *
 * The screen is rebuilt like the awaiting verifier's (renderPaneScreen): each
 * stretch of the ring at the size it was written at, a resize during the read
 * rejected, and cells the ring no longer covers marked. A ring larger than
 * the tail window is read from its tail first: a live dialog is the pane's
 * newest output, and the tail decides most screens at a fraction of the
 * whole ring's cost. The tail parse takes a small-snapshot slot, beside the
 * shared snapshot queue, not behind it; the ring is copied only once the slot
 * is taken, and the parse stops at the request's deadline.
 *
 * A tail that cannot decide is not the last word (#2855). A renderer that
 * repaints by cell diff (ConPTY, Claude Code) never redraws a cell that did
 * not change, so the cells drawn before the tail read as unknown, idle or
 * printing, and a dialog's choices may read as cut. The whole ring is then
 * parsed (wholeRingRun): one parse per session at a time, in a lane of its
 * own, under its own budget rather than the request's. The request waits for
 * it until its own deadline ('unknown', 'timeout', past it); the parse goes
 * on, and its verdict answers every request until the pane prints or is
 * resized.
 */
export async function folderTrustState(deps: FolderTrustDeps, id: string): Promise<FolderTrustState> {
  return (await readFolderTrust(deps, id)).state;
}

/** folderTrustState, saying also why a verdict is 'unknown'. */
export async function readFolderTrust(deps: FolderTrustDeps, id: string): Promise<FolderTrustReading> {
  const session = deps.getSession(id);
  // No process runs under an id the daemon holds no live session for: a
  // recovery placeholder, a record kept only on disk, a closed pane.
  if (!session) return CLEAR;
  if (session.meta.state === 'suspended' || session.meta.state === 'dead') return CLEAR;
  const readable = readableOutput(session);
  if (!readable) return MUTED;
  const known = currentWholeRingVerdict(session, readable.mark);
  if (known) return known;
  const timeoutMs = deps.timeoutMs ?? FOLDER_TRUST_DEFAULT_BUDGET_MS;
  const deadline = Date.now() + timeoutMs;
  let dropped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      dropped = true;
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
  });
  const parse: Snapshot = deps.snapshot ?? ((req) => generateTextSnapshotUnqueued({ ...req, budgetMs: Math.max(1, deadline - Date.now()) }));
  try {
    const tail = await Promise.race([runSmallSnapshotJob(() => readTail(deps, id, session, parse, () => dropped)).catch(() => null), timedOut]);
    if (!tail) return { state: 'unknown', reason: dropped ? 'timeout' : 'unreadable' };
    if ('reading' in tail) return tail.reading;
    const reading = verdictOf(tail.frame);
    // A tail that read the whole ring, or decided, is the answer.
    if (tail.whole || reading.state !== 'unknown') return reading;
    // A whole ring kept for this tail's bytes, or a parse that reads at least them.
    const kept = currentWholeRingVerdict(session, tail.mark);
    if (kept) return kept;
    return (await Promise.race([wholeRingRun(deps, id, session, tail.mark).done, timedOut])) ?? { state: 'unknown', reason: 'timeout' };
  } finally {
    clearTimeout(timer);
  }
}

const CLEAR: FolderTrustReading = { state: 'clear' };
const MUTED: FolderTrustReading = { state: 'unknown', reason: 'muted' };

/**
 * The tail read, inside its small-snapshot slot: the ring is read (and its
 * mark taken) only now, so a request waiting for a slot holds no copy of it.
 * `frame`, at `mark`, and whether it covers the whole ring (a ring no larger
 * than the tail window); or a reading when there is nothing to parse.
 */
async function readTail(
  deps: FolderTrustDeps,
  id: string,
  session: FolderTrustSession,
  parse: Snapshot,
  dropped: () => boolean,
): Promise<{ frame: AwaitingFrame; mark: number; whole: boolean } | { reading: FolderTrustReading } | null> {
  // A request past its deadline reads nothing once its turn comes.
  if (dropped()) return null;
  const readable = readableOutput(session);
  if (!readable) return { reading: MUTED };
  const pane = readable.pane();
  let firstRead = true;
  let whole = false;
  const tailFirst: Snapshot = async (req) => {
    // A whole ring larger than the tail window: answer 'budget' at once, so
    // renderPaneScreen reads its tail.
    const first = firstRead;
    firstRead = false;
    if (first && req.initial.length > AWAITING_RENDER_WINDOW_BYTES + TAIL_SLACK_BYTES) return { ok: false, reason: 'budget' };
    if (dropped()) return { ok: false };
    const outcome = await parse(req);
    if (first && outcome.ok) whole = true;
    return outcome;
  };
  const frame = await renderPaneScreen(() => (deps.getSession(id) === session ? pane : undefined), tailFirst);
  return frame ? { frame, mark: readable.mark, whole } : null;
}

/** A frame's verdict: the dialog on it, or an unseen cell where one would be. */
function verdictOf(frame: AwaitingFrame): FolderTrustReading {
  const lines = joinWrappedRows(frame.rows.map((text, i) => ({ text, wrapped: frame.wrapped?.[i] === true })), frame.cols);
  const onScreen = readFolderTrustScreen(lines.slice(-60));
  if (onScreen === 'trust') return { state: 'trust' };
  if (onScreen === 'unreadable') return { state: 'unknown', reason: 'cut-choices' };
  return frame.unknown && unknownWhereADialogWouldBe(frame.unknown) ? { state: 'unknown', reason: 'unseen-cells' } : CLEAR;
}

/** The whole-ring verdict, while the output holds no newer byte (`mark`), the mute is unchanged and the size is the one it was read at. */
function currentWholeRingVerdict(session: FolderTrustSession, mark: number): FolderTrustReading | null {
  const known = wholeRingVerdicts.get(session);
  if (!known || known.mark !== mark || known.muted !== session.bridge.isMuted) return null;
  if (known.overBudgetAt !== undefined && Date.now() - known.overBudgetAt > OVER_BUDGET_RETRY_MS) return null;
  const size = liveGeometry(session);
  return size && size.cols === known.cols && size.rows === known.rows ? known.reading : null;
}

/**
 * The whole-ring parse that answers a request whose tail was read at `mark`:
 * the session's parse under way when it read the ring at `mark` or later, or
 * has not read it yet; else the one queued behind it, which reads the ring
 * once that one ends. One parse per session at a time, so requests that
 * arrive together (a delivery gate, a wake nudge) share one parse and one
 * ring copy.
 */
function wholeRingRun(deps: FolderTrustDeps, id: string, session: FolderTrustSession, mark: number): WholeRingRun {
  let runs = wholeRingRuns.get(session);
  if (!runs) {
    runs = {};
    wholeRingRuns.set(session, runs);
  }
  const slot = runs;
  if (slot.next) return slot.next;
  const { running } = slot;
  if (running && (running.mark === undefined || running.mark >= mark)) return running;
  const queuedAt = Date.now();
  const run: WholeRingRun = { done: Promise.resolve(MUTED) };
  // A run never rejects (parseWholeRing catches), so its end is the next one's turn.
  const turn = running ? running.done.then(() => undefined) : Promise.resolve();
  run.done = turn
    .then(() => {
      slot.running = run;
      if (slot.next === run) slot.next = undefined;
      return runWholeRingJob(() => parseWholeRing(deps, id, session, run, queuedAt));
    })
    .finally(() => {
      if (slot.running === run) slot.running = undefined;
    });
  if (running) slot.next = run;
  else slot.running = run;
  return run;
}

/**
 * Parse the session's whole ring, as it is when the lane gives the parse its
 * turn (`run.mark`), under its own budget, and keep its verdict (see
 * currentWholeRingVerdict). The replay keeps no scrollback, so the headless
 * terminal holds one screen. One timing line per parse (bytes, ms in the
 * waiting for its turn and parsing, outcome), so a slower machine's parse speed can be read
 * from the log.
 */
async function parseWholeRing(
  deps: FolderTrustDeps,
  id: string,
  session: FolderTrustSession,
  run: WholeRingRun,
  queuedAt: number,
): Promise<FolderTrustReading> {
  try {
    const size = liveGeometry(session);
    if (deps.getSession(id) !== session || !size) return { state: 'unknown', reason: 'unreadable' };
    // The ring is read now, and renderPaneScreen reads it before its first await, at this mark.
    const readable = readableOutput(session);
    if (!readable) return MUTED;
    run.mark = readable.mark;
    const muted = session.bridge.isMuted;
    const pane = readable.pane();
    const live = (): RenderablePane | undefined => (deps.getSession(id) === session && session.bridge.isMuted === muted ? pane : undefined);
    const started = Date.now();
    let bytes = 0;
    let overBudget = false;
    const parse: Snapshot = async (req) => {
      bytes = req.initial.length;
      const outcome = await (deps.snapshot ?? ((r) => generateTextSnapshotUnqueued({ ...r, budgetMs: WHOLE_RING_BUDGET_MS })))(req);
      overBudget = !outcome.ok && outcome.reason === 'budget';
      return outcome;
    };
    const frame = await renderPaneScreen(live, parse, { tail: false }).catch(() => null);
    const reading: FolderTrustReading = frame ? verdictOf(frame) : { state: 'unknown', reason: 'unreadable' };
    if (frame || overBudget) {
      wholeRingVerdicts.set(session, {
        mark: readable.mark, muted, cols: size.cols, rows: size.rows, reading,
        ...(frame ? {} : { overBudgetAt: Date.now() }),
      });
    }
    const outcome = frame
      ? `${reading.state}${reading.reason ? ` (${reading.reason})` : ''}`
      : `not decided (${overBudget ? `past its ${WHOLE_RING_BUDGET_MS} ms budget` : 'unreadable'})`;
    (deps.log ?? wholeRingTimingLog ?? console.log)(`[folder-trust] whole-ring parse on pane ${id}: ${bytes} bytes in ${Date.now() - started} ms, after ${started - queuedAt} ms waiting: ${outcome}`);
    return reading;
  } catch {
    return { state: 'unknown', reason: 'unreadable' };
  }
}

/**
 * The mark a read is taken at (the ring's lifetime byte count, plus the held
 * output's for a muted session), and the pane it parses: the session itself,
 * or, while it is muted, its ring and the output held outside it. Null when a
 * resize while muted dropped that output, or mixed it with output at the old
 * size. The pane is built only for a parse: the mark alone answers from a
 * kept verdict.
 */
function readableOutput(session: FolderTrustSession): { mark: number; pane: () => RenderablePane } | null {
  if (!session.bridge.isMuted) return { mark: session.ringBuffer.totalBytesWritten, pane: () => session };
  const held = session.bridge.heldOutput();
  if (!held || session.resizedWhileMuted) return null;
  return { mark: session.ringBuffer.totalBytesWritten + held.total, pane: () => withHeldOutput(session, held.read()) };
}

/**
 * A muted session as the parse sees it, at the size the ring last recorded
 * (no resize while muted), and no longer muted: its ring followed by the
 * output held outside it. Once the hold dropped some, the newest held output
 * is read alone (from its first line or escape sequence, see the bridge's
 * tailBytes), like a ring that lost its oldest bytes: a cell it does not draw
 * is unknown (withUnknownCells).
 */
function withHeldOutput(session: FolderTrustSession, held: { data: Buffer; dropped: number }): RenderablePane {
  const tailOnly = held.dropped > 0;
  const { data } = held;
  return {
    meta: session.meta,
    ptyProcess: session.ptyProcess,
    ringBuffer: {
      readAllWithGeometry: () => {
        if (tailOnly) return { data, geometry: undefined, writtenAt: session.ringBuffer.totalBytesWritten + held.dropped + data.length };
        const ring = session.ringBuffer.readAllWithGeometry();
        return { ...ring, data: Buffer.concat([ring.data, data]), writtenAt: ring.writtenAt + data.length };
      },
    },
    // The modes the dropped output set are unknown; the ring's are older.
    bridge: { isMuted: false, outputModes: tailOnly ? null : session.bridge.outputModes },
  };
}

/**
 * Whether a cell the read could not see lies where a dialog would be: in the
 * DIALOG_SPAN_ROWS rows up to the last row with content. A full-screen TUI's
 * old cells above that (a header it never redraws) cannot hide one.
 */
function unknownWhereADialogWouldBe(unknownRows: readonly string[]): boolean {
  let last = unknownRows.length - 1;
  while (last >= 0 && unknownRows[last].trim() === '') last--;
  return unknownRows.slice(Math.max(0, last - DIALOG_SPAN_ROWS + 1), last + 1).some((row) => row.includes(UNKNOWN_CELL));
}

/** What `daemon.folderTrustState` reads of the session manager. */
export interface FolderTrustSessions {
  getSession(id: string): FolderTrustSession | undefined;
}

/**
 * `daemon.folderTrustState({ id, budgetMs? })` → `{ state, reason? }`. Main
 * asks when the renderer has no screen for a pane (hidden, parked, not
 * attached yet). `budgetMs` (clamped to FOLDER_TRUST_DEFAULT_BUDGET_MS ..
 * FOLDER_TRUST_MAX_BUDGET_MS) is for a caller no person waits on: an
 * agent's delivery may wait for a whole-ring parse a keystroke should not.
 */
export function registerFolderTrustRpc(pipeServer: Pick<DaemonPipeServer, 'onRpc'>, sessions: FolderTrustSessions): void {
  pipeServer.onRpc('daemon.folderTrustState', async (params) => {
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    const budget = params['budgetMs'];
    const timeoutMs = typeof budget === 'number' && Number.isFinite(budget)
      ? Math.min(FOLDER_TRUST_MAX_BUDGET_MS, Math.max(FOLDER_TRUST_DEFAULT_BUDGET_MS, budget))
      : undefined;
    // `reason` is additive: a main that predates it reads `state` alone, and
    // one that predates `budgetMs` gets the default budget.
    return readFolderTrust({ getSession: (sid) => sessions.getSession(sid), ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, id);
  });
}

/**
 * The verdict that keeps a daemon writer from typing into `id` now, or null
 * when it may write: 'trust' always; 'unknown' only for an automated writer
 * (`refuseUnknown`), never for a person's own input. One log line per
 * refusal, naming the writer and the verdict. `budgetMs` as for
 * `daemon.folderTrustState`.
 */
export async function folderTrustRefusal(
  sessions: FolderTrustSessions,
  id: string,
  writer: string,
  opts: { refuseUnknown: boolean; log: (message: string) => void; budgetMs?: number },
): Promise<'trust' | 'unknown' | null> {
  const { state: verdict, reason } = await readFolderTrust(
    { getSession: (sid) => sessions.getSession(sid), ...(opts.budgetMs !== undefined ? { timeoutMs: opts.budgetMs } : {}) },
    id,
  );
  if (verdict === 'clear' || (verdict === 'unknown' && !opts.refuseUnknown)) return null;
  opts.log(`[folder-trust] refused ${writer} on pane ${id}: folder-trust ${verdict}${reason ? ` (${reason})` : ''}`);
  return verdict;
}

/** A key a daemon writer did not send: the pane is on a folder-trust prompt
 *  ('trust'), or cannot rule one out ('unknown'). */
export class FolderTrustRefusedError extends Error {
  constructor(readonly verdict: 'trust' | 'unknown') {
    super(`folder-trust ${verdict}`);
  }
}
