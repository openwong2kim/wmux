// Sibling worktree collision watch — the contract between the renderer (which
// knows the panes and their folders) and main (which runs git).
//
// The renderer sends the folders of its live terminal panes; main groups the
// ones that are separate worktrees of one repository, dry-runs a merge of each
// pair (`git merge-tree`, read-only) and answers with the files two siblings
// both touch. The renderer maps folders back to panes for the marker.

/** Default time between checks while two or more siblings are open. */
export const SIBLING_COLLISION_DEFAULT_INTERVAL_MIN = 2;
/** The interval choices Settings offers, in minutes. */
export const SIBLING_COLLISION_INTERVAL_CHOICES_MIN = [1, 2, 5, 10] as const;
/** Main clamps whatever it is sent into this range (ms). */
export const SIBLING_COLLISION_MIN_INTERVAL_MS = 30_000;
export const SIBLING_COLLISION_MAX_INTERVAL_MS = 60 * 60_000;

export interface SiblingCollisionWatchRequest {
  enabled: boolean;
  intervalMs: number;
  /** The working folders of the live local terminal panes (any order, deduped by main). */
  cwds: string[];
}

/** One sibling a worktree collides with. */
export interface SiblingCollisionPeer {
  /** The sibling's worktree toplevel. */
  worktreePath: string;
  /** Files a merge of the two committed heads would leave conflicted (`git merge-tree`). */
  conflicts: string[];
  /**
   * Files both sides changed, where at least one side's change is not
   * committed yet (or every shared file, when git is too old for merge-tree).
   * "Same file changed" — not a known conflict.
   */
  overlaps: string[];
}

export interface SiblingCollisionEntry {
  /** This folder's worktree toplevel. */
  worktreePath: string;
  peers: SiblingCollisionPeer[];
}

export interface SiblingCollisionSnapshot {
  /** Keyed by the cwd the renderer sent; only folders that collide appear. */
  byCwd: Record<string, SiblingCollisionEntry>;
  /** Every sent cwd that resolved, by its worktree toplevel (to map a peer back to its panes). */
  cwdsByWorktree: Record<string, string[]>;
}

export const EMPTY_SIBLING_COLLISIONS: SiblingCollisionSnapshot = { byCwd: {}, cwdsByWorktree: {} };

/** Clamp a requested interval (ms) to what main accepts; anything unusable is the default. */
export function clampSiblingCollisionInterval(ms: unknown): number {
  const n = typeof ms === 'number' && Number.isFinite(ms) ? ms : SIBLING_COLLISION_DEFAULT_INTERVAL_MIN * 60_000;
  return Math.min(SIBLING_COLLISION_MAX_INTERVAL_MS, Math.max(SIBLING_COLLISION_MIN_INTERVAL_MS, Math.round(n)));
}
