// WorkspaceSettleService — main owns whether a workspace is settled (its work
// is finished) or snoozed, so the state keeps moving while the window is
// closed. Inputs: the renderer's workspace mirror (agent status, pins), agent
// lifecycle events, PTY input, PR / git observations and its own clock tick.
// Output: one snapshot plus the changes behind it, pushed to the renderer and
// read by the phone workspace list. Visibility only — nothing here closes,
// archives or kills anything.
//
// Rules live in workspaceSettleRules.ts; this class holds the rows, applies
// the user's verbs, keeps the undo records and persists through `save`.

import {
  clampIdleDays,
  DEFAULT_WORKSPACE_IDLE_DAYS,
  WORKSPACE_SETTLE_UNDO_MS,
  type WorkspaceSettleCause,
  type WorkspaceSettleChange,
  type WorkspaceSettleChangedPayload,
  type WorkspaceSettleChangeKind,
  type WorkspaceSettleCommand,
  type WorkspaceSettleCommandResult,
  type WorkspaceSettleSnapshot,
  type WorkspaceSettleState,
} from '../../../shared/workspaceSettle';
import type { WorkspaceMirrorPushPayload } from '../../../shared/workspaceMirror';
import type { PrStatus } from '../../../shared/types';
import {
  autoSettleReason,
  isFinishedPrKey,
  isPrActivity,
  isPassiveInput,
  prKeyOf,
  settleBlocked,
  type WorkspaceSettleFacts,
  type WorkspaceSettleRow,
} from './workspaceSettleRules';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Keystrokes are the hot path: one activity note per workspace per window. */
export const INPUT_ACTIVITY_THROTTLE_MS = 30_000;
/** An undo click can land a little after the toast's 5 s: the record outlives it. */
const UNDO_GRACE_MS = 3_000;
/** Undoing an automatic unsnooze re-snoozes for at least this long. */
const RESNOOZE_MS = 60 * 60 * 1000;
const MAX_SNOOZE_MS = 366 * DAY_MS;
/** A running agent keeps touching its workspace on every status push; the
 *  idle clock only needs to move in steps this size, so the file is not
 *  rewritten for each one. */
const ACTIVITY_STEP_MS = 30_000;
/** No automatic settle this soon after the first mirror push: agents are
 *  still being detected, and a workspace must not flicker into a group. */
export const BOOT_SETTLE_GRACE_MS = 2 * 60 * 1000;
/** A mirror push can trail an awaiting_input lifecycle signal; inside this
 *  window its "not awaiting" is taken as stale, not as the prompt closing. */
const AWAITING_MIRROR_LAG_MS = 5_000;

export interface PersistedWorkspaceSettle {
  version: 1;
  idleDays: number;
  rows: Record<string, WorkspaceSettleRow>;
}

export interface WorkspaceSettleServicePorts {
  now?: () => number;
  /** The persisted file's raw content, or null when there is none. */
  load?: () => unknown;
  save?: (data: PersistedWorkspaceSettle) => void;
  /** The HQ workspace id (exempt from settle and snooze), or null. */
  hqId?: () => string | null;
}

interface UndoRecord {
  workspaceId: string;
  kind: WorkspaceSettleChangeKind;
  cause: WorkspaceSettleCause;
  prev: WorkspaceSettleState;
  at: number;
}

type Listener = (payload: WorkspaceSettleChangedPayload) => void;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read the persisted file defensively: it is hand-editable, a bad row is dropped. */
export function parsePersistedWorkspaceSettle(raw: unknown): { idleDays: number; rows: Map<string, WorkspaceSettleRow> } {
  const rows = new Map<string, WorkspaceSettleRow>();
  if (!isRecord(raw)) return { idleDays: DEFAULT_WORKSPACE_IDLE_DAYS, rows };
  if (isRecord(raw.rows)) {
    for (const [id, r] of Object.entries(raw.rows)) {
      if (!isRecord(r) || typeof r.lastActivityAt !== 'number' || !Number.isFinite(r.lastActivityAt)) continue;
      const row: WorkspaceSettleRow = { lastActivityAt: r.lastActivityAt };
      const s = r.settled;
      if (isRecord(s) && typeof s.at === 'number' && (s.reason === 'idle' || s.reason === 'pr' || s.reason === 'manual')) {
        row.settled = { at: s.at, reason: s.reason };
      }
      if (!row.settled && typeof r.snoozedUntil === 'number' && Number.isFinite(r.snoozedUntil)) row.snoozedUntil = r.snoozedUntil;
      if (typeof r.prKey === 'string') row.prKey = r.prKey;
      if (typeof r.prAckKey === 'string') row.prAckKey = r.prAckKey;
      if (typeof r.ahead === 'number') row.ahead = r.ahead;
      rows.set(id, row);
    }
  }
  return { idleDays: clampIdleDays(raw.idleDays), rows };
}

