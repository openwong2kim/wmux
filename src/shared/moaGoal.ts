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
//     HQ's active pane, and its workers start with the goal worker profile
//     (fanout.rpc.ts, shared/moaGoalWorker.ts). A fan-out from a turn that
//     another PC's Moa woke is refused;
//   - the fan-out tasks it creates are the contract's: Moa may answer their
//     questions and send follow-ups without asking (CommanderEventCoalescer);
//   - a hand-off to a workspace the contract names (or to one of its tasks) is
//     delivered without a card, but only while the operator's own request is
//     live: a hand-off from a wake (worker output, PR comments, another PC's
//     Moa) still asks with a card, as it does without a goal (moaHandoff.ts).
//
// What it never changes (code, not prompt): the human-only list below and the
// operator's own entries, push / PR / merge / release, secrets, destructive
// commands, critical approvals, permission gates (`allow` stays the phone's
// alone, src/daemon/index.ts) and any workspace the contract does not name.
//
// How those rules are held, outermost first, and what each one really is:
//   - BOUNDARY (outside wmux): the remote's branch protection and required
//     reviews. wmux cannot see or vouch for them.
//   - DENY RULES (cheap first line): a worker a goal fans out runs Claude Code
//     with `--disallowedTools` rules for push, PR, release, tag, publish and
//     recursive-delete commands (shared/moaGoalWorker.ts). They match the
//     command as written, so a wrapper (`sh -c`, a script, an alias the list
//     does not name) slips past; an argv-normalising PreToolUse hook is a
//     listed follow-up.
//   - FRICTION: the goal worker's environment withholds GitHub credentials
//     (placeholder GH_TOKEN, empty GH_CONFIG_DIR, git credential helpers
//     reset, an unusable push URL for `origin`). The launch is typed into a
//     login shell after its rc files, so the operator's own rc can undo it.
//   - TRIPWIRE: goalHardRuleHit reads what Moa is about to send a worker and
//     refuses the plain ways of asking for those things. A paraphrase,
//     a translation or a split message can get past it.
// Workers that cannot carry the deny rules (agy, codex, a role bound to
// another CLI) are not started under a goal at all. task_pr / task_close
// still ask the operator, and permission gates are never answered with
// `allow` by Moa (src/daemon/index.ts).
//
// NOTE: by default fan-out workers run `--permission-mode auto`, which lets a
// worker push and open a PR it was asked for. Nothing here changes that for
// fan-outs outside an active goal (owner decision, 2026-09-24).

import type { MoaLevel } from './moa';
import type { FanoutWorkerPermissionMode } from './workerLaunch';

export type MoaGoalStatus = 'pending' | 'active' | 'declined' | 'completed' | 'canceled' | 'expired' | 'exhausted';

export interface MoaGoalBudget {
  /** Fan-out tasks the contract may create, in total. */
  maxTasks: number;
  /** Hours from approval until the contract expires. */
  maxHours: number;
  /** Moa's automatic turns (wakes) while the contract is active. */
  maxTurns: number;
}

/** What "done" means for a goal, agreed on the approval card: checkable
 *  done criteria, the evidence Moa must show for them, and constraints the
 *  work must respect. Each list may be empty; a record written before these
 *  fields existed reads as all-empty (see goalTermsOf). */
export interface MoaGoalTerms {
  doneCriteria: string[];
  evidence: string[];
  constraints: string[];
}

/** One task gate that proved a completed goal, pinned to the commit it ran on. */
export interface MoaGoalVerificationGate {
  taskId: string;
  workspaceId: string;
  /** The worktree HEAD the gate ran on (unchanged through the run). */
  headSha: string;
  command: string;
  exitCode: number | null;
  at: number;
  /** The gate output the verifier saved, and its sha256. */
  logPath: string;
  logSha256: string;
  /** Failed once, passed on the one retry (moaGoalLearning.ts): a flake. */
  flaky?: true;
}

/** A file named as evidence for a done criterion, hashed when verified. */
export interface MoaGoalVerificationArtifact {
  path: string;
  sha256: string;
  bytes: number;
}

