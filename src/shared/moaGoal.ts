// Moa's goal contract: the shared shapes and the code-side hard rules.
//
// The operator approves a GOAL once instead of approving every message Moa
// sends for it. Moa proposes the contract with `moa_propose_goal`; main
// stores it (src/main/deck/moaGoalContract.ts) and raises ONE main-owned card
// in the HQ's decision slot (origin 'moa-goal'). Only the operator's click on
// that card makes it active; no brain can see or resolve the card.
//
// What an ACTIVE contract changes, and only while the HQ's autonomy level is
// 2 or more (moaLevelGate.ts) and the budget lasts:
//   - fan-out from the HQ anchors on the contract's repository instead of the
//     HQ's active pane (fanout.rpc.ts);
//   - the fan-out tasks it creates are the contract's: Moa may answer their
//     questions and send follow-ups without asking (CommanderEventCoalescer);
//   - a hand-off to a workspace the contract names (or to one of its tasks) is
//     delivered without a card (moaHandoff.ts).
//
// What it never changes (code, not prompt): the human-only list below and the
// operator's own entries, push / PR / merge / release, secrets, destructive
// commands, critical approvals, permission gates (`allow` stays the phone's
// alone, src/daemon/index.ts) and any workspace the contract does not name.
//
// THE TEXT SCREEN IS A TRIPWIRE, NOT A SANDBOX. goalHardRuleHit reads what Moa
// is about to send a worker and refuses the obvious "push it" / "here is the
// token" lines. A paraphrase can get past it. What actually stops a push or a
// merge is unchanged: the worker's own permission prompts, which Moa can only
// deny, and task_pr / task_close, which still ask the operator.

import type { MoaLevel } from './moa';

export type MoaGoalStatus = 'pending' | 'active' | 'declined' | 'completed' | 'canceled' | 'expired' | 'exhausted';

export interface MoaGoalBudget {
  /** Fan-out tasks the contract may create, in total. */
  maxTasks: number;
  /** Hours from approval until the contract expires. */
  maxHours: number;
  /** Moa's automatic turns (wakes) while the contract is active. */
  maxTurns: number;
}

export interface MoaGoalContract {
  /** `G-` + 6 hex characters: short enough to read on a card and in a label. */
  id: string;
  hqWorkspaceId: string;
  goal: string;
  /** The vetted repository (realpath of `git rev-parse --show-toplevel`), or
   *  null when the contract names none. */
  repoRoot: string | null;
  /** Existing workspaces the contract covers (hand-offs without a card). */
  workspaceIds: string[];
  /** The level the operator approved: 2 (delegate) or 3 (reserved: merge). */
  level: 2 | 3;
  budget: MoaGoalBudget;
  /** The operator-visible extra human-only entries Moa proposed. The default
   *  list (MOA_GOAL_DEFAULT_HUMAN_ONLY) always applies on top. */
  humanOnly: string[];
  status: MoaGoalStatus;
  /** The card that asks for approval (HQ slot). */
  decisionId?: string;
  createdAt: number;
  approvedAt?: number;
  endedAt?: number;
  /** Why it ended (completed summary, cancel / expiry / budget note). */
  endNote?: string;
  /** Fan-out task workspaces created under the contract. */
  taskWorkspaceIds: string[];
  tasksUsed: number;
  turnsUsed: number;
}

export const MOA_GOAL_LIMITS = {
  GOAL_MAX_CHARS: 400,
  HUMAN_ONLY_MAX: 8,
  HUMAN_ONLY_ITEM_MAX_CHARS: 60,
  WORKSPACES_MAX: 4,
  TASKS: { min: 1, max: 16, default: 4 },
  HOURS: { min: 1, max: 24, default: 4 },
  TURNS: { min: 1, max: 200, default: 40 },
} as const;

/** The card's options. */
export const MOA_GOAL_OPTIONS = {
  approve: 'Approve goal',
  decline: 'Decline',
} as const;

/** Always the operator's, whatever a contract says. Shown on every card. */
export const MOA_GOAL_DEFAULT_HUMAN_ONLY: readonly string[] = [
  'push, pull requests and merges',
  'releases, versions and tags',
  'secrets, tokens and credentials',
  'deleting data or history',
  'critical approvals and permission prompts',
  'work outside this goal\'s repository and workspaces',
];

const GOAL_ID_RE = /^G-[0-9a-f]{6}$/;

export function isMoaGoalId(v: unknown): v is string {
  return typeof v === 'string' && GOAL_ID_RE.test(v);
}

function clampInt(v: unknown, range: { min: number; max: number; default: number }): number | null {
  if (v === undefined || v === null) return range.default;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < range.min || v > range.max) return null;
  return v;
}

