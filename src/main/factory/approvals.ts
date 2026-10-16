// ─── Owner approvals — the irreversible and public acts a bot asks for ─────
//
// Contract: shared/botApproval.ts. A bot asks with `botApproval.request`
// (approval_request); main writes the record from its own reads — the bot's
// repository from its profile, the PR head fresh from GitHub, the gh login,
// the thread of the wake it is running and whether that wake carried outside
// text (wakeTaint.ts) — and posts an `approval` card in that thread. The bot
// names only the act, the PR or issue and a one-line reason.
//
// Only the owner decides, through main:
//   - the main window (BOT_APPROVAL_IPC, ipc/handlers/approval.handler.ts:
//     sender-checked) — the card's Approve / Deny / Always allow / Undo and
//     the composer's "Approve N pending" chip;
//   - the phone's approval route (`decide(…, 'phone')`: the operator token,
//     or a paired device with an explicit input grant, whose id the log
//     records; phone/PhoneBotApprovals.ts, daemon/web/botApprovals.ts);
//   - a message the owner typed: a `human` card (written only by the owner's
//     composer, or a phone using the operator token) in the same thread, after the pending approval
//     cards, that isOwnerApprovalText reads as "go" approves the thread's
//     pending requests shown right above it (after the owner's previous
//     message there; a reply to one approval card, that request only) —
//     unless a question asked since then is still open (the words may
//     answer that instead).
//
// A request's card goes where the bot talks with the owner — the thread of
// the owner's latest message to it, usually `general` — and links the PR's
// or issue's own thread (refs.threadId), so "merge it" typed where the owner
// is chatting approves it.
// No bot RPC writes a decision or a rule.
//
// An approved merge waits APPROVAL_UNDO_MS with Undo on its card, then
// becomes a MergeEffect for the one
// merge executor (mergeLaneHost.ts): `{approvedBy:'owner'|'rule', decisionId:
// requestId, expectHead: the head main read}`. The executor asks this store
// again at run time (authorizeEffect: still approved, same head, the rule
// still there; identityEffect: the gh login unchanged) and re-reads the PR;
// a moved head is refused `head-moved`, and a new request is needed.
//
// "Always allow" approves the request and remembers a rule {action, repoKey,
// one bot or its workspace}. A later request it covers is approved by
// `'rule'` only when it is untainted and the lane-grade check passes now
// (every lane predicate, the rule's gate: factory on and the lane's daily
// cap, whatever lane auto-merge reads); else it
// waits for the owner, its card naming why the rule did not apply. No rule
// covers a release or a push to a default branch.
//
// Acts other than merge are recorded and decided, but nothing carries them
// out yet (the card says so); a bot's workers are refused them
// (shared/botWorkerGuard.ts).
//
// Persistence: `<wmuxDir>/factory/approvals.json` ({version:1, requests,
// rules}), written on every change; a change that did not reach the file is
// not made. An unreadable file refuses to start (approvals stay off) rather
// than drop decisions. A decision is never taken from the file: on load an
// approved request is pending again (the owner approves it again), so only
// a decision made in this run reaches the executor. A request whose merge
// effect already ended takes that outcome on start.
//
// Typed approval is scoped: the message's addressees (refs.botId /
// refs.botIds, main-stamped) are the only bots whose requests it approves,
// and a thread with an open question, or a message replying to a card that
// is not an approval, approves nothing.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import { botTemplate, type BotBinding, type BotEventPayload, type BotProfile } from '../../shared/bot';
import {
  APPROVAL_ACTIONS,
  APPROVAL_ID_RE,
  APPROVAL_NEVER_BY_RULE,
  APPROVAL_UNDO_MS,
  BOT_APPROVAL_RPC,
  RULE_OTHER_ASKER,
  firstRuleSkip,
  isOwnerApprovalText,
  type ApprovalAction,
  type ApprovalApprover,
  type ApprovalDecideRequest,
  type ApprovalRequest,
  type ApprovalRule,
  type ApprovalRuleNeed,
  type ApprovalState,
} from '../../shared/botApproval';
import type { FactoryRefusal } from '../../shared/botSurface';
import type { Fact, FactDraft } from '../../shared/facts';
import type { MergeEffect } from '../../shared/moaDecision';
import type { PrLaneFacts } from '../../shared/prReview';
import type { RpcContext } from '../../shared/rpc';
import { GENERAL_THREAD, ROOM_LIMITS, dmThreadBot, issueThreadId, parseThreadId, prThreadId, type RoomCard, type ThreadId } from '../../shared/room';
import type { FactoryRouter } from './factoryHost';
import { factFromMergeEffect } from './factIngest';
import { fenceFor } from '../../shared/markdownFence';
import { redactStoredSecrets } from './secretRedaction';
import { normalizeRepoKey } from './repoWatch';
import { laneRefusalCodes, laneRefusalLine } from './laneRefusalText';
import { wakeReplyTo, type RoomWriter } from './roomWriter';
import type { BotNoticeInput } from './botNotices';
import type { BotDirectoryApi } from './triggerEngine';

export const APPROVALS_FILENAME = 'approvals.json';

export const APPROVAL_LIMITS = {
  /** A pending request older than this expires. */
  PENDING_TTL_MS: 24 * 3600_000,
  /** Settled requests older than this are dropped from the file. */
  RETAIN_MS: 30 * 24 * 3600_000,
  REQUESTS_MAX: 500,
  RULES_MAX: 100,
  /** Pending requests one bot may hold. */
  PENDING_PER_BOT: 20,
  REASON_MAX: 300,
  CLIENT_ID_MAX: 200,
  LIST_MAX: 100,
  /** An owner message counts as approval only this soon after it was
   *  posted, and once. */
  TYPED_FRESH_MS: 10 * 60_000,
  TYPED_SEEN_MAX: 500,
  /** Bots one decision or merge is told to. */
  NOTIFY_MAX: 6,
} as const;

/** The stored record: the contract's fields plus what only main reads. */
export interface StoredApproval extends ApprovalRequest {
  /** The repository's checkout, from the bot's profile at the request. */
  repoPath: string;
  clientRequestId: string;
  /** An approved merge runs at this time unless undone. */
  executeAfter?: number;
  /** The merge effect it became. */
  effectId?: string;
  /** Why a covering rule did not approve it (shown on the card). */
  ruleSkipped?: string;
}

/** A request as the main window and the bot see it (no checkout path). */
export type ApprovalView = Omit<StoredApproval, 'repoPath' | 'clientRequestId'>;

export function approvalView(r: StoredApproval): ApprovalView {
  const view: Partial<StoredApproval> = { ...r };
  delete view.repoPath;
  delete view.clientRequestId;
  // What the owner reads: sentences, never the raw codes.
  delete view.refusalText;
  delete view.ruleSkippedText;
  delete view.ruleSkippedCondition;
  const refusalText = r.refusal ? laneRefusalLine(r.refusal) : '';
  // A skip names its first unmet condition only (firstRuleSkip).
  const skip = r.ruleSkipped ? firstRuleSkip(laneRefusalCodes(r.ruleSkipped)) : null;
  const ruleSkippedText = skip ? laneRefusalLine(skip.code) : '';
  return {
    ...(view as ApprovalView),
    ...(refusalText ? { refusalText } : {}),
    ...(ruleSkippedText ? { ruleSkippedText } : {}),
    ...(skip?.condition ? { ruleSkippedCondition: skip.condition } : {}),
  };
}

/** The running wake of a bot, as main knows it. */
export interface ApprovalWake {
  wakeId: string;
  /** The wake's attempt (a retried turn asks again from its first ordinal). */
  attempt: number;
  threadId: ThreadId | null;
  tainted: boolean;
  /** The wake carries the owner's own message. */
  ownerWords?: boolean;
  /** The owner card that started the wake (RunningWake.ownerCardId): the
   *  request's card answers it when it lands in that card's thread. */
  ownerCardId?: string;
}

/** What the approvals reach of the merge executor (mergeLaneHost.ts). */
export interface ApprovalMergeHost {
  /** Enqueue the effect for an approved merge request (one per request). */
  enqueue(r: StoredApproval, approvedBy: ApprovalApprover): Promise<MergeEffect>;
  run(effectId: string): Promise<MergeEffect | null>;
  /** Null when a rule may approve this head now: untainted head branch,
   *  every lane predicate on a fresh read, the lane's gate. Else why not. */
  ruleCheck(r: StoredApproval): Promise<string | null>;
  /** The outbox row of an effect, or null. */
  effect?(effectId: string): MergeEffect | null;
}