/** One task branch delivered after a verified goal (moaGoalDelivery.ts). */
export interface MoaGoalDeliveryItem {
  taskId: string;
  branch: string;
  /** The verified commit that was pushed. */
  headSha: string;
  /** The PR base branch. */
  base: string;
  pushed: boolean;
  prUrl?: string;
  prNumber?: number;
  /** Set when the merge path is on: the earliest time it may merge (the
   *  operator's objection window). Never set while auto-merge is off. */
  mergeAfter?: number;
  merged?: boolean;
  /** Why this item stopped short (push or PR failed). */
  error?: string;
}

/** What Moa delivered for a completed goal, and how to undo it. */
export interface MoaGoalDelivery {
  at: number;
  items: MoaGoalDeliveryItem[];
  /** Human-readable steps that undo the delivery, recorded at delivery time. */
  revertRecipe: string[];
  /** Set by "Revert this goal". */
  reverted?: { at: number; by: 'operator' | 'moa'; notes: string[] };
}

/** The last time Moa tried to complete and was refused: shown to the
 *  operator as the per-criterion ✗ list. Cleared by a pass. */
export interface MoaGoalLastCheck {
  at: number;
  problems: string[];
}

/** What a goal Moa completed showed (moaGoalVerifier.ts). */
export interface MoaGoalVerification {
  at: number;
  gates: MoaGoalVerificationGate[];
  criteria: { criterion: number; text: string; artifacts: MoaGoalVerificationArtifact[] }[];
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
  /** Done criteria (see MoaGoalTerms). Absent on records written before them. */
  doneCriteria?: string[];
  /** Evidence Moa must produce for the criteria (test runs, logs, screenshots). */
  evidence?: string[];
  /** Constraints the work must respect. */
  constraints?: string[];
  /** Set when Moa completed the goal: the gates and evidence that proved it.
   *  Absent on an operator end and on records from before the gate. */
  verification?: MoaGoalVerification;
  /** What Moa pushed and opened after verification (moaGoalDelivery.ts). */
  delivery?: MoaGoalDelivery;
  /** The last refused completion, for the operator's ✗ list. */
  lastCheck?: MoaGoalLastCheck;
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
  /** The fan-out worker permission mode shown on the card, pinned at
   *  approval: a goal fan-out is refused once Settings says otherwise.
   *  Absent on a record written before the pin existed (refused too). */
  workerPermissionMode?: FanoutWorkerPermissionMode;
}

export const MOA_GOAL_LIMITS = {
  GOAL_MAX_CHARS: 400,
  HUMAN_ONLY_MAX: 8,
  HUMAN_ONLY_ITEM_MAX_CHARS: 60,
  WORKSPACES_MAX: 4,
  TERMS_MAX: 8,
  TERMS_ITEM_MAX_CHARS: 200,
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
  // Delivery (moaGoalDelivery.ts): after the evidence gate passes, Moa pushes
  // the goal's task branches and opens their PRs itself. Merging stays here
  // until auto-merge is turned on (MOA_GOAL_AUTO_MERGE), and never-force.
  'merges',
  'force-push',
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

/** The terms of a contract, empty lists for a record that predates them. */
export function goalTermsOf(c: Partial<Pick<MoaGoalContract, 'doneCriteria' | 'evidence' | 'constraints'>>): MoaGoalTerms {
  return {
    doneCriteria: Array.isArray(c.doneCriteria) ? [...c.doneCriteria] : [],
    evidence: Array.isArray(c.evidence) ? [...c.evidence] : [],
    constraints: Array.isArray(c.constraints) ? [...c.constraints] : [],
  };
}

/** One list of terms: strings only, one line each, ≤TERMS_ITEM_MAX_CHARS,
 *  ≤TERMS_MAX items, blanks dropped, case-insensitive duplicates folded.
 *  Over a bound is a refusal (null), never a silent cut. */
function parseTermList(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MOA_GOAL_LIMITS.TERMS_MAX) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return null;
    const one = goalOneLine(item);
    if (!one) continue;
    if ([...one].length > MOA_GOAL_LIMITS.TERMS_ITEM_MAX_CHARS) return null;
    if (!out.some((x) => x.toLowerCase() === one.toLowerCase())) out.push(one);
  }
  return out;
}

