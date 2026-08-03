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
import type { ApprovalChoice, ApprovalRequest } from '../approvals/types';

/** Shown when the agent gave us no question text to quote. */
export const APPROVAL_PUSH_FALLBACK_BODY = 'A pane is waiting on an answer.';

export function buildApprovalPushPayload(request: ApprovalRequest): PushPayload {
  const choiceFields = lockScreenChoiceFields(request.choices);
  return {
    title: 'Approval needed',
    // The options ride in the body whenever an affirmative is on offer.
    //
    // The extension titles that button from a STATIC category — it cannot name
    // a dynamic one, because a category the notification daemon has not
    // ingested yet renders with no buttons at all, which is worse than a
    // generic word. So the button reads "Approve — first option", and this is
    // what makes that phrase unambiguous: the first option is printed right
    // above it. Without this line somebody would be tapping a pronoun.
    //
    // Same shape the in-app local notifier already uses (` · ` separated), so
    // the two paths read alike.
    body: bodyFor(request, choiceFields.firstOption !== undefined),
    approvalId: request.id,
    sessionId: request.sessionId,
    ...choiceFields,
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
 * The question, plus the options when a button will act on one of them.
 *
 * Only when the affirmative is offered: everywhere else the person opens the
 * app to answer and reads the options on the card, and pasting them onto a
 * lock screen there would be noise rather than consent.
 */
function bodyFor(request: ApprovalRequest, offersAffirmative: boolean): string {
  // A permission gate has no question — name the tool and quote its input, or
  // the banner says "a pane is waiting" for a command that rewrites the disk.
  if (request.kind === 'awaiting_permission') {
    const summary = request.toolInputSummary?.trim();
    return summary ? `${request.toolName}: ${summary}` : `${request.toolName} wants to run`;
  }
  const question = request.question ?? APPROVAL_PUSH_FALLBACK_BODY;
  if (!offersAffirmative) return question;
  const labels = (request.choices ?? []).map((c) => c.label.trim()).filter((l) => l.length > 0);
  return labels.length > 0 ? `${question}\n${labels.join(' · ')}` : question;
}

/**
 * The largest choice set one affirmative button can stand for.
 *
 * Two is the consent shape: a tap means "the first one", and the other side is
 * Deny, which every category already offers. Three is a picker — no single
 * button can represent it without hiding an option — and that keeps the
 * in-app-only category.
 */
const AFFIRMATIVE_MAX_CHOICES = 2;

/**
 * Can a lock-screen affirmative express this question, and what should it say?
 *
 * **Why this is not simply "has choices".** It used to be, and the cost was
 * that the button never appeared at all: the only source of approvals is the
 * `AskUserQuestion` hook, and those always carry structured choices, so every
 * approval on earth took the in-app-only branch. The feature was dark.
 *
 * **Why relaxing it is still safe.** The rule this runs on is that *the
 * button's title is the choice*: a button reading "Approve" asks somebody to
 * commit to text they have not read, and a button reading the option's own
 * label does not. So the affirmative is offered only when there is a label to
 * title it with, and that label travels as `firstOption` for the extension to
 * use. An empty or missing label cannot title a button, so it falls back
 * rather than borrowing a generic word.
 *
 * `risk` is unaffected and still decides this independently — `elevatedRisk`
 * already scans choice labels precisely so that this relaxation could not turn
 * into a gap.
 */
function lockScreenChoiceFields(
  choices?: ApprovalChoice[],
): { requiresInAppChoice?: true; firstOption?: string } {
  // No structured choices at all is the pre-existing shape: the extension's
  // static category already handles it and nothing here should change.
  if (!choices?.length) return {};

  const labels = choices.map((c) => c.label?.trim() ?? '');
  if (choices.length > AFFIRMATIVE_MAX_CHOICES || labels.some((l) => l.length === 0)) {
    return { requiresInAppChoice: true };
  }
  return { firstOption: labels[0] };
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
  // A permission gate (#783) carries no question and no choices — the thing
  // being approved is the tool call itself. Scanning only the question would
  // score every gate as `normal` and light up the one-tap lock-screen button
  // for `rm -rf` with nothing on screen to read (review: Claude). The tool name
  // and its input summary ARE the text to judge here.
  if (request.kind === 'awaiting_permission') {
    return hasElevatedRisk(request.toolName, request.toolInputSummary);
  }
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
