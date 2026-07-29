// ─── PrincipalService ─────────────────────────────────────────────────
// The sole writer of the principal registry (R2). Same shape as
// ChannelService: injected writer + constructor hydration + save on state
// change.
//
// The write path is renderer-only — the renderer's agent detection
// (surfaceAgent) is the source of upserts, and the renderer calls
// remove/markStale when cleaning up panes/workspaces. Mutating methods are
// not exposed to external MCP callers over the pipe (the renderer-only
// boundary in channelLocal.handler — same convention as kick).
//
// liveness rules (structurally block the stale→live mis-sync bug direction):
//   - Daemon restart: backfill every pane-agent to stale (pane liveness
//     cannot be proven).
//   - Only a renderer upsert brings it back to live.
//   - Session death (session:died): mark that ptyId's pane-agent stale.

import {
  HUMAN_SELF_PRINCIPAL_ID,
  type PrincipalRecord,
  type PrincipalState,
} from '../../shared/principals';

/** Writer contract narrowed to a structural type so tests can inject an in-memory fake. */
export interface PrincipalWriterLike {
  saveImmediate(state: PrincipalState): boolean;
  saveDebounced(state: PrincipalState): void;
  load(): PrincipalState;
}

export interface PrincipalServiceDeps {
  writer: PrincipalWriterLike;
  now?: () => number;
}

/** upsert input — createdAt/lastSeenAt/liveness are service-managed. */
export type PrincipalUpsertInput = Omit<
  PrincipalRecord,
  'createdAt' | 'lastSeenAt' | 'liveness'
>;

export class PrincipalService {
  private readonly writer: PrincipalWriterLike;
  private state: PrincipalState;
  private readonly now: () => number;

