// ─── Moa's delegate decisions — records, owner IPC and events (shapes only) ──
//
// Two records, each in its own store under `<wmuxDir>/moa-delegate/`
// (main/deck/moaDecisionStore.ts, main/deck/moaEffectStore.ts). Neither is
// deckDecisionStore: a MoaDecision is one agent's question to Moa, keyed by the
// asker, not a workspace's single blocking card.
//
//   MoaDecision — one moa_ask ticket: who asked (stamped), what, the judge's
//                 verdict, how it was settled and the receipt state.
//   MergeEffect — the outbox row for a merge a decision allowed. Its kind is
//                 'pr.merge' ONLY. There is no approval-press effect: the model
//                 never presses a permission prompt (eng review).
//
// Owner resolution happens ONLY through the renderer IPC channels named in
// shared/constants.ts (DECK_MOA_DELEGATE_*). No pipe RPC, MCP tool or CLI verb
// resolves a MoaDecision or toggles a rule's auto flag — the same boundary as
// deckDecisionStore.isMainOwnedDecision.
//
// THREAT MODEL
//   In scope: text-borne injection. Everything an agent writes (the question,
//   option labels, context, PR titles, branch names, check names, the pane's
//   screen) is quoted data to the judge and is never parsed for targets or
//   authority. "The owner already approved", a fake rule id or a fake "CI
//   passed" must end as an escalation or a refusal, never an action.
//   Out of scope: a malicious agent with a shell. Files under ~/.wmux are
//   written by the same uid every agent runs as, so they are NOT a trust
//   boundary; such an agent can edit these stores, the policy book, or merge
//   with the same gh credentials directly. The lane is a recorded, head-pinned
//   path, not a lock.
//   Replay re-evaluates everything: a stored "go", "approved" or "done" never
//   authorizes an execution. Before any merge (first try or retry) main reads
//   the PR fresh and re-runs every lane predicate and mergeBlock.
//   Follow-up, not done here: HMAC-signing the records with a key outside the
//   agents' reach, so a same-uid edit is at least detectable.

import type {
  MergeEffectStatus,
  MoaAskBody,
  MoaAskKind,
  MoaAsker,
  MoaAskMode,
  MoaResolvedBy,
  MoaTicketStatus,
  MoaTicketView,
} from './moaAsk';
import { MOA_ASK_POLL_MS } from './moaAsk';

export const MOA_DELEGATE_DIRNAME = 'moa-delegate';
export const MOA_DECISIONS_FILENAME = 'decisions.json';
export const MOA_EFFECTS_FILENAME = 'effects.json';

/** The decision's mode: the ask mode in force when it was created (never 'off'). */
export type MoaDecisionMode = Exclude<MoaAskMode, 'off'>;

/**
 * Processing state, mirroring AnswerReceiptState. `inFlight`: the judge (or a
 * deterministic check) is still running. A row found `inFlight` on load is
 * read as `uncertain` and never judged again.
 */
export type MoaReceiptState = 'inFlight' | 'done' | 'refused' | 'uncertain';

/** What the judge (or the pre-check) said. */
export interface MoaJudgeResult {
  /** `answer` names a choice; `go` allows the action; `escalate` sends it to the owner. */
  verdict: 'answer' | 'go' | 'escalate';
  choiceKey?: string;
  ruleId?: string;
  reasonCode: string;
  why: string;
  tokens: { input: number; output: number };
  ms: number;
}

export interface MoaDecision {
  /** `moa-d-<uuid>`. */
  id: string;
  /** `moa-t-<uuid>`: the only id the asker ever sees. */
  ticketId: string;
  asker: MoaAsker;
  /** sha256 hex of the idempotency key (asker + askId, or asker + "q:"+questionHash). */
  askKey: string;
  /** The caller's own key, when it gave one. */
  askId?: string;
  /** main's hash of the body (32 hex), the same normalization as shadowPacketHash. */
  questionHash: string;
  kind: MoaAskKind;
  /** The validated request body (shown to the owner, re-judged never). */
  body: MoaAskBody;
  /** For a merge: the repo main resolved from the asker's cwd. */
  repo?: { key: string; path: string };
  mode: MoaDecisionMode;
  status: MoaTicketStatus;
  judge: MoaJudgeResult | null;
  /** The rule the final status rests on (null when none, or the owner answered). */
  ruleId: string | null;
  reasonCode: string;
  why: string;
  /** Set once answered. */
  answer?: { choiceKey: string } | { actionVerdict: 'go' | 'no-go' };
  resolvedBy: MoaResolvedBy | null;
  createdAt: number;
  resolvedAt: number | null;
  receipt: MoaReceiptState;
}

