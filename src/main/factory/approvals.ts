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
// A comment, a new issue, closing an issue or a PR, or a release
// (ACT_ACTIONS) is carried out the same way once approved: the request pins
// what it acts on and the text it publishes (`act`), the card shows that text
// whole (fenced, actPayload.ts), an approval from a button (the card's, the
// chip's or the phone's) echoes the card's payloadHash (a text act and a
// release are approved from their card only, never by typed words or the
// chip), and after the Undo window the act outbox runs it (actHost.ts,
// actExecutor.ts, releaseAct.ts) under the same gates as a merge; the outcome
// comes back here (onActEffect). A request an older build stored (no `act`),
// and every other act, is recorded and decided only (the card says so). A
// bot's workers are refused all of them (shared/botWorkerGuard.ts).
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
import type { MemoryChange } from '../../shared/botMemory';
import {
  ACT_ACTIONS,
  APPROVAL_ACTIONS,
  APPROVAL_ID_RE,
  APPROVAL_NEVER_BY_RULE,
  APPROVAL_UNDO_MS,
  BOT_APPROVAL_RPC,
  BOT_REQUESTABLE_ACTIONS,
  CARD_ONLY_ACTIONS,
  RULE_OTHER_ASKER,
  TEXT_ACT_ACTIONS,
  TYPED_APPROVABLE_ACTIONS,
  firstRuleSkip,
  isOwnerApprovalText,
  type ActAction,
  type ApprovalAct,
  type ApprovalActRepo,
  type ApprovalAction,
  type ApprovalReleaseAct,
  type ApprovalApprover,
  type ApprovalDecideRequest,
  type ApprovalRequest,
  type ApprovalRoutine,
  type ApprovalRule,
  type ApprovalRuleNeed,
  type ApprovalState,
} from '../../shared/botApproval';
import type { FactoryRefusal } from '../../shared/botSurface';
import type { Fact, FactDraft } from '../../shared/facts';
import type { MergeEffect } from '../../shared/moaDecision';
import type { PrLaneFacts } from '../../shared/prReview';
import type { RpcContext } from '../../shared/rpc';
import { GENERAL_THREAD, ROOM_LIMITS, dmThreadBot, dmThreadId, issueThreadId, parseThreadId, prThreadId, type RoomCard, type ThreadId } from '../../shared/room';
import { secretValueKind } from '../../shared/secretGuard';
import type { FactoryRouter } from './factoryHost';
import { factFromMergeEffect } from './factIngest';
import { fenceFor } from '../../shared/markdownFence';
import { redactStoredSecrets } from './secretRedaction';
import { normalizeRepoKey } from './repoWatch';
import { isGitlabRepoKey } from '../github/hostLane';
import { botRepo } from '../../shared/repoKey';
import { laneRefusalCodes, laneRefusalLine } from './laneRefusalText';
import { wakeReplyTo, type RoomWriter } from './roomWriter';
import type { BotNoticeInput } from './botNotices';
import type { BotDirectoryApi } from './triggerEngine';
import { GUEST_TURN_STARTS_NO_WORKERS, guestOfRecord } from './wakeTaint';
import { guestSide } from './guestWorkspaces';
import { CONTEXT_FENCE_INFO, PAYLOAD_FENCE_INFO, UNSHOWABLE, actContentKey, actTextProblem, bodyWithMarker, fencedLines, normalizeActText, payloadHashOf } from './actPayload';
import { nextSlot, scheduleLabel } from './routines';
import type { OwnerCardProof } from './ownerAsked';
import { actEffectId, actRowClaimed, draftUndecided, type ActEffect, type ActEffectStatus } from './actEffectStore';
import type { IssueFacts, PullFacts } from './actExecutor';
import { releaseTagProblem, type AlsoRunsOn, type ReleaseAsk, type ReleaseAskInput, type ReleaseAskRefusal } from './releaseAct';

export const APPROVALS_FILENAME = 'approvals.json';

export const APPROVAL_LIMITS = {
  /** A pending request older than this expires. */
  PENDING_TTL_MS: 24 * 3600_000,
  /** An approved act no try of which was started this long after its
   *  decision is refused (`approval-stale`). */
  APPROVED_TTL_MS: 24 * 3600_000,
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
  /** Its wake was not known clean of a guest's words; the bots told of its
   *  decision are told in a guest-sourced notice. Absent (a request stored
   *  before it was recorded): as its taint says. */
  guest?: boolean;
  /** An act: its bot text and target without the marker (one request per
   *  content while it waits; a reused clientRequestId must carry the same). */
  contentKey?: string;
  /** A refused release whose bot was told to wait while its draft was
   *  undecided: told again once it is decided. */
  draftWait?: true;
}

/** A request as the main window and the bot see it (no checkout path). An
 *  act carries where its outbox row stands (`actStatus`), so its card can
 *  say it is running or being checked. */
export type ApprovalView = Omit<StoredApproval, 'repoPath' | 'clientRequestId' | 'contentKey'> & { actStatus?: ActEffectStatus };

export function approvalView(r: StoredApproval): ApprovalView {
  const view: Partial<StoredApproval> = { ...r };
  delete view.repoPath;
  delete view.clientRequestId;
  delete view.guest;
  delete view.contentKey;
  delete view.draftWait;
  // What the owner reads: sentences, never the raw codes.
  delete view.refusalText;
  delete view.ruleSkippedText;
  delete view.ruleSkippedCondition;
  const refusalText = r.refusal ? laneRefusalLine(r.refusal, r.repoKey) : '';
  // A skip names its first unmet condition only (firstRuleSkip).
  const skip = r.ruleSkipped ? firstRuleSkip(laneRefusalCodes(r.ruleSkipped)) : null;
  const ruleSkippedText = skip ? laneRefusalLine(skip.code, r.repoKey) : '';
  return {
    ...(view as ApprovalView),
    ...(refusalText ? { refusalText } : {}),
    ...(ruleSkippedText ? { ruleSkippedText } : {}),
    ...(skip?.condition ? { ruleSkippedCondition: skip.condition } : {}),
  };
}

/** What a bot reads back of a request: a request not known clean of a
 *  guest's words keeps its state but not its words, unless the reading
 *  wake is itself guest-sourced. */
export const GUEST_REASON_HIDDEN = '(asked in a turn that came from an external guest; not shown here)';

export function botApprovalView(r: StoredApproval, readerGuest: boolean): ApprovalView {
  const view = approvalView(r);
  if (readerGuest || guestOfRecord(r.guest, r.tainted) === false) return view;
  const hidden: ApprovalView = { ...view, reason: GUEST_REASON_HIDDEN };
  delete hidden.skill;
  delete hidden.ownerProfile;
  delete hidden.routine;
  delete hidden.botMemory;
  delete hidden.act;
  return hidden;
}

/** The running wake of a bot, as main knows it. */
export interface ApprovalWake {
  wakeId: string;
  /** The wake's attempt (a retried turn asks again from its first ordinal). */
  attempt: number;
  threadId: ThreadId | null;
  tainted: boolean;
  /** The wake's guest provenance (wakeTaint.ts). Not known clean: the
   *  request counts as tainted (no remembered rule approves it) and its card
   *  is guest-sourced. Absent: unknown. */
  guest?: boolean | 'unknown';
  /** The wake carries the owner's own message. */
  ownerWords?: boolean;
  /** The owner card that started the wake (RunningWake.ownerCardId): the
   *  request's card answers it when it lands in that card's thread. */
  ownerCardId?: string;
  /** The bot's conversation holds data from a signed-in task
   *  (conversationMarks.ts): the request's card, which carries the bot's
   *  reason, goes to the bot's own 1:1. Absent: not known otherwise, so
   *  yes. */
  signedIn?: boolean;
}

/** Whether a wake's conversation is not known to hold no signed-in task's
 *  data. */
function signedInWake(wake: Pick<ApprovalWake, 'signedIn'>): boolean {
  return wake.signedIn !== false;
}

