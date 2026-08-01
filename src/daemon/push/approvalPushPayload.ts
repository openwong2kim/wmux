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
import { hasElevatedRisk } from '../../shared/criticalPatterns';
import { PUSH_RISK_CRITICAL, PUSH_RISK_NORMAL, type PushPayload } from '../../shared/push/pushEnvelope';
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
    //
    // RE-DERIVED, NOT COPIED FROM `request.risk`. The record's field answers
    // "is this the dangerous class?" and only `critical` patterns set it, so
    // copying it here would stamp `normal` on a `DELETE FROM users` — and
    // `normal` is not a description, it is a grant: the extension reads
    // anything that is not `critical` as "one tap on the lock screen is
    // enough". Before this payload carried a risk at all the field was absent
    // and the button was withheld, so a careless copy would turn a
    // fail-CLOSED into a fail-OPEN for the softer tier. `hasElevatedRisk`
    // counts both tiers for exactly this decision.
    risk: elevatedRisk(request) ? PUSH_RISK_CRITICAL : PUSH_RISK_NORMAL,
  };
}

/**
 * Does anything the agent wrote name a destructive action, at either tier?
 *
 * `choices` labels are scanned too. Today a request that has them also sets
 * `requiresInAppChoice`, which withholds the affirmative on its own — but that
 * is two independent reasons agreeing, not one covering the other, and the day
 * the choice rule changes this must not quietly become the gap.
 */
function elevatedRisk(request: ApprovalRequest): boolean {
  if (request.risk === 'critical') return true;
  return hasElevatedRisk(
    request.question,
    ...(request.options ?? []),
    ...(request.choices ?? []).map((c) => c.label),
  );
}

/** One pending request per pane, so a re-prompt replaces its own banner. */
export function approvalPushCollapseId(request: ApprovalRequest): string {
  return `ap-${request.sessionId}`.slice(0, 64);
}