export interface MoaGoalProposal extends MoaGoalTerms {
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
  const doneCriteria = parseTermList(params.doneCriteria);
  if (doneCriteria === null) return { error: 'done_criteria_invalid' };
  const evidence = parseTermList(params.evidence);
  if (evidence === null) return { error: 'evidence_invalid' };
  const constraints = parseTermList(params.constraints);
  if (constraints === null) return { error: 'constraints_invalid' };
  return { goal, repo, workspaceIds, level, budget: { maxTasks, maxHours, maxTurns }, humanOnly, doneCriteria, evidence, constraints };
}

/** The approval card's text. Everything the contract grants is on it: a card
 *  whose context had to be cut is refused at proposal time (`card_too_long`). */
export function buildMoaGoalCard(
  c: Pick<MoaGoalContract, 'id' | 'goal' | 'repoRoot' | 'workspaceIds' | 'level' | 'budget' | 'humanOnly' | 'workerPermissionMode' | 'doneCriteria' | 'evidence' | 'constraints'>,
  workspaceName: (id: string) => string | undefined,
): { question: string; options: string[]; context: string } {
  const ws = c.workspaceIds.map((id) => workspaceName(id) ?? id);
  const lines = [
    `Goal: ${c.goal}`,
    `Repository: ${c.repoRoot ?? '(none)'}`,
    ...(ws.length ? [`Workspaces: ${ws.join(', ')}`] : []),
    ...goalCardTermsLines(goalTermsOf(c)),
    `Moa may, without asking: fan out up to ${c.budget.maxTasks} task${c.budget.maxTasks === 1 ? '' : 's'} in that repository, answer and instruct those tasks${ws.length ? ', hand work to the workspaces above' : ''}. Level ${c.level}; ends after ${c.budget.maxHours} h or ${c.budget.maxTurns} automatic turns.`,
    'Once proved: Moa pushes task branches and opens PRs itself.',
    `Workers: Claude Code only, permission mode ${c.workerPermissionMode ?? 'unknown'}; push, PR, tag, release, publish and recursive-delete commands denied; GitHub credentials withheld.`,
    `Always yours: ${[...MOA_GOAL_DEFAULT_HUMAN_ONLY, ...c.humanOnly].join('; ')}.`,
  ];
  return {
    question: `Approve Moa's goal ${c.id}? ${c.goal}`.slice(0, 1000),
    options: [MOA_GOAL_OPTIONS.approve, MOA_GOAL_OPTIONS.decline],
    context: lines.join('\n'),
  };
}

/** The card's terms: one line per criterion, so a long list reads as a list
 *  (the card renders its context with line breaks kept). */
export function goalCardTermsLines(t: MoaGoalTerms): string[] {
  return [
    ...(t.doneCriteria.length
      ? ['Done when:', ...t.doneCriteria.map((x, i) => `  (${i + 1}) ${x}`)]
      : ['Done when: (no criteria stated; Moa must say how it verified the goal)']),
    ...(t.evidence.length ? ['Evidence:', ...t.evidence.map((x) => `  • ${x}`)] : []),
    ...(t.constraints.length ? ['Constraints:', ...t.constraints.map((x) => `  • ${x}`)] : []),
  ];
}

/** The terms as lines for the [goal] block and the worker note.
 *  An empty done-criteria list is said out loud, so nobody reads silence as
 *  "anything counts as done". */
export function goalTermsLines(t: MoaGoalTerms): string[] {
  return [
    t.doneCriteria.length
      ? `Done when: ${t.doneCriteria.map((x, i) => `(${i + 1}) ${x}`).join(' ')}`
      : 'Done when: (no criteria stated; Moa must say how it verified the goal)',
    ...(t.evidence.length ? [`Evidence: ${t.evidence.join('; ')}`] : []),
    ...(t.constraints.length ? [`Constraints: ${t.constraints.join('; ')}`] : []),
  ];
}

