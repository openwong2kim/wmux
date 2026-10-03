// One-line nudge to the pane that started a fan-out, when a worker's turn ends
// and the owner workspace has no brain to hear it (main parks the event in the
// task ledger and sends a pointer here — main/deck/fanoutCallerNotify.ts).
//
// Accelerator only: the park is the record, nothing is acknowledged, and any
// doubt means no write.
//
// Address: the requester's stable {paneId, surfaceId} from the lineage stamp,
// re-resolved against the OWNER workspace's live leaves at receipt and again
// right before each write. A surface id must name that exact terminal surface
// (and sit in that pane when both ids are given); a pane id alone must hold
// exactly one terminal surface. Never the active tab, never another workspace.
// The queue holds those ids, never a PTY id.
//
// When: the pane must pass the A2A turn-end eligibility (detected agent known
// alive, not running / awaiting_input, not held at a usage limit). Idle → a
// short coalescing window, then one flush per pane. Busy → queued until the
// pane's agent ends a turn. Held at a usage limit → retried on every sweep.
// A pane that is not an agent (or is gone) drops its pending pointers.
//
// What: a fixed template and the task ids, zero bytes of worker text. One
// line per pane per flush. Each (pane, taskId, seq) is accepted once per
// renderer session. A failure before the paste is retried; a paste whose
// Enter was withheld is never pasted again.
import { useStore } from '../stores';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import { gatedSubmitToPty } from '../utils/ptyMessageDelivery';
import { eligibility } from './a2aTurnEndReminder';

export const FANOUT_NUDGE_COALESCE_MS = 750;
const MAX_SEND_ATTEMPTS = 3;
const SEEN_CAP = 2000;
const LISTED_IDS = 4;

export interface FanoutCallerPointer {
  ownerWorkspaceId: string;
  taskId: string;
  seq: number;
  origin: { paneId?: string; surfaceId?: string };
}

interface Target {
  ownerWorkspaceId: string;
  paneId?: string;
  surfaceId?: string;
  /** taskIds waiting for a line, in arrival order. */
  pending: Set<string>;
  /** A turn end (or a usage-limit hold) was seen: sweeps may flush. */
  armed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  attempts: number;
}

const targets = new Map<string, Target>();
const seen = new Set<string>();

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : undefined;
}

function parsePointer(raw: unknown): FanoutCallerPointer | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ownerWorkspaceId = str(r.ownerWorkspaceId);
  const taskId = str(r.taskId);
  const seq = r.seq;
  const o = r.origin && typeof r.origin === 'object' ? (r.origin as Record<string, unknown>) : null;
  if (!ownerWorkspaceId || !taskId || typeof seq !== 'number' || !Number.isFinite(seq) || !o) return null;
  const paneId = str(o.paneId);
  const surfaceId = str(o.surfaceId);
  if (!paneId && !surfaceId) return null;
  return { ownerWorkspaceId, taskId, seq, origin: { ...(paneId ? { paneId } : {}), ...(surfaceId ? { surfaceId } : {}) } };
}

function isTerminal(s: { surfaceType?: string; ptyId?: string }): boolean {
  return (s.surfaceType === undefined || s.surfaceType === 'terminal') && typeof s.ptyId === 'string' && s.ptyId.length > 0;
}

/**
 * The PTY the origin names right now inside `ownerWorkspaceId`, or null.
 * Fail-closed: no fallback to an active tab, a sibling surface or another
 * workspace.
 */
export function resolveOriginPty(
  workspaces: ReturnType<typeof useStore.getState>['workspaces'],
  ownerWorkspaceId: string,
  origin: { paneId?: string; surfaceId?: string },
): string | null {
  const ws = workspaces.find((w) => w.id === ownerWorkspaceId);
  if (!ws) return null;
  const leaves = getWorkspaceLeafPanes(ws);
  if (origin.surfaceId) {
    for (const leaf of leaves) {
      const surface = leaf.surfaces.find((s) => s.id === origin.surfaceId);
      if (!surface) continue;
      if (origin.paneId && leaf.id !== origin.paneId) return null;
      return isTerminal(surface) ? (surface.ptyId as string) : null;
    }
    return null;
  }
  const leaf = leaves.find((l) => l.id === origin.paneId);
  if (!leaf) return null;
  const terminals = leaf.surfaces.filter(isTerminal);
  return terminals.length === 1 ? (terminals[0].ptyId as string) : null;
}

export function buildFanoutCallerNudge(taskIds: readonly string[]): string {
  const ids = taskIds.map((id) => id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8)).filter((id) => id.length > 0);
  if (ids.length <= 1) return `[wmux] fan-out task ${ids[0] ?? '?'} updated — channel_mission_list`;
  const listed = ids.slice(0, LISTED_IDS).join(', ');
  const more = ids.length > LISTED_IDS ? ` +${ids.length - LISTED_IDS}` : '';
  return `[wmux] fan-out tasks ${listed}${more} updated — channel_mission_list`;
}

function targetKey(p: FanoutCallerPointer): string {
  return `${p.ownerWorkspaceId}|${p.origin.paneId ?? ''}|${p.origin.surfaceId ?? ''}`;
}

