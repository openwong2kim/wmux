// Bot approvals on the phone (contract: shared/phoneBotApprovals.ts):
//
//   GET  /api/bot-approvals/:requestId
//   POST /api/bot-approvals/:requestId/decision   {decision, ruleScope?}
//
// The requests and every decision are Electron main's. A read answers any
// authenticated caller. A decision is taken from the operator token, or from
// a paired device that holds the input grant AND had it set explicitly (the
// rule of the phone git write actions); a server started without
// --allow-input takes none (403 `read-only`). These are checked before the
// body is read, and again on the credential presented when the body is in,
// just before main is asked: it must be the same caller (the same device),
// still granted. Then main is asked over the desktop bridge and its reply is
// parsed with the same allowlist main projected with. No desktop, or one that
// did not announce the commands, is 503; nothing here answers from memory.

import {
  PHONE_BOT_APPROVAL_COMMAND,
  PHONE_BOT_APPROVAL_DECIDE_COMMAND,
  isPhoneBotApprovalId,
  parsePhoneBotApprovalDecideBody,
  parsePhoneBotApprovalReply,
} from '../../shared/phoneBotApprovals';
import { DesktopPhoneError } from '../phone/DesktopPhoneBridge';

export const BOT_APPROVALS_ROUTE = /^\/api\/bot-approvals\/([^/]+)(\/decision)?$/;

/** The part of the desktop bridge the routes use (DesktopPhoneBridge). */
export interface BotApprovalsDesktop {
  supports(command: string): boolean;
  request(command: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface BotApprovalsResponse {
  status: number;
  body: unknown;
}

/** The caller as the server resolved it: for a device, its input grant
 *  under the server's ceiling, and whether that grant was set explicitly
 *  (a record paired before grants existed was not). */
export type BotApprovalsCaller =
  | { kind: 'operator' }
  | { kind: 'device'; deviceId: string; mayInput: boolean; explicitInputGrant: boolean };

export const GRANT_HINT = 'Allow typing for this device on the Remote page, under Phones, on the machine running wmux web.';

/** Why this caller may not decide, or null when it may. `readOnly`: the
 *  server runs without --allow-input. */
export function botApprovalDecisionRefusal(caller: BotApprovalsCaller, readOnly: boolean): BotApprovalsResponse | null {
  if (readOnly) return { status: 403, body: { error: 'read-only' } };
  if (caller.kind === 'operator') return null;
  if (!caller.mayInput) {
    return { status: 403, body: { error: 'read-only: this device was paired without permission to type', detail: `Deciding a bot approval requires input permission. ${GRANT_HINT}` } };
  }
  if (!caller.explicitInputGrant) {
    return { status: 403, body: { error: 'read-only: this device has no explicit input grant', detail: `Deciding a bot approval needs an input grant set for this device. ${GRANT_HINT}` } };
  }
  return null;
}

/** Whether both commands answer on the attached desktop. */
export function botApprovalsSupported(desktop: BotApprovalsDesktop | null): boolean {
  return !!desktop && desktop.supports(PHONE_BOT_APPROVAL_COMMAND) && desktop.supports(PHONE_BOT_APPROVAL_DECIDE_COMMAND);
}

/** `GET /api/bot-approvals/:id` (body undefined) or `POST …/decision`
 *  (the parsed JSON body). Never throws. */
export async function botApprovalsResponse(
  rawId: string,
  view: 'get' | 'decision',
  body: unknown,
  opts: {
    caller: BotApprovalsCaller;
    desktop: BotApprovalsDesktop | null;
    readOnly?: boolean;
    /** Decision only: the caller the credential on this request resolves
     *  to now, or null when it no longer authenticates as the same caller.
     *  Asked once the body is in, before main is. Missing: refused. */
    reauthorize?: () => Promise<BotApprovalsCaller | null>;
  },
): Promise<BotApprovalsResponse> {
  if (view === 'decision') {
    const refused = botApprovalDecisionRefusal(opts.caller, opts.readOnly === true);
    if (refused) return refused;
  }
  let requestId: string;
  try {
    requestId = decodeURIComponent(rawId);
  } catch {
    return { status: 404, body: { error: 'approval-not-found' } };
  }
  if (!isPhoneBotApprovalId(requestId)) return { status: 404, body: { error: 'approval-not-found' } };
  let payload: Record<string, unknown> = { requestId };
  if (view === 'decision') {
    const decided = parsePhoneBotApprovalDecideBody(body);
    if (!decided) return { status: 400, body: { error: 'invalid-decision' } };
    payload = { requestId, ...decided };
  }
  const desktop = opts.desktop;
  if (!desktop) return { status: 503, body: { error: 'desktop-unavailable' } };
  if (!botApprovalsSupported(desktop)) return { status: 503, body: { error: 'approvals-unavailable' } };
  if (view === 'decision') {
    // The credential that sent the headers, checked again now: the same
    // caller (the same device), still allowed to decide.
    let now: BotApprovalsCaller | null = null;
    try {
      now = opts.reauthorize ? await opts.reauthorize() : null;
    } catch {
      now = null;
    }
    if (!now || !sameApprovalsCaller(opts.caller, now)) return { status: 401, body: { error: 'authorization-expired' } };
    const refused = botApprovalDecisionRefusal(now, opts.readOnly === true);
    if (refused) return refused;
    // Main records which device decided.
    if (now.kind === 'device') payload.deviceId = now.deviceId;
  }
  let raw: unknown;
  try {
    raw = await desktop.request(view === 'get' ? PHONE_BOT_APPROVAL_COMMAND : PHONE_BOT_APPROVAL_DECIDE_COMMAND, payload);
  } catch (error) {
    return error instanceof DesktopPhoneError && error.tag === 'desktop-timeout'
      ? { status: 504, body: { error: 'desktop-timeout' } }
      : { status: 503, body: { error: 'desktop-unavailable' } };
  }
  const reply = parsePhoneBotApprovalReply(raw, requestId);
  if (!reply) return { status: 502, body: { error: 'desktop-bad-reply' } };
  if ('unavailable' in reply) return { status: 503, body: { error: 'approvals-unavailable' } };
  if ('notFound' in reply) return { status: 404, body: { error: 'approval-not-found' } };
  if ('invalid' in reply) return { status: 400, body: { error: 'invalid-decision' } };
  if ('refused' in reply) return { status: 409, body: { error: 'approval-refused', code: reply.refused.code, message: reply.refused.message } };
  return { status: 200, body: { request: reply.request } };
}

function sameApprovalsCaller(original: BotApprovalsCaller, now: BotApprovalsCaller): boolean {
  return now.kind === 'operator'
    ? original.kind === 'operator'
    : original.kind === 'device' && now.deviceId === original.deviceId;
}
