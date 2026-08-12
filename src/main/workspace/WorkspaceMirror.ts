// WorkspaceMirror — a main-process cache of the renderer's workspace tree +
// per-pane agent status, populated by renderer push (IPC.WORKSPACE_MIRROR_PUSH).
//
// WHY: today `workspace.list` is a main→renderer round-trip (workspace.rpc.ts →
// useRpcBridge.ts). Hook signals fire far more often than the workspace tree
// changes, and a large-buffer flush storm can starve that round-trip until the
// bridge's 2s cap trips (see hooks.rpc.ts WORKSPACE_LIST_CACHE_TTL_MS). The
// mirror lets main serve the last renderer-pushed snapshot locally instead —
// no renderer dependency on the hot path.
//
// CONTRACT: routing/snapshot-only. The mirror is NEVER read by the renderer/UI
// and is never authoritative for focus. Full-snapshot replacement (last write
// wins) — the renderer always pushes the complete tree, so there is nothing to
// reconcile. `now` is injectable so the staleness math is unit-testable.

import type {
  WorkspaceListEntry,
  FleetSnapshot,
  WorkspaceMirrorPushPayload,
} from '../../shared/workspaceMirror';

// Re-export the shared shapes so downstream main consumers (hook resolvers,
// routing) can import them straight from the mirror.
export type {
  WorkspaceListEntry,
  FleetSnapshot,
  FleetSnapshotPane,
  WorkspaceMirrorPushPayload,
} from '../../shared/workspaceMirror';

export class WorkspaceMirror {
  private entries: WorkspaceListEntry[] | null = null;
  private fleets = new Map<string, FleetSnapshot>();
  // null ⇒ the last push carried no roleBindings field (old renderer) — callers
  // must treat the bindings as UNKNOWN and round-trip, never as "unbound".
  private roleBindings: Record<string, unknown> | null = null;
  private setAt = 0;
  private populated = false;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Replace the entire mirrored snapshot. Last write wins — a later push with an
   * empty tree legitimately clears the mirror (every workspace was closed).
   */
  setSnapshot(payload: WorkspaceMirrorPushPayload): void {
    this.entries = payload.entries;
    this.fleets = new Map(payload.fleets.map((f) => [f.workspaceId, f]));
    this.roleBindings = payload.roleBindings ?? null;
    // Stamp with our own clock, not the renderer's `payload.ts`: `peek().ageMs`
    // must be measured against the same clock the caller reads `now()` on, so a
    // clock skew between renderer and main can never make a snapshot look
    // negatively aged or arbitrarily stale.
    this.setAt = this.now();
    this.populated = true;
  }

  // Read accessors return a SHALLOW COPY of the stored array so a mutating caller
  // (splice/sort/push) can't corrupt the singleton's list for every other reader.
  // Copying the array level is sufficient: the entry/pane objects themselves are
  // renderer-validated value objects and are treated as read-only downstream — a
  // per-read deep-freeze would tax this hot routing path (a hook fires far more
  // often than the tree changes) for no additional list-corruption protection.

  /** The mirrored workspace entries, or null if nothing has ever been pushed. */
  getEntries(): WorkspaceListEntry[] | null {
    return this.entries === null ? null : [...this.entries];
  }

  /**
   * The entries plus their age in ms (measured against the injected clock),
   * WITHOUT mutating anything. null until the first push — mirrors the hook
   * cache's `peek()` so a routing caller can apply its own staleness bound.
   */
  peek(): { entries: WorkspaceListEntry[]; ageMs: number } | null {
    if (this.entries === null) return null;
    return { entries: [...this.entries], ageMs: this.now() - this.setAt };
  }

  /**
   * ONE pty's mirrored role binding plus the snapshot's age, WITHOUT mutating
   * anything. null when nothing was ever pushed OR the last push predates the
   * roleBindings field (old renderer) — both mean "unknown, round-trip".
   * A non-null result with `binding: undefined` means the map is PRESENT and
   * this pty is authoritatively unbound. Single-key on purpose: the caller
   * (input.send hot path) reads one entry per call, so copying the whole map
   * per lookup would tax exactly the path this mirror exists to speed up.
   * The value is raw (untrusted); callers re-normalize at the read boundary.
   */
  peekRoleBinding(ptyId: string): { binding: unknown; ageMs: number } | null {
    if (this.roleBindings === null) return null;
    return { binding: this.roleBindings[ptyId], ageMs: this.now() - this.setAt };
  }

  /** The per-workspace agent-status snapshot, or null when unknown. */
  getFleetSnapshot(workspaceId: string): FleetSnapshot | null {
    const fleet = this.fleets.get(workspaceId);
    if (!fleet) return null;
    // Copy the object + its panes array so a caller reordering/mutating the list
    // can't corrupt the stored snapshot.
    return { ...fleet, panes: [...fleet.panes] };
  }

  /**
   * Whether the mirror has received at least one push. Distinct from
   * `getEntries() !== null` in intent (a caller asking "is the renderer wired up
   * yet?") — though today they coincide, a future clear-to-null would keep this
   * true so callers can tell "never populated" (cold boot) from "populated then
   * emptied" (all workspaces closed).
   */
  hasEverBeenPopulated(): boolean {
    return this.populated;
  }
}

// Module-level singleton. Main has exactly one renderer/workspace tree, so a
// single shared mirror is the right scope — same pattern as the other
// main-process singletons (EventBus, etc.).
let singleton: WorkspaceMirror | null = null;

export function getWorkspaceMirror(): WorkspaceMirror {
  if (!singleton) singleton = new WorkspaceMirror();
  return singleton;
}

/** Test-only: drop the singleton so a fresh mirror is built on next access. */
export function __resetWorkspaceMirrorForTest(): void {
  singleton = null;
}
