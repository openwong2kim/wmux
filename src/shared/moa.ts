// Moa (the HQ main bot) — the shapes the renderer reads over the deck bridge.
// Main is the source of truth (src/main/deck/deckHqStore.ts); these mirror it.

export type MoaLevel = 1 | 2 | 3;

export type MoaHqState = 'unset' | 'ok' | 'hq-missing' | 'hq-unknown' | 'hq-store-corrupt';

export interface MoaConfig {
  enabled: boolean;
  /** The operator has been through the first-run card. */
  onboarded: boolean;
  level: MoaLevel;
  maxTurnsPerHour: number;
  bubbles: boolean;
  reduceMotion: boolean;
  /** How the switch got its first value, when it was decided automatically. */
  defaultReason: 'new-install' | 'existing-brain' | null;
  /** Opt-in: main presses fan-out workers' small permission approvals by rule
   *  (owner in danger, not critical) and tells Moa afterwards. Absent = off. */
  approvalPress?: boolean;
  /** Moa may propose precedents and skills ("Remember this?"); nothing is
   *  saved without the operator's click. Absent = on. */
  proposals?: boolean;
}

export type MoaConfigPatch = Partial<Pick<MoaConfig, 'onboarded' | 'level' | 'maxTurnsPerHour' | 'bubbles' | 'reduceMotion' | 'approvalPress' | 'proposals'>>;

export interface MoaState {
  config: MoaConfig;
  hq: { workspaceId: string | null; state: MoaHqState };
  /** Decisions the HQ migration archived; `unacked` drives the one-time notice. */
  archive: { unacked: number; total: number };
}

/** `deck.moa.setup(workspaceId)`'s answer. On failure, `committed: true` says
 *  main already made that workspace the HQ and only a later step (mode, caps,
 *  settings, switch) failed: calling setup again with the same id is safe and
 *  finishes the rest. */
export interface MoaSetupResult {
  ok: boolean;
  code?: string;
  archived?: number;
  committed?: boolean;
}

export interface MoaArchivedDecision {
  workspaceId: string;
  decision: {
    id: string;
    question: string;
    options: string[];
    context: string;
    status: 'pending' | 'resolved';
    raisedAt: number;
  };
  archivedAt: number;
}

/** The app-owned HQ workspace's name. */
export const MOA_WORKSPACE_NAME = 'Moa';

/** Bounds on the HQ turn cap Settings accepts (mirrors main). */
export const MOA_MAX_TURNS_PER_HOUR_RANGE = { min: 1, max: 120 } as const;

/** The decision-store key Moa's "Remember this?" cards are raised under. Not a
 *  workspace: a card on the HQ's own key would block Moa's wakes. */
export const MOA_MEMORY_DECISION_KEY = '_moa-memory';

/** One thing Moa remembers, as Settings → Moa lists it. */
export interface MoaMemoryItem {
  kind: 'precedent' | 'note' | 'skill';
  /** The slug (file or skill folder name). */
  name: string;
  description: string;
  savedAt: number;
}
