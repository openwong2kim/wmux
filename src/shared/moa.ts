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
}

export type MoaConfigPatch = Partial<Pick<MoaConfig, 'onboarded' | 'level' | 'maxTurnsPerHour' | 'bubbles' | 'reduceMotion'>>;

export interface MoaState {
  config: MoaConfig;
  hq: { workspaceId: string | null; state: MoaHqState };
  /** Decisions the HQ migration archived; `unacked` drives the one-time notice. */
  archive: { unacked: number; total: number };
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