// ── hard rules on outbound text ─────────────────────────────────────────────
//
// A TRIPWIRE, NOT THE BOUNDARY. These patterns read what Moa is about to send
// a worker and refuse the plain ways of asking for a push, a release, a secret
// or a destructive command. They are deliberately broad (a refusal only costs
// Moa a rephrase or a deck_ask_decision), but a regex over natural language
// can always be paraphrased, split or translated past. What actually holds a
// goal worker is layered under this: the worker's own deny rules and the
// credential friction of the goal worker profile (shared/moaGoalWorker.ts),
// and outside wmux the remote's branch protection.

export type MoaGoalHardRule = 'remote' | 'release' | 'secret' | 'destructive' | 'human-only';

/** Global git options that may stand between `git` and its subcommand
 *  (`git -C . push`, `git -c k=v push`, `git --no-pager push`). */
const GIT_OPTS = String.raw`(?:\s+(?:-[cC]\s+\S+|--[a-z][\w-]*(?:=\S+)?|-[a-zA-Z]))*`;

function gitCmd(sub: string): RegExp {
  return new RegExp(String.raw`\bgit${GIT_OPTS}\s+(?:${sub})`, 'i');
}

const REMOTE_PLACE = String.raw`(?:the\s+)?(?:origin|remote|upstream|github|gitlab|bitbucket)`;