/** Most attempts at one merge effect before it stays refused. */
export const MERGE_EFFECT_MAX_ATTEMPTS = 3;

export interface MergeEffect {
  /** `effect:<decisionId>:pr.merge`. */
  id: string;
  kind: 'pr.merge';
  decisionId: string;
  repoKey: string;
  repoPath: string;
  prNumber: number;
  expectHead: string;
  /** Who allowed it. 'moa-auto' re-runs every lane predicate before each try;
   *  'owner' re-runs head-unchanged (and mergeBlock) — the owner may approve
   *  what the lane would not, e.g. an outside contributor's PR. */
  approvedBy: 'owner' | 'moa-auto';
  status: MergeEffectStatus;
  attempt: number;
  reason?: string;
  createdAt: number;
  updatedAt: number;
  /** The last time an execution started (status went inFlight). */
  startedAt?: number;
  /** Evidence once done: the squash commit GitHub recorded. */
  mergeCommitOid?: string;
}

export function mergeEffectId(decisionId: string): string {
  return `effect:${decisionId}:pr.merge`;
}

/**
 * The asker's view of its ticket. `uncertain` (main stopped mid-judge) and
 * `expired` (the owner never answered) read as `escalated`: the asker asks the
 * owner itself.
 */
export function ticketView(d: MoaDecision, effect?: MergeEffect | null): MoaTicketView {
  let status = d.status;
  let reasonCode = d.reasonCode;
  let why = d.why;
  if (d.receipt === 'uncertain' && d.status === 'pending') {
    status = 'escalated';
    reasonCode = 'restart-uncertain';
    why = 'wmux restarted while this was being decided; ask the owner';
  }
  const view: MoaTicketView = {
    ticketId: d.ticketId,
    kind: d.kind,
    status,
    reasonCode,
    why,
    createdAt: d.createdAt,
    resolvedAt: d.resolvedAt,
  };
  if (status === 'answered' && d.answer && (d.resolvedBy === 'owner' || d.resolvedBy === 'moa-auto')) {
    view.answer = {
      ...('choiceKey' in d.answer ? { choiceKey: d.answer.choiceKey } : { actionVerdict: d.answer.actionVerdict }),
      ruleId: d.resolvedBy === 'owner' ? null : d.ruleId,
      reasonCode: d.reasonCode,
      why: d.why,
      resolvedBy: d.resolvedBy,
    };
  }
  if (effect) view.effect = { status: effect.status, ...(effect.reason ? { reason: effect.reason } : {}) };
  if (status === 'pending') view.pollAfterMs = MOA_ASK_POLL_MS;
  return view;
}

// ── Owner IPC (renderer-only) ────────────────────────────────────────────────

/** A policy rule as the panel lists it. */
export interface MoaRuleView {
  ruleId: string;
  text: string;
  /** The book's own `{auto: true}` attribute. */
  autoInBook: boolean;
  /** The predicate the book binds to the rule, when it names a known one. */
  predicate: string | null;
  /** The owner's per-rule toggle (MoaConfig.autoRules). */
  autoOn: boolean;
  /** Agreement with the owner on settled decisions citing this rule.
   *  DISPLAY ONLY: never a trigger for anything automatic. */
  agreement: { compared: number; agreed: number };
}

/** DECK_MOA_DELEGATE_LIST's answer. */
export interface MoaDelegateListResult {
  mode: MoaAskMode;
  decisions: MoaDecision[];
  effects: MergeEffect[];
  rules: MoaRuleView[];
}

export type MoaOwnerAnswer =
  | { type: 'choice'; choiceKey: string }
  /** The head the owner saw on the card; a moved head is refused as `stale`. */
  | { type: 'merge'; approve: boolean; expectHead: string }
  /** Close it as not needed; the asker reads `refused` / 'dismissed'. */
  | { type: 'dismiss' };

/** DECK_MOA_DELEGATE_RESOLVE's request. */
export interface MoaResolveRequest {
  decisionId: string;
  answer: MoaOwnerAnswer;
}