function resolve(t: Target): string | null {
  return resolveOriginPty(useStore.getState().workspaces, t.ownerWorkspaceId, t);
}

function isBusy(ptyId: string): boolean {
  const status = useStore.getState().surfaceAgent[ptyId]?.status;
  return status === 'running' || status === 'awaiting_input';
}

function drop(key: string, t: Target): void {
  if (t.timer) clearTimeout(t.timer);
  targets.delete(key);
}

function rememberSeen(k: string): void {
  seen.add(k);
  while (seen.size > SEEN_CAP) {
    const oldest = seen.values().next().value as string | undefined;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

/** Decide what to do with a target now: drop, schedule, wait or arm. */
function evaluate(key: string, t: Target): void {
  if (t.pending.size === 0) {
    drop(key, t);
    return;
  }
  const ptyId = resolve(t);
  if (!ptyId) {
    drop(key, t);
    return;
  }
  const verdict = eligibility(ptyId);
  if (verdict === 'never') {
    drop(key, t);
    return;
  }
  if (verdict === 'write') {
    if (!t.timer && !t.inFlight) {
      t.timer = setTimeout(() => {
        t.timer = null;
        void flush(key);
      }, FANOUT_NUDGE_COALESCE_MS);
    }
    return;
  }
  // 'wait': busy waits for a turn end; a usage-limit hold is retried by sweeps.
  if (!isBusy(ptyId)) t.armed = true;
}

async function flush(key: string): Promise<void> {
  const t = targets.get(key);
  if (!t || t.inFlight) return;
  if (t.timer) {
    clearTimeout(t.timer);
    t.timer = null;
  }
  const ptyId = resolve(t);
  if (!ptyId || t.pending.size === 0) {
    drop(key, t);
    return;
  }
  const verdict = eligibility(ptyId);
  if (verdict === 'never') {
    drop(key, t);
    return;
  }
  if (verdict === 'wait') {
    // Never disarm: a turn end is often seen while the pane still reads
    // 'running', and the sweep that follows must keep it.
    if (!isBusy(ptyId)) t.armed = true;
    return;
  }
  const ids = [...t.pending];
  t.inFlight = true;
  t.armed = false;
  let result: Awaited<ReturnType<typeof gatedSubmitToPty>>;
  try {
    result = await gatedSubmitToPty(ptyId, buildFanoutCallerNudge(ids), {
      agent: useStore.getState().surfaceAgent[ptyId]?.name ?? null,
    });
  } finally {
    t.inFlight = false;
  }
  if (result.ok || result.pasted) {
    if (!result.ok) {
      console.warn(`[fanout-nudge] line pasted but not submitted (${result.reason}) for ${ids.join(',')}; not pasted again`);
    }
    for (const id of ids) t.pending.delete(id);
    t.attempts = 0;
  } else if (result.reason === 'usage_limited') {
    t.armed = true;
    return;
  } else if (result.reason === 'approval_pending') {
    // Nothing written; wait for the pane's next turn end.
    return;
  } else if (++t.attempts >= MAX_SEND_ATTEMPTS) {
    console.warn(`[fanout-nudge] gave up after ${t.attempts} attempts (${result.reason}) for ${ids.join(',')}`);
    drop(key, t);
    return;
  } else {
    t.armed = true;
    return;
  }
  // Pointers that arrived mid-flight start their own window.
  if (targets.get(key) === t) evaluate(key, t);
}

/** A pointer from main (DECK_FANOUT_CALLER). Malformed input is ignored. */
export function receiveFanoutCallerEvent(raw: unknown): void {
  const p = parsePointer(raw);
  if (!p) return;
  const key = targetKey(p);
  const dedup = `${key}|${p.taskId}|${p.seq}`;
  if (seen.has(dedup)) return;
  rememberSeen(dedup);
  let t = targets.get(key);
  if (!t) {
    t = {
      ownerWorkspaceId: p.ownerWorkspaceId,
      ...(p.origin.paneId ? { paneId: p.origin.paneId } : {}),
      ...(p.origin.surfaceId ? { surfaceId: p.origin.surfaceId } : {}),
      pending: new Set(),
      armed: false,
      timer: null,
      inFlight: false,
      attempts: 0,
    };
    targets.set(key, t);
  }
  t.pending.add(p.taskId);
  if (!t.inFlight) evaluate(key, t);
}

/** An agent turn ended on `ptyId` (hook / detector stop, not osc133). */
export function noteFanoutCallerTurnEnd(ptyId: string): void {
  if (!ptyId) return;
  for (const t of targets.values()) {
    if (t.pending.size > 0 && resolve(t) === ptyId) t.armed = true;
  }
}

/** Flush armed targets whose pane is writable now. Call on every event poll. */
export async function sweepFanoutCallerNudges(): Promise<void> {
  for (const [key, t] of [...targets]) {
    if (!t.armed || t.inFlight) continue;
    // eslint-disable-next-line no-await-in-loop -- one gated write per pane, in order
    await flush(key);
  }
}

/** Test-only. */
export function resetFanoutCallerNudgesForTest(): void {
  for (const t of targets.values()) if (t.timer) clearTimeout(t.timer);
  targets.clear();
  seen.clear();
}
