// Pure settle rules for one workspace. No clock, no I/O: the service feeds
// `now` and the facts, so every rule is unit-testable on its own.

import type { PrStatus } from '../../../shared/types';
import type { WorkspaceSettleReason } from '../../../shared/workspaceSettle';

/** A finished PR settles its workspace only after this long without activity,
 *  so the turn that merged it (and the user reading the result) is not cut off. */
export const PR_SETTLE_QUIET_MS = 15 * 60 * 1000;

/** The persisted per-workspace record. */
export interface WorkspaceSettleRow {
  /** Last agent turn, input or other un-settling event (epoch ms). A workspace
   *  seen for the first time starts its idle clock then. */
  lastActivityAt: number;
  settled?: { at: number; reason: WorkspaceSettleReason };
  snoozedUntil?: number;
  /** Last observed PR as `<number>:<state>`; absent when the branch has none. */
  prKey?: string;
  /** A finished-PR key the user un-settled (or undid). That PR state never
   *  settles the workspace again; a later state or another PR can. */
  prAckKey?: string;
  /** Last observed commits ahead of upstream — an increase is new commits. */
  ahead?: number;
}

/** What main knows about the workspace right now (mirror + HQ store). */
export interface WorkspaceSettleFacts {
  running: boolean;
  awaiting: boolean;
  pinned: boolean;
  hq: boolean;
}

export function prKeyOf(pr: Pick<PrStatus, 'number' | 'state'> | null | undefined): string | undefined {
  return pr ? `${pr.number}:${pr.state}` : undefined;
}

export function isFinishedPrKey(key: string | undefined): boolean {
  return key !== undefined && (key.endsWith(':merged') || key.endsWith(':closed'));
}

function prNumberOf(key: string | undefined): string | undefined {
  return key?.slice(0, key.indexOf(':'));
}

/** Whether rule (b)/(c) forbid settling: a running or waiting-on-you agent, a pin, the HQ. */
export function settleBlocked(facts: WorkspaceSettleFacts): boolean {
  return facts.running || facts.awaiting || facts.pinned || facts.hq;
}

/**
 * Why the workspace should settle on its own now, or null. A snoozed workspace
 * is left alone until the snooze ends.
 */
export function autoSettleReason(
  row: WorkspaceSettleRow,
  facts: WorkspaceSettleFacts,
  now: number,
  idleMs: number,
): Exclude<WorkspaceSettleReason, 'manual'> | null {
  if (row.settled || row.snoozedUntil !== undefined || settleBlocked(facts)) return null;
  const quietFor = now - row.lastActivityAt;
  if (isFinishedPrKey(row.prKey) && row.prKey !== row.prAckKey && quietFor >= PR_SETTLE_QUIET_MS) return 'pr';
  if (quietFor >= idleMs) return 'idle';
  return null;
}

/**
 * Whether a fresh PR / git observation is activity: the PR was reopened, a
 * different PR appeared, or the branch gained commits. Pure — the caller then
 * stores the new key and ahead count on the row.
 */
export function isPrActivity(
  row: Pick<WorkspaceSettleRow, 'prKey' | 'ahead'>,
  nextKey: string | undefined,
  nextAhead: number | undefined,
): boolean {
  if (nextAhead !== undefined && row.ahead !== undefined && nextAhead > row.ahead) return true;
  if (nextKey === undefined || row.prKey === undefined || nextKey === row.prKey) return false;
  if (prNumberOf(nextKey) !== prNumberOf(row.prKey)) return true;
  return isFinishedPrKey(row.prKey) && !isFinishedPrKey(nextKey);
}

/**
 * Bytes that reach a PTY without anyone using it: replies the terminal writes
 * back on its own (device attributes, status and cursor-position reports, mode
 * reports, focus in/out — agents turn focus reporting on, so merely viewing
 * the pane sends one — and OSC / DCS answers), and mouse reports (SGR and X10;
 * scrolling an agent's screen is looking, not using).
 */
const PASSIVE_INPUT =
  /\x1b\[(?:\?[\d;]*(?:c|n|u|\$y)|[>=][\d;]*c|[\d;]*[Rn]|[IO]|<\d+;\d+;\d+[Mm]|M[\s\S]{3})|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/gy;

/** Whether `data` is nothing but passive input — not activity. */
export function isPassiveInput(data: string): boolean {
  if (data.length === 0 || data.charCodeAt(0) !== 0x1b) return false;
  let at = 0;
  while (at < data.length) {
    PASSIVE_INPUT.lastIndex = at;
    if (!PASSIVE_INPUT.exec(data)) return false;
    at = PASSIVE_INPUT.lastIndex;
  }
  return true;
}
