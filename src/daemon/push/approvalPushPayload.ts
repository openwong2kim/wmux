/**
 * The one place an approval turns into the plaintext the phone's Notification
 * Service Extension reads.
 *
 * It lives here rather than inline at the `onEvent` subscription in
 * `daemon/index.ts` because the rules it encodes are not obvious from either
 * end: the extension decides whether a lock-screen Approve button exists from
 * these fields alone, and it reads an ABSENT field as "I cannot tell", not as
 * "ordinary". Inline in a boot function that mapping had no test, and the first
 * version of it shipped a `risk` that was only ever set on the critical branch
 * — which switched the button off for every approval on earth.
 */
import { PUSH_RISK_NORMAL, type PushPayload } from '../../shared/push/pushEnvelope';
import type { ApprovalRequest } from '../approvals/types';

/** Shown when the agent gave us no question text to quote. */
export const APPROVAL_PUSH_FALLBACK_BODY = 'A pane is waiting on an answer.';

export function buildApprovalPushPayload(request: ApprovalRequest): PushPayload {
  return {
    title: 'Approval needed',
    body: request.question ?? APPROVAL_PUSH_FALLBACK_BODY,
    approvalId: request.id,
    sessionId: request.sessionId,
    // A structured-choice question cannot be answered by a single affirmative,
    // so the extension must drop to a category that only deep-links into the
    // app.
    ...(request.choices?.length ? { requiresInAppChoice: true } : {}),
    // ALWAYS stated, unlike the REST field. See `PushPayload.risk`: the
    // extension has nothing but this payload, so silence there means unknown
    // and costs the button.
    risk: request.risk ?? PUSH_RISK_NORMAL,
  };
}

/** One pending request per pane, so a re-prompt replaces its own banner. */
export function approvalPushCollapseId(request: ApprovalRequest): string {
  return `ap-${request.sessionId}`.slice(0, 64);
}