export interface ApprovalPorts {
  /** `<wmuxDir>/factory/approvals.json`. */
  file: string;
  bots: () => BotDirectoryApi | null;
  /** The wake the bot is running now, or null between turns. */
  runningWake: (botId: string) => ApprovalWake | null;
  /** The thread of the owner's latest message to the bot (its latest
   *  owner-message wake), or null when the owner has not written to it. */
  conversationThread?: (botId: string) => ThreadId | null;
  /** The PR read fresh (never a cache); throws when unreadable. */
  readPr: (repoPath: string, repoKey: string, prNumber: number) => Promise<PrLaneFacts>;
  /** The gh login a merge would go out as now, or null. */
  ghLogin: (repo: { key: string; path: string }) => Promise<string | null>;
  rooms: () => RoomWriter | null;
  merge: () => ApprovalMergeHost | null;
  appendFact?: (draft: FactDraft) => Fact | null;
  /** Tell one bot what became of a request or its PR (botNotices.ts
   *  noticeBot: a directed fact and one wake per key). */
  notice?: (n: BotNoticeInput) => void;
  emit?: (payload: BotEventPayload) => void;
  /** The bot skills store, for `skill` requests: the owner's answer is the
   *  act. `approve` returns why the proposal on the card cannot be approved
   *  (it changed since), or null once it is the approved version. */
  skills?: () => ApprovalSkillHost | null;
  now?: () => number;
  log?: (line: string) => void;
}

/** What a `skill` request's decision does to the bot's skill. */
export interface ApprovalSkillHost {
  approve(r: StoredApproval): string | null;
  /** Denied, or expired unanswered: the proposal is archived. */
  deny(r: StoredApproval): void;
}

/** What `proposeSkill` takes (the store has written the proposal). */
export interface SkillApprovalInput {
  name: string;
  hash: string;
  version: string;
  update: boolean;
  /** The change against the approved version, shown on the card. */
  diff: string;
  /** The bot's one line. */
  reason: string;
}

type Refusal = FactoryRefusal<'not_bot' | 'not_running' | 'invalid' | 'no_repo' | 'read_failed' | 'not_open' | 'too_many' | 'not_found' | 'not_pending' | 'too_late' | 'not_ruleable' | 'write_failed' | 'not_started' | 'stale'>;

function refuse(code: Refusal['code'], message: string): Refusal {
  return { ok: false, code, message };
}

function newRequestId(): string {
  return `apr-${randomBytes(9).toString('base64url')}`;
}

function newRuleId(): string {
  return `rule-${randomBytes(9).toString('base64url')}`;
}