/** One line, control characters dropped, whitespace folded. */
export function goalOneLine(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface MoaGoalProposal {
  goal: string;
  repo: string | null;
  workspaceIds: string[];
  level: 2 | 3;
  budget: MoaGoalBudget;
  humanOnly: string[];
}

/** Validate what the brain proposed. Every bound is a refusal, never a silent
 *  cut: the operator approves exactly what the card shows. */
export function parseMoaGoalProposal(params: Record<string, unknown>): MoaGoalProposal | { error: string } {
  const goal = typeof params.goal === 'string' ? goalOneLine(params.goal) : '';
  if (!goal) return { error: 'goal_empty' };
  if ([...goal].length > MOA_GOAL_LIMITS.GOAL_MAX_CHARS) return { error: 'goal_too_long' };
  let repo: string | null = null;
  if (params.repo !== undefined && params.repo !== null && params.repo !== '') {
    if (typeof params.repo !== 'string') return { error: 'repo_invalid' };
    const r = params.repo.trim();
    // eslint-disable-next-line no-control-regex
    if (!r || r.startsWith('-') || /[\x00-\x1f\x7f]/.test(r)) return { error: 'repo_invalid' };
    repo = r;
  }
  const rawWs = params.workspaceIds ?? [];
  if (!Array.isArray(rawWs) || rawWs.length > MOA_GOAL_LIMITS.WORKSPACES_MAX
    || rawWs.some((w) => typeof w !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(w))) {
    return { error: 'workspaces_invalid' };
  }
  const workspaceIds = [...new Set(rawWs as string[])];
  if (!repo && workspaceIds.length === 0) return { error: 'no_scope' };
  const level = params.level === undefined ? 2 : params.level;
  if (level !== 2 && level !== 3) return { error: 'level_invalid' };
  const b = (params.budget && typeof params.budget === 'object' && !Array.isArray(params.budget))
    ? params.budget as Record<string, unknown> : {};
  const maxTasks = clampInt(b.maxTasks, MOA_GOAL_LIMITS.TASKS);
  const maxHours = clampInt(b.maxHours, MOA_GOAL_LIMITS.HOURS);
  const maxTurns = clampInt(b.maxTurns, MOA_GOAL_LIMITS.TURNS);
  if (maxTasks === null || maxHours === null || maxTurns === null) return { error: 'budget_invalid' };
  const rawHo = params.humanOnly ?? [];
  if (!Array.isArray(rawHo) || rawHo.length > MOA_GOAL_LIMITS.HUMAN_ONLY_MAX) return { error: 'human_only_invalid' };
  const humanOnly: string[] = [];
  for (const h of rawHo) {
    if (typeof h !== 'string') return { error: 'human_only_invalid' };
    const one = goalOneLine(h);
    if (!one) continue;
    if ([...one].length > MOA_GOAL_LIMITS.HUMAN_ONLY_ITEM_MAX_CHARS) return { error: 'human_only_invalid' };
    if (!humanOnly.some((x) => x.toLowerCase() === one.toLowerCase())) humanOnly.push(one);
  }
  return { goal, repo, workspaceIds, level, budget: { maxTasks, maxHours, maxTurns }, humanOnly };
}

/** The approval card's text. Everything the contract grants is on it: a card
 *  whose context had to be cut is refused at proposal time (`card_too_long`). */
export function buildMoaGoalCard(
  c: Pick<MoaGoalContract, 'id' | 'goal' | 'repoRoot' | 'workspaceIds' | 'level' | 'budget' | 'humanOnly'>,
  workspaceName: (id: string) => string | undefined,
): { question: string; options: string[]; context: string } {
  const ws = c.workspaceIds.map((id) => workspaceName(id) ?? id);
  const lines = [
    `Goal: ${c.goal}`,
    `Repository: ${c.repoRoot ?? '(none)'}`,
    ...(ws.length ? [`Workspaces: ${ws.join(', ')}`] : []),
    `Moa may, without asking: fan out up to ${c.budget.maxTasks} task${c.budget.maxTasks === 1 ? '' : 's'} in that repository, answer and instruct those tasks${ws.length ? ', hand work to the workspaces above' : ''}. Level ${c.level}; ends after ${c.budget.maxHours} h or ${c.budget.maxTurns} automatic turns.`,
    `Always yours: ${[...MOA_GOAL_DEFAULT_HUMAN_ONLY, ...c.humanOnly].join('; ')}.`,
  ];
  return {
    question: `Approve Moa's goal ${c.id}? ${c.goal}`.slice(0, 1000),
    options: [MOA_GOAL_OPTIONS.approve, MOA_GOAL_OPTIONS.decline],
    context: lines.join('\n'),
  };
}

// ── hard rules on outbound text ─────────────────────────────────────────────

export type MoaGoalHardRule = 'remote' | 'release' | 'secret' | 'destructive' | 'human-only';

const HARD_RULES: ReadonlyArray<{ rule: MoaGoalHardRule; re: RegExp; literal?: true }> = [
  { rule: 'remote', re: /\bgit\s+push\b/i },
  { rule: 'remote', re: /\bpush\s+(it|this|that|them|the\s+(branch|changes?|commits?))\b/i },
  { rule: 'remote', re: /\bpush\s+(to|into)\s+(origin|remote|upstream|github|main|master)\b/i },
  { rule: 'remote', re: /\bforce[- ]push/i },
  { rule: 'remote', re: /\bgh\s+pr\s+(create|merge|ready)\b/i },
  { rule: 'remote', re: /\b(open|create|raise|merge|submit)\s+(a\s+|the\s+|your\s+)?(pull\s+request|PR)\b/i },
  { rule: 'release', re: /\b(npm|pnpm|yarn|cargo)\s+publish\b/i },
  { rule: 'release', re: /\bgh\s+release\b/i },
  { rule: 'release', re: /\bgit\s+tag\b/i },
  { rule: 'release', re: /\b(cut|publish|ship|tag)\s+(a\s+|the\s+)?release\b/i },
  { rule: 'secret', re: /\b(api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret[_ -]?key|private[_ -]?key|password|passwd|credentials?)\b/i },
  { rule: 'secret', re: /(^|[\s'"`(/])(\.env(\.[\w-]+)?|id_rsa|id_ed25519|\.ssh\/|\.npmrc|\.aws\/credentials)\b/i },
  // A token itself: refused even in a negated sentence.
  { rule: 'secret', re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abp]-[A-Za-z0-9-]{10,})\b/, literal: true },
  { rule: 'destructive', re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i },
  { rule: 'destructive', re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|push\s+--delete)\b/i },
  { rule: 'destructive', re: /\bdrop\s+(table|database|schema)\b/i },
];

/** A negation shortly before the match in the same clause ("do not push it")
 *  is an instruction to stay local, which is what the rules want. */
const NEGATION_RE = /\b(do\s+not|don['’]t|never|must\s+not|mustn['’]t|should\s+not|shouldn['’]t|without|no)\b[^.;:!?\n]*$/i;

function negated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 48), index);
  return NEGATION_RE.test(before);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The first hard rule `text` trips, or null. `humanOnly` is the contract's own
 * list (the operator approved it); each entry matches as a whole phrase,
 * case-insensitively. Negated mentions are allowed through.
 */
export function goalHardRuleHit(
  text: string,
  humanOnly: readonly string[] = [],
): { rule: MoaGoalHardRule; match: string } | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const folded = text.normalize('NFKC');
  for (const { rule, re, literal } of HARD_RULES) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of folded.matchAll(g)) {
      if (!literal && negated(folded, m.index ?? 0)) continue;
      return { rule, match: m[0].trim().slice(0, 60) };
    }
  }
  for (const phrase of humanOnly) {
    const p = goalOneLine(phrase);
    if (p.length < 3) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(p)}($|[^\\p{L}\\p{N}])`, 'giu');
    for (const m of folded.matchAll(re)) {
      if (negated(folded, m.index ?? 0)) continue;
      return { rule: 'human-only', match: p };
    }
  }
  return null;
}

/** Why a contract grants nothing right now, or null when it does. */
export type MoaGoalInertReason = 'none' | 'not-active' | 'level' | 'expired' | 'tasks' | 'turns' | 'hq-moved';

/** The contract's effective level, or why it is inert. Pure: the caller passes
 *  the HQ's id and level and the clock. */
export function moaGoalPowers(
  c: MoaGoalContract | null,
  hq: { workspaceId: string | null; level: MoaLevel },
  now: number,
): { ok: true; level: 2 | 3 } | { ok: false; reason: MoaGoalInertReason } {
  if (!c) return { ok: false, reason: 'none' };
  if (c.status !== 'active' || c.approvedAt === undefined) return { ok: false, reason: 'not-active' };
  if (c.hqWorkspaceId !== hq.workspaceId) return { ok: false, reason: 'hq-moved' };
  if (hq.level < 2) return { ok: false, reason: 'level' };
  if (now >= c.approvedAt + c.budget.maxHours * 3_600_000) return { ok: false, reason: 'expired' };
  if (c.turnsUsed >= c.budget.maxTurns) return { ok: false, reason: 'turns' };
  // tasksUsed may reach maxTasks: the contract still answers its tasks, it
  // only cannot create more (checked where a fan-out reserves).
  if (c.tasksUsed > c.budget.maxTasks) return { ok: false, reason: 'tasks' };
  return { ok: true, level: Math.min(c.level, hq.level) >= 3 ? 3 : 2 };
}

/** What Moa reads about its goal (moa_goal / the [goal] block). */
export interface MoaGoalView {
  id: string;
  status: MoaGoalStatus;
  goal: string;
  repoRoot: string | null;
  workspaceIds: string[];
  level: 2 | 3;
  effective: { ok: true; level: 2 | 3 } | { ok: false; reason: MoaGoalInertReason };
  budget: MoaGoalBudget;
  tasksUsed: number;
  turnsUsed: number;
  expiresAt?: number;
  taskWorkspaceIds: string[];
  humanOnly: string[];
}