export type MoaResolveResult =
  | { ok: true; decision: MoaDecision; effect?: MergeEffect }
  /** unknown: no such decision. not-open: already settled. stale: the card's
   *  head is not the decision's. invalid: the request failed validation. */
  | { ok: false; code: 'unknown' | 'not-open' | 'stale' | 'invalid'; message: string };

/** DECK_MOA_DELEGATE_AUTO_SET's request: the owner's per-rule auto toggle. */
export interface MoaAutoRuleSetRequest {
  ruleId: string;
  auto: boolean;
}

export type MoaAutoRuleSetResult = { ok: true; autoRules: string[] } | { ok: false; code: 'invalid' | 'store-error'; message: string };

// ── Events (main → renderer, send) ───────────────────────────────────────────

/** DECK_MOA_DELEGATE_DECISION_EVENT. */
export interface MoaDecisionEvent {
  type: 'created' | 'updated';
  decision: MoaDecision;
}

/** DECK_MOA_DELEGATE_EFFECT_EVENT. */
export interface MoaEffectEvent {
  effect: MergeEffect;
}

// ── Validation ───────────────────────────────────────────────────────────────

export const MOA_DECISION_ID_RE = /^moa-d-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A policy rule id, as deckPolicy parses it. */
export const MOA_RULE_ID_RE = /^R-[a-z0-9][a-z0-9-]{0,47}$/;
const OPTION_KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

type Parsed<T> = { ok: true; value: T } | { ok: false; code: 'invalid'; message: string };
const invalid = (message: string): { ok: false; code: 'invalid'; message: string } => ({ ok: false, code: 'invalid', message });
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));

/** Validate a renderer's resolve request. Pure; never throws. */
export function parseMoaResolveRequest(raw: unknown): Parsed<MoaResolveRequest> {
  if (!isRecord(raw) || !onlyKeys(raw, ['decisionId', 'answer'])) return invalid('expected { decisionId, answer }');
  if (typeof raw.decisionId !== 'string' || !MOA_DECISION_ID_RE.test(raw.decisionId)) return invalid('not a decision id');
  const a = raw.answer;
  if (!isRecord(a)) return invalid('answer must be an object');
  if (a.type === 'choice' && onlyKeys(a, ['type', 'choiceKey'])) {
    if (typeof a.choiceKey !== 'string' || !OPTION_KEY_RE.test(a.choiceKey)) return invalid('not a choice key');
    return { ok: true, value: { decisionId: raw.decisionId, answer: { type: 'choice', choiceKey: a.choiceKey } } };
  }
  if (a.type === 'merge' && onlyKeys(a, ['type', 'approve', 'expectHead'])) {
    if (typeof a.approve !== 'boolean') return invalid('approve must be a boolean');
    if (typeof a.expectHead !== 'string' || !COMMIT_SHA_RE.test(a.expectHead)) return invalid('expectHead must be a full commit SHA');
    return { ok: true, value: { decisionId: raw.decisionId, answer: { type: 'merge', approve: a.approve, expectHead: a.expectHead } } };
  }
  if (a.type === 'dismiss' && onlyKeys(a, ['type'])) {
    return { ok: true, value: { decisionId: raw.decisionId, answer: { type: 'dismiss' } } };
  }
  return invalid('answer.type must be choice, merge or dismiss, with only its own fields');
}

/** Validate a renderer's per-rule auto toggle. Pure; never throws. */
export function parseMoaAutoRuleSetRequest(raw: unknown): Parsed<MoaAutoRuleSetRequest> {
  if (!isRecord(raw) || !onlyKeys(raw, ['ruleId', 'auto'])) return invalid('expected { ruleId, auto }');
  if (typeof raw.ruleId !== 'string' || !MOA_RULE_ID_RE.test(raw.ruleId)) return invalid('not a rule id');
  if (typeof raw.auto !== 'boolean') return invalid('auto must be a boolean');
  return { ok: true, value: { ruleId: raw.ruleId, auto: raw.auto } };
}

/** Normalize the stored per-rule toggles: valid ids only, deduped, sorted. */
export function sanitizeAutoRules(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((r): r is string => typeof r === 'string' && MOA_RULE_ID_RE.test(r)))].sort();
}