export class WorkspaceSettleService {
  private readonly now: () => number;
  private readonly save: (data: PersistedWorkspaceSettle) => void;
  /** The HQ workspace is exempt from settling and snoozing. */
  private readonly hqId: () => string | null;
  private idleDays: number;
  private readonly rows: Map<string, WorkspaceSettleRow>;
  private mirror: WorkspaceMirrorPushPayload | null = null;
  /** One edge memory for the awaiting state, shared by the lifecycle and the
   *  mirror paths, so a repeated signal for the same prompt never wakes twice. */
  private readonly awaiting = new Map<string, { on: boolean; at: number }>();
  /** First mirror push: seeds `awaiting` without firing, starts the boot grace. */
  private firstMirrorAt: number | null = null;
  /** A new idle-days value, applied by the next tick (typing passes through
   *  intermediate values). */
  private pendingIdleDays: number | null = null;
  private readonly inputNotedAt = new Map<string, number>();
  private readonly undo = new Map<string, UndoRecord>();
  private readonly listeners = new Set<Listener>();
  private changeSeq = 0;
  /** A row changed in a way the snapshot does not show (activity time, PR key). */
  private dirty = false;

  constructor(ports: WorkspaceSettleServicePorts = {}) {
    this.now = ports.now ?? Date.now;
    this.save = ports.save ?? (() => undefined);
    this.hqId = ports.hqId ?? (() => null);
    const parsed = parsePersistedWorkspaceSettle(ports.load?.() ?? null);
    this.idleDays = parsed.idleDays;
    this.rows = parsed.rows;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): WorkspaceSettleSnapshot {
    const states: WorkspaceSettleSnapshot['states'] = {};
    for (const [id, row] of this.rows) {
      if (row.settled) states[id] = { settled: { ...row.settled } };
      else if (row.snoozedUntil !== undefined) states[id] = { snoozedUntil: row.snoozedUntil };
    }
    return { states, idleDays: this.pendingIdleDays ?? this.idleDays, hqWorkspaceId: this.hqId() };
  }

  /** Workspaces main knows to exist right now (the last mirror push). */
  presentIds(): string[] {
    return this.mirror ? this.mirror.entries.map((e) => e.id) : [];
  }

  /** A full mirror push: new facts, awaiting edges, row cleanup, re-evaluation. */
  noteMirror(payload: WorkspaceMirrorPushPayload): void {
    this.mirror = payload;
    const now = this.now();
    const changes: WorkspaceSettleChange[] = [];
    const present = new Set(payload.entries.map((e) => e.id));
    // The first push after boot only learns who is already waiting: a prompt
    // that was open before the restart is not a new reason to wake anything.
    const seeding = this.firstMirrorAt === null;
    if (seeding) this.firstMirrorAt = now;
    for (const id of present) this.noteAwaiting(id, this.facts(id).awaiting, 'mirror', now, changes, seeding);
    // Forget closed workspaces only when the tree came from the saved session;
    // a failed session load must not wipe the persisted state.
    if (payload.sessionRestored === true) {
      for (const id of [...this.rows.keys()]) {
        if (!present.has(id)) {
          this.rows.delete(id);
          this.dirty = true;
        }
      }
      for (const id of [...this.awaiting.keys()]) if (!present.has(id)) this.awaiting.delete(id);
    }
    this.evaluateAll(now, changes, false);
    this.commit(changes, false);
  }

  /** An agent turn ran (any lifecycle signal), or it is waiting on the user. */
  noteLifecycle(workspaceId: string, kind: string): void {
    if (!this.isPresent(workspaceId)) return;
    const now = this.now();
    const changes: WorkspaceSettleChange[] = [];
    this.touch(workspaceId, now, changes);
    if (kind === 'agent.awaiting_input') this.noteAwaiting(workspaceId, true, 'lifecycle', now, changes, false);
    // A turn boundary closes whatever prompt was open.
    else if (kind !== 'agent.subagent_stop') this.awaiting.set(workspaceId, { on: false, at: now });
    this.commit(changes, false);
  }