/** Whether a wake is not known to be clean of a guest's words. */
function guestSourcedWake(wake: Pick<ApprovalWake, 'guest'>): boolean {
  return wake.guest !== false;
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

/** What the approvals reach of the act outbox (actHost.ts): GitHub reads for
 *  a request's pins (gh, from a folder main owns), and the outbox. */
export interface ApprovalActHost {
  login(repoKey: string): Promise<string | null>;
  /** The repository's pins, and the default branch it names now (not pinned). */
  repo(repoKey: string): Promise<(ApprovalActRepo & { defaultBranch?: string }) | { error: string; status?: number }>;
  issue(repoKey: string, n: number): Promise<IssueFacts | { error: string; status?: number }>;
  pull(repoKey: string, n: number): Promise<PullFacts | { error: string; status?: number }>;
  /** What a release request pins and its card states (releaseAct.ts), or
   *  why the repository cannot take it as asked. */
  release(repoKey: string, input: ReleaseAskInput): Promise<ReleaseAsk | ReleaseAskRefusal>;
  /** The outbox row of an approved request (one per request), or null when
   *  it could not be stored. */
  enqueue(r: StoredApproval): ActEffect | null;
  run(effectId: string): Promise<ActEffect | null>;
  effect(effectId: string): ActEffect | null;
  /** Drop the row of a request that ended (expired, dropped). */
  remove(effectId: string): void;
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
  /** The memory store, for `owner_profile` and `bot_memory` requests:
   *  `approve` applies the change on the card, checked again, and returns
   *  why it cannot, or null once it is written. */
  ownerProfile?: () => ApprovalOwnerProfileHost | null;
  /** The routine store, for `routine` requests: `approve` saves the routine
   *  on the card, checked again as of now, and returns why it cannot, or
   *  null once it is saved. */
  routines?: () => ApprovalRoutineHost | null;
  /** The act outbox, for ACT_ACTIONS requests. Absent: none is asked for. */
  acts?: () => ApprovalActHost | null;
  now?: () => number;
  log?: (line: string) => void;
}

/** What a `skill` request's decision does to the bot's skill. */
export interface ApprovalSkillHost {
  approve(r: StoredApproval): string | null;
  /** Denied, or expired unanswered: the proposal is archived. */
  deny(r: StoredApproval): void;
}

/** What an `owner_profile` request's Approve does to the owner's profile,
 *  and a `bot_memory` request's to the bot's notes. */
export interface ApprovalOwnerProfileHost {
  approve(r: StoredApproval): string | null;
}

/** What a `routine` request's Approve does: saves its routine. */
export interface ApprovalRoutineHost {
  approve(r: StoredApproval): string | null;
}

/** What the owner asked a bot for in a conversation that took in outside
 *  text (proposeOwnerAsked). */
export type OwnerAsk =
  | { action: 'routine'; routine: ApprovalRoutine }
  | { action: 'bot_memory' | 'owner_profile'; change: MemoryChange };

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

type Refusal = FactoryRefusal<'not_bot' | 'not_running' | 'not_now' | 'invalid' | 'no_repo' | 'read_failed' | 'not_open' | 'too_many' | 'not_found' | 'not_pending' | 'too_late' | 'not_ruleable' | 'write_failed' | 'not_started' | 'stale' | 'client_update_required' | 'changed' | 'not_here'>;

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

/** The longest command a `native_tool` card shows. */
const NATIVE_TOOL_COMMAND_MAX = 1_500;

const ACTION_TITLE: Readonly<Record<ApprovalAction, string>> = {
  merge: 'Merge',
  push_default: 'Push to the default branch of',
  issue_create: 'Open an issue on',
  issue_close: 'Close',
  comment: 'Comment on',
  release: 'Publish a release of',
  pr_close: 'Close',
  skill: 'Load the skill',
  owner_profile: 'Change',
  native_tool: 'Run',
  routine: 'Set up the routine',
  bot_memory: 'Change',
};

/** What a done act's outcome card says it did. */
const ACT_DONE_TITLE: Readonly<Record<ActAction, string>> = {
  comment: 'Commented on',
  issue_create: 'Opened',
  issue_close: 'Closed',
  pr_close: 'Closed without merging',
  release: 'Published',
};

/** A PR as its host names it: a GitLab merge request is `MR !n`. */
function prName(repoKey: string, n: number): string {
  return isGitlabRepoKey(repoKey) ? `MR !${n}` : `PR #${n}`;
}

function subject(r: Pick<ApprovalRequest, 'action' | 'repoKey' | 'prNumber' | 'issueNumber' | 'skill' | 'act' | 'routine'>): string {
  if (r.skill) return `${r.skill.name} ${r.skill.version}`;
  if (r.act?.kind === 'release') return `${r.repoKey} (${r.act.tagName})`;
  if (r.action === 'owner_profile') return 'your profile';
  if (r.action === 'bot_memory') return 'your notes';
  if (r.routine) return `"${r.routine.title}"`;
  if (r.prNumber !== undefined) return prName(r.repoKey, r.prNumber);
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

const OWNER_PROFILE_TITLE: Readonly<Record<MemoryChange['action'], string>> = {
  add: 'Add this to your profile?',
  replace: 'Change this in your profile?',
  remove: 'Remove this from your profile?',
};

const BOT_MEMORY_TITLE: Readonly<Record<MemoryChange['action'], string>> = {
  add: 'Add this to the bot\'s notes?',
  replace: 'Change this in the bot\'s notes?',
  remove: 'Remove this from the bot\'s notes?',
};

function textBlock(text: string): string[] {
  const fence = fenceFor(text);
  return [`${fence}text`, text, fence];
}

/** An owner-profile card's lines after the bot's: what Approve does, then
 *  the exact entry (replace: as it reads, then as it would), each in a
 *  fence no backtick run in it can close. `shared` says who reads it (the
 *  bot's own notes: that bot). Pure. */
export function ownerProfileCardLines(change: MemoryChange, shared = 'Every bot of yours reads your profile when its session starts.'): string[] {
  const block = textBlock;
  if (change.action === 'add') {
    return ['', `Approve to add this entry; Deny drops it. ${shared}`, '', ...block(change.text ?? '')];
  }
  if (change.action === 'remove') {
    return ['', `Approve to remove this entry; Deny keeps it. ${shared}`, '', ...block(change.old ?? '')];
  }
  return ['', `Approve to replace this entry; Deny keeps it as it is. ${shared}`, '', 'Now:', ...block(change.old ?? ''), '', 'Becomes:', ...block(change.text ?? '')];
}

/** The lines an owner-asked card starts with (proposeOwnerAsked): why it is
 *  asked, and the owner's own message it was asked on. Pure. */
export function ownerAskedLines(excerpt: string): string[] {
  return [
    '',
    'This conversation has read outside text (a pull request, an issue, CI, or work that read them), so nothing it asks for that stays is saved without you. Check that this is what you asked for. Your message:',
    ...textBlock(excerpt),
  ];
}

function hhmm(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A routine card's lines after the owner-asked ones: what Approve does,
 *  then every field that changes what runs and when (the schedule in words
 *  with the time zone and its next run, quiet hours, the thread), then the
 *  title and the whole prompt, each fenced. Pure. */
export function routineCardLines(r: ApprovalRoutine, o: { botId: string; botName: string; now: number; timeZone: string }): string[] {
  const s = r.schedule;
  const next = s.kind === 'interval' ? `first run ${scheduleLabel(s).replace(/^every /, '')} after you approve` : `next run ${hhmm(nextSlot(s, o.now))}`;
  const thread = !r.threadId || r.threadId === GENERAL_THREAD ? 'General' : r.threadId === dmThreadId(o.botId) ? `your 1:1 with ${o.botName}` : r.threadId;
  return [
    '',
    `Approve to save this routine; Deny drops it. Each run wakes ${o.botName} afresh, with the prompt below as its instructions.`,
    '',
    `Schedule: ${scheduleLabel(s)} (${o.timeZone} time); ${next}`,
    `Quiet hours: ${r.quietHours ? `${r.quietHours.start}–${r.quietHours.end} (runs inside it are skipped)` : 'none'}`,
    `Runs in: ${thread}`,
    '',
    'Title:',
    ...textBlock(r.title),
    '',
    'Prompt:',
    ...textBlock(r.prompt),
  ];
}

/** Why a text an owner-asked card would show is not shown as it is saved,
 *  or null: what the card shows is what is saved, nothing hidden or cut. */
export function ownerAskedTextProblem(text: string): string | null {
  if (UNSHOWABLE.test(text)) return 'it holds control, bidi or zero-width characters, which the card would not show as they are saved';
  if (redactStoredSecrets(text) !== text) return 'it holds a stored secret, which the card would hide';
  const key = text.split('\n').map(secretValueKind).find((k) => k !== null);
  if (key) return `it holds a key (${key}); a secret goes through secret_request`;
  return null;
}

/** The longest text an act publishes (the card's room is the real cap). */
export const ACT_TEXT_MAX = 6000;
export const ACT_TITLE_MAX = 256;

/** An act card's lines after the bot's: what Approve does, then the target's
 *  GitHub title as context (fence `text`), then each payload field in its
 *  own `wmux-payload` fence, in order (actPayload.ts). Pure. */
export function actCardLines(act: Exclude<ApprovalAct, ApprovalReleaseAct>, fields: readonly string[], o: { login: string; repoKey: string; signedIn: boolean }): string[] {
  const secs = Math.round(APPROVAL_UNDO_MS / 1000);
  const when = `${secs} s after you approve (Undo until then)`;
  const target = act.kind === 'issue_create' ? '' : act.kind === 'pr_close' || (act.kind === 'comment' && act.target === 'pr') ? prName(o.repoKey, act.number) : `issue #${act.number}`;
  const what = act.kind === 'comment'
    ? `Approve to post this comment on ${target} as @${o.login}, ${when}. It is public and stays under your name. Its last line is wmux's marker; GitHub does not show it.`
    : act.kind === 'issue_create'
      ? `Approve to open this issue on ${o.repoKey} as @${o.login}, ${when}: the first block is its title, the second its body. The body's last line is wmux's marker; GitHub does not show it.`
      : act.kind === 'issue_close'
        ? `Approve to close ${target} as ${act.stateReason === 'not_planned' ? 'not planned' : 'completed'} as @${o.login}, ${when}.`
        : `Approve to close ${target} without merging as @${o.login}, ${when}. It can be reopened; its branch stays.`;
  const lines = ['', what];
  if (o.signedIn) lines.push('This bot\'s conversation holds data from a task you signed in to: check that the text shares none of it.');
  if (act.kind !== 'issue_create') lines.push('', `${target} on GitHub:`, ...fencedLines(act.title, CONTEXT_FENCE_INFO));
  for (const f of fields) lines.push('', ...fencedLines(f, PAYLOAD_FENCE_INFO));
  return lines;
}

/** A release's payload fields, in card order: the tag, the commit, then
 *  what the owner approves of the release itself (its title, notes and
 *  `release` or `prerelease`), or the workflows a pushed tag starts. Pure. */
export function releaseFields(act: ApprovalReleaseAct): string[] {
  return act.mode === 'workflow'
    ? [act.tagName, act.targetSha, act.workflows.join('\n')]
    : [act.tagName, act.targetSha, act.title, act.notes, act.prerelease ? 'prerelease' : 'release'];
}

/** A release card's title: the tag, the repository, the commit, and that it
 *  cannot be undone. Pure. */
export function releaseCardTitle(act: ApprovalReleaseAct, fullName: string): string {
  const at = act.targetSha.slice(0, 7);
  return act.mode === 'workflow'
    ? `Push tag ${act.tagName} to ${fullName} at ${at} — starts its release workflow, cannot be undone`
    : `Publish release ${act.tagName} of ${fullName} at ${at} — publishes a release, cannot be undone`;
}

/** What the card says of the checks the bot's request read. An approval
 *  while they have not passed is refused, not held: the bot asks again once
 *  they pass (a held approval would keep an irreversible act waiting). */
const CHECK_WORDS: Readonly<Record<ReleaseAsk['checks'], string>> = {
  passed: 'passed',
  failed: 'one did not pass; approving now is refused, and the bot asks again once they pass',
  running: 'still running; approving now is refused, and the bot asks again once they pass',
  none: 'none',
  'not-started': 'its push CI has not run yet; approving now is refused, and the bot asks again once it passes',
};

/** A release refusal's code that says what became of its draft. */
function isDraftCode(code: string): boolean {
  return code.startsWith('draft-');
}

const ASK_AGAIN = 'Nothing more is tried for this request; ask again with a new request if it is still wanted.';

/** What a bot told of a release refusal is to do: wait while its draft is
 *  undecided (asking again would find it), leave the release alone while
 *  its draft stays, or may stay, on GitHub, else ask again if wanted. Pure. */
function releaseRefusalAdvice(refusal: string, draftOpen: boolean): string {
  if (draftOpen) return 'Its draft release is not settled yet: do not ask for this release again until you are told it is.';
  const codes = laneRefusalCodes(refusal);
  if (codes.includes('draft-kept-unchecked')) {
    return 'Its draft release may still be on GitHub until the owner publishes or deletes it: do not ask for this release again meanwhile.';
  }
  if (codes.some((c) => isDraftCode(c) && c !== 'draft-gone')) {
    return 'Its draft release stays on GitHub until the owner publishes or deletes it: do not ask for this release again meanwhile.';
  }
  return ASK_AGAIN;
}

/** What starts another workflow, as the card says it. */
const ALSO_RUNS_WORDS: Readonly<Record<AlsoRunsOn, string>> = {
  'tag-push': 'on this tag push',
  'tag-create': 'when the tag is created',
  'release-published': 'when the release is published',
};

/** `a`, `a and b`, `a, b and c`. Pure. */
function joinWords(words: readonly string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** A release card's lines after the bot's: what Approve does and whether it
 *  is marked Latest, the workflows the tag push also starts, what main read when the bot asked (the default branch,
 *  the checks, package.json's version), then each payload field in its own
 *  `wmux-payload` fence, in order. Pure. */
export function releaseCardLines(act: ApprovalReleaseAct, fields: readonly string[], o: { login: string; facts: Pick<ReleaseAsk, 'behindBy' | 'checks' | 'version' | 'alsoRuns'>; signedIn: boolean }): string[] {
  const secs = Math.round(APPROVAL_UNDO_MS / 1000);
  const when = `${secs} s after you approve (Undo until then)`;
  const at = act.targetSha.slice(0, 7);
  const lines = [''];
  if (act.mode === 'release') {
    lines.push(
      `Approve publishes this release on GitHub as @${o.login}, ${when}. A published release and its tag cannot be taken back by wmux. On a repository whose workflows run on a tag push (wmux's own builds installers and publishes to WinGet and Chocolatey), this starts them.`,
      act.prerelease ? 'Prerelease, never Latest.' : 'Marked Latest.',
    );
  } else {
    const runs = act.workflows.length === 1 ? `the workflow ${act.workflows[0]} runs on it` : `the workflows ${act.workflows.join(', ')} run on it`;
    lines.push(
      `Approve pushes the tag ${act.tagName} at ${at} as @${o.login}, ${when}; ${runs} and builds and publishes the release (wmux's own builds installers and publishes to WinGet and Chocolatey). A pushed tag cannot be taken back by wmux.`,
      'The workflow decides whether it is marked Latest.',
    );
  }
  // Other workflows the act starts (they build nothing that is published,
  // but they run).
  for (const w of o.facts.alsoRuns) lines.push(`${w.path} also runs ${joinWords(w.on.map((e) => ALSO_RUNS_WORDS[e]))}.`);
  const behind = o.facts.behindBy === 0 ? `${at} is its head` : `${at} is ${o.facts.behindBy} ${o.facts.behindBy === 1 ? 'commit' : 'commits'} behind its head`;
  // A push runs the checks on the pushed head only: one behind it may never run them.
  const checks = o.facts.checks === 'not-started' && o.facts.behindBy > 0
    ? 'its push CI has not run yet (a commit behind the head may never run it); approving now is refused, and the bot asks again once it passes'
    : CHECK_WORDS[o.facts.checks];
  lines.push('', `Default branch ${act.defaultBranch}: ${behind}.`, `Checks on ${at}: ${checks}.`);
  if (o.facts.version) lines.push(`package.json version: ${o.facts.version}.`);
  if (o.signedIn) lines.push('This bot\'s conversation holds data from a task you signed in to: check that the title and notes share none of it.');
  lines.push('', act.mode === 'release'
    ? 'The blocks are the tag, the commit, the release\'s title, its notes, and release or prerelease.'
    : `The blocks are the tag, the commit, and the ${act.workflows.length === 1 ? 'workflow' : 'workflows'} it starts.`);
  for (const f of fields) lines.push('', ...fencedLines(f, PAYLOAD_FENCE_INFO));
  return lines;
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
  /** `native_tool` requests: the turn waiting for the owner's answer. */
  private readonly nativeWaiters = new Map<string, (approved: boolean) => void>();
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
      // A `native_tool` request lives only while its turn waits; an older
      // build reading the file would refuse the unknown action.
      atomicWriteJSONSync(this.ports.file, { version: 1, requests: [...this.requests.values()].filter((r) => r.action !== 'native_tool'), rules: [...this.rules.values()] });
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
    if (CARD_ONLY_ACTIONS.has(act)) {
      return refuse('invalid', act === 'skill' ? 'a skill is proposed with skill_propose'
        : act === 'native_tool' ? 'a command approval comes from the bot\'s own engine, not approval_request'
          : act === 'routine' ? 'a routine is proposed with routine_set'
            : act === 'bot_memory' ? 'a change to your notes is proposed with memory_update target memory'
              : 'a change to the owner\'s profile is proposed with memory_update');
    }
    if (!(BOT_REQUESTABLE_ACTIONS as readonly string[]).includes(act)) {
      return refuse('invalid', `${act} is not asked for with approval_request; it has no executor yet`);
    }
    const num = (v: unknown): number | undefined | null => (v === undefined ? undefined : Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null);
    const prNumber = num(raw.prNumber);
    const issueNumber = num(raw.issueNumber);
    if (prNumber === null || issueNumber === null) return refuse('invalid', 'prNumber / issueNumber must be positive integers');
    if (act === 'merge' && prNumber === undefined) return refuse('invalid', 'a merge names its prNumber');
    if (act === 'issue_close' && issueNumber === undefined) return refuse('invalid', 'closing an issue names its issueNumber');
    if (act === 'comment' && prNumber === undefined && issueNumber === undefined) return refuse('invalid', 'a comment names a prNumber or an issueNumber');
    if (act === 'pr_close' && (prNumber === undefined || issueNumber !== undefined)) return refuse('invalid', 'closing a pull request names its prNumber');
    if (act === 'issue_close' && prNumber !== undefined) return refuse('invalid', 'closing an issue names its issueNumber; a pull request is closed with pr_close');
    if (act === 'issue_create' && (prNumber !== undefined || issueNumber !== undefined)) return refuse('invalid', 'a new issue names no number');
    if (act === 'release' && (prNumber !== undefined || issueNumber !== undefined)) return refuse('invalid', 'a release names its tagName, no number');
    if (prNumber !== undefined && issueNumber !== undefined) return refuse('invalid', 'name a prNumber or an issueNumber, not both');
    const given = oneLine(raw.reason, APPROVAL_LIMITS.REASON_MAX);
    if (!given) return refuse('invalid', 'reason is required (one line)');
    if (raw.clientRequestId !== undefined && (typeof raw.clientRequestId !== 'string' || !raw.clientRequestId || raw.clientRequestId.length > APPROVAL_LIMITS.CLIENT_ID_MAX)) {
      return refuse('invalid', 'clientRequestId is not a valid key');
    }

    const wake = this.ports.runningWake(bot.botId);
    if (!wake) return refuse('not_running', 'a bot asks for approval only during a wake');
    const readerGuest = wake.guest === true;
    let profile: BotProfile | null = null;
    try {
      profile = this.ports.bots()?.get(bot.botId) ?? null;
    } catch {
      profile = null;
    }
    if (!profile || !profile.enabled || profile.workspaceId !== bot.workspaceId) return refuse('not_bot', 'this bot is not running in the factory');
    const repo = botRepo(profile);
    if (!repo) {
      // What the bot can do instead: a bot of its workspace with a
      // repository asks for it; with none, only the owner can set one.
      let holder = false;
      try {
        holder = (this.ports.bots()?.listEnabled() ?? []).some((b) => b.enabled && b.workspaceId === bot.workspaceId && b.id !== bot.botId && !!botRepo(b));
      } catch {
        holder = false;
      }
      return refuse('no_repo', holder
        ? 'this bot has no repository to act on: hand the request to a bot of this workspace that has the repository (handoff_send), which asks for it'
        : 'this bot has no repository to act on, and no bot of this workspace has one: tell the owner in one line and ask them to set a repository on a bot\'s profile');
    }
    const { repoKey, repoPath } = repo;
    if (ACT_ACTIONS.has(act)) return this.requestAct(bot, raw, act as ActAction, wake, profile, repoKey, repoPath, prNumber, issueNumber, given);

    // One request per (bot, key): a retried turn gets the first one back.
    const clientRequestId = typeof raw.clientRequestId === 'string' ? raw.clientRequestId : this.nextOrdinal(bot.botId, wake);
    const prior = [...this.requests.values()].find((r) => r.botId === bot.botId && r.clientRequestId === clientRequestId);
    if (prior) return { ok: true, request: botApprovalView(prior, readerGuest), duplicate: true };
    const open = [...this.requests.values()].filter((r) => r.botId === bot.botId && r.state === 'pending');
    if (open.length >= APPROVAL_LIMITS.PENDING_PER_BOT) return refuse('too_many', `${open.length} requests already wait for the owner`);

    let headSha: string | undefined;
    let ghLogin: string | undefined;
    if (act === 'merge' && prNumber !== undefined) {
      let facts: PrLaneFacts;
      try {
        facts = await this.ports.readPr(repoPath, repoKey, prNumber);
      } catch (err) {
        return refuse('read_failed', `${prName(repoKey, prNumber)} could not be read: ${String(err)}`.slice(0, 300));
      }
      if (facts.number !== prNumber || facts.state !== 'OPEN') return refuse('not_open', `${prName(repoKey, prNumber)} is not open`);
      headSha = facts.headRefOid;
      // The same head already asked about and not settled: that request.
      const same = [...this.requests.values()].find((r) => r.action === 'merge' && r.repoKey === repoKey && r.prNumber === prNumber && r.headSha === headSha
        && (r.state === 'pending' || r.state === 'approved'));
      if (same) return { ok: true, request: botApprovalView(same, readerGuest), duplicate: true };
      const login = await this.ports.ghLogin({ key: repoKey, path: repoPath }).catch(() => null);
      if (!login) return refuse('read_failed', `the ${isGitlabRepoKey(repoKey) ? 'glab' : 'gh'} login could not be read`);
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
    if (again) return { ok: true, request: botApprovalView(again, readerGuest), duplicate: true };
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
      // The conversation's mark as it reads now, after the waits, and never
      // cleaner than when it asked.
      threadId: this.conversationThread(bot.botId, wake, signedInWake(wake) || signedInWake(still)),
      reason,
      // As the wake reads now, after the waits, and never cleaner than when
      // it asked.
      tainted: wake.tainted || still.tainted || guestSourcedWake(wake) || guestSourcedWake(still),
      guest: guestSourcedWake(wake) || guestSourcedWake(still),
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

  /**
   * An act main carries out (ACT_ACTIONS): the text the bot wrote, checked
   * so the card shows the bytes the post sends, and what main reads now on
   * GitHub (the login it goes out as, the repository's name and node id, the
   * target's node id, state and head). The card is posted first, with the
   * text fenced (actPayload.ts), and the request stored once, with it. No
   * rule approves it.
   */
  private async requestAct(
    bot: BotBinding, raw: Record<string, unknown>, act: ActAction, wake: ApprovalWake, profile: BotProfile,
    repoKey: string, repoPath: string, prNumber: number | undefined, issueNumber: number | undefined, given: string,
  ): Promise<{ ok: true; request: ApprovalView; duplicate?: true } | Refusal> {
    // What a guest's turn asks for is never published under the owner's name.
    if (guestSourcedWake(wake)) return refuse('not_now', `approval_request: ${GUEST_TURN_STARTS_NO_WORKERS}`);
    if (isGitlabRepoKey(repoKey)) return refuse('invalid', `wmux carries out ${act} on GitHub only; this repository is on GitLab`);
    const host = this.ports.acts?.() ?? null;
    if (!host) return refuse('not_started', 'wmux cannot carry out this act right now; ask again later');
    const text = (v: unknown, what: string, max: number, required: boolean): string | Refusal => {
      if (v === undefined && !required) return '';
      if (typeof v !== 'string') return refuse('invalid', `${what} is required`);
      const t = normalizeActText(v);
      if (required && !t) return refuse('invalid', `${what} is required`);
      if (t.length > max) return refuse('invalid', `${what} is longer than ${max} characters`);
      const problem = t ? actTextProblem(t, redactStoredSecrets) : null;
      return problem ? refuse('invalid', `${what} cannot be shown and posted as it is: ${problem}`) : t;
    };
    const isRefusal = (v: unknown): v is Refusal => typeof v === 'object' && v !== null && (v as Refusal).ok === false;
    const body = act === 'comment' || act === 'issue_create' ? text(raw.body, 'body', ACT_TEXT_MAX, act === 'comment') : '';
    if (isRefusal(body)) return body;
    const title = act === 'issue_create' || act === 'release' ? text(raw.title, 'title', ACT_TITLE_MAX, act === 'issue_create') : '';
    if (isRefusal(title)) return title;
    if (title.includes('\n')) return refuse('invalid', 'title is one line');
    const stateReason = raw.stateReason === undefined || raw.stateReason === 'completed' ? 'completed' : raw.stateReason === 'not_planned' ? 'not_planned' : null;
    if (stateReason === null) return refuse('invalid', 'stateReason is completed or not_planned');
    // A release: its tag, the commit (default: the default branch's head
    // when main reads it), its notes, and whether it is a prerelease.
    let tagName = '';
    let targetSha: string | undefined;
    let notes = '';
    let prerelease: boolean | undefined;
    if (act === 'release') {
      if (typeof raw.tagName !== 'string') return refuse('invalid', 'a release names its tagName');
      tagName = raw.tagName;
      const bad = releaseTagProblem(tagName) ?? actTextProblem(tagName, redactStoredSecrets);
      if (bad) return refuse('invalid', `tagName cannot be used: ${bad}`);
      if (raw.targetSha !== undefined && (typeof raw.targetSha !== 'string' || !/^[0-9a-f]{40}$/i.test(raw.targetSha))) return refuse('invalid', 'targetSha is a full 40-character commit SHA');
      targetSha = typeof raw.targetSha === 'string' ? raw.targetSha.toLowerCase() : undefined;
      const n = text(raw.notes, 'notes', ACT_TEXT_MAX, false);
      if (isRefusal(n)) return n;
      notes = n;
      if (raw.prerelease !== undefined && typeof raw.prerelease !== 'boolean') return refuse('invalid', 'prerelease is true or false');
      prerelease = raw.prerelease as boolean | undefined;
    }
    const contentKey = actContentKey([act, repoKey, prNumber ?? null, issueNumber ?? null, title, body, act === 'issue_close' ? stateReason : null,
      ...(act === 'release' ? [tagName, targetSha ?? null, notes, prerelease ?? null] : [])]);
    const readerGuest = wake.guest === true;

    // One request per (bot, key), and one per content while it waits.
    const clientRequestId = typeof raw.clientRequestId === 'string' ? raw.clientRequestId : this.nextOrdinal(bot.botId, wake);
    const duplicate = (): { ok: true; request: ApprovalView; duplicate: true } | Refusal | null => {
      const prior = [...this.requests.values()].find((r) => r.botId === bot.botId && r.clientRequestId === clientRequestId);
      if (prior) {
        return prior.action === act && prior.contentKey === contentKey
          ? { ok: true, request: botApprovalView(prior, readerGuest), duplicate: true }
          : refuse('invalid', 'clientRequestId was used for another request; send a new one');
      }
      const same = [...this.requests.values()].find((r) => r.repoKey === repoKey && r.contentKey === contentKey && (r.state === 'pending' || r.state === 'approved'));
      return same ? { ok: true, request: botApprovalView(same, readerGuest), duplicate: true } : null;
    };
    const first = duplicate();
    if (first) return first;
    const open = [...this.requests.values()].filter((r) => r.botId === bot.botId && r.state === 'pending');
    if (open.length >= APPROVAL_LIMITS.PENDING_PER_BOT) return refuse('too_many', `${open.length} requests already wait for the owner`);

    // GitHub, read now: the login, the repository, the target.
    const login = await host.login(repoKey).catch(() => null);
    if (!login) return refuse('read_failed', 'the gh login could not be read');
    const repoPin = await host.repo(repoKey).catch((err: unknown) => ({ error: String(err) }));
    if ('error' in repoPin) return refuse('read_failed', `the repository could not be read: ${repoPin.error}`.slice(0, 300));
    const n = (prNumber ?? issueNumber) as number;
    const unread = (what: string, r: { error: string; status?: number }): Refusal => (r.status === 404 || r.status === 410
      ? refuse('not_open', `${what} was not found on GitHub`)
      : refuse('read_failed', `${what} could not be read: ${r.error}`.slice(0, 300)));
    let actPin: ApprovalAct;
    let headSha: string | undefined;
    let ask: ReleaseAsk | null = null;
    if (act === 'release') {
      const read = await host.release(repoKey, {
        tagName, ...(targetSha ? { targetSha } : {}), ...(prerelease !== undefined ? { prerelease } : {}),
        ...(repoPin.defaultBranch ? { defaultBranch: repoPin.defaultBranch } : {}),
      })
        .catch((err: unknown): ReleaseAskRefusal => ({ refuse: 'read_failed', message: `the repository could not be read: ${String(err)}`.slice(0, 300) }));
      if ('refuse' in read) return refuse(read.refuse, read.message);
      ask = read;
      headSha = read.targetSha;
      // In workflow mode the workflow writes the release: no title or notes.
      actPin = {
        kind: 'release', mode: read.mode, tagName, targetSha: read.targetSha, defaultBranch: read.defaultBranch,
        title: read.mode === 'release' ? title || tagName : '', notes: read.mode === 'release' ? notes : '',
        prerelease: read.prerelease, workflows: read.workflows, checksExpected: read.checksExpected, pushWorkflows: read.pushWorkflows, draft: false,
      };
    } else if (act === 'issue_create') {
      actPin = { kind: 'issue_create', title, body };
    } else if (act === 'pr_close') {
      const pr = await host.pull(repoKey, n).catch((err: unknown) => ({ error: String(err) }));
      if ('error' in pr) return unread(prName(repoKey, n), pr);
      if (pr.merged || pr.state !== 'open') return refuse('not_open', `${prName(repoKey, n)} is not open`);
      headSha = pr.headSha;
      actPin = { kind: 'pr_close', number: n, targetNodeId: pr.nodeId, headSha, title: pr.title };
    } else {
      const issue = await host.issue(repoKey, n).catch((err: unknown) => ({ error: String(err) }));
      const what = prNumber !== undefined ? prName(repoKey, n) : `issue #${n}`;
      if ('error' in issue) return unread(what, issue);
      if (issue.isPr !== (prNumber !== undefined)) {
        return refuse('invalid', issue.isPr ? `#${n} is a pull request: name it with prNumber` : `#${n} is an issue: name it with issueNumber`);
      }
      if (act === 'issue_close') {
        if (issue.state !== 'open') return refuse('not_open', `${what} is not open`);
        actPin = { kind: 'issue_close', number: n, targetNodeId: issue.nodeId, title: issue.title, stateReason };
      } else {
        if (issue.locked) return refuse('invalid', `${what} is locked`);
        if (prNumber !== undefined) {
          const pr = await host.pull(repoKey, n).catch((err: unknown) => ({ error: String(err) }));
          if ('error' in pr) return unread(what, pr);
          headSha = pr.headSha;
        }
        actPin = { kind: 'comment', target: prNumber !== undefined ? 'pr' : 'issue', number: n, targetNodeId: issue.nodeId, ...(headSha ? { headSha } : {}), title: issue.title, body };
      }
    }
    // Re-read the wake after the awaits: a request outlives no turn.
    const still = this.ports.runningWake(bot.botId);
    if (!still || still.wakeId !== wake.wakeId) return refuse('not_running', 'the wake that asked has ended');
    if (guestSourcedWake(still)) return refuse('not_now', `approval_request: ${GUEST_TURN_STARTS_NO_WORKERS}`);
    if (this.botGone(bot)) return refuse('not_bot', 'this bot was deleted');
    const again = duplicate();
    if (again) return again;

    const requestId = newRequestId();
    const fields = actPin.kind === 'comment' ? [bodyWithMarker(actPin.body, requestId)]
      : actPin.kind === 'issue_create' ? [actPin.title, bodyWithMarker(actPin.body, requestId)]
        : actPin.kind === 'release' ? releaseFields(actPin)
          : [];
    const reason = withoutOwnerQuotes(given, this.ownerTexts(bot.workspaceId)) || `${ACTION_TITLE[act]} ${subject({ action: act, repoKey, prNumber, issueNumber, act: actPin })}.`;
    const signedIn = signedInWake(wake) || signedInWake(still);
    const lines = actPin.kind === 'release' && ask
      ? releaseCardLines(actPin, fields, { login, facts: ask, signedIn: actPin.mode === 'release' && signedIn })
      : actPin.kind !== 'release' ? actCardLines(actPin, fields, { login, repoKey, signedIn: TEXT_ACT_ACTIONS.has(act) && signedIn }) : [];
    // Measured as the room stores it: the owner reads all of what they approve.
    if (redactStoredSecrets([askLine(profile, reason), ...lines].join('\n')).length > ROOM_LIMITS.CARD_BODY_MAX) {
      return refuse('invalid', 'the text does not fit on the owner\'s card; write a shorter one');
    }
    const at = this.now();
    const record: StoredApproval = {
      requestId,
      action: act,
      repoKey,
      repoPath,
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(issueNumber !== undefined ? { issueNumber } : {}),
      ...(headSha ? { headSha } : {}),
      ghLogin: login.toLowerCase(),
      act: actPin,
      actRepo: { fullName: repoPin.fullName, nodeId: repoPin.nodeId, id: repoPin.id },
      payloadHash: payloadHashOf(fields),
      contentKey,
      botId: bot.botId,
      workspaceId: bot.workspaceId,
      threadId: this.conversationThread(bot.botId, wake, signedInWake(wake) || signedInWake(still)),
      reason,
      tainted: wake.tainted || still.tainted,
      guest: false,
      state: 'pending',
      clientRequestId,
      createdAt: at,
      updatedAt: at,
    };
    // Approved on its card only: the card is posted first and the request
    // stored once, with it.
    const card = this.postCard(record, profile, still, lines);
    if (!card) return refuse('write_failed', 'the approval card could not be posted; ask again');
    if (!this.put({ ...record, cardId: card.id })) {
      this.closeCard({ ...record, cardId: card.id });
      return refuse('write_failed', 'the request could not be stored; ask again');
    }
    this.changed(record.workspaceId);
    return { ok: true, request: approvalView(this.get(record.requestId) ?? record) };
  }

  /** A bot's skill proposal (the skills module, from `skill_propose`): one
   *  `skill` request whose card shows the diff. No repository is needed and
   *  no rule ever approves it. */
  proposeSkill(bot: BotBinding, input: SkillApprovalInput): { ok: true; request: ApprovalView } | Refusal {
    const wake = this.ports.runningWake(bot.botId);
    if (!wake) return refuse('not_running', 'a bot proposes a skill only during a wake');
    // An approved skill is read in every later wake.
    if (guestSourcedWake(wake)) return refuse('not_now', `skill_propose: ${GUEST_TURN_STARTS_NO_WORKERS}`);
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
      tainted: wake.tainted || guestSourcedWake(wake),
      guest: guestSourcedWake(wake),
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

  /** A Hermes bot's own tool asks for permission mid-turn (its ACP
   *  permission request, main/deck/AcpBrainAdapter.ts): one `native_tool`
   *  request whose desktop card shows the command. Resolves the owner's
   *  answer: true on Approve; false on Deny, after `timeoutMs`, when
   *  `signal` aborts, or when no card could be posted. One waits per bot;
   *  the request lives only while it waits (never in approvals.json). */
  askNativeTool(bot: BotBinding, input: { title: string; command: string }, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<boolean> {
    const wake = this.ports.runningWake(bot.botId);
    if (!wake || opts.signal?.aborted) return Promise.resolve(false);
    let profile: BotProfile | null = null;
    try {
      profile = this.ports.bots()?.get(bot.botId) ?? null;
    } catch {
      profile = null;
    }
    if (!profile || !profile.enabled || profile.workspaceId !== bot.workspaceId) return Promise.resolve(false);
    if ([...this.requests.values()].some((r) => r.botId === bot.botId && r.action === 'native_tool' && r.state === 'pending')) return Promise.resolve(false);
    const command = redactStoredSecrets(String(input.command ?? '')).slice(0, NATIVE_TOOL_COMMAND_MAX);
    const title = oneLine(redactStoredSecrets(String(input.title ?? '')), APPROVAL_LIMITS.REASON_MAX);
    const at = this.now();
    const record: StoredApproval = {
      requestId: newRequestId(),
      action: 'native_tool',
      repoKey: '',
      repoPath: '',
      nativeTool: { title, command },
      botId: bot.botId,
      workspaceId: bot.workspaceId,
      threadId: this.conversationThread(bot.botId, wake),
      reason: 'Hermes wants to run a command it flags as needing your approval.',
      tainted: wake.tainted || guestSourcedWake(wake),
      guest: guestSourcedWake(wake),
      state: 'pending',
      clientRequestId: `native:${wake.wakeId}:${at}`,
      createdAt: at,
      updatedAt: at,
    };
    const fence = fenceFor(command);
    const card = this.postCard(record, profile, wake, ['', 'Approve to let it run this once; Deny refuses it. No answer in a few minutes refuses it too.', '', `${fence}text`, command, fence]);
    if (!card) return Promise.resolve(false);
    const stored: StoredApproval = { ...record, cardId: card.id };
    this.requests.set(stored.requestId, stored);
    this.changed(stored.workspaceId);
    return new Promise<boolean>((resolve) => {
      const done = (approved: boolean): void => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        this.nativeWaiters.delete(stored.requestId);
        resolve(approved);
      };
      const lapse = (): void => {
        this.withdraw(stored.requestId);
        done(false);
      };
      const onAbort = (): void => lapse();
      const timer = setTimeout(lapse, opts.timeoutMs);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.nativeWaiters.set(stored.requestId, done);
    });
  }

  /** The turn waiting on a `native_tool` request gets the owner's answer. */
  private answerNativeTool(r: StoredApproval, approved: boolean): void {
    if (r.action === 'native_tool') this.nativeWaiters.get(r.requestId)?.(approved);
  }

  /** A bot's change to the owner's profile (the memory module, from
   *  `memory_update` target `user`): one `owner_profile` request whose card
   *  shows the exact change. The same change waiting already is that
   *  request; no rule ever approves one. */
  proposeOwnerProfile(bot: BotBinding, change: MemoryChange): { ok: true; request: ApprovalView; duplicate?: true } | Refusal {
    const wake = this.ports.runningWake(bot.botId);
    if (!wake) return refuse('not_running', 'a bot proposes a change to the owner\'s profile only during a wake');
    // Every bot reads the profile in every later session.
    if (guestSourcedWake(wake)) return refuse('not_now', `memory_update: ${GUEST_TURN_STARTS_NO_WORKERS}`);
    let profile: BotProfile | null = null;
    try {
      profile = this.ports.bots()?.get(bot.botId) ?? null;
    } catch {
      profile = null;
    }
    if (!profile || !profile.enabled || profile.workspaceId !== bot.workspaceId) return refuse('not_bot', 'this bot is not running in the factory');
    const key = `owner_profile:${createHash('sha256').update(JSON.stringify([change.action, change.text ?? null, change.old ?? null])).digest('hex').slice(0, 32)}`;
    const waiting = [...this.requests.values()].find((r) => r.botId === bot.botId && r.state === 'pending' && r.clientRequestId === key);
    if (waiting) return { ok: true, request: approvalView(waiting), duplicate: true };
    const open = [...this.requests.values()].filter((r) => r.botId === bot.botId && r.state === 'pending').length;
    if (open >= APPROVAL_LIMITS.PENDING_PER_BOT) return refuse('too_many', `${open} requests already wait for the owner`);
    const reason = 'Remember this about you, for every bot.';
    const lines = ownerProfileCardLines(change);
    // Measured as the room stores it: the owner reads all of what they approve.
    if (redactStoredSecrets([askLine(profile, reason), ...lines].join('\n')).length > ROOM_LIMITS.CARD_BODY_MAX) {
      return refuse('invalid', 'the change does not fit on the owner\'s card; propose a shorter entry');
    }
    const at = this.now();
    const record: StoredApproval = {
      requestId: newRequestId(),
      action: 'owner_profile',
      repoKey: '',
      repoPath: '',
      ownerProfile: { ...change },
      botId: bot.botId,
      workspaceId: bot.workspaceId,
      threadId: this.conversationThread(bot.botId, wake),
      reason,
      tainted: wake.tainted || guestSourcedWake(wake),
      guest: guestSourcedWake(wake),
      state: 'pending',
      clientRequestId: key,
      createdAt: at,
      updatedAt: at,
    };
    // Approved on its card only: the card is posted first and the request
    // stored once, with it.
    const card = this.postCard(record, profile, wake, lines);
    if (!card) return refuse('write_failed', 'the approval card could not be posted; propose the change again');
    if (!this.put({ ...record, cardId: card.id })) {
      this.closeCard({ ...record, cardId: card.id });
      return refuse('write_failed', 'the request could not be stored; propose the change again');
    }
    this.changed(record.workspaceId);
    return { ok: true, request: approvalView(this.get(record.requestId) ?? record) };
  }

  /** What the owner asked the bot for in a conversation that took in
   *  outside text (routine_set, memory_update): one card-only request, asked
   *  in the wake that runs on the owner's card (`proof`), whose card shows
   *  that message and the whole change. One per action and owner message:
   *  the same change again while it waits is that request, another one, or
   *  any once the owner answered, is refused. The caller has
   *  refused a guest's wake, a tainted wake and a signed-in conversation. */
  proposeOwnerAsked(bot: BotBinding, ask: OwnerAsk, proof: OwnerCardProof): { ok: true; request: ApprovalView; duplicate?: true } | Refusal {
    const tool = ask.action === 'routine' ? 'routine_set' : 'memory_update';
    const wake = this.ports.runningWake(bot.botId);
    if (!wake || wake.wakeId !== proof.wakeId) return refuse('not_running', `${tool}: the turn the owner's message started has ended`);
    if (guestSourcedWake(wake)) return refuse('not_now', `${tool}: ${GUEST_TURN_STARTS_NO_WORKERS}`);
    let profile: BotProfile | null = null;
    try {
      profile = this.ports.bots()?.get(bot.botId) ?? null;
    } catch {
      profile = null;
    }
    if (!profile || !profile.enabled || profile.workspaceId !== bot.workspaceId) return refuse('not_bot', 'this bot is not running in the factory');
    // A replace or remove shows the entry it changes too.
    const texts = ask.action === 'routine' ? [ask.routine.title, ask.routine.prompt] : [ask.change.text ?? '', ask.change.old ?? ''];
    for (const t of texts) {
      const problem = ownerAskedTextProblem(t);
      if (problem) return refuse('invalid', `${tool}: this cannot go on the owner's card as it is: ${problem}`);
    }
    // The owner's words on the card are held to the same: shown as stored.
    if (ownerAskedTextProblem(proof.excerpt)) return refuse('invalid', `${tool}: the owner's message cannot be quoted on a card as it is; tell the owner what you would save`);
    const payload = ask.action === 'routine' ? ask.routine : ask.change;
    const contentKey = createHash('sha256').update(JSON.stringify([ask.action, payload])).digest('hex').slice(0, 32);
    // One per action and owner message, whichever wake runs on it, so
    // outside text cannot fill the owner's inbox.
    const clientRequestId = `${ask.action}:${proof.cardId}`;
    const prior = [...this.requests.values()].find((r) => r.botId === bot.botId && r.clientRequestId === clientRequestId);
    if (prior) {
      if (prior.state !== 'pending') return refuse('not_pending', `${tool}: the owner already answered this request (${prior.state}); do not ask again unless they say so`);
      return prior.contentKey === contentKey
        ? { ok: true, request: approvalView(prior), duplicate: true }
        : refuse('too_many', `${tool}: one such request per owner message, and one waits already; tell the owner what else you would save`);
    }
    const open = [...this.requests.values()].filter((r) => r.botId === bot.botId && r.state === 'pending').length;
    if (open >= APPROVAL_LIMITS.PENDING_PER_BOT) return refuse('too_many', `${open} requests already wait for the owner`);
    const reason = ask.action === 'routine' ? 'Set up this routine you asked for.'
      : ask.action === 'bot_memory' ? 'Keep this in my notes, as you asked.'
        : 'Remember this about you, for every bot.';
    const lines = [
      ...ownerAskedLines(proof.excerpt),
      ...(ask.action === 'routine'
        ? routineCardLines(ask.routine, { botId: bot.botId, botName: profile.name || 'the bot', now: this.now(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
        : ownerProfileCardLines(ask.change, ask.action === 'bot_memory' ? 'This bot reads its notes when its session starts.' : undefined)),
    ];
    // Measured as posted, and never cut: the owner reads all of what they
    // approve.
    if ([askLine(profile, reason), ...lines].join('\n').length > ROOM_LIMITS.CARD_BODY_MAX) {
      return refuse('invalid', `${tool}: this does not fit on the owner's card; make it shorter`);
    }
    const at = this.now();
    const record: StoredApproval = {
      requestId: newRequestId(),
      action: ask.action,
      repoKey: '',
      repoPath: '',
      ...(ask.action === 'routine' ? { routine: { ...ask.routine } } : ask.action === 'bot_memory' ? { botMemory: { ...ask.change } } : { ownerProfile: { ...ask.change } }),
      ownerCardId: proof.cardId,
      botId: bot.botId,
      workspaceId: bot.workspaceId,
      threadId: this.conversationThread(bot.botId, wake),
      reason,
      tainted: true,
      guest: false,
      state: 'pending',
      clientRequestId,
      contentKey,
      createdAt: at,
      updatedAt: at,
    };
    // Approved on its card only: the card is posted first and the request
    // stored once, with it.
    const card = this.postCard(record, profile, wake, lines);
    if (!card) return refuse('write_failed', `${tool}: the approval card could not be posted; ask again`);
    if (!this.put({ ...record, cardId: card.id })) {
      this.closeCard({ ...record, cardId: card.id });
      return refuse('write_failed', `${tool}: the request could not be stored; ask again`);
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
      const armed = r.state === 'approved' && (r.act ? !this.actClaimed(r) : r.action === 'merge' && !r.effectId);
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

  /** The bot that asked is there and switched on. */
  private botEnabled(r: Pick<StoredApproval, 'botId'>): boolean {
    try {
      return this.ports.bots()?.get(r.botId)?.enabled === true;
    } catch {
      return false;
    }
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
    this.answerNativeTool(next, false);
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
   *  there or its conversation holds data from a signed-in task (the card
   *  carries the bot's reason, and no other bot reads that 1:1), else the
   *  thread of the owner's latest words to the bot (its latest
   *  owner-message wake), else the running wake's when that is the owner's,
   *  else `general`. */
  private conversationThread(botId: string, wake: ApprovalWake, signedIn = signedInWake(wake)): ThreadId {
    if (signedIn) return dmThreadId(botId);
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
    let readerGuest = false;
    try {
      readerGuest = this.ports.runningWake(bot.botId)?.guest === true;
    } catch {
      readerGuest = false;
    }
    const rows = [...this.requests.values()]
      .filter((r) => r.botId === bot.botId && r.action !== 'native_tool' && (!want || want.includes(r.state)))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((r) => botApprovalView(r, readerGuest));
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
      .map((r) => {
        const view = approvalView(r);
        const effect = r.act ? this.actEffect(r) : null;
        return effect ? { ...view, actStatus: effect.status } : view;
      });
  }

  /** An act request's outbox row, or null. */
  private actEffect(r: Pick<StoredApproval, 'requestId'>): ActEffect | null {
    try {
      return this.ports.acts?.()?.effect(actEffectId(r.requestId)) ?? null;
    } catch {
      return null;
    }
  }

  /** Whether an act request's row was claimed (it may have reached GitHub):
   *  from then on it is not undone, and not taken back on a restart. */
  private actClaimed(r: Pick<StoredApproval, 'requestId'>): boolean {
    const e = this.actEffect(r);
    return !!e && actRowClaimed(e);
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
    const via = `${by === 'phone' && deviceId ? `phone, device ${deviceId}` : by}${p.source === 'chip' || p.source === 'card' ? `, ${p.source}` : ''}`;
    switch (p.decision) {
      case 'approve': {
        // The chip approves a merge and a close without text only; a text act
        // is approved from its card, echoing the text the card shows.
        if (p.source === 'chip' && !TYPED_APPROVABLE_ACTIONS.has(cur.action)) {
          return refuse('not_here', cur.action === 'release'
            ? 'a release is approved with Approve on its card, where what it publishes is shown'
            : 'this act publishes text: approve it with Approve on its card, where the text is shown');
        }
        // Every request that carries a payloadHash needs it echoed: an app
        // that sends none does not know what it approves, a close included.
        if (cur.payloadHash !== undefined && typeof p.payloadHash !== 'string') {
          return refuse('client_update_required', 'this app version cannot show this act: update the app, or approve it on the desktop');
        }
        if (cur.act && p.payloadHash !== undefined && p.payloadHash !== cur.payloadHash) {
          return refuse('changed', 'the card changed since you read it: read it again before you approve');
        }
        return this.approve(cur, 'owner', via);
      }
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
        // A native tool hears the answer in its own turn.
        if (next.action === 'native_tool') this.answerNativeTool(next, false);
        else this.tellDecided(next, `The owner denied: ${ACTION_TITLE[next.action]} ${subject(next)}.`, 'Do not ask for it again unless the owner says so.');
        return { ok: true, request: approvalView(next) };
      }
      case 'undo': {
        if (cur.state !== 'approved') return refuse('not_pending', `the request is ${cur.state}`);
        // An approved skill is loaded already; the profile's Archive unloads it.
        if (cur.action === 'skill') return refuse('too_late', 'the skill is loaded; archive it from the bot\'s profile');
        if (cur.action === 'native_tool') return refuse('too_late', 'the tool was told already');
        // Approving saved it already: there is no window to take it back in.
        if (cur.action === 'owner_profile' || cur.action === 'bot_memory' || cur.action === 'routine') return refuse('too_late', 'it is saved already; change it from the bot\'s profile or the Schedules page');
        if (cur.act) {
          if (this.actClaimed(cur) || (cur.executeAfter !== undefined && this.now() >= cur.executeAfter)) return refuse('too_late', 'wmux has already started it');
        } else if (cur.effectId || (cur.executeAfter !== undefined && this.now() >= cur.executeAfter)) return refuse('too_late', 'the merge has started');
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
    const memory = cur.action === 'owner_profile' || cur.action === 'bot_memory';
    const profileHost = memory ? this.ports.ownerProfile?.() ?? null : null;
    if (memory && !profileHost) return refuse('not_started', 'memory is not running yet');
    const routineHost = cur.action === 'routine' ? this.ports.routines?.() ?? null : null;
    if (cur.action === 'routine' && !routineHost) return refuse('not_started', 'routines are not running yet');
    // What it saves runs in the bot's later turns.
    if ((cur.action === 'routine' || cur.action === 'bot_memory') && !this.botEnabled(cur)) return refuse('not_now', 'the bot is switched off: switch it on, then approve');
    const at = this.now();
    const next: StoredApproval = {
      ...cur,
      state: 'approved',
      decidedBy: approver,
      decidedAt: at,
      updatedAt: at,
      ...(ruleId ? { ruleId } : {}),
      ...(cur.action === 'merge' || cur.act ? { executeAfter: at + APPROVAL_UNDO_MS } : {}),
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
    const applier = profileHost ?? routineHost;
    if (applier) {
      // The owner's answer is the act, checked again as things stand now
      // (the scanner, the limit, the entry it was for; a routine's schedule
      // and the bot's cap). When it cannot be applied the decision is taken
      // back and the card is moot.
      let why: string | null;
      try {
        why = applier.approve(next);
      } catch (err) {
        why = `the change could not be applied: ${String(err)}`;
      }
      if (why) {
        const moot: StoredApproval = { ...cur, state: 'expired', updatedAt: this.now() };
        if (this.put(moot)) this.closeCard(moot);
        else this.log(`[factory] approval ${cur.requestId} kept as approved though its change was not applied`);
        this.changed(cur.workspaceId);
        return refuse('stale', why);
      }
    }
    this.log(`[factory] approval ${cur.requestId} approved by ${approver} (${by})`);
    // Decided: the card stops waiting on the owner (its Undo reads the request).
    this.closeCard(next);
    if (next.action === 'merge' || next.act) this.arm(next);
    this.changed(next.workspaceId);
    // A merge is told once it ran (merged, or refused); any other act now.
    if (next.action === 'skill') {
      this.tellDecided(next, `The owner approved your skill ${subject(next)}.`, 'It is listed in your wakes from now on; read it with skill_read.');
    } else if (next.action === 'owner_profile') {
      this.tellDecided(next, 'The owner approved the change to their profile.', 'Every bot\'s next session starts with it.');
    } else if (next.action === 'bot_memory') {
      this.tellDecided(next, 'The owner approved the change to your notes.', 'Your next session starts with it.');
    } else if (next.action === 'routine') {
      this.tellDecided(next, `The owner approved the routine ${subject(next)}.`, 'It runs on its schedule from now on; routine_list shows it.');
    } else if (next.action === 'native_tool') {
      this.answerNativeTool(next, true);
      // Nothing is left to do or undo: the card keeps the answer.
      this.requests.delete(next.requestId);
      this.changed(next.workspaceId);
    } else if (next.act) {
      this.tellDecided(next, `The owner approved: ${ACTION_TITLE[next.action]} ${subject(next)}.`, `wmux carries it out after a ${Math.round(APPROVAL_UNDO_MS / 1000)} s Undo window, and tells you how it went.`);
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
    // A skill or a profile change is approved on its card only, where the
    // change is shown.
    // A text act is approved on its card only, where its text is shown.
    const pending = [...this.requests.values()].filter((r) => r.state === 'pending' && !CARD_ONLY_ACTIONS.has(r.action) && TYPED_APPROVABLE_ACTIONS.has(r.action));
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
    this.resumeActs();
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
    if (r?.act) {
      await this.executeAct(r);
      return null;
    }
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

  /** Start: an approved act whose outbox row was never claimed waits for the
   *  owner again (only a decision of this run is carried out); one whose row
   *  was claimed stays approved while the outbox settles it, and one whose
   *  row ended takes that outcome. */
  private resumeActs(): void {
    for (const r of [...this.requests.values()]) {
      if (!r.act || r.state !== 'approved' || this.timers.has(r.requestId)) continue;
      const e = this.actEffect(r);
      if (e && (e.status === 'done' || e.status === 'refused')) {
        this.onActEffect(e);
        continue;
      }
      if (e && actRowClaimed(e)) continue;
      this.handActBack(r);
    }
  }

  /** An approved act no try of which was claimed waits for the owner again,
   *  its unclaimed outbox row dropped. */
  private handActBack(r: StoredApproval): void {
    const back: StoredApproval = { ...r, state: 'pending', updatedAt: this.now() };
    delete back.decidedBy;
    delete back.decidedAt;
    delete back.executeAfter;
    delete back.effectId;
    if (!this.put(back)) return;
    this.removeActEffect(back);
    this.clearTimer(back.requestId);
    this.reopenCard(back);
    this.changed(back.workspaceId);
  }

  /** Run an approved act whose Undo window passed (its outbox row). */
  private async executeAct(r: StoredApproval): Promise<void> {
    if (r.state !== 'approved' || r.decidedBy !== 'owner') return;
    if (r.executeAfter !== undefined && this.now() < r.executeAfter) {
      this.arm(r);
      return;
    }
    const host = this.ports.acts?.() ?? null;
    const effect = host?.enqueue(r) ?? null;
    if (!host || !effect) {
      this.log(`[factory] approval ${r.requestId}: ${host ? 'its act could not be put in the outbox' : 'the act outbox is not running'}; it waits for the owner again`);
      this.handActBack(r);
      return;
    }
    const cur = this.requests.get(r.requestId);
    if (cur && cur.effectId !== effect.id) this.put({ ...cur, effectId: effect.id, updatedAt: this.now() });
    this.changed(r.workspaceId);
    await host.run(effect.id);
  }

  /** The act outbox's gate for a row, asked on every try and again right
   *  before the write: null when the request allows it now. Not approved
   *  (undone, denied, waiting again) or inside the Undo window means "not
   *  now" (the row waits; actExecutor.ts ACT_NOT_NOW). A row no try of
   *  which was started (actRowClaimed) whose approval is APPROVED_TTL_MS
   *  old is refused `approval-stale`; a row that may have reached GitHub is
   *  left to its read. */
  authorizeAct(e: Pick<ActEffect, 'requestId' | 'action' | 'payloadHash' | 'repoKey' | 'status' | 'attempt' | 'draftId'>): string | null {
    const r = this.requests.get(e.requestId);
    if (!r) return 'approval-missing';
    if (!r.act || r.action !== e.action) return 'approval-mismatch';
    if (this.botGone(r)) return 'bot-removed';
    if (r.state !== 'approved') return 'approval-not-approved';
    if (r.decidedBy !== 'owner' || r.payloadHash !== e.payloadHash || normalizeRepoKey(e.repoKey) !== r.repoKey) return 'approval-mismatch';
    // Counted from the decision on purpose, a long sleep before the first
    // try included: a day on, things may have changed, so the bot asks
    // again. No decision time (none is made without one) counts as stale; a
    // clock that went back waits (the Undo window below), and only one
    // that went back more than a day is stale too.
    const at = this.now();
    const ttl = APPROVAL_LIMITS.APPROVED_TTL_MS;
    const stale = !actRowClaimed(e) && (r.decidedAt === undefined || at - r.decidedAt >= ttl || r.decidedAt - at > ttl);
    // A directory that cannot be read now says nothing about the bot: not
    // now, unless the approval is stale (a "not now" never outlives it).
    let profile: BotProfile | null;
    try {
      profile = this.ports.bots()?.get(r.botId) ?? null;
    } catch {
      return stale ? 'approval-stale' : 'bots-unreadable';
    }
    if (!profile) return stale ? 'approval-stale' : 'bots-unreadable';
    if (botRepo(profile)?.repoKey !== r.repoKey) return 'repo-changed';
    // A secret stored since the request would now be hidden on the card the
    // owner reads, and published by the post.
    const texts = r.act.kind === 'comment' ? [r.act.body] : r.act.kind === 'issue_create' ? [r.act.title, r.act.body]
      : r.act.kind === 'release' ? [r.act.title, r.act.notes] : [];
    if (texts.some((t) => redactStoredSecrets(t) !== t)) return 'secret-in-body';
    // After the refusals that name a cause.
    if (stale) return 'approval-stale';
    // A clock behind the decision is inside the window too: not now.
    if ((r.executeAfter !== undefined && at < r.executeAfter) || (r.decidedAt !== undefined && at < r.decidedAt)) return 'approval-undo-window';
    return null;
  }

  /** An act outbox row moved: a row that ended settles its request (the
   *  outcome card, the bot told); any other move redraws the card. */
  onActEffect(e: ActEffect): void {
    const r = this.requests.get(e.requestId);
    if (!r?.act) return;
    if (e.status !== 'done' && e.status !== 'refused') {
      this.changed(r.workspaceId);
      return;
    }
    if (r.state === 'refused' && e.status === 'refused' && r.act.kind === 'release') {
      // A refusal told before its draft was decided (a quit, or GitHub not
      // answering, came between): its draft's code added, told in one more
      // outcome card and to the bot. Within 300 characters the refusal as
      // told stays first (cut at its end), the draft's code last. A bot told
      // to wait is told once it is decided, whatever became of the draft.
      if (e.draftOpen) return;
      const had = laneRefusalCodes(r.refusal ?? '');
      const added = laneRefusalCodes(e.reason ?? '').filter((c) => isDraftCode(c) && !had.includes(c));
      if (added.length === 0 && !r.draftWait) return;
      const tail = added.join(', ');
      const base = r.refusal ?? 'refused';
      const room = 300 - tail.length - 2;
      const amended: StoredApproval = {
        ...r,
        ...(tail ? { refusal: `${base.length <= room ? base : base.slice(0, Math.max(0, room))}, ${tail}` } : {}),
        updatedAt: this.now(),
      };
      delete amended.draftWait;
      if (!this.put(amended)) return;
      if (tail) this.outcomeCard(amended, 'draft');
      this.changed(amended.workspaceId);
      this.tellDecided(
        amended,
        `Not done: ${ACTION_TITLE[amended.action]} ${subject(amended)} (${laneRefusalLine(tail || (amended.refusal ?? ''), amended.repoKey) || 'refused'}).`,
        tail ? releaseRefusalAdvice(amended.refusal ?? '', false) : `Its draft release is settled. ${ASK_AGAIN}`,
        'draft',
      );
      return;
    }
    if (r.state === 'executed' || r.state === 'refused') return;
    const done = e.status === 'done';
    const next: StoredApproval = {
      ...r,
      state: done ? 'executed' : 'refused',
      effectId: e.id,
      // A refusal may carry what it still made (a release published on a
      // tag that points elsewhere).
      ...(e.result ? { result: e.result } : {}),
      ...(!done ? { refusal: (e.reason ?? 'refused').slice(0, 300) } : {}),
      ...(!done && r.act.kind === 'release' && e.draftOpen ? { draftWait: true as const } : {}),
      updatedAt: this.now(),
    };
    this.put(next);
    this.clearTimer(next.requestId);
    // A claimed row its failed reads stopped (actStalledTooLong): the last
    // read's error, for the owner to fix.
    const readError = !done && laneRefusalCodes(e.reason ?? '').includes('approval-stale') && e.readUnansweredTries && e.lastReadError
      ? `GitHub could not be read for this request for a day, so wmux stopped trying. Last read error: ${redactStoredSecrets(e.lastReadError)}` : '';
    this.outcomeCard(next, undefined, readError);
    this.closeCard(next);
    this.changed(next.workspaceId);
    if (done) {
      this.tellDecided(next, `Done: ${ACTION_TITLE[next.action]} ${subject(next)}${next.result?.url ? ` (${next.result.url})` : ''}.`, 'It is done: do not ask the owner for it again.');
    } else {
      this.tellDecided(next, `Not done: ${ACTION_TITLE[next.action]} ${subject(next)} (${laneRefusalLine(next.refusal ?? '', next.repoKey) || 'refused'}).`,
        next.act?.kind === 'release' ? releaseRefusalAdvice(next.refusal ?? '', next.draftWait === true) : ASK_AGAIN);
    }
  }

  /** A claimed act row whose reads failed past its bound (actEffectStore.ts
   *  actStalledTooLong) and still cannot say whether it went through: no
   *  write is sent for it again, and the request stays approved while the
   *  outbox keeps reading. The owner is told once, in its thread (what is
   *  known: it may be on GitHub, and the last read's error), and its bots
   *  not to ask again meanwhile; its outcome is told as ever once a read
   *  settles it. Called on every such sweep: the card is keyed, and once it
   *  is in the room nothing more is told, so a sweep the rooms were not up
   *  for is told on the next. */
  onActStalled(e: ActEffect): void {
    const r = this.requests.get(e.requestId);
    if (!r?.act || r.state !== 'approved') return;
    const title = `Not confirmed: ${ACTION_TITLE[r.action]} ${subject(r)} (GitHub has not said for a day whether it went through)`;
    const error = e.lastReadError ? redactStoredSecrets(e.lastReadError) : '';
    const body = [
      'It may be on GitHub: check there before asking for it again. wmux sends nothing more for it; it keeps reading GitHub and posts the outcome once it can tell.',
      error ? `Last read error: ${error}` : '',
    ].filter(Boolean).join('\n\n');
    try {
      const posted = this.ports.rooms()?.post({
        workspaceId: r.workspaceId,
        threadId: r.threadId,
        kind: 'status',
        actor: { kind: 'system' },
        title,
        body,
        refs: { approvalId: r.requestId, ...(r.prNumber !== undefined ? { pr: r.prNumber } : {}), ...(r.issueNumber !== undefined ? { issue: r.issueNumber } : {}) },
        clientPostId: `approval-outcome:${r.requestId}:stalled`,
      });
      // Told on an earlier sweep: its bots were told then.
      if (posted?.ok && posted.duplicate) return;
    } catch {
      /* the request is the record; the card only shows it */
    }
    this.tellDecided(r, `${title}.`, 'It may be on GitHub: do not ask for it again until you are told its outcome.', 'stalled');
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
      this.tellDecided(next, `Not merged: ${subject(next)} (${laneRefusalLine(next.refusal ?? '', next.repoKey) || 'refused'}).`, next.refusal === 'head-moved' ? 'Its head moved since the request: ask again for the new head.' : undefined);
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
   *  since its card, are told once (once per `again`: a later word on the
   *  same decision, under a key of its own). */
  private tellDecided(r: StoredApproval, title: string, body?: string, again?: 'draft' | 'stalled'): void {
    const cardSeq = r.cardId ? this.ports.rooms()?.get(r.workspaceId, r.cardId)?.seq ?? null : null;
    const bots = new Set([r.botId, ...this.speakersAfter(r.workspaceId, r.threadId, cardSeq)]);
    // As guest-sourced as the request (an older one without the field: as
    // its taint says).
    const guest = guestOfRecord(r.guest, r.tainted) !== false;
    for (const botId of [...bots].slice(0, APPROVAL_LIMITS.NOTIFY_MAX)) {
      this.notice({
        botId, workspaceId: r.workspaceId, key: `approval:${r.requestId}:${r.state}${again ? `:${again}` : ''}`, topic: 'approval.decided',
        title, ...(body ? { body } : {}), threadId: r.threadId, repoKey: r.repoKey,
        ...(guest ? { guest: true, tainted: true } : {}),
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
      ? `on ${isGitlabRepoKey(repoKey) ? 'GitLab' : 'GitHub'}`
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
      // A guest workspace has no repository; skipped all the same.
      watching = (this.ports.bots()?.listEnabled() ?? []).filter((b) => normalizeRepoKey(b.repo?.repoKey) === repoKey && !guestSide(b.workspaceId));
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
        title: `${prName(repoKey, pr)} merged ${how}.`,
        body: 'It is done: do not ask the owner to approve or merge it again.',
        threadId: at.threadId, repoKey, pr,
      });
    }
  }

  /** Pending requests past their time expire. */
  private expire(): void {
    const at = this.now();
    const stale = [...this.requests.values()].filter((r) => r.state === 'pending' && at - r.createdAt >= APPROVAL_LIMITS.PENDING_TTL_MS);
    // A refused release whose draft is undecided stays: its refusal is
    // amended, and its bot told, once the draft is decided.
    const ends = (r: StoredApproval): boolean => r.state !== 'pending' && r.state !== 'approved' && !this.draftUndecidedOf(r);
    const old = [...this.requests.values()].filter((r) => ends(r) && at - r.updatedAt >= APPROVAL_LIMITS.RETAIN_MS);
    if (stale.length === 0 && old.length === 0 && this.requests.size <= APPROVAL_LIMITS.REQUESTS_MAX) return;
    const ok = this.commit(() => {
      for (const r of stale) this.requests.set(r.requestId, { ...r, state: 'expired', updatedAt: at });
      for (const r of old) this.requests.delete(r.requestId);
      const settled = [...this.requests.values()].filter(ends).sort((a, b) => a.updatedAt - b.updatedAt);
      while (this.requests.size > APPROVAL_LIMITS.REQUESTS_MAX && settled.length > 0) this.requests.delete((settled.shift() as StoredApproval).requestId);
    });
    if (ok) {
      // An act's outbox row goes with its request (one that may have run stays
      // until a read settles it).
      for (const r of [...stale, ...old]) if (r.act) this.removeActEffect(r);
      for (const r of stale) {
        this.closeCard(r);
        if (r.action === 'skill') this.skillDenied(r);
        this.answerNativeTool(r, false);
      }
    }
  }

  /** Whether a refused release's outbox row has its draft undecided. */
  private draftUndecidedOf(r: StoredApproval): boolean {
    if (r.state !== 'refused' || r.act?.kind !== 'release') return false;
    try {
      const row = this.ports.acts?.()?.effect(actEffectId(r.requestId));
      return !!row && draftUndecided(row);
    } catch {
      return false;
    }
  }

  private removeActEffect(r: Pick<StoredApproval, 'requestId'>): void {
    try {
      this.ports.acts?.()?.remove(actEffectId(r.requestId));
    } catch (err) {
      this.log(`[factory] act row of ${r.requestId} not removed: ${String(err)}`);
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

  private postCard(r: StoredApproval, profile: BotProfile, wake: ApprovalWake, changeLines?: readonly string[]): RoomCard | null {
    const writer = this.ports.rooms();
    if (!writer) return null;
    const replyTo = wakeReplyTo(writer, wake, r.workspaceId, r.threadId);
    const what = r.skill
      ? `${r.skill.update ? 'Update the skill' : 'Add the skill'} ${subject(r)}?`
      : r.ownerProfile ? OWNER_PROFILE_TITLE[r.ownerProfile.action]
      : r.botMemory ? BOT_MEMORY_TITLE[r.botMemory.action]
      : r.routine ? 'Save this routine?'
      : r.nativeTool ? 'Let Hermes run this command?'
      : r.act?.kind === 'release' ? releaseCardTitle(r.act, r.actRepo?.fullName ?? r.repoKey)
      : `${ACTION_TITLE[r.action]} ${subject(r)}${r.headSha ? ` at ${r.headSha.slice(0, 7)}` : ''}?`;
    const subjectThread = r.prNumber !== undefined ? prThreadId(r.repoKey, r.prNumber) : r.issueNumber !== undefined ? issueThreadId(r.repoKey, r.issueNumber) : null;
    const lines = [
      askLine(profile, r.reason),
      // "Started from outside text" is the card's own line, from the
      // request's `tainted` (ApprovalAnswers, the phone): not in the body.
      ...(r.action === 'merge' || r.act || CARD_ONLY_ACTIONS.has(r.action) ? [] : ['wmux records your answer; it does not carry this act out yet.']),
    ];
    if (changeLines) lines.push(...changeLines);
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
      ...(guestSourcedWake(wake) ? { origin: 'guest' as const } : {}),
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

  /** `amend`: the card that tells a refusal amended after it was told (its
   *  own clientPostId, so it is posted once); `note`: a line for the body. */
  private outcomeCard(r: StoredApproval, amend?: 'draft', note = ''): void {
    const writer = this.ports.rooms();
    if (!writer) return;
    const by = r.decidedBy === 'rule' ? 'a rule you set' : 'you';
    const done = r.state === 'executed';
    const moved = r.refusal === 'head-moved';
    const full = r.actRepo?.fullName ?? r.repoKey;
    // A release draft's fate (`draft-*` codes) is told in the body, not the title.
    const codes = laneRefusalCodes(r.refusal ?? '');
    const isDraft = (c: string): boolean => r.act?.kind === 'release' && isDraftCode(c);
    const why = laneRefusalLine(codes.filter((c) => !isDraft(c)).join(', '), r.repoKey);
    const title = amend
      ? `${codes.includes('draft-kept-unchecked') ? 'Draft release may still be on GitHub' : 'Draft release still on GitHub'}: ${ACTION_TITLE[r.action]} ${subject(r)}`
      : r.act?.kind === 'release' && done
      ? r.act.mode === 'workflow'
        ? `Tag pushed — the release workflow is building it (${r.act.tagName} on ${full}, approved by you)`
        : `${ACT_DONE_TITLE.release} release ${r.act.tagName} of ${full} (approved by you)`
      : r.act
      ? done ? `${ACT_DONE_TITLE[r.act.kind]} ${r.act.kind === 'issue_create' ? `issue #${r.result?.number ?? '?'} on ${r.repoKey}` : subject(r)} (approved by you)`
        : `Not done: ${ACTION_TITLE[r.action]} ${subject(r)} (${why || 'refused'})`
      : done
        ? `Merged ${subject(r)} (approved by ${by})`
        : moved ? `Not merged: ${subject(r)} has a new head since the request; it needs a new approval` : `Not merged: ${subject(r)} (${laneRefusalLine(r.refusal ?? '') || 'refused'})`;
    // What became of a refused release's draft (its refusal's `draft-*`
    // code), in the body too: a long title is cut.
    const draft = done ? '' : laneRefusalLine(codes.filter(isDraft).join(', '), r.repoKey);
    const body = [draft, note, r.act ? r.result?.url ?? '' : ''].filter(Boolean).join('\n\n');
    writer.post({
      workspaceId: r.workspaceId,
      threadId: r.threadId,
      kind: done ? 'status' : 'refusal',
      actor: { kind: 'system' },
      title,
      ...(body ? { body } : {}),
      refs: { approvalId: r.requestId, ...(r.prNumber !== undefined ? { pr: r.prNumber } : {}), ...(r.issueNumber !== undefined ? { issue: r.issueNumber } : {}) },
      clientPostId: `approval-outcome:${r.requestId}${amend ? `:${amend}` : ''}`,
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