function oneLine(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** A quoted span: straight or curly double quotes, guillemets, corner
 *  brackets, curly single quotes, or straight single quotes that open after
 *  a space or bracket and close before a space or punctuation (so an
 *  apostrophe inside a word opens none). */
const QUOTED = /["“«「『‘]([^"”»」』’]{1,300})["”»」』’]|(?<=^|[\s([])'([^'\n]{1,300})'(?=$|[\s.,;:!?)\]])/g;

function sameWords(a: string): string {
  return a.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A request's reason without the sentences that quote one of the owner's
 * messages: the reason is the bot's own account of this act, and only the
 * owner's answer on its card approves it, so earlier words of theirs (about
 * this or another PR) never ride on the card. Quotes are found before the
 * sentences, so a quote with a full stop inside is one quote. Empty when
 * every sentence quoted the owner. Pure.
 */
export function withoutOwnerQuotes(reason: string, ownerTexts: readonly string[]): string {
  const said = new Set(ownerTexts.map(sameWords).filter(Boolean));
  if (said.size === 0) return reason;
  const quotes = [...reason.matchAll(QUOTED)].map((m) => ({
    from: m.index ?? 0, to: (m.index ?? 0) + m[0].length, owner: said.has(sameWords(m[1] ?? m[2] ?? '')),
  }));
  if (!quotes.some((q) => q.owner)) return reason;
  const inQuote = (i: number): boolean => quotes.some((q) => i > q.from && i < q.to - 1);
  const sentences: Array<{ from: number; to: number }> = [];
  let start = 0;
  for (let i = 0; i < reason.length; i += 1) {
    if (/[.!?。]/.test(reason[i]) && (i + 1 === reason.length || /\s/.test(reason[i + 1])) && !inQuote(i)) {
      sentences.push({ from: start, to: i + 1 });
      start = i + 1;
    }
  }
  if (start < reason.length) sentences.push({ from: start, to: reason.length });
  return sentences
    .filter((x) => !quotes.some((q) => q.owner && q.from < x.to && q.to > x.from))
    .map((x) => reason.slice(x.from, x.to).trim())
    .filter(Boolean)
    .join(' ');
}

const STATES: ReadonlySet<string> = new Set<ApprovalState>(['pending', 'approved', 'denied', 'undone', 'executed', 'refused', 'expired']);

function isStoredApproval(v: unknown): v is StoredApproval {
  const r = v as StoredApproval;
  return !!r && typeof r === 'object'
    && typeof r.requestId === 'string' && APPROVAL_ID_RE.test(r.requestId)
    && (APPROVAL_ACTIONS as readonly string[]).includes(r.action)
    && typeof r.repoKey === 'string' && typeof r.repoPath === 'string'
    && typeof r.botId === 'string' && typeof r.workspaceId === 'string'
    && parseThreadId(r.threadId) !== null
    && typeof r.reason === 'string' && typeof r.tainted === 'boolean'
    && STATES.has(r.state) && typeof r.clientRequestId === 'string'
    && Number.isSafeInteger(r.createdAt) && Number.isSafeInteger(r.updatedAt);
}

function isRule(v: unknown): v is ApprovalRule {
  const r = v as ApprovalRule;
  if (!r || typeof r !== 'object' || typeof r.ruleId !== 'string' || typeof r.repoKey !== 'string') return false;
  if (!(APPROVAL_ACTIONS as readonly string[]).includes(r.action) || APPROVAL_NEVER_BY_RULE.has(r.action)) return false;
  const s = r.scope as Record<string, unknown> | undefined;
  const scoped = !!s && ((typeof s.botId === 'string' && !('workspaceId' in s)) || (typeof s.workspaceId === 'string' && !('botId' in s)));
  return scoped && Number.isSafeInteger(r.createdAt);
}

/** Whether a rule covers a request. Pure. */
export function ruleCovers(rule: ApprovalRule, r: Pick<ApprovalRequest, 'action' | 'repoKey' | 'botId' | 'workspaceId'>): boolean {
  if (APPROVAL_NEVER_BY_RULE.has(r.action) || rule.action !== r.action || rule.repoKey !== r.repoKey) return false;
  return 'botId' in rule.scope ? rule.scope.botId === r.botId : rule.scope.workspaceId === r.workspaceId;
}

/**
 * The requests an owner's typed message approves: the thread's pending
 * requests whose cards come before the message, none if an open question
 * card sits between the newest of them and the message. Pure.
 */
/** The clientPostId prefix of a phone message sent with the operator token
 *  (factoryWiring.factoryPhoneMessage: `phone:<sha256(actor)[:16]>:<id>`,
 *  actor `operator` or `device:<id>`). */
const PHONE_OPERATOR_POST = `phone:${createHash('sha256').update('operator').digest('hex').slice(0, 16)}:`;

/** Whether an owner card may approve by its words: the desktop composer's,
 *  or a phone's sent with the operator token (a paired device's message
 *  approves nothing; a device with an explicit input grant decides on the
 *  approval route). Pure. */
export function typedApprovalSourceAllowed(card: Pick<RoomCard, 'clientPostId'>): boolean {
  const id = card.clientPostId;
  return typeof id !== 'string' || !id.startsWith('phone:') || id.startsWith(PHONE_OPERATOR_POST);
}

export function typedApprovalTargets(
  message: Pick<RoomCard, 'kind' | 'actor' | 'threadId' | 'seq' | 'title' | 'body' | 'workspaceId' | 'refs' | 'replyTo'>,
  pending: readonly Pick<StoredApproval, 'requestId' | 'workspaceId' | 'threadId' | 'state' | 'cardId' | 'botId'>[],
  cards: (cardId: string) => Pick<RoomCard, 'seq' | 'threadId' | 'kind'> | null,
  threadCards: ReadonlyArray<Pick<RoomCard, 'seq' | 'kind' | 'state' | 'actor' | 'title' | 'body'>>,
): string[] {
  if (message.kind !== 'human' || message.actor.kind !== 'human') return [];
  const text = message.body?.trim() ? message.body : message.title;
  if (!isOwnerApprovalText(text)) return [];
  // A reply to anything but an approval card is about that card.
  if (message.replyTo && cards(message.replyTo)?.kind !== 'approval') return [];
  // Only the bots the message was addressed to (main stamped them).
  const to = new Set([message.refs?.botId, ...(message.refs?.botIds ?? [])].filter((b): b is string => typeof b === 'string'));
  if (to.size === 0 && !message.replyTo) return [];
  // Right above the message: after the owner's previous message in the
  // thread that said something else (its words were about what came before
  // it); "merge it" said twice still means the same requests.
  const before = threadCards.filter((c) => c.seq < message.seq);
  const previousOwner = before
    .filter((c) => c.kind === 'human' && c.actor.kind === 'human' && !isOwnerApprovalText(c.body?.trim() ? c.body : c.title))
    .reduce((m, c) => Math.max(m, c.seq), -Infinity);
  // The words may answer a question instead: none while one asked since
  // the owner's previous message is open.
  if (before.some((c) => c.seq > previousOwner && c.kind === 'question' && c.state === 'open')) return [];
  // The cards read must reach back to a request's card, or what sits
  // between it and the words is not known: such a request is not approved.
  const reach = before.reduce((m, c) => Math.min(m, c.seq), Infinity);
  const above: Array<{ id: string; seq: number }> = [];
  for (const r of pending) {
    if (r.state !== 'pending' || r.workspaceId !== message.workspaceId || r.threadId !== message.threadId || !r.cardId) continue;
    // A reply to one approval card is about that request only, whoever the
    // message woke (a room with a coordinator wakes only it); words that
    // reply to no card approve only the addressees' requests.
    if (message.replyTo ? r.cardId !== message.replyTo : !to.has(r.botId)) continue;
    const card = cards(r.cardId);
    if (!card || card.kind !== 'approval' || card.threadId !== message.threadId || card.seq >= message.seq || card.seq <= previousOwner) continue;
    if (before.length > 0 && card.seq < reach) continue;
    above.push({ id: r.requestId, seq: card.seq });
  }
  return above.sort((a, b) => a.seq - b.seq).map((a) => a.id);
}

const ACTION_TITLE: Readonly<Record<ApprovalAction, string>> = {
  merge: 'Merge',
  push_default: 'Push to the default branch of',
  issue_create: 'Open an issue on',
  issue_close: 'Close',
  comment: 'Comment on',
  release: 'Publish a release of',
  skill: 'Load the skill',
};

function subject(r: Pick<ApprovalRequest, 'action' | 'repoKey' | 'prNumber' | 'issueNumber' | 'skill'>): string {
  if (r.skill) return `${r.skill.name} ${r.skill.version}`;
  if (r.prNumber !== undefined) return `PR #${r.prNumber}`;
  if (r.issueNumber !== undefined) return `issue #${r.issueNumber}`;
  return r.repoKey;
}

/** A skill card's lines after the bot's: what Approve does, then the whole
 *  diff in a fence longer than any backtick run in it, so it shows as
 *  written. Null when they do not fit in `room` characters: the owner sees
 *  all of what they approve, so a diff is never cut. Pure. */
export function skillCardLines(update: boolean, diff: string, room: number): string[] | null {
  const fence = fenceFor(diff);
  const lines = [
    '',
    update
      ? 'Approve to load this version in place of the approved one; Deny keeps the approved one and archives this proposal.'
      : 'Approve to load this skill in the bot\'s wakes and its workers; Deny archives it.',
    '',
    `${fence}diff`,
    diff,
    fence,
  ];
  return lines.join('\n').length <= room ? lines : null;
}

/** The first line of an approval card's body. */
function askLine(profile: BotProfile, reason: string): string {
  return `${profile.name || 'A bot'} asks: ${reason}`;
}

export class ApprovalService {
  private requests = new Map<string, StoredApproval>();
  private rules = new Map<string, ApprovalRule>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Requests asked per turn (`<wakeId>#<attempt>`), for default keys. */
  private readonly ordinals = new Map<string, { n: number; botId: string; wakeId: string }>();
  /** Owner cards already read for approval: each is read once. */
  private readonly typedSeen = new Set<string>();
  /** Merge approvals the file held, now pending again (reopened on resume). */
  private readonly reloaded = new Set<string>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly ports: ApprovalPorts) {
    this.now = ports.now ?? Date.now;
    this.log = ports.log ?? ((l) => console.log(l));
    if (!fs.existsSync(ports.file)) return;
    const raw = atomicReadJSONSync<{ version?: unknown; requests?: unknown; rules?: unknown }>(ports.file);
    if (!raw || raw.version !== 1 || !Array.isArray(raw.requests) || !Array.isArray(raw.rules)) throw new Error('Unreadable approvals storage');
    for (const r of raw.requests) {
      if (!isStoredApproval(r)) throw new Error('Invalid approval entry');
      this.requests.set(r.requestId, r);
    }
    // A merge approval is never taken from the file: it waits for the owner
    // again (reopened on resume). Its effect, if one was enqueued, settles it.
    for (const r of [...this.requests.values()]) {
      if (r.state !== 'approved' || r.action !== 'merge') continue;
      const back: StoredApproval = { ...r, state: 'pending' };
      delete back.decidedBy;
      delete back.decidedAt;
      delete back.executeAfter;
      delete back.ruleId;
      this.requests.set(r.requestId, back);
      this.reloaded.add(r.requestId);
    }
    for (const r of raw.rules) {
      if (!isRule(r)) throw new Error('Invalid approval rule');
      this.rules.set(r.ruleId, r);
    }
  }

  // ── persistence ──

  private save(): boolean {
    try {
      fs.mkdirSync(path.dirname(this.ports.file), { recursive: true });
      atomicWriteJSONSync(this.ports.file, { version: 1, requests: [...this.requests.values()], rules: [...this.rules.values()] });
      return true;
    } catch (err) {
      this.log(`[factory] approvals not written: ${String(err)}`);
      return false;
    }
  }

  /** Apply a change; undone in memory when it did not reach the file. */
  private commit(change: () => void): boolean {
    const requests = new Map(this.requests);
    const rules = new Map(this.rules);
    change();
    if (this.save()) return true;
    this.requests = requests;
    this.rules = rules;
    return false;
  }

  private put(r: StoredApproval): boolean {
    return this.commit(() => this.requests.set(r.requestId, r));
  }

  private changed(workspaceId?: string): void {
    try {
      this.ports.emit?.({ type: 'approvals-changed', ...(workspaceId ? { workspaceId } : {}) });
    } catch {
      /* a listener never breaks the store */
    }
  }

  get(requestId: string): StoredApproval | null {
    return this.requests.get(requestId) ?? null;
  }

  // ── bot side ──

  /** `botApproval.request` (a bot, during a wake). */
  async request(bot: BotBinding, raw: Record<string, unknown>): Promise<{ ok: true; request: ApprovalView; duplicate?: true } | Refusal> {
    const action = raw.action;
    if (typeof action !== 'string' || !(APPROVAL_ACTIONS as readonly string[]).includes(action)) {
      return refuse('invalid', `action must be one of ${APPROVAL_ACTIONS.join(', ')}`);
    }
    const act = action as ApprovalAction;
    if (act === 'skill') return refuse('invalid', 'a skill is proposed with skill_propose');
    const num = (v: unknown): number | undefined | null => (v === undefined ? undefined : Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null);
    const prNumber = num(raw.prNumber);
    const issueNumber = num(raw.issueNumber);
    if (prNumber === null || issueNumber === null) return refuse('invalid', 'prNumber / issueNumber must be positive integers');
    if (act === 'merge' && prNumber === undefined) return refuse('invalid', 'a merge names its prNumber');
    if (act === 'issue_close' && issueNumber === undefined) return refuse('invalid', 'closing an issue names its issueNumber');
    if (act === 'comment' && prNumber === undefined && issueNumber === undefined) return refuse('invalid', 'a comment names a prNumber or an issueNumber');
    if (prNumber !== undefined && issueNumber !== undefined) return refuse('invalid', 'name a prNumber or an issueNumber, not both');
    const given = oneLine(raw.reason, APPROVAL_LIMITS.REASON_MAX);
    if (!given) return refuse('invalid', 'reason is required (one line)');
    if (raw.clientRequestId !== undefined && (typeof raw.clientRequestId !== 'string' || !raw.clientRequestId || raw.clientRequestId.length > APPROVAL_LIMITS.CLIENT_ID_MAX)) {
      return refuse('invalid', 'clientRequestId is not a valid key');
    }

    const wake = this.ports.runningWake(bot.botId);
    if (!wake) return refuse('not_running', 'a bot asks for approval only during a wake');
    let profile: BotProfile | null = null;
    try {
      profile = this.ports.bots()?.get(bot.botId) ?? null;
    } catch {
      profile = null;
    }
    if (!profile || !profile.enabled || profile.workspaceId !== bot.workspaceId) return refuse('not_bot', 'this bot is not running in the factory');
    const repoKey = normalizeRepoKey(profile.repo?.repoKey);
    const repoPath = profile.repo?.repoPath ?? '';
    if (!repoKey || !repoPath) return refuse('no_repo', 'this bot has no repository to act on');

    // One request per (bot, key): a retried turn gets the first one back.
    const clientRequestId = typeof raw.clientRequestId === 'string' ? raw.clientRequestId : this.nextOrdinal(bot.botId, wake);
    const prior = [...this.requests.values()].find((r) => r.botId === bot.botId && r.clientRequestId === clientRequestId);
    if (prior) return { ok: true, request: approvalView(prior), duplicate: true };
    const open = [...this.requests.values()].filter((r) => r.botId === bot.botId && r.state === 'pending');
    if (open.length >= APPROVAL_LIMITS.PENDING_PER_BOT) return refuse('too_many', `${open.length} requests already wait for the owner`);

    let headSha: string | undefined;
    let ghLogin: string | undefined;
    if (act === 'merge' && prNumber !== undefined) {
      let facts: PrLaneFacts;
      try {
        facts = await this.ports.readPr(repoPath, repoKey, prNumber);
      } catch (err) {
        return refuse('read_failed', `PR #${prNumber} could not be read: ${String(err)}`.slice(0, 300));
      }
      if (facts.number !== prNumber || facts.state !== 'OPEN') return refuse('not_open', `PR #${prNumber} is not open`);
      headSha = facts.headRefOid;
      // The same head already asked about and not settled: that request.
      const same = [...this.requests.values()].find((r) => r.action === 'merge' && r.repoKey === repoKey && r.prNumber === prNumber && r.headSha === headSha
        && (r.state === 'pending' || r.state === 'approved'));
      if (same) return { ok: true, request: approvalView(same), duplicate: true };
      const login = await this.ports.ghLogin({ key: repoKey, path: repoPath }).catch(() => null);
      if (!login) return refuse('read_failed', 'the gh login could not be read');
      ghLogin = login.toLowerCase();
    }
    // Re-read the wake after the awaits: a request outlives no turn, and
    // no bot deleted meanwhile.
    const still = this.ports.runningWake(bot.botId);
    if (!still || still.wakeId !== wake.wakeId) return refuse('not_running', 'the wake that asked has ended');
    if (this.botGone(bot)) return refuse('not_bot', 'this bot was deleted');
    // A request stored while this one read GitHub (a retry, another bot).
    const again = [...this.requests.values()].find((r) => (r.botId === bot.botId && r.clientRequestId === clientRequestId)
      || (headSha !== undefined && r.action === 'merge' && r.repoKey === repoKey && r.prNumber === prNumber && r.headSha === headSha && (r.state === 'pending' || r.state === 'approved')));
    if (again) return { ok: true, request: approvalView(again), duplicate: true };
    const openNow = [...this.requests.values()].filter((r) => r.botId === bot.botId && r.state === 'pending').length;
    if (openNow >= APPROVAL_LIMITS.PENDING_PER_BOT) return refuse('too_many', `${openNow} requests already wait for the owner`);

    const reason = withoutOwnerQuotes(given, this.ownerTexts(bot.workspaceId)) || `${ACTION_TITLE[act]} ${subject({ action: act, repoKey, prNumber, issueNumber })}.`;
    const at = this.now();
    const record: StoredApproval = {
      requestId: newRequestId(),
      action: act,
      repoKey,
      repoPath,
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(issueNumber !== undefined ? { issueNumber } : {}),
      ...(headSha ? { headSha } : {}),
      ...(ghLogin ? { ghLogin } : {}),
      botId: bot.botId,
      workspaceId: bot.workspaceId,
      // Where the bot talks with the owner, so the owner's "merge it" there
      // approves it; the card links the PR's (or issue's) own thread.
      threadId: this.conversationThread(bot.botId, wake),
      reason,
      tainted: wake.tainted,
      state: 'pending',
      clientRequestId,
      createdAt: at,
      updatedAt: at,
    };
    if (!this.put(record)) return refuse('write_failed', 'the request could not be stored');
    const card = this.postCard(record, profile, still);
    if (card) this.put({ ...record, cardId: card.id });
    this.changed(record.workspaceId);
    await this.applyRule(record.requestId);
    return { ok: true, request: approvalView(this.get(record.requestId) ?? record) };
  }

  /** A bot's skill proposal (the skills module, from `skill_propose`): one
   *  `skill` request whose card shows the diff. No repository is needed and
   *  no rule ever approves it. */
  proposeSkill(bot: BotBinding, input: SkillApprovalInput): { ok: true; request: ApprovalView } | Refusal {
    const wake = this.ports.runningWake(bot.botId);
    if (!wake) return refuse('not_running', 'a bot proposes a skill only during a wake');
    let profile: BotProfile | null = null;
    try {
      profile = this.ports.bots()?.get(bot.botId) ?? null;
    } catch {
      profile = null;
    }
    if (!profile || !profile.enabled || profile.workspaceId !== bot.workspaceId) return refuse('not_bot', 'this bot is not running in the factory');
    const given = oneLine(input.reason, APPROVAL_LIMITS.REASON_MAX);
    const reason = withoutOwnerQuotes(given, this.ownerTexts(bot.workspaceId)) || `${ACTION_TITLE.skill} ${input.name} ${input.version}.`;
    const open = [...this.requests.values()].filter((r) => r.botId === bot.botId && r.state === 'pending').length;
    if (open >= APPROVAL_LIMITS.PENDING_PER_BOT) return refuse('too_many', `${open} requests already wait for the owner`);
    const skillLines = skillCardLines(input.update, input.diff, ROOM_LIMITS.CARD_BODY_MAX - askLine(profile, reason).length - 1);
    // Measured as the room stores it (stored secrets redacted), so the card
    // the owner reads is the whole change.
    const posted = skillLines ? redactStoredSecrets([askLine(profile, reason), ...skillLines].join('\n')) : '';
    if (!skillLines || posted.length > ROOM_LIMITS.CARD_BODY_MAX) return refuse('invalid', 'the change does not fit on the owner\'s card; propose a shorter skill or a smaller change');
    const at = this.now();
    const record: StoredApproval = {
      requestId: newRequestId(),
      action: 'skill',
      repoKey: normalizeRepoKey(profile.repo?.repoKey) ?? '',
      repoPath: '',
      skill: { name: input.name, hash: input.hash, version: input.version, update: input.update },
      botId: bot.botId,
      workspaceId: bot.workspaceId,
      threadId: this.conversationThread(bot.botId, wake),
      reason,
      tainted: wake.tainted,
      state: 'pending',
      clientRequestId: `skill:${input.name}:${input.hash}`,
      createdAt: at,
      updatedAt: at,
    };
    // A skill is approved on its card only, so the card is posted first and
    // the request is stored once, with it: nothing waits without a card.
    const card = this.postCard(record, profile, wake, skillLines);
    if (!card) return refuse('write_failed', 'the approval card could not be posted; propose the skill again');
    if (!this.put({ ...record, cardId: card.id })) {
      this.closeCard({ ...record, cardId: card.id });
      return refuse('write_failed', 'the request could not be stored; propose the skill again');
    }
    this.changed(record.workspaceId);
    return { ok: true, request: approvalView(this.get(record.requestId) ?? record) };
  }

  /** The bot was deleted: each of its requests still waiting expires and
   *  its card closes (a skill's proposal is shelved), and so does a merge
   *  approved but still inside its Undo window. Returns how many. */
  botRemoved(botId: string): number {
    let n = 0;
    for (const r of [...this.requests.values()]) {
      if (r.botId !== botId) continue;
      const armed = r.state === 'approved' && r.action === 'merge' && !r.effectId;
      if (r.state !== 'pending' && !armed) continue;
      if (this.expireForGoneBot(r)) n += 1;
    }
    return n;
  }

  /** A request whose bot no longer exists: it expires, unanswered. */
  private expireForGoneBot(r: StoredApproval): boolean {
    const next: StoredApproval = { ...r, state: 'expired', updatedAt: this.now() };
    if (!this.put(next)) return false;
    this.log(`[factory] approval ${r.requestId} expired: bot deleted`);
    this.clearTimer(r.requestId);
    this.closeCard(next);
    if (next.action === 'skill') this.skillDenied(next);
    this.changed(next.workspaceId);
    return true;
  }

  /** The bot that asked was deleted (a directory that is running says so). */
  private botGone(r: Pick<StoredApproval, 'botId'>): boolean {
    try {
      const dir = this.ports.bots();
      return !!dir && !dir.get(r.botId);
    } catch {
      return false;
    }
  }

  /** A pending request whose subject went away (a skill proposal replaced
   *  or archived): it expires, its card closes, nobody is told. */
  withdraw(requestId: string): boolean {
    const r = this.requests.get(requestId);
    if (!r || r.state !== 'pending') return false;
    const next: StoredApproval = { ...r, state: 'expired', updatedAt: this.now() };
    if (!this.put(next)) return false;
    this.closeCard(next);
    this.changed(next.workspaceId);
    return true;
  }

  /** What the owner wrote in the workspace's room lately (newest page). */
  private ownerTexts(workspaceId: string): string[] {
    try {
      const cards = this.ports.rooms()?.read(workspaceId, {}).cards ?? [];
      return cards.filter((c) => c.kind === 'human' && c.actor.kind === 'human').map((c) => (c.body?.trim() ? c.body : c.title));
    } catch {
      return [];
    }
  }

  /** The thread a request's card goes to: the bot's 1:1 when its turn runs
   *  there, else the thread of the owner's latest words to the bot (its
   *  latest owner-message wake), else the running wake's when that is the
   *  owner's, else `general`. */
  private conversationThread(botId: string, wake: ApprovalWake): ThreadId {
    // A turn in the bot's 1:1 (its task's facts wake there too) asks there:
    // the 1:1 is where that work was asked for.
    if (dmThreadBot(wake.threadId) === botId) return wake.threadId as ThreadId;
    let thread: ThreadId | null = null;
    try {
      thread = this.ports.conversationThread?.(botId) ?? null;
    } catch {
      thread = null;
    }
    return thread ?? (wake.ownerWords ? wake.threadId : null) ?? GENERAL_THREAD;
  }

  /** `wake:<wakeId>:a<n>`, n counting this turn's requests from 1: a
   *  retried turn (the next attempt) asks again under the same keys. */
  private nextOrdinal(botId: string, wake: ApprovalWake): string {
    const turn = `${wake.wakeId}#${wake.attempt}`;
    const n = (this.ordinals.get(turn)?.n ?? 0) + 1;
    this.ordinals.delete(turn);
    this.ordinals.set(turn, { n, botId, wakeId: wake.wakeId });
    // A turn still running keeps its count: the oldest turn that ended goes
    // first, and a running one only when every kept turn is running.
    while (this.ordinals.size > 200) {
      let drop: string | undefined;
      for (const [key, v] of this.ordinals) {
        if (key === turn) continue;
        let running = false;
        try {
          running = this.ports.runningWake(v.botId)?.wakeId === v.wakeId;
        } catch {
          running = false;
        }
        if (!running) {
          drop = key;
          break;
        }
      }
      drop ??= this.ordinals.keys().next().value;
      if (drop === undefined) break;
      this.ordinals.delete(drop);
    }
    return `wake:${wake.wakeId}:a${n}`;
  }

  /** `botApproval.list`: the caller's own requests, newest first. */
  listFor(bot: BotBinding, raw: Record<string, unknown>): { ok: true; requests: ApprovalView[] } | Refusal {
    const states = raw.state;
    if (states !== undefined && (!Array.isArray(states) || states.some((s) => !STATES.has(s as string)))) return refuse('invalid', 'state must be a list of approval states');
    const limit = raw.limit === undefined ? 20 : Number(raw.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > APPROVAL_LIMITS.LIST_MAX) return refuse('invalid', `limit must be 1..${APPROVAL_LIMITS.LIST_MAX}`);
    this.expire();
    const want = states as ApprovalState[] | undefined;
    const rows = [...this.requests.values()]
      .filter((r) => r.botId === bot.botId && (!want || want.includes(r.state)))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(approvalView);
    return { ok: true, requests: rows };
  }

  // ── owner side (main window, phone, typed words) ──

  /** Requests for the main window (one workspace, or all), newest first. */
  listForOperator(workspaceId?: string): ApprovalView[] {
    this.expire();
    return [...this.requests.values()]
      .filter((r) => !workspaceId || r.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, APPROVAL_LIMITS.REQUESTS_MAX)
      .map(approvalView);
  }

  rulesList(): ApprovalRule[] {
    return [...this.rules.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  revokeRule(ruleId: unknown): { ok: true } | Refusal {
    if (typeof ruleId !== 'string' || !this.rules.has(ruleId)) return refuse('not_found', 'no such rule');
    if (!this.commit(() => this.rules.delete(ruleId))) return refuse('write_failed', 'the rule could not be removed');
    this.changed();
    return { ok: true };
  }

  /** The owner's decision on one request (main window or phone only).
   *  `deviceId`: the paired device a phone decision came from (the
   *  operator token has none); it is logged with the decision. */
  decide(raw: unknown, by: 'desktop' | 'phone', deviceId?: string): { ok: true; request: ApprovalView; rule?: ApprovalRule } | Refusal {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<ApprovalDecideRequest>;
    const r = typeof p.requestId === 'string' ? this.requests.get(p.requestId) : undefined;
    if (!r) return refuse('not_found', 'no such request');
    this.expire();
    const cur = this.requests.get(r.requestId) as StoredApproval;
    // A request whose bot was deleted takes no decision (and stops waiting).
    if (this.botGone(cur)) {
      if (cur.state === 'pending') this.expireForGoneBot(cur);
      return refuse('not_bot', 'the bot that asked was deleted');
    }
    const via = by === 'phone' && deviceId ? `phone, device ${deviceId}` : by;
    switch (p.decision) {
      case 'approve':
        return this.approve(cur, 'owner', via);
      case 'always': {
        // Only merges are carried out by a rule (and never a release or a
        // push to a default branch).
        if (cur.action !== 'merge' || APPROVAL_NEVER_BY_RULE.has(cur.action)) return refuse('not_ruleable', 'this act always needs you');
        if (cur.state !== 'pending') return refuse('not_pending', `the request is ${cur.state}`);
        const scope = p.ruleScope === 'workspace' ? { workspaceId: cur.workspaceId } : { botId: cur.botId };
        const existing = [...this.rules.values()].find((x) => x.action === cur.action && x.repoKey === cur.repoKey && JSON.stringify(x.scope) === JSON.stringify(scope));
        const rule: ApprovalRule = existing ?? {
          ruleId: newRuleId(), action: cur.action as ApprovalRule['action'], repoKey: cur.repoKey, scope, createdAt: this.now(),
        };
        if (!existing && this.rules.size >= APPROVAL_LIMITS.RULES_MAX) return refuse('too_many', `at most ${APPROVAL_LIMITS.RULES_MAX} rules`);
        // The rule and the approval are one write: neither stands alone.
        const res = this.approve(cur, 'owner', via, undefined, existing ? undefined : rule);
        return res.ok ? { ...res, rule } : res;
      }
      case 'deny': {
        if (cur.state !== 'pending') return refuse('not_pending', `the request is ${cur.state}`);
        const next: StoredApproval = { ...cur, state: 'denied', decidedBy: 'owner', decidedAt: this.now(), updatedAt: this.now() };
        if (!this.put(next)) return refuse('write_failed', 'the decision could not be stored');
        this.log(`[factory] approval ${cur.requestId} denied by owner (${via})`);
        this.closeCard(next);
        if (next.action === 'skill') this.skillDenied(next);
        this.changed(next.workspaceId);
        this.tellDecided(next, `The owner denied: ${ACTION_TITLE[next.action]} ${subject(next)}.`, 'Do not ask for it again unless the owner says so.');
        return { ok: true, request: approvalView(next) };
      }
      case 'undo': {
        if (cur.state !== 'approved') return refuse('not_pending', `the request is ${cur.state}`);
        // An approved skill is loaded already; the profile's Archive unloads it.
        if (cur.action === 'skill') return refuse('too_late', 'the skill is loaded; archive it from the bot\'s profile');
        if (cur.effectId || (cur.executeAfter !== undefined && this.now() >= cur.executeAfter)) return refuse('too_late', 'the merge has started');
        const next: StoredApproval = { ...cur, state: 'pending', updatedAt: this.now() };
        delete next.decidedBy;
        delete next.decidedAt;
        delete next.executeAfter;
        delete next.ruleId;
        if (!this.put(next)) return refuse('write_failed', 'the decision could not be stored');
        this.log(`[factory] approval ${cur.requestId} undone by owner (${via})`);
        this.clearTimer(next.requestId);
        this.reopenCard(next);
        this.changed(next.workspaceId);
        return { ok: true, request: approvalView(next) };
      }
      default:
        return refuse('invalid', 'decision must be approve, deny, undo or always');
    }
  }

  private approve(cur: StoredApproval, approver: ApprovalApprover, by: string, ruleId?: string, newRule?: ApprovalRule): { ok: true; request: ApprovalView } | Refusal {
    if (cur.state !== 'pending') return refuse('not_pending', `the request is ${cur.state}`);
    if (this.botGone(cur)) {
      this.expireForGoneBot(cur);
      return refuse('not_bot', 'the bot that asked was deleted');
    }
    const skillHost = cur.action === 'skill' ? this.ports.skills?.() ?? null : null;
    if (cur.action === 'skill' && !skillHost) return refuse('not_started', 'skills are not running yet');
    const at = this.now();
    const next: StoredApproval = {
      ...cur,
      state: 'approved',
      decidedBy: approver,
      decidedAt: at,
      updatedAt: at,
      ...(ruleId ? { ruleId } : {}),
      ...(cur.action === 'merge' ? { executeAfter: at + APPROVAL_UNDO_MS } : {}),
    };
    const stored = this.commit(() => {
      this.requests.set(next.requestId, next);
      if (newRule) this.rules.set(newRule.ruleId, newRule);
    });
    if (!stored) return refuse('write_failed', 'the decision could not be stored');
    if (skillHost) {
      // The owner's answer is the act: once the decision is stored, the
      // proposal on the card becomes the approved skill. When it cannot (it
      // changed since, or a write failed) the decision is taken back and
      // the card is moot, so the two stores never disagree on a live skill.
      let why: string | null;
      try {
        why = skillHost.approve(next);
      } catch (err) {
        why = `the skill could not be approved: ${String(err)}`;
      }
      if (why) {
        const moot: StoredApproval = { ...cur, state: 'expired', updatedAt: this.now() };
        if (this.put(moot)) {
          this.closeCard(moot);
          // As a lapsed card does: the proposal it showed is shelved.
          this.skillDenied(moot);
        } else this.log(`[factory] approval ${cur.requestId} kept as approved though its skill did not load`);
        this.changed(cur.workspaceId);
        return refuse('stale', why);
      }
    }
    this.log(`[factory] approval ${cur.requestId} approved by ${approver} (${by})`);
    // Decided: the card stops waiting on the owner (its Undo reads the request).
    this.closeCard(next);
    if (next.action === 'merge') this.arm(next);
    this.changed(next.workspaceId);
    // A merge is told once it ran (merged, or refused); any other act now.
    if (next.action === 'skill') {
      this.tellDecided(next, `The owner approved your skill ${subject(next)}.`, 'It is listed in your wakes from now on; read it with skill_read.');
    } else if (next.action !== 'merge') {
      this.tellDecided(next, `The owner approved: ${ACTION_TITLE[next.action]} ${subject(next)}.`, 'wmux records it but does not carry this act out yet.');
    }
    return { ok: true, request: approvalView(next) };
  }

  /** A `human` card the owner wrote (via its human.message fact): typed
   *  approval of the thread's pending requests above it. `roomWide`: the
   *  words were to the whole room, which woke only its coordinator; they
   *  approve for every enabled bot of the room, as a room message always did. */
  onOwnerCard(card: RoomCard, roomWide = false): string[] {
    const writer = this.ports.rooms();
    if (!writer) return [];
    // Only a card the room store holds as the owner's counts.
    const stored = writer.get(card.workspaceId, card.id);
    if (!stored || stored.kind !== 'human' || stored.actor.kind !== 'human') return [];
    if (!typedApprovalSourceAllowed(stored)) return [];
    // Each message is read once, and only while it is fresh.
    const key = `${stored.workspaceId}/${stored.id}`;
    if (this.typedSeen.has(key) || this.now() - stored.at > APPROVAL_LIMITS.TYPED_FRESH_MS) return [];
    this.typedSeen.add(key);
    while (this.typedSeen.size > APPROVAL_LIMITS.TYPED_SEEN_MAX) {
      const first = this.typedSeen.values().next().value;
      if (first === undefined) break;
      this.typedSeen.delete(first);
    }
    this.expire();
    // A skill is approved on its card only, where its diff is shown.
    const pending = [...this.requests.values()].filter((r) => r.state === 'pending' && r.action !== 'skill');
    // The thread's latest cards: what sits between the requests and the words.
    const threadCards = writer.read(stored.workspaceId, { threadId: stored.threadId }).cards;
    let message: RoomCard = stored;
    if (roomWide) {
      let room: string[] = [];
      try {
        room = (this.ports.bots()?.listEnabled() ?? []).filter((b) => b.enabled && b.workspaceId === stored.workspaceId).map((b) => b.id);
      } catch {
        room = [];
      }
      message = { ...stored, refs: { ...(stored.refs ?? {}), botIds: room } };
    }
    const ids = typedApprovalTargets(message, pending, (id) => writer.get(stored.workspaceId, id), threadCards);
    const done: string[] = [];
    for (const id of ids) {
      const r = this.requests.get(id);
      if (r && this.approve(r, 'owner', 'typed').ok) done.push(id);
    }
    return done;
  }

  /** A fact from the log: an owner's message may approve; a merged PR is
   *  told to the bots that asked for it or talked about it. Never throws. */
  onFact(f: Fact): void {
    if (f.kind === 'merge.done' || f.kind === 'pr.merged') {
      try {
        this.onMerged(f);
      } catch (err) {
        this.log(`[factory] merged PR not told: ${String(err)}`);
      }
      return;
    }
    if (f.kind !== 'human.message') return;
    try {
      const cardId = typeof f.payload?.cardId === 'string' ? f.payload.cardId : null;
      const ws = f.workspaceId;
      const writer = this.ports.rooms();
      if (!cardId || !ws || !writer) return;
      const card = writer.get(ws, cardId);
      if (card) this.onOwnerCard(card, f.payload?.lead === true);
    } catch (err) {
      this.log(`[factory] typed approval not read: ${String(err)}`);
    }
  }

  // ── rules ──

  /** A rule covering a fresh request approves it when it may. */
  private async applyRule(requestId: string): Promise<void> {
    const r = this.requests.get(requestId);
    if (!r || r.state !== 'pending' || APPROVAL_NEVER_BY_RULE.has(r.action)) return;
    const rule = [...this.rules.values()].find((x) => ruleCovers(x, r));
    if (!rule) {
      await this.noRule(r);
      return;
    }
    let why: string | null;
    // A rule decides only a request whose card the owner can see.
    if (!r.cardId) why = 'its card could not be posted';
    else if (r.tainted) why = 'tainted-origin';
    else if (r.action !== 'merge') why = 'only merges are carried out by a rule';
    else {
      const host = this.ports.merge();
      why = host ? await host.ruleCheck(r).catch((err: unknown) => `check failed: ${String(err)}`) : 'the merge lane is not running';
    }
    const cur = this.requests.get(requestId);
    // Any change to the request while the check ran (an owner decision, an
    // undo) stands: the check's result applies only to the request it read.
    if (!cur || cur !== r || cur.state !== 'pending') return;
    // The owner may have revoked it while the check read GitHub.
    const still = this.rules.get(rule.ruleId);
    if (!why && (!still || !ruleCovers(still, cur))) why = 'the rule was revoked';
    if (why) {
      this.put({ ...cur, ruleSkipped: why.slice(0, 300), updatedAt: this.now() });
      this.changed(cur.workspaceId);
      return;
    }
    this.approve(cur, 'rule', 'rule', rule.ruleId);
  }

  /** A merge request no rule covers. A bot-scoped rule on the same act and
   *  repository for another bot is named on the card (a rule covers the
   *  bot that asks, not the bot that wrote the PR). With no rule at all, the
   *  card says what a rule made from it would still lack here: a Reviewer
   *  bot on the repository to verify heads, required checks on the repository, a trusted
   *  author (the lane's own reasons, read now). */
  private async noRule(r: StoredApproval): Promise<void> {
    if (r.action !== 'merge' || !r.cardId) return;
    const near = [...this.rules.values()].some((x) => x.action === r.action && x.repoKey === r.repoKey && 'botId' in x.scope && x.scope.botId !== r.botId);
    let patch: Partial<StoredApproval> | null = near ? { ruleSkipped: RULE_OTHER_ASKER } : null;
    if (!patch && !r.tainted) {
      const needs = new Set<ApprovalRuleNeed>();
      let bots: BotProfile[] = [];
      try {
        bots = this.ports.bots()?.listEnabled() ?? [];
      } catch {
        bots = [];
      }
      // A Reviewer records verdicts on its own repository only.
      if (!bots.some((b) => botTemplate(b) === 'reviewer' && normalizeRepoKey(b.repo?.repoKey) === r.repoKey)) needs.add('verifier');
      const host = this.ports.merge();
      const why = host ? await host.ruleCheck(r).catch(() => null) : null;
      for (const code of why ? laneRefusalCodes(why) : []) {
        if (code === 'required-checks-green:no-required-checks') needs.add('noChecks');
        else if (code.startsWith('author-trusted:')) needs.add('author');
      }
      if (needs.size > 0) patch = { ruleNeeds: (['verifier', 'noChecks', 'author'] as const).filter((n) => needs.has(n)) };
    }
    if (!patch) return;
    const cur = this.requests.get(r.requestId);
    if (!cur || cur !== r || cur.state !== 'pending') return;
    this.put({ ...cur, ...patch, updatedAt: this.now() });
    this.changed(cur.workspaceId);
  }

  // ── execution ──

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  private arm(r: StoredApproval): void {
    this.clearTimer(r.requestId);
    const wait = Math.max(0, (r.executeAfter ?? 0) - this.now());
    const t = setTimeout(() => {
      this.timers.delete(r.requestId);
      void this.execute(r.requestId);
    }, wait);
    t.unref?.();
    this.timers.set(r.requestId, t);
  }

  /** Startup: approved merges past their Undo window run, the rest re-arm;
   *  stale pending requests expire. */
  resume(): void {
    if (this.reloaded.size > 0) {
      this.save();
      for (const id of this.reloaded) {
        const r = this.requests.get(id);
        if (r) this.reopenCard(r);
      }
      this.reloaded.clear();
    }
    this.expire();
    // A bot deleted while a request of its was still open (its clean-up did
    // not land): those end now.
    for (const botId of new Set([...this.requests.values()].filter((r) => r.state === 'pending' || r.state === 'approved').map((r) => r.botId))) {
      if (this.botGone({ botId })) this.botRemoved(botId);
    }
    // A request whose merge already ended takes that outcome (a write that
    // failed before the quit included).
    const host = this.ports.merge();
    for (const r of [...this.requests.values()]) {
      if (!r.effectId || r.state === 'executed' || r.state === 'refused') continue;
      const effect = host?.effect?.(r.effectId) ?? null;
      if (effect && (effect.status === 'done' || effect.status === 'refused')) this.onEffect(effect);
    }
  }

  /** Startup: requests still pending for a PR whose merge fact the log
   *  kept (it merged while the app was down) are moot. Nobody is woken. */
  settleMergedSince(facts: readonly Fact[]): void {
    for (const f of facts) {
      if (f.kind !== 'merge.done' && f.kind !== 'pr.merged') continue;
      try {
        this.onMerged(f, { quiet: true });
      } catch (err) {
        this.log(`[factory] merged PR not settled: ${String(err)}`);
      }
    }
  }

  /** Quit: no merge starts from a timer after this (the next start runs
   *  what is due). */
  stop(): void {
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
  }

  /** Run an approved merge whose Undo window passed. */
  async execute(requestId: string): Promise<MergeEffect | null> {
    const r = this.requests.get(requestId);
    if (!r || r.state !== 'approved' || r.action !== 'merge' || !r.decidedBy) return null;
    if (r.executeAfter !== undefined && this.now() < r.executeAfter) {
      this.arm(r);
      return null;
    }
    const host = this.ports.merge();
    if (!host) {
      this.log(`[factory] approval ${requestId}: the merge executor is not running; it runs on the next start`);
      return null;
    }
    let effect: MergeEffect;
    try {
      effect = await host.enqueue(r, r.decidedBy);
    } catch (err) {
      this.log(`[factory] approval ${requestId} not enqueued: ${String(err)}`);
      return null;
    }
    const cur = this.requests.get(requestId);
    if (cur && !cur.effectId) this.put({ ...cur, effectId: effect.id, updatedAt: this.now() });
    if (effect.status !== 'pending') {
      this.onEffect(effect);
      return effect;
    }
    return host.run(effect.id);
  }

  /** The executor's run-time gate for an effect behind a request. */
  authorizeEffect(e: MergeEffect): string | null {
    const r = typeof e.decisionId === 'string' ? this.requests.get(e.decisionId) : undefined;
    if (!r) return 'approval-missing';
    if (r.state !== 'approved' || r.action !== 'merge') return 'approval-not-approved';
    if (this.botGone(r)) return 'bot-removed';
    if (r.decidedBy !== e.approvedBy) return 'approval-mismatch';
    if (r.headSha !== e.expectHead || r.prNumber !== e.prNumber || normalizeRepoKey(e.repoKey) !== r.repoKey) return 'approval-mismatch';
    if (r.executeAfter !== undefined && this.now() < r.executeAfter) return 'approval-undo-window';
    if (e.approvedBy === 'rule') {
      if (r.tainted) return 'tainted-origin';
      const rule = r.ruleId ? this.rules.get(r.ruleId) : undefined;
      if (!rule || !ruleCovers(rule, r)) return 'rule-revoked';
    }
    return null;
  }

  /** The executor's last gate: the gh login is the one the request read. */
  async identityEffect(e: MergeEffect): Promise<string | null> {
    const r = typeof e.decisionId === 'string' ? this.requests.get(e.decisionId) : undefined;
    if (!r?.ghLogin) return 'identity-unknown';
    const now = await this.ports.ghLogin({ key: r.repoKey, path: r.repoPath }).catch(() => null);
    if (!now) return 'identity-unknown';
    return now.toLowerCase() === r.ghLogin ? null : 'identity-changed';
  }

  /** An executor outcome for an effect behind a request. */
  onEffect(e: MergeEffect): void {
    if (typeof e.decisionId !== 'string' || !APPROVAL_ID_RE.test(e.decisionId)) return;
    if (e.status !== 'done' && e.status !== 'refused') return;
    const r = this.requests.get(e.decisionId);
    if (!r || r.state === 'executed' || r.state === 'refused') return;
    const next: StoredApproval = {
      ...r,
      state: e.status === 'done' ? 'executed' : 'refused',
      ...(e.status === 'refused' ? { refusal: (e.reason ?? 'refused').slice(0, 300) } : {}),
      effectId: e.id,
      updatedAt: this.now(),
    };
    this.put(next);
    const draft = factFromMergeEffect(e);
    if (draft) {
      try {
        this.ports.appendFact?.(draft);
      } catch (err) {
        this.log(`[factory] ${draft.kind} fact not written: ${String(err)}`);
      }
    }
    this.outcomeCard(next);
    this.closeCard(next);
    this.changed(next.workspaceId);
    // A merge that ran is told with the merged PR (onMerged, on its fact).
    if (next.state === 'refused') {
      this.tellDecided(next, `Not merged: ${subject(next)} (${laneRefusalLine(next.refusal ?? '') || 'refused'}).`, next.refusal === 'head-moved' ? 'Its head moved since the request: ask again for the new head.' : undefined);
    }
  }

  // ── telling the bots ──

  /** The bots that spoke in a thread after one card (or in its latest
   *  cards), at most NOTIFY_MAX. */
  private speakersAfter(workspaceId: string, threadId: ThreadId, afterSeq: number | null): string[] {
    const writer = this.ports.rooms();
    if (!writer) return [];
    try {
      const cards = afterSeq === null
        ? writer.read(workspaceId, { threadId }).cards
        : writer.read(workspaceId, { threadId, sinceSeq: afterSeq }).cards;
      return [...new Set(cards.map((c) => (c.actor.kind === 'bot' ? c.actor.botId : '')).filter(Boolean))].slice(0, APPROVAL_LIMITS.NOTIFY_MAX);
    } catch {
      return [];
    }
  }

  private notice(n: BotNoticeInput): void {
    try {
      this.ports.notice?.(n);
    } catch (err) {
      this.log(`[factory] approval notice not sent: ${String(err)}`);
    }
  }

  /** A request was decided: its bot, and the bots that spoke in its thread
   *  since its card, are told once. */
  private tellDecided(r: StoredApproval, title: string, body?: string): void {
    const cardSeq = r.cardId ? this.ports.rooms()?.get(r.workspaceId, r.cardId)?.seq ?? null : null;
    const bots = new Set([r.botId, ...this.speakersAfter(r.workspaceId, r.threadId, cardSeq)]);
    for (const botId of [...bots].slice(0, APPROVAL_LIMITS.NOTIFY_MAX)) {
      this.notice({
        botId, workspaceId: r.workspaceId, key: `approval:${r.requestId}:${r.state}`, topic: 'approval.decided',
        title, ...(body ? { body } : {}), threadId: r.threadId, repoKey: r.repoKey,
        ...(r.prNumber !== undefined ? { pr: r.prNumber } : {}),
      });
    }
  }

  /** A PR merged (by wmux, the lane or on GitHub): the bots that asked to
   *  merge it, spoke after those requests, or spoke in its thread are told
   *  once (one key per PR, whichever fact comes first). Requests still
   *  pending for it are moot and expire. */
  private onMerged(f: Fact, opts: { quiet?: boolean } = {}): void {
    const repoKey = normalizeRepoKey(f.repoKey);
    const pr = f.ref?.pr;
    if (!repoKey || typeof pr !== 'number') return;
    const how = f.kind === 'pr.merged'
      ? 'on GitHub'
      : f.payload?.approvedBy === 'lane' ? 'by the merge lane' : f.payload?.approvedBy === 'rule' ? 'by a rule the owner set' : 'with the owner\'s approval';
    const told = new Map<string, { workspaceId: string; threadId: ThreadId }>();
    const add = (botId: string, workspaceId: string, threadId: ThreadId): void => {
      if (!told.has(botId) && told.size < APPROVAL_LIMITS.NOTIFY_MAX) told.set(botId, { workspaceId, threadId });
    };
    const mine = [...this.requests.values()].filter((r) => r.action === 'merge' && r.repoKey === repoKey && r.prNumber === pr);
    for (const r of mine) {
      add(r.botId, r.workspaceId, r.threadId);
      const seq = r.cardId ? this.ports.rooms()?.get(r.workspaceId, r.cardId)?.seq ?? null : null;
      for (const b of this.speakersAfter(r.workspaceId, r.threadId, seq)) add(b, r.workspaceId, r.threadId);
    }
    let watching: BotProfile[] = [];
    try {
      watching = (this.ports.bots()?.listEnabled() ?? []).filter((b) => normalizeRepoKey(b.repo?.repoKey) === repoKey);
    } catch {
      watching = [];
    }
    const thread = prThreadId(repoKey, pr);
    for (const ws of new Set(watching.map((b) => b.workspaceId))) {
      for (const b of this.speakersAfter(ws, thread, null)) add(b, ws, thread);
    }
    // Pending requests for a PR that merged without them are moot.
    const moot = mine.filter((r) => r.state === 'pending');
    if (moot.length > 0 && this.commit(() => { for (const r of moot) this.requests.set(r.requestId, { ...r, state: 'expired', updatedAt: this.now() }); })) {
      for (const r of moot) this.closeCard(r);
      this.changed(moot[0].workspaceId);
    }
    if (opts.quiet) return;
    for (const [botId, at] of told) {
      this.notice({
        botId, workspaceId: at.workspaceId, key: `pr.merged:${repoKey}#${pr}`, topic: 'pr.merged',
        title: `PR #${pr} merged ${how}.`,
        body: 'It is done: do not ask the owner to approve or merge it again.',
        threadId: at.threadId, repoKey, pr,
      });
    }
  }

  /** Pending requests past their time expire. */
  private expire(): void {
    const at = this.now();
    const stale = [...this.requests.values()].filter((r) => r.state === 'pending' && at - r.createdAt >= APPROVAL_LIMITS.PENDING_TTL_MS);
    const old = [...this.requests.values()].filter((r) => r.state !== 'pending' && r.state !== 'approved' && at - r.updatedAt >= APPROVAL_LIMITS.RETAIN_MS);
    if (stale.length === 0 && old.length === 0 && this.requests.size <= APPROVAL_LIMITS.REQUESTS_MAX) return;
    const ok = this.commit(() => {
      for (const r of stale) this.requests.set(r.requestId, { ...r, state: 'expired', updatedAt: at });
      for (const r of old) this.requests.delete(r.requestId);
      const settled = [...this.requests.values()].filter((r) => r.state !== 'pending' && r.state !== 'approved').sort((a, b) => a.updatedAt - b.updatedAt);
      while (this.requests.size > APPROVAL_LIMITS.REQUESTS_MAX && settled.length > 0) this.requests.delete((settled.shift() as StoredApproval).requestId);
    });
    if (ok) {
      for (const r of stale) {
        this.closeCard(r);
        if (r.action === 'skill') this.skillDenied(r);
      }
    }
  }

  /** A skill proposal the owner denied or left unanswered is archived. */
  private skillDenied(r: StoredApproval): void {
    try {
      this.ports.skills?.()?.deny(r);
    } catch (err) {
      this.log(`[factory] skill proposal ${r.requestId} not archived: ${String(err)}`);
    }
  }

  // ── cards ──

  private postCard(r: StoredApproval, profile: BotProfile, wake: ApprovalWake, skillLines?: readonly string[]): RoomCard | null {
    const writer = this.ports.rooms();
    if (!writer) return null;
    const replyTo = wakeReplyTo(writer, wake, r.workspaceId, r.threadId);
    const what = r.skill
      ? `${r.skill.update ? 'Update the skill' : 'Add the skill'} ${subject(r)}?`
      : `${ACTION_TITLE[r.action]} ${subject(r)}${r.headSha ? ` at ${r.headSha.slice(0, 7)}` : ''}?`;
    const subjectThread = r.prNumber !== undefined ? prThreadId(r.repoKey, r.prNumber) : r.issueNumber !== undefined ? issueThreadId(r.repoKey, r.issueNumber) : null;
    const lines = [
      askLine(profile, r.reason),
      // "Started from outside text" is the card's own line, from the
      // request's `tainted` (ApprovalAnswers, the phone): not in the body.
      ...(r.action === 'merge' || r.action === 'skill' ? [] : ['wmux records your answer; it does not carry this act out yet.']),
    ];
    if (skillLines) lines.push(...skillLines);
    const res = writer.post({
      workspaceId: r.workspaceId,
      threadId: r.threadId,
      kind: 'approval',
      actor: { kind: 'bot', workspaceId: r.workspaceId, botId: r.botId },
      title: what,
      body: lines.join('\n'),
      refs: {
        approvalId: r.requestId,
        ...(r.prNumber !== undefined ? { pr: r.prNumber } : {}),
        ...(r.issueNumber !== undefined ? { issue: r.issueNumber } : {}),
        ...(r.headSha ? { headSha: r.headSha } : {}),
        ...(subjectThread && subjectThread !== r.threadId ? { threadId: subjectThread } : {}),
      },
      state: 'open',
      ...(replyTo ? { replyTo } : {}),
      clientPostId: `approval:${r.requestId}`,
    });
    return res.ok ? res.card : null;
  }

  private closeCard(r: StoredApproval): void {
    const writer = this.ports.rooms();
    if (!writer || !r.cardId) return;
    try {
      if (writer.get(r.workspaceId, r.cardId)?.state === 'open') writer.setState(r.workspaceId, r.cardId, 'resolved');
    } catch {
      /* the request is the record; the card only shows it */
    }
  }

  private reopenCard(r: StoredApproval): void {
    const writer = this.ports.rooms();
    if (!writer || !r.cardId) return;
    try {
      if (writer.get(r.workspaceId, r.cardId)?.state === 'resolved') writer.setState(r.workspaceId, r.cardId, 'open');
    } catch {
      /* the request is the record; the card only shows it */
    }
  }

  private outcomeCard(r: StoredApproval): void {
    const writer = this.ports.rooms();
    if (!writer) return;
    const by = r.decidedBy === 'rule' ? 'a rule you set' : 'you';
    const done = r.state === 'executed';
    const moved = r.refusal === 'head-moved';
    writer.post({
      workspaceId: r.workspaceId,
      threadId: r.threadId,
      kind: done ? 'status' : 'refusal',
      actor: { kind: 'system' },
      title: done
        ? `Merged ${subject(r)} (approved by ${by})`
        : moved ? `Not merged: ${subject(r)} has a new head since the request; it needs a new approval` : `Not merged: ${subject(r)} (${laneRefusalLine(r.refusal ?? '') || 'refused'})`,
      refs: { approvalId: r.requestId, ...(r.prNumber !== undefined ? { pr: r.prNumber } : {}) },
      clientPostId: `approval-outcome:${r.requestId}`,
    });
  }
}

// ── Singleton and RPC (the module: approvalsModule.ts) ─────────────────────

let current: ApprovalService | null = null;

export function setApprovalService(s: ApprovalService | null): void {
  current = s;
}

export function getApprovalService(): ApprovalService | null {
  return current;
}

function params(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** The bot RPCs: a bot only asks and reads its own requests. */
/** `startFailure`: why the store did not start (approvals stay off until it
 *  is fixed; the detail stays in main's log), or null while it may still
 *  start. */
export function registerApprovalRpc(router: Pick<FactoryRouter, 'register'>, service: () => ApprovalService | null, startFailure: () => string | null = () => null): void {
  const notStarted = (): Refusal => {
    return refuse('not_started', startFailure() ? `approvals are off until the owner fixes factory/${APPROVALS_FILENAME} (see the wmux log)` : 'approvals are not running yet');
  };
  router.register(BOT_APPROVAL_RPC.request, async (raw: unknown, ctx: RpcContext | undefined) => {
    if (!ctx?.bot) return refuse('not_bot', 'approval_request is a bot\'s');
    const s = service();
    if (!s) return notStarted();
    return s.request(ctx.bot, params(raw));
  });
  router.register(BOT_APPROVAL_RPC.list, async (raw: unknown, ctx: RpcContext | undefined) => {
    if (!ctx?.bot) return refuse('not_bot', 'approval_list is a bot\'s');
    const s = service();
    if (!s) return notStarted();
    return s.listFor(ctx.bot, params(raw));
  });
}
