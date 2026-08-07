/**
 * The ONE danger verdict on an approval request, shared by every notification
 * path.
 *
 * It lives in its own module because there are now two consumers with very
 * different consequences — the sealed phone payload, where the verdict decides
 * whether a one-tap lock-screen approve button exists, and the outbound
 * webhook/ntfy sink, where it decides how loudly the phone rings. A second copy
 * of this logic is not a duplication smell, it is a future disagreement about
 * what counts as dangerous: the day someone tightens one scan, the other path
 * keeps calling `rm -rf` ordinary. One function, one verdict, both callers.
 *
 * Note what does NOT leave here: only a boolean. The strings scanned are
 * agent-authored text that the webhook path must never transmit.
 */
import { hasElevatedRisk } from '../../shared/criticalPatterns';
import type { ApprovalRequest } from '../approvals/types';

/**
 * Does anything the agent wrote name a destructive action, at either tier?
 *
 * `choices` labels are scanned too. Today a request that has them also sets
 * `requiresInAppChoice`, which withholds the affirmative on its own — but that
 * is two independent reasons agreeing, not one covering the other, and the day
 * the choice rule changes this must not quietly become the gap.
 *
 * A permission gate (#783) carries no question and no choices — the thing being
 * approved is the tool call itself. Scanning only the question would score every
 * gate as `normal` and light up the one-tap lock-screen button for `rm -rf` with
 * nothing on screen to read (review: Claude). The tool name and its input
 * summary ARE the text to judge there.
 */
export function approvalHasElevatedRisk(request: ApprovalRequest): boolean {
  if (request.risk === 'critical') return true;
  if (request.kind === 'awaiting_permission') {
    return hasElevatedRisk(request.toolName, request.toolInputSummary);
  }
  return hasElevatedRisk(
    request.question,
    ...(request.options ?? []),
    ...(request.choices ?? []).map((c) => c.label),
  );
}