  constructor(deps: PrincipalServiceDeps) {
    this.writer = deps.writer;
    this.now = deps.now ?? (() => Date.now());
    this.state = this.writer.load();

    // Restart backfill: every pane-agent goes stale — only a renderer re-registration brings it back to live.
    let backfilled = false;
    for (const p of this.state.principals) {
      if (p.kind === 'pane-agent' && p.liveness === 'live') {
        p.liveness = 'stale';
        backfilled = true;
      }
    }

    // human:me seed — this GUI's human always exists and is always live.
    const human = this.state.principals.find(
      (p) => p.id === HUMAN_SELF_PRINCIPAL_ID,
    );
    const ts = this.now();
    if (!human) {
      this.state.principals.push({
        id: HUMAN_SELF_PRINCIPAL_ID,
        kind: 'human',
        display: 'Me',
        reachability: 'gui',
        liveness: 'live',
        reportsTo: null,
        createdAt: ts,
        lastSeenAt: ts,
      });
      backfilled = true;
    } else if (human.liveness !== 'live') {
      human.liveness = 'live';
      backfilled = true;
    }

    if (backfilled) {
      this.saveNow();
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────

  list(): PrincipalRecord[] {
    return this.state.principals.map((p) => ({ ...p }));
  }

  find(id: string): PrincipalRecord | undefined {
    const p = this.state.principals.find((r) => r.id === id);
    return p ? { ...p } : undefined;
  }

  /**
   * Return a pane principal's last registered PTY coordinate.
   *
   * This deliberately does NOT interpret registry `liveness`: the daemon
   * backfills every pane-agent to stale on restart, including idle panes whose
   * persisted sessions were successfully rebuilt as detached. Callers must
   * prove that the returned id is present in the daemon's live-session table
   * before acting on it.
   */
  ptyIdOf(id: string): string | undefined {
    const p = this.state.principals.find((r) => r.id === id);
    if (!p || p.kind !== 'pane-agent') return undefined;
    return p.ptyId;
  }

  // ── Mutations ─────────────────────────────────────────────────────

  /**
   * Upsert keyed by id. New records and structural changes (liveness
   * transition, ptyId swap) save immediately; display/timestamp-only updates
   * save debounced.
   *
   * Hardening (review I6): human:me may not have its kind changed via upsert
   * (the seed is the sole owner — blocks the path of reshaping the human
   * record into a pane-agent via kind spoofing). The record explicitly picks
   * only allowed keys — this prevents unknown extension keys that slipped past
   * the validation guard from being persisted into principals.json via a
   * {...input} spread.
   */
  upsert(input: PrincipalUpsertInput): PrincipalRecord {
    const ts = this.now();
    if (input.id === HUMAN_SELF_PRINCIPAL_ID && input.kind !== 'human') {
      const human = this.state.principals.find((p) => p.id === HUMAN_SELF_PRINCIPAL_ID);
      if (human) return { ...human };
      // No calls happen before the seed, but defensively ignore rather than coerce the input to human.
      throw new Error('human:me may not be reshaped via upsert');
    }
    const existing = this.state.principals.find((p) => p.id === input.id);
    if (!existing) {
      const record: PrincipalRecord = {
        id: input.id,
        kind: input.kind,
        display: input.display,
        reachability: input.reachability,
        liveness: 'live',
        ...(input.reportsTo !== undefined ? { reportsTo: input.reportsTo } : {}),
        ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
        ...(input.paneId !== undefined ? { paneId: input.paneId } : {}),
        ...(input.ptyId !== undefined ? { ptyId: input.ptyId } : {}),
        ...(input.memberId !== undefined ? { memberId: input.memberId } : {}),
        ...(input.agentSlug !== undefined ? { agentSlug: input.agentSlug } : {}),
        createdAt: ts,
        lastSeenAt: ts,
      };
      this.state.principals.push(record);
      this.saveNow();
      return { ...record };
    }

    const structural =
      existing.liveness !== 'live' || existing.ptyId !== input.ptyId;
    existing.kind = input.kind;
    existing.display = input.display;
    existing.reachability = input.reachability;
    if (input.reportsTo !== undefined) existing.reportsTo = input.reportsTo;
    if (input.workspaceId !== undefined) existing.workspaceId = input.workspaceId;
    if (input.paneId !== undefined) existing.paneId = input.paneId;
    if (input.ptyId !== undefined) existing.ptyId = input.ptyId;
    if (input.memberId !== undefined) existing.memberId = input.memberId;
    if (input.agentSlug !== undefined) existing.agentSlug = input.agentSlug;
    existing.liveness = 'live';
    existing.lastSeenAt = ts;

    if (structural) {
      this.saveNow();
    } else {
      this.writer.saveDebounced(this.state);
    }
    return { ...existing };
  }

  /** Immediate save + failure log (review I8) — the registry is derivable
   *  info, so instead of rolling back we only log: even if in-memory runs
   *  ahead, a renderer re-registration / TTL reaper converges it. */
  private saveNow(): void {
    if (!this.writer.saveImmediate(this.state)) {
      console.error('[PrincipalService] persist failed — in-memory registry is ahead of disk');
    }
  }

  /** On session death, mark that ptyId's pane-agent stale. Returns whether anything changed. */
  markStaleByPtyId(ptyId: string): boolean {
    if (!ptyId) return false;
    let changed = false;
    for (const p of this.state.principals) {
      if (p.kind === 'pane-agent' && p.ptyId === ptyId && p.liveness === 'live') {
        p.liveness = 'stale';
        p.lastSeenAt = this.now();
        changed = true;
      }
    }
    if (changed) this.saveNow();
    return changed;
  }

  /** On workspace deletion, mark every pane-agent in it stale. Returns whether anything changed. */
  markStaleByWorkspace(workspaceId: string): boolean {
    if (!workspaceId) return false;
    let changed = false;
    for (const p of this.state.principals) {
      if (
        p.kind === 'pane-agent' &&
        p.workspaceId === workspaceId &&
        p.liveness === 'live'
      ) {
        p.liveness = 'stale';
        p.lastSeenAt = this.now();
        changed = true;
      }
    }
    if (changed) this.saveNow();
    return changed;
  }

  /** On pane close, remove a principal whose coordinate no longer exists. Returns whether it was removed. */
  remove(id: string): boolean {
    // human:me cannot be removed — the human always exists as long as the GUI is alive.
    if (id === HUMAN_SELF_PRINCIPAL_ID) return false;
    const idx = this.state.principals.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    this.state.principals.splice(idx, 1);
    this.saveNow();
    return true;
  }
}