  /**
   * Input reached a PTY. Throttled per PTY before any lookup: this is the
   * keystroke path. `data` is filtered here (terminal replies and mouse
   * reports are not use); the daemon's typed-input signal comes pre-filtered
   * and passes none.
   */
  noteInput(ptyId: string, data?: string): void {
    if (data !== undefined && isPassiveInput(data)) return;
    const now = this.now();
    if (now - (this.inputNotedAt.get(ptyId) ?? -Infinity) < INPUT_ACTIVITY_THROTTLE_MS) return;
    const entry = this.mirror?.entries.find((e) => e.activePtyId === ptyId || e.ptyIds?.includes(ptyId));
    if (!entry) return;
    this.inputNotedAt.set(ptyId, now);
    const changes: WorkspaceSettleChange[] = [];
    this.touch(entry.id, now, changes);
    this.commit(changes, false);
  }

  /** The workspace needs the user (CI failure, approval). */
  noteAttention(workspaceId: string): void {
    if (!this.isPresent(workspaceId)) return;
    const changes: WorkspaceSettleChange[] = [];
    this.attention(workspaceId, this.now(), changes);
    this.commit(changes, changes.length > 0);
  }

  /**
   * A fresh PR / git observation for the workspace's branch. `pr` undefined
   * means the lookup failed (network, auth, gh missing): the last valid PR
   * observation stands, or a merged PR reopened behind a failed lookup would
   * be missed. null means the branch has no PR.
   */
  notePr(workspaceId: string, pr: PrStatus | null | undefined, ahead: number | undefined): void {
    if (!this.isPresent(workspaceId)) return;
    const now = this.now();
    const row = this.row(workspaceId, now);
    const nextKey = pr === undefined ? row.prKey : prKeyOf(pr);
    const changes: WorkspaceSettleChange[] = [];
    if (isPrActivity(row, nextKey, ahead)) this.touch(workspaceId, now, changes);
    const dirty = row.prKey !== nextKey || (ahead !== undefined && row.ahead !== ahead);
    row.prKey = nextKey;
    if (ahead !== undefined) row.ahead = ahead;
    this.commit(changes, dirty);
  }

  /** Whether a PR observation can change anything for this workspace: it can
   *  settle, or it is snoozed (a CI failure wakes it). */
  wantsPrObservation(workspaceId: string): boolean {
    const row = this.rows.get(workspaceId);
    return row?.snoozedUntil !== undefined || !settleBlocked(this.facts(workspaceId));
  }

  /** Clock tick: snooze expiry and the automatic settle rules. */
  tick(): void {
    const changes: WorkspaceSettleChange[] = [];
    if (this.pendingIdleDays !== null) {
      this.idleDays = this.pendingIdleDays;
      this.pendingIdleDays = null;
    }
    this.evaluateAll(this.now(), changes, true);
    this.commit(changes, changes.length > 0);
  }

  command(cmd: WorkspaceSettleCommand): WorkspaceSettleCommandResult {
    const now = this.now();
    const changes: WorkspaceSettleChange[] = [];
    if (cmd.op === 'setIdleDays') {
      if (typeof cmd.days !== 'number' || !Number.isFinite(cmd.days)) return { ok: false, error: 'invalid' };
      // Applied by the next tick, not here: a field typed digit by digit
      // ("14" passes through 1) must not settle everything on the way.
      this.pendingIdleDays = clampIdleDays(cmd.days);
      this.commit(changes, true, true);
      return { ok: true, snapshot: this.snapshot() };
    }
    if (cmd.op === 'undo') {
      const record = this.undo.get(cmd.changeId);
      this.pruneUndo(now);
      if (!record || now - record.at > WORKSPACE_SETTLE_UNDO_MS + UNDO_GRACE_MS || !this.rows.has(record.workspaceId)) {
        return { ok: false, error: 'unknown-change' };
      }
      this.undo.delete(cmd.changeId);
      this.applyUndo(record, now, changes);
      this.commit(changes, true);
      return { ok: true, snapshot: this.snapshot() };
    }
    if (typeof cmd.workspaceId !== 'string' || !this.isPresent(cmd.workspaceId)) return { ok: false, error: 'invalid' };
    const id = cmd.workspaceId;
    const row = this.row(id, now);
    const facts = this.facts(id);
    const prev = this.stateOf(row);
    switch (cmd.op) {
      case 'settle':
        if (facts.hq) return { ok: false, error: 'hq' };
        if (settleBlocked(facts)) return { ok: false, error: 'refused' };
        if (!row.settled) {
          delete row.snoozedUntil;
          row.settled = { at: now, reason: 'manual' };
          changes.push(this.change(id, 'settled', 'manual', prev, now));
        }
        break;
      case 'unsettle':
        if (row.settled) this.unsettle(id, row, 'manual', now, changes);
        break;
      case 'snooze':
        if (typeof cmd.until !== 'number' || !(cmd.until > now) || cmd.until - now > MAX_SNOOZE_MS) return { ok: false, error: 'invalid' };
        if (facts.hq) return { ok: false, error: 'hq' };
        if (facts.pinned) return { ok: false, error: 'refused' };
        delete row.settled;
        row.snoozedUntil = cmd.until;
        changes.push(this.change(id, 'snoozed', 'manual', prev, now));
        break;
      case 'unsnooze':
        if (row.snoozedUntil !== undefined) {
          delete row.snoozedUntil;
          this.restartClock(row, now);
          changes.push(this.change(id, 'unsnoozed', 'manual', prev, now));
        }
        break;
      default:
        return { ok: false, error: 'invalid' };
    }
    this.commit(changes, changes.length > 0);
    return { ok: true, snapshot: this.snapshot() };
  }

