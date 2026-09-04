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
// `lastLine` is the summary text the ACTOR wrote (a worker, usually). It is
// UNTRUSTED: sanitized (control chars out, whitespace collapsed) and truncated
// here, and rendered as text by the panel, never as markup or instructions.

import type { LedgerEntry, LedgerStatus } from '../../shared/ledger';
import type { AgentStatus } from '../../shared/types';

/** Hard cap on the rendered `lastLine`. The panel gives it one row. */
export const LEDGER_ROW_LINE_MAX = 160;

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
  /** Main's clock when the summary was built. */
  ts: number;
}

export const EMPTY_LEDGER_SUMMARY: DeckLedgerSummary = { openCount: 0, rows: [], ts: 0 };

/** Collapse whitespace, drop control characters, truncate. */
export function sanitizeLedgerLine(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > LEDGER_ROW_LINE_MAX ? `${flat.slice(0, LEDGER_ROW_LINE_MAX - 1)}\u2026` : flat;
}

/**
 * The one status a row shows for its worker. A pane waiting on a human beats a
 * running one: the panel exists to surface the task that needs somebody, and a
 * fan-out workspace routinely holds several panes.
 */
const WORKER_STATUS_PRIORITY: readonly AgentStatus[] = [
  'awaiting_input',
  'error',
  'waiting',
  'running',
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
  const rows: DeckLedgerRow[] = sorted.slice(0, LEDGER_SUMMARY_ROW_CAP).map((e) => ({
    id: e.id,
    title: e.title,
    status: e.status,
    taskWorkspaceId: e.taskWorkspaceId,
    workerStatus: pickWorkerStatus(input.panesFor(e.taskWorkspaceId) ?? []),
    lastLine: sanitizeLedgerLine(e.summary),
    updatedAt: e.updatedAt,
    ageMs: Math.max(0, now - e.updatedAt),
  }));
  return { openCount: sorted.length, rows, ts: now };
}
