// Moa (the HQ main bot) — the shapes the renderer reads over the deck bridge.
// Main is the source of truth (src/main/deck/deckHqStore.ts); these mirror it.

import type { MoaAskMode } from './moaAsk';

/** Moa's autonomy level, enforced in main (src/main/deck/moaLevelGate.ts):
 *  0 observe only (every write the brain could make is refused), 1 today's
 *  behaviour (the default: what main already allows, nothing more), 2 adds
 *  the powers of an operator-approved goal contract (shared/moaGoal.ts), 3 is
 *  reserved for merging under a contract and is enforced like 2 for now. */
export type MoaLevel = 0 | 1 | 2 | 3;

export const MOA_LEVELS: readonly MoaLevel[] = [0, 1, 2, 3];

export function isMoaLevel(v: unknown): v is MoaLevel {
  return v === 0 || v === 1 || v === 2 || v === 3;
}

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
  /** Moa reads files (Read, Grep, Glob) in the repos it delegated to without a
   *  permission prompt (moaReadGate.ts). Absent = on. */
  readWithoutAsking?: boolean;
  /** Opt-in: Moa's shadow judge records what it would answer agents' questions
   *  from the policy book, and whether the owner agreed. It answers nothing.
   *  Absent = off. */
  shadowJudge?: boolean;
  /** moa_ask (shared/moaAsk.ts): off, records only, suggests in the panel, or
   *  may answer by itself where a rule is auto-eligible. Absent = 'off'. */
  askMode?: MoaAskMode;
  /** Policy rule ids the owner allowed to settle by themselves (the per-rule
   *  toggle, set only through DECK_MOA_DELEGATE_AUTO_SET). Absent = none. */
  autoRules?: string[];
  /** Most decisions Moa may settle by itself per local day (auto mode).
   *  Absent = MOA_AUTO_DAILY_CAP_DEFAULT. */
  autoDailyCap?: number;
  /** The kill switch: true stops every automatic answer and merge at once,
   *  whatever the mode and the per-rule toggles say. Absent = off. */
  autoPaused?: boolean;
}

/** Auto answers per local day when the owner set no cap. */
export const MOA_AUTO_DAILY_CAP_DEFAULT = 10;
/** Bounds on the auto cap Settings accepts. */
export const MOA_AUTO_DAILY_CAP_RANGE = { min: 0, max: 200 } as const;

/** The shadow judge's readout (Settings › Moa). */
export interface MoaShadowStats {
  decisions: number;
  answered: number;
  escalations: number;
  /** Ended questions where both the judge and the owner named a choice. */
  compared: number;
  agreed: number;
  tokensToday: number;
  callsToday: number;
  /** Decisions this run could not write (memory only). */
  unwritten: number;
  /** The shadow log is full: nothing more is judged. */
  full: boolean;
}

export type MoaConfigPatch = Partial<Pick<MoaConfig, 'onboarded' | 'level' | 'maxTurnsPerHour' | 'bubbles' | 'reduceMotion' | 'approvalPress' | 'memoryProposals' | 'issueProposals' | 'trustedAuthors' | 'issuePollMinutes' | 'ignoredRepos' | 'autoHandoff' | 'readWithoutAsking' | 'shadowJudge' | 'askMode' | 'autoDailyCap' | 'autoPaused'>>;

/** Settings › Moa's view of the goal contract (shared/moaGoal.ts): the open
 *  one, or the last one that ended. */
export interface MoaGoalPanel {
  id: string;
  status: import('./moaGoal').MoaGoalStatus;
  goal: string;
  repoRoot: string | null;
  tasksUsed: number;
  maxTasks: number;
  turnsUsed: number;
  maxTurns: number;
  expiresAt?: number;
  /** Granting powers right now (active, level 2+, budget left). */
  live: boolean;
  /** Why an active contract grants nothing right now. */
  inertReason?: string;
  endNote?: string;
}

export interface MoaState {
  config: MoaConfig;
  goal?: MoaGoalPanel | null;
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
  /** A brain's own card: the operator may close it as not needed. */
  dismissible?: true;
}

/** A permission prompt of an agent Moa delegated work to (Waiting on you).
 *  `what` is agent-authored text (the command or file): render it as text. */
export interface MoaDelegatedApproval {
  id: string;
  ptyId: string;
  workspaceId: string;
  workspaceName?: string;
  agentName: string;
  toolName?: string;
  what?: string;
  createdAt: number;
  /** The plain Yes and No of a dialog the daemon bound to its call (agent
   *  text labels). Present only when it can be answered in place. */
  choices?: Array<{ key: string; label: string; decision: 'approve' | 'deny' }>;
  /** Echoed back with an answer: the daemon refuses it if the dialog changed. */
  promptFingerprint?: string;
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
