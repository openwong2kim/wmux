// ─── A bot's approval requests, as the phone sees and answers them
//
//   GET  /api/bot-approvals/:requestId            → 200 {request}
//   POST /api/bot-approvals/:requestId/decision   {decision, ruleScope?} → 200 {request}
//
// The requests live in Electron main (factory/approvals.ts). The daemon gates
// (any caller reads; a decision takes the operator token or a paired device
// with an explicit input grant, and the daemon sends that device's id along
// as `deviceId`), asks main over the desktop bridge with the two commands
// below, and parses main's reply with the same allowlist main projected
// with. A decision is main's:
// `ApprovalService.decide(…, 'phone')`, the same rules as the desktop card
// (an approved merge waits APPROVAL_UNDO_MS with Undo; `always` is offered
// for a merge only). The view carries no bot-written text (the request's
// reason is on its room card).
//
// Room cards: an `approval` card's refs carry `approvalId`, the requestId
// these routes take (shared/phoneRooms.ts).

import { APPROVAL_ACTIONS, APPROVAL_ID_RE, APPROVAL_NEVER_BY_RULE, type ApprovalAction, type ApprovalRequest, type ApprovalState } from './botApproval';
import { parseThreadId, type ThreadId } from './room';

export const PHONE_BOT_APPROVAL_COMMAND = 'workspaces.botApproval';
export const PHONE_BOT_APPROVAL_DECIDE_COMMAND = 'workspaces.botApprovalDecide';

export const PHONE_BOT_APPROVAL_DECISIONS = ['approve', 'deny', 'undo', 'always'] as const;
export type PhoneBotApprovalDecision = (typeof PHONE_BOT_APPROVAL_DECISIONS)[number];

const STATES: readonly ApprovalState[] = ['pending', 'approved', 'denied', 'undone', 'executed', 'refused', 'expired'];

/** One request as the phone sees it. */
export interface PhoneBotApproval {
  requestId: string;
  action: ApprovalAction;
  workspaceId: string;
  threadId: ThreadId;
  botId: string;
  repoKey: string;
  prNumber?: number;
  issueNumber?: number;
  headSha?: string;
  /** Started from outside text: no rule approves it. */
  tainted: boolean;
  state: ApprovalState;
  decidedBy?: 'owner' | 'rule';
  decidedAt?: number;
  /** An approved merge runs at this time unless undone first. */
  executeAfter?: number;
  /** Main's reason for `refused` (head-moved, …). */
  refusal?: string;
  createdAt: number;
  updatedAt: number;
  /** `always` may be sent (a merge still pending). */
  canAlwaysAllow: boolean;
}

/** `POST …/decision` body. */
export interface PhoneBotApprovalDecideBody {
  decision: PhoneBotApprovalDecision;
  /** decision `always`: one bot (default) or every bot of its workspace. */
  ruleScope?: 'bot' | 'workspace';
}

/** Main's reply to either command. */
export type PhoneBotApprovalReply =
  | { request: PhoneBotApproval }
  | { refused: { code: string; message: string } }
  | { unavailable: true }
  | { notFound: true }
  | { invalid: true };

const LINE_MAX = 200;

/** The acts the phone shows and decides: not a bot's skill proposal, which
 *  is approved on its desktop card, where its change is shown. */
export const PHONE_APPROVAL_ACTIONS: readonly ApprovalAction[] = APPROVAL_ACTIONS.filter((a) => a !== 'skill');

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function line(v: unknown, max = LINE_MAX): string | undefined {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) return undefined;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return undefined;
  }
  return v;
}
function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined;
}
function time(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

export function isPhoneBotApprovalId(v: unknown): v is string {
  return typeof v === 'string' && APPROVAL_ID_RE.test(v);
}

/** A request as the phone may see it, or null. Idempotent: main projects a
 *  request with it and the daemon parses main's reply with it. */
export function parsePhoneBotApproval(value: unknown): PhoneBotApproval | null {
  if (!isRecord(value)) return null;
  const requestId = isPhoneBotApprovalId(value.requestId) ? value.requestId : undefined;
  const action = (PHONE_APPROVAL_ACTIONS as readonly unknown[]).includes(value.action) ? value.action as ApprovalAction : undefined;
  const state = (STATES as readonly unknown[]).includes(value.state) ? value.state as ApprovalState : undefined;
  const threadId = parseThreadId(value.threadId);
  const workspaceId = line(value.workspaceId);
  const botId = line(value.botId);
  const repoKey = line(value.repoKey);
  const createdAt = time(value.createdAt);
  const updatedAt = time(value.updatedAt);
  if (!requestId || !action || !state || !threadId || !workspaceId || !botId || !repoKey || createdAt === undefined || updatedAt === undefined) return null;
  const prNumber = count(value.prNumber);
  const issueNumber = count(value.issueNumber);
  const headSha = typeof value.headSha === 'string' && /^[0-9a-f]{7,64}$/i.test(value.headSha) ? value.headSha : undefined;
  const decidedBy = value.decidedBy === 'owner' || value.decidedBy === 'rule' ? value.decidedBy : undefined;
  const decidedAt = time(value.decidedAt);
  const executeAfter = time(value.executeAfter);
  const refusal = line(value.refusal, 300);
  return {
    requestId, action, workspaceId, threadId, botId, repoKey,
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(headSha ? { headSha } : {}),
    tainted: value.tainted !== false,
    state,
    ...(decidedBy ? { decidedBy } : {}),
    ...(decidedAt !== undefined ? { decidedAt } : {}),
    ...(executeAfter !== undefined ? { executeAfter } : {}),
    ...(refusal ? { refusal } : {}),
    createdAt, updatedAt,
    canAlwaysAllow: state === 'pending' && action === 'merge' && !APPROVAL_NEVER_BY_RULE.has(action),
  };
}

/** Main's projection of one of its requests. */
export function phoneBotApproval(r: ApprovalRequest & { executeAfter?: number }): PhoneBotApproval | null {
  return parsePhoneBotApproval(r);
}

/** A decision body, or null when it is not one (unknown fields refused). */
export function parsePhoneBotApprovalDecideBody(value: unknown): PhoneBotApprovalDecideBody | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((k) => k !== 'decision' && k !== 'ruleScope')) return null;
  if (!(PHONE_BOT_APPROVAL_DECISIONS as readonly unknown[]).includes(value.decision)) return null;
  if (value.ruleScope !== undefined && (value.decision !== 'always' || (value.ruleScope !== 'bot' && value.ruleScope !== 'workspace'))) return null;
  return { decision: value.decision as PhoneBotApprovalDecision, ...(value.ruleScope ? { ruleScope: value.ruleScope as 'bot' | 'workspace' } : {}) };
}

/** Main's reply as the daemon accepts it, or null (a bad reply). */
export function parsePhoneBotApprovalReply(value: unknown, requestId: string): PhoneBotApprovalReply | null {
  if (!isRecord(value)) return null;
  if (value.unavailable === true) return { unavailable: true };
  if (value.notFound === true) return { notFound: true };
  if (value.invalid === true) return { invalid: true };
  if (isRecord(value.refused)) {
    const code = line(value.refused.code, 40);
    const message = line(value.refused.message, 300) ?? '';
    return code ? { refused: { code, message } } : null;
  }
  const request = parsePhoneBotApproval(value.request);
  return request && request.requestId === requestId ? { request } : null;
}
