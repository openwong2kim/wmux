// ─── Command Deck — the ledger status summary the Deck panel renders ────────
//
// The Deck's pinned status panel answers one question ("what is delegated right
// now?") and it must answer it from the LEDGER, not from pane screens: the
// ledger is the one state the brain, the workers and the Stop gate already
// share (src/shared/ledger.ts). This module is the pure projection between the
// two — ledger entries plus the workspace mirror's per-pane agent status, in,
// render-ready rows out — so the panel's contract is unit-testable without
// Electron, a daemon or a ledger on disk.
//
// `lastLine` and `title` are both text the ACTOR wrote (a worker, usually).
// They are UNTRUSTED: sanitized (control, bidi and format characters out,
// whitespace collapsed) and truncated here, and rendered as text by the panel,
// never as markup or instructions.

import type { LedgerEntry, LedgerStatus } from '../../shared/ledger';
import { isOpenLedgerStatus } from '../../daemon/ledger/TaskLedger';
import type { AgentStatus } from '../../shared/types';
import type { FleetSnapshot } from '../../shared/workspaceMirror';

/** Hard cap on the rendered `lastLine`. The panel gives it one row. */
export const LEDGER_ROW_LINE_MAX = 160;

/** Hard cap on the rendered `title`. Shorter than the line cap: the title
 *  shares its row with four other cells and the panel truncates it visually
 *  anyway — this cap bounds what crosses the IPC, it does not lay anything out. */
export const LEDGER_ROW_TITLE_MAX = 80;

/** Rows are capped so a runaway fan-out cannot make the pinned panel eat the
 *  Deck. The count in the header stays honest (`openCount` is not capped). */
export const LEDGER_SUMMARY_ROW_CAP = 20;

export interface DeckLedgerRow {
  /** WorkTask id. */
  id: string;
  title: string;
  status: LedgerStatus;
  /** The task workspace, so the panel can jump to the worker. */
  taskWorkspaceId: string;
  /** Agent status of the worker's panes, or null when the mirror knows none. */
  workerStatus: AgentStatus | null;
  /** Last ledger line — sanitized, truncated, UNTRUSTED. Null when the last
   *  transition carried no summary. */
  lastLine: string | null;
  /** Epoch ms of the last transition. */
  updatedAt: number;
  /** How long the row has sat at `updatedAt` (ms, never negative). */
  ageMs: number;
}

export interface DeckLedgerSummary {
  /** Open tasks the owner has — NOT capped by LEDGER_SUMMARY_ROW_CAP. */
  openCount: number;
  rows: DeckLedgerRow[];
  /**
   * Terminal tasks (completed / failed / cancelled) still inside the ledger's
   * retention window, newest first and capped like `rows`. Optional: a caller
   * that asked for open entries only gets no field at all, which is not the
   * same claim as "nothing has finished".
   *
   * These exist because closing a task used to take its mission channel out of
   * reach — the sidebar's finished-tasks disclosure was the only way back to
   * the record, and it went away with the sidebar rows.
   */
  finishedRows?: DeckLedgerRow[];
  /** Finished tasks the owner has — NOT capped, like `openCount`. */
  finishedCount?: number;
  /** Main's clock when the summary was built. */
  ts: number;
  /**
   * True when the ledger could not be READ at all. Deliberately distinct from
   * an empty summary: "nothing is delegated" and "I cannot tell you what is
   * delegated" are opposite facts, and collapsing the second into the first
   * hides a broken ledger behind a panel that looks idle — while the Stop gate
   * reading that same ledger may be holding the brain's turn open on it.
   */
  error?: true;
}

export const EMPTY_LEDGER_SUMMARY: DeckLedgerSummary = { openCount: 0, rows: [], ts: 0 };

/** What the panel gets when the ledger read threw. */
export const UNAVAILABLE_LEDGER_SUMMARY: DeckLedgerSummary = {
  openCount: 0,
  rows: [],
  ts: 0,
  error: true,
};

// Bidi controls and invisible format characters survive a C0 scrub — they are
// printable code points — yet they reorder or hide the text around them once in
// the DOM. Without this a worker could make its own row read as another task's.
// eslint-disable-next-line no-misleading-character-class
const BIDI_AND_FORMAT = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

/** Truncate by CODE POINT, never by UTF-16 unit: slicing units can split a
 *  surrogate pair and leave a lone half, which renders as U+FFFD. */
function truncateCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, max - 1).join('')}…`;
}

/** Collapse whitespace, drop control + bidi characters, truncate. */
export function sanitizeLedgerLine(
  raw: string | undefined,
  max: number = LEDGER_ROW_LINE_MAX,
): string | null {
  if (typeof raw !== 'string') return null;
  const flat = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(BIDI_AND_FORMAT, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return null;
  return truncateCodePoints(flat, max);
}

/** The row's title, through the same scrub as `lastLine`. A ledger title is
 *  written by whoever created the task (a worker, over the pipe), so it is
 *  exactly as untrusted as the summary line. */
export function sanitizeLedgerTitle(raw: string | undefined): string | null {
  return sanitizeLedgerLine(raw, LEDGER_ROW_TITLE_MAX);
}

/**
 * The one status a row shows for its worker. A pane waiting on a human beats a
 * running one: the panel exists to surface the task that needs somebody, and a
 * fan-out workspace routinely holds several panes.
 *
 * `waiting` sits BELOW `running` — it means "turn ended, ready for the next
 * instruction" (src/shared/types.ts), so one finished pane of a many-pane
 * workspace must not shout down the panes that are still working. Only
 * `awaiting_input` (blocked mid-turn) and `error` outrank live work.
 */
const WORKER_STATUS_PRIORITY: readonly AgentStatus[] = [
  'awaiting_input',
  'error',
  'running',
  'waiting',
  'complete',
  'idle',
];

export function pickWorkerStatus(panes: readonly { agentStatus: AgentStatus }[]): AgentStatus | null {
  if (panes.length === 0) return null;
  for (const candidate of WORKER_STATUS_PRIORITY) {
    if (panes.some((p) => p.agentStatus === candidate)) return candidate;
  }
  return panes[0].agentStatus;
}

/**
 * The panes of a mirror snapshot, or null when the snapshot is too old to
 * describe anything. The same freshness rule the Stop gate applies
 * (stopGate.ts): a workspace that was closed or detached stops pushing, so its
 * last snapshot would otherwise show a dead worker as `running` forever. A
 * derived signal that stopped arriving proves nothing — null means unknown, and
 * the row renders no worker status at all.
 */
export function freshSnapshotPanes(
  snapshot: FleetSnapshot | null | undefined,
  now: number,
  maxAgeMs: number,
): readonly { agentStatus: AgentStatus }[] | null {
  if (!snapshot) return null;
  return now - snapshot.ts <= maxAgeMs ? snapshot.panes : null;
}

export interface DeckLedgerSummaryInput {
  /** Already filtered to the owner (and, for the panel, to open tasks). */
  entries: readonly LedgerEntry[];
  /** The mirror's panes for a task workspace; empty/absent ⇒ unknown. */
  panesFor: (taskWorkspaceId: string) => readonly { agentStatus: AgentStatus }[] | null | undefined;
  now?: () => number;
}

/**
 * Project ledger entries into panel rows, newest transition first — the row
 * that just moved is the one the operator is looking for.
 */
export function buildDeckLedgerSummary(input: DeckLedgerSummaryInput): DeckLedgerSummary {
  const now = (input.now ?? Date.now)();
  const sorted = [...input.entries].sort((a, b) => b.updatedAt - a.updatedAt);
  const toRow = (e: LedgerEntry): DeckLedgerRow => ({
    id: e.id,
    // A title scrubbed to nothing falls back to the id: the row must stay
    // identifiable, and the id is the one field the panel already trusts.
    title: sanitizeLedgerTitle(e.title) ?? e.id,
    status: e.status,
    taskWorkspaceId: e.taskWorkspaceId,
    workerStatus: pickWorkerStatus(input.panesFor(e.taskWorkspaceId) ?? []),
    lastLine: sanitizeLedgerLine(e.summary),
    updatedAt: e.updatedAt,
    ageMs: Math.max(0, now - e.updatedAt),
  });
  // The caller decides what it asked for; this splits what it got. A caller
  // that filtered to open entries sees no finished half at all (the fields stay
  // absent), so "I did not ask" never renders as "nothing has finished".
  const open = sorted.filter((e) => isOpenLedgerStatus(e.status));
  const finished = sorted.filter((e) => !isOpenLedgerStatus(e.status));
  const summary: DeckLedgerSummary = {
    openCount: open.length,
    rows: open.slice(0, LEDGER_SUMMARY_ROW_CAP).map(toRow),
    ts: now,
  };
  if (finished.length > 0) {
    summary.finishedRows = finished.slice(0, LEDGER_SUMMARY_ROW_CAP).map(toRow);
    summary.finishedCount = finished.length;
  }
  return summary;
}

/** Trailing-edge coalesce window for the ledger push. */
export const LEDGER_PUSH_DEBOUNCE_MS = 250;

export interface LedgerPushCoalescer {
  /** Schedule a push for this owner; repeats inside the window collapse. */
  notify: (ownerWorkspaceId: string) => void;
  /** Drop every pending timer (handler teardown). */
  dispose: () => void;
}

/**
 * One push per owner per window instead of one per transition. A fan-out lands
 * a burst of transitions in a few ms and each one made the panel re-read the
 * whole ledger; the trailing edge is what the panel actually needs, because the
 * read it fires is a projection of the FINAL state either way.
 */
export function createLedgerPushCoalescer(
  emit: (ownerWorkspaceId: string) => void,
  delayMs: number = LEDGER_PUSH_DEBOUNCE_MS,
): LedgerPushCoalescer {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    notify: (ownerWorkspaceId: string) => {
      if (!ownerWorkspaceId) return;
      const pending = timers.get(ownerWorkspaceId);
      if (pending) clearTimeout(pending);
      timers.set(
        ownerWorkspaceId,
        setTimeout(() => {
          timers.delete(ownerWorkspaceId);
          emit(ownerWorkspaceId);
        }, delayMs),
      );
    },
    dispose: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
