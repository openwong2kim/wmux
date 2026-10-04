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
  memoryProposals?: boolean;
  /** Opt-in: propose new issues and outside PRs of open repos as decision
   *  cards (moaIssueProposals.ts). Absent = off. */
  issueProposals?: boolean;
  /** GitHub logins (lowercase) whose `wmux:auto` items may be handed off
   *  without a card. Absent = none. */
  trustedAuthors?: string[];
  /** Minutes between proposal scans. Absent = the default. */
  issuePollMinutes?: number;
  /** Repos (host/owner/repo, lowercase) Moa no longer proposes from. */
  ignoredRepos?: string[];
  /** Moa may hand off to a workspace in danger mode without a card, while the
   *  HQ is in danger mode too. Never applies to any other target. Absent = on. */
  autoHandoff?: boolean;
}

export type MoaConfigPatch = Partial<Pick<MoaConfig, 'onboarded' | 'level' | 'maxTurnsPerHour' | 'bubbles' | 'reduceMotion' | 'approvalPress' | 'memoryProposals' | 'issueProposals' | 'trustedAuthors' | 'issuePollMinutes' | 'ignoredRepos' | 'autoHandoff'>>;

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

/** The pending "Remember this?" card, with everything Save would write. */
export interface MoaMemoryCard {
  id: string;
  kind: 'precedent' | 'note' | 'skill';
  name: string;
  question: string;
  description: string;
  /** Exactly the text Save writes. */
  fullText: string;
  /** Save replaces an item already kept under this name. */
  replaces: boolean;
}

/** Bounds and default of the proposal scan interval, in minutes. */
export const MOA_ISSUE_POLL_MINUTES_RANGE = { min: 5, max: 120 } as const;
export const MOA_ISSUE_POLL_MINUTES_DEFAULT = 10;
/** At most this many trusted authors and ignored repos are kept. */
export const MOA_ISSUE_LIST_MAX = 50;

const GITHUB_LOGIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const REPO_KEY_RE = /^[a-z0-9.-]+\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

/** GitHub logins from free text (comma, space or newline separated, an
 *  optional leading @), lowercased, deduplicated, invalid ones dropped. */
export function parseTrustedAuthors(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p !== 'string') continue;
    const login = p.trim().replace(/^@/, '').toLowerCase();
    if (GITHUB_LOGIN_RE.test(login) && !out.includes(login)) out.push(login);
    if (out.length >= MOA_ISSUE_LIST_MAX) break;
  }
  return out;
}

/** Repo keys (host/owner/repo) from free text, lowercased, deduplicated,
 *  invalid ones dropped. */
export function parseIgnoredRepos(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p !== 'string') continue;
    const key = p.trim().toLowerCase();
    if (REPO_KEY_RE.test(key) && !out.includes(key)) out.push(key);
    if (out.length >= MOA_ISSUE_LIST_MAX) break;
  }
  return out;
}
/** A pending decision in any workspace, for the panel's "Waiting on you". */
export interface MoaPendingDecision {
  workspaceId: string;
  /** The workspace's display name when the desktop knows it. */
  workspaceName?: string;
  decision: {
    id: string;
    question: string;
    options: string[];
    context: string;
    raisedAt: number;
  };
  /** Present on a hand-off Moa proposed (origin 'moa-handoff'). */
  handoff?: import('./moaHandoff').MoaHandoffCardInfo;
}

/** Moa's mascot states (the panel header, the titlebar icon). */
export type MoaMascotState = 'idle' | 'working' | 'needs-you' | 'done';

/**
 * Moa's own permission prompt (#1772), as the daemon's `terminal_prompt`
 * record for the HQ brain pane (DECK_MOA_APPROVAL). Agent-authored text:
 * render it as text, never as markup.
 */
export interface MoaApproval {
  id: string;
  toolName?: string;
  summary?: string;
  question?: string;
  reason?: string;
  choices?: Array<{ key: string; label: string }>;
  /** Echoed back with an answer. */
  promptFingerprint?: string;
  /** The choices may be pressed from here. */
  answerable: boolean;
  /** The one remote answer was typed; the card settles when the dialog closes. */
  answered: boolean;
  createdAt: number;
}

/**
 * DECK_MOA_APPROVAL_ANSWER's answer. `not_pending`: answered or gone
 * elsewhere (quiet); `answer_too_soon`: the card just appeared, try again.
 */
export type MoaApprovalAnswerResult =
  | { ok: true }
  | { ok: false; code: 'not_pending' | 'answer_too_soon' | 'invalid' | 'error'; reason?: string };