const HARD_RULES: ReadonlyArray<{ rule: MoaGoalHardRule; re: RegExp; literal?: true }> = [
  // remote
  { rule: 'remote', re: gitCmd(String.raw`push\b`) },
  { rule: 'remote', re: /\bpush\s+(it|this|that|them|everything|the\s+(branch|changes?|commits?|fix|work|tags?)|your\s+(branch|changes?|commits?|work|tags?)|(all\s+)?(the\s+)?tags?)\b/i },
  { rule: 'remote', re: new RegExp(String.raw`\bpush\s+((it|this|them|everything)\s+)?(up\s+)?(to|into)\s+(${REMOTE_PLACE}|main|master)\b`, 'i') },
  { rule: 'remote', re: /\bforce[- ]?push/i },
  { rule: 'remote', re: /\bgh\s+pr\s+(create|merge|ready|close|reopen|edit|comment|review)\b/i },
  { rule: 'remote', re: /\bgh\s+(api|workflow\s+run|run\s+rerun|repo\s+(create|delete|edit|rename|archive|fork|sync))\b/i },
  { rule: 'remote', re: /\b(open|create|raise|file|merge|submit|land)\s+(a\s+|an\s+|the\s+|your\s+)?(draft\s+)?(pull\s+request|PR|merge\s+request|MR)s?\b/i },
  { rule: 'remote', re: new RegExp(String.raw`\b(publish|upload|sync)\w*\s+(\S+\s+){0,4}?(to|with|on|onto)\s+${REMOTE_PLACE}\b`, 'i') },
  { rule: 'remote', re: /\bpublish\s+(your|the|this)\s+branch\b/i },
  { rule: 'remote', re: /(\bgit|깃)\s*(푸시|푸쉬)|(푸시|푸쉬)\s*(해|하|를|좀)|원격\S*\s*(에|으로)?\s*(올려|푸시|푸쉬)|(PR|풀\s*리퀘스트|풀리퀘)\s*(을|를)?\s*(만들|열어|올려|생성|머지|병합)|(머지|병합)\s*(해|하)|プッシュ|プルリク|マージして|推送|合并请求|拉取请求/i },
  // release
  { rule: 'release', re: /\b(npm|pnpm|yarn|bun|cargo|gem|poetry|vsce|ovsx|changeset|lerna)\s+(npm\s+)?publish\b|\btwine\s+upload\b/i },
  { rule: 'release', re: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(release|publish|deploy|version)\b/i },
  { rule: 'release', re: /\b(make|just|task)\s+(release|publish|deploy)\b/i },
  { rule: 'release', re: /[\w./-]*\b(release|publish|deploy)[\w.-]*\.(sh|ps1|cmd|bat|mjs|cjs|js|ts|py)\b/i },
  { rule: 'release', re: /\bgh\s+release\b/i },
  { rule: 'release', re: gitCmd(String.raw`tag\b`) },
  { rule: 'release', re: /\bdocker\s+push\b/i },
  { rule: 'release', re: /\b(cut|publish|ship|tag|make|create|do)\s+(a\s+|an\s+|the\s+)?(new\s+)?release\b/i },
  { rule: 'release', re: /\bbump\s+(the\s+)?version\b/i },
  { rule: 'release', re: /(릴리스|릴리즈|배포)\s*(해|하|를|좀|만들)|버전\s*(을|를)?\s*올려|リリースして|发布/i },
  // secret
  { rule: 'secret', re: /\b(api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret[_ -]?key|private[_ -]?key|password|passwd|credentials?)\b/i },
  { rule: 'secret', re: /(^|[\s(/=:])(\.env(\.[\w-]+)?|id_(rsa|ed25519|ecdsa|dsa)|\.ssh\/|\.npmrc|\.pypirc|[._]netrc|\.git-credentials|\.aws\/credentials)\b/i },
  { rule: 'secret', re: /\.config\/gh\b|\bgh\/hosts\.yml\b|\bhosts\.yml\b|github cli\/|\.docker\/config\.json|\.kube\/config\b|\bcredentials\.json\b/i },
  { rule: 'secret', re: /\bgh\s+auth\s+(token|login|refresh|status\s+(-t|--show-token))\b|\bgit\s+credential\b|\bcmdkey\b|\bsecurity\s+find-(generic|internet)-password\b/i },
  { rule: 'secret', re: /(토큰|비밀번호|패스워드|자격\s*증명|시크릿)\S*\s*(을|를)?\s*(알려|보여|붙여|출력|복사|읽어|찾아)/ },
  // A token itself: refused even in a negated sentence.
  { rule: 'secret', re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abp]-[A-Za-z0-9-]{10,})\b/, literal: true },
  // destructive
  { rule: 'destructive', re: /\brm(\s+-{1,2}[\w-]+)*?\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$)/ },
  { rule: 'destructive', re: /\b(Remove-Item|ri|rmdir|rd|del|erase)\b[^\n;|&]*?\s[-/](Recurse|r|s)\b/i },
  { rule: 'destructive', re: /\bfind\b[^\n;|&]*\s-(delete|exec\s+rm)\b/i },
  { rule: 'destructive', re: gitCmd(String.raw`reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|push\s+--delete|checkout\s+--\s|restore\s+(--\S+\s+)*\.(\s|$)|stash\s+(drop|clear)|filter-branch|update-ref\s+-d`) },
  { rule: 'destructive', re: /\b(drop\s+(table|database|schema)|truncate\s+table)\b|\bmkfs\b|\bformat\s+[a-z]:/i },
];

/** Breaks a clause: punctuation, a dash between spaces, or a joining word.
 *  A negation only covers the clause it is in ("No rush, git push" is not). */
const CLAUSE_BREAK = /[.,;:!?\n]|\s[-–—]+\s|\b(then|and|but|so|after|before|once|when|while|also)\b/gi;

/** A negation directly in front of the match: at most two words between. */
const NEGATION_TAIL = /\b(do\s+not|dont|never|must\s+not|mustnt|should\s+not|shouldnt|cannot|cant|wont|not|no|without)\s+(\S+\s+){0,2}$/i;

/** Phrases that look like a negation and are not. */
const NOT_A_NEGATION = /\b(never\s+mind|no\s+(rush|worries|problem|need|hurry|matter)|not\s+(only|just)|(dont|do\s+not|never)\s+(forget|hesitate)|without\s+(delay|waiting|asking|hesitation))\b/i;

function negated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 60), index);
  let start = 0;
  for (const m of before.matchAll(CLAUSE_BREAK)) start = (m.index ?? 0) + m[0].length;
  const clause = before.slice(start);
  if (NOT_A_NEGATION.test(clause)) return false;
  return NEGATION_TAIL.test(clause);
}