  persisted(): PersistedWorkspaceSettle {
    const rows: Record<string, WorkspaceSettleRow> = {};
    for (const [id, row] of this.rows) rows[id] = { ...row };
    return { version: 1, idleDays: this.pendingIdleDays ?? this.idleDays, rows };
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private isPresent(id: string): boolean {
    return this.mirror?.entries.some((e) => e.id === id) ?? false;
  }

  private row(id: string, now: number): WorkspaceSettleRow {
    let row = this.rows.get(id);
    if (!row) {
      row = { lastActivityAt: now };
      this.rows.set(id, row);
      this.dirty = true;
    }
    return row;
  }

  private facts(id: string): WorkspaceSettleFacts {
    const panes = this.mirror?.fleets.find((f) => f.workspaceId === id)?.panes ?? [];
    return {
      running: panes.some((p) => p.agentStatus === 'running'),
      awaiting: panes.some((p) => p.agentStatus === 'awaiting_input'),
      pinned: this.mirror?.pinnedIds?.includes(id) ?? false,
      hq: id === this.hqId(),
    };
  }

  private stateOf(row: WorkspaceSettleRow): WorkspaceSettleState {
    return {
      ...(row.settled ? { settled: { ...row.settled } } : {}),
      ...(row.snoozedUntil !== undefined ? { snoozedUntil: row.snoozedUntil } : {}),
    };
  }

  /**
   * `autoSettle` false (mirror pushes) runs everything but the automatic
   * settle rules, which only the clock tick applies — a pending idle-days
   * value or a burst of pushes must not settle anything between ticks.
   */
  private evaluateAll(now: number, changes: WorkspaceSettleChange[], autoSettle: boolean): void {
    if (!this.mirror) return;
    const idleMs = this.idleDays * DAY_MS;
    const settling = autoSettle && this.firstMirrorAt !== null && now - this.firstMirrorAt >= BOOT_SETTLE_GRACE_MS;
    for (const { id } of this.mirror.entries) {
      const row = this.row(id, now);
      const facts = this.facts(id);
      if (facts.running) this.touch(id, now, changes);
      if (row.settled && (facts.pinned || facts.hq)) this.unsettle(id, row, 'exempt', now, changes);
      if (row.snoozedUntil !== undefined && row.snoozedUntil <= now) {
        const prev = this.stateOf(row);
        delete row.snoozedUntil;
        // A snooze longer than the idle days must not hand the workspace
        // straight to the idle rule: it comes back for a full period.
        this.restartClock(row, now);
        changes.push(this.change(id, 'unsnoozed', 'expired', prev, now));
      }
      const reason = settling ? autoSettleReason(row, facts, now, idleMs) : null;
      if (reason) {
        const prev = this.stateOf(row);
        row.settled = { at: now, reason };
        changes.push(this.change(id, 'settled', reason, prev, now));
      }
    }
  }

  private touch(id: string, now: number, changes: WorkspaceSettleChange[]): void {
    const row = this.row(id, now);
    if (now - row.lastActivityAt >= ACTIVITY_STEP_MS) {
      row.lastActivityAt = now;
      this.dirty = true;
    }
    if (row.settled) {
      const prev = this.stateOf(row);
      delete row.settled;
      changes.push(this.change(id, 'unsettled', 'activity', prev, now));
    }
  }

  /**
   * The awaiting edge, shared by both paths: it fires attention only on a
   * false→true transition. `seed` records the level without firing.
   */
  private noteAwaiting(
    id: string,
    on: boolean,
    source: 'mirror' | 'lifecycle',
    now: number,
    changes: WorkspaceSettleChange[],
    seed: boolean,
  ): void {
    const before = this.awaiting.get(id);
    if (on) {
      if (!before?.on && !seed) this.attention(id, now, changes);
      if (!before?.on || source === 'lifecycle') this.awaiting.set(id, { on: true, at: now });
      return;
    }
    // A mirror push right after the lifecycle signal may not show it yet.
    if (before?.on && source === 'mirror' && now - before.at < AWAITING_MIRROR_LAG_MS) return;
    this.awaiting.set(id, { on: false, at: now });
  }

  /** Restart the idle clock and stop the current finished PR from settling the
   *  workspace again — the workspace was just handed back to the user. */
  private restartClock(row: WorkspaceSettleRow, now: number): void {
    row.lastActivityAt = Math.max(row.lastActivityAt, now);
    if (isFinishedPrKey(row.prKey)) row.prAckKey = row.prKey;
    this.dirty = true;
  }

  private attention(id: string, now: number, changes: WorkspaceSettleChange[]): void {
    const row = this.row(id, now);
    const prev = this.stateOf(row);
    this.restartClock(row, now);
    if (row.snoozedUntil !== undefined) {
      delete row.snoozedUntil;
      changes.push(this.change(id, 'unsnoozed', 'attention', prev, now));
    }
    if (row.settled) {
      delete row.settled;
      changes.push(this.change(id, 'unsettled', 'attention', prev, now));
    }
  }

  /** Un-settle by the user's hand (or an undo): restart the idle clock and stop
   *  the same finished PR from settling the workspace straight back. */
  private unsettle(id: string, row: WorkspaceSettleRow, cause: WorkspaceSettleCause, now: number, changes: WorkspaceSettleChange[]): void {
    const prev = this.stateOf(row);
    delete row.settled;
    if (cause !== 'exempt') this.restartClock(row, now);
    changes.push(this.change(id, 'unsettled', cause, prev, now));
  }

  private applyUndo(record: UndoRecord, now: number, changes: WorkspaceSettleChange[]): void {
    const id = record.workspaceId;
    const row = this.row(id, now);
    switch (record.kind) {
      case 'settled':
        if (row.settled) this.unsettle(id, row, 'undo', now, changes);
        if (record.prev.snoozedUntil !== undefined && record.prev.snoozedUntil > now) row.snoozedUntil = record.prev.snoozedUntil;
        break;
      case 'snoozed': {
        const prev = this.stateOf(row);
        delete row.snoozedUntil;
        if (record.prev.settled) row.settled = { ...record.prev.settled };
        changes.push(this.change(id, 'unsnoozed', 'undo', prev, now));
        break;
      }
      case 'unsnoozed': {
        const prev = this.stateOf(row);
        const before = record.prev.snoozedUntil;
        delete row.settled;
        // An expired or woken snooze has no future left to restore: hold it an hour.
        row.snoozedUntil = before !== undefined && before > now + 60_000 ? before : now + RESNOOZE_MS;
        changes.push(this.change(id, 'snoozed', 'undo', prev, now));
        break;
      }
      default:
        break;
    }
  }

  private change(
    workspaceId: string,
    kind: WorkspaceSettleChangeKind,
    cause: WorkspaceSettleCause,
    prev: WorkspaceSettleState,
    at: number,
  ): WorkspaceSettleChange {
    // Settle, snooze and unsnooze get an Undo toast; un-settling is the
    // workspace coming back on its own and does not.
    const undoable = cause !== 'undo' && kind !== 'unsettled';
    const id = `wss-${at.toString(36)}-${(++this.changeSeq).toString(36)}`;
    if (undoable) this.undo.set(id, { workspaceId, kind, cause, prev, at });
    return { id, workspaceId, kind, cause, undoable, at };
  }

  private pruneUndo(now: number): void {
    for (const [id, r] of this.undo) if (now - r.at > WORKSPACE_SETTLE_UNDO_MS + UNDO_GRACE_MS) this.undo.delete(id);
  }

  private commit(changes: WorkspaceSettleChange[], dirty: boolean, forceEmit = false): void {
    if (dirty || this.dirty || changes.length > 0) {
      this.dirty = false;
      this.save(this.persisted());
    }
    if (changes.length === 0 && !forceEmit) return;
    this.pruneUndo(this.now());
    const payload: WorkspaceSettleChangedPayload = { snapshot: this.snapshot(), changes };
    for (const l of this.listeners) {
      try { l(payload); } catch (err) { console.error('[workspaceSettle] listener threw:', err); }
    }
  }
}