/** Text as the rules read it: compatibility-folded (full-width forms), with
 *  zero-width / format characters and quote marks removed (so `git` "push"
 *  and `g​it push` read as one command), and Windows path separators
 *  turned into `/`. */
export function goalScreenText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[­​-‏⁠-⁤﻿]/g, '')
    .replace(/["'`‘’“”]/g, '')
    .replace(/\\/g, '/');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The first hard rule `text` trips, or null. `humanOnly` is the contract's own
 * list (the operator approved it); each entry matches as a whole phrase,
 * case-insensitively. A mention negated in its own clause ("do not push it")
 * is an instruction to stay local and passes; a literal token never does.
 */
export function goalHardRuleHit(
  text: string,
  humanOnly: readonly string[] = [],
): { rule: MoaGoalHardRule; match: string } | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const folded = goalScreenText(text);
  for (const { rule, re, literal } of HARD_RULES) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of folded.matchAll(g)) {
      if (!literal && negated(folded, m.index ?? 0)) continue;
      return { rule, match: m[0].trim().slice(0, 60) };
    }
  }
  for (const phrase of humanOnly) {
    const p = goalScreenText(goalOneLine(phrase));
    if (p.length < 3) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(p)}($|[^\\p{L}\\p{N}])`, 'giu');
    for (const m of folded.matchAll(re)) {
      // The match starts with the separator in front of the phrase.
      if (negated(folded, (m.index ?? 0) + (m[1]?.length ?? 0))) continue;
      return { rule: 'human-only', match: p };
    }
  }
  return null;
}

/** Screen several texts (a fan-out's prompt, titles and per-task prompts). */
export function goalHardRuleHitAny(
  texts: readonly unknown[],
  humanOnly: readonly string[] = [],
): { rule: MoaGoalHardRule; match: string } | null {
  for (const t of texts) {
    if (typeof t === 'string') {
      const hit = goalHardRuleHit(t, humanOnly);
      if (hit) return hit;
    } else if (Array.isArray(t)) {
      const hit = goalHardRuleHitAny(t, humanOnly);
      if (hit) return hit;
    }
  }
  return null;
}

/** Why a contract grants nothing right now, or null when it does. */
export type MoaGoalInertReason = 'none' | 'not-active' | 'level' | 'expired' | 'tasks' | 'turns' | 'hq-moved';

/** The contract's effective level, or why it is inert. Pure: the caller passes
 *  the HQ's id and level and the clock. `turnOpen`: the automatic turn that
 *  used the last of the turn budget is still running. A turn is counted when
 *  it starts, so without this the last allowed turn would run with no goal. */
export function moaGoalPowers(
  c: MoaGoalContract | null,
  hq: { workspaceId: string | null; level: MoaLevel },
  now: number,
  opts: { turnOpen?: boolean } = {},
): { ok: true; level: 2 | 3 } | { ok: false; reason: MoaGoalInertReason } {
  if (!c) return { ok: false, reason: 'none' };
  if (c.status !== 'active' || c.approvedAt === undefined) return { ok: false, reason: 'not-active' };
  if (c.hqWorkspaceId !== hq.workspaceId) return { ok: false, reason: 'hq-moved' };
  if (hq.level < 2) return { ok: false, reason: 'level' };
  if (now >= c.approvedAt + c.budget.maxHours * 3_600_000) return { ok: false, reason: 'expired' };
  if (c.turnsUsed > c.budget.maxTurns || (c.turnsUsed === c.budget.maxTurns && !opts.turnOpen)) {
    return { ok: false, reason: 'turns' };
  }
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
  doneCriteria: string[];
  evidence: string[];
  constraints: string[];
}

/** Auto-merge after delivery (with a one-hour objection window). OFF for the
 *  trial: the merge path exists (moaGoalDelivery.ts) but nothing turns it on. */
export const MOA_GOAL_AUTO_MERGE = false;
/** How long the operator has to object before an auto-merge, once it is on. */
export const MOA_GOAL_MERGE_OBJECTION_MS = 60 * 60 * 1000;

