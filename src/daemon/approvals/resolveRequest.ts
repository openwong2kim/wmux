// ─── daemon.approvals.resolve — request parsing, and WHO is asking ──────────
//
// Split out of daemon/index.ts so the one decision that turns the press scope
// on or off is testable on its own.
//
// `resolver: 'human'` short-circuits `decideApprovalPress` entirely — a human
// looking at a prompt is not subject to a workspace classification. That makes
// it an authorization input, and an authorization input a caller can set is not
// one. It is therefore NOT read from params: it is derived from the pipe
// client's first-party classification, which the daemon assigns
// (`daemon.client.identify` + DaemonPipeServer.markFirstParty), not the caller.
//
// Who is human, concretely:
//   - the renderer/main process, which is where the desktop approval UI lives;
//   - the web HTTP route, which does not come through this RPC at all —
//     WebTerminalServer calls `registry.resolve` directly with an authenticated
//     device principal, and passes no resolver, so it takes the 'human' default
//     of ApprovalResolveParams.
// Everything else on this pipe — the CLI, the bundled MCP server, an
// orchestrator brain, any local process holding the token — is AUTOMATED.
//
// The default is `automated`, so a client that has not identified is scoped
// rather than trusted, and a new caller cannot opt out by forgetting a field.
//
// ── The one thing a caller MAY say about itself (orchestrator wave 2) ───────
//
// A first-party client can ask to be treated as AUTOMATED (`resolver:
// 'automated'` in params). That is a DOWNGRADE and only a downgrade: it can
// never turn an automated client into a human one, so it grants nothing — it
// gives up the human short-circuit and submits to `decideApprovalPress`.
//
// It exists because main is first-party for good reasons (it hosts the desktop
// approval UI, where a person really is looking at the prompt) AND is the
// process that relays a BRAIN's press (`approval.press`). Without this, the
// brain's press would inherit main's 'human' classification and skip the entire
// press scope — the scope would govern nothing at all, since no other caller
// class reaches this RPC. Main declares `automated` on the brain's behalf, and
// its own desktop UI keeps saying nothing and stays human.

import type { ApprovalDecision, ApprovalResolveParams } from './types';

/** A malformed request, with the wire reason to answer. */
export interface ApprovalResolveRejection {
  ok: false;
  reason: 'not-found' | 'invalid-choice-key';
}

export function parseApprovalResolveRequest(
  params: Record<string, unknown>,
  ctx: { isFirstParty: boolean },
): ApprovalResolveParams | ApprovalResolveRejection {
  const id = typeof params['id'] === 'string' ? params['id'] : '';
  // Anything that is not exactly one of the two decisions is refused rather
  // than defaulted: guessing between "approve" and "deny" on a pipe client's
  // typo is not a recoverable mistake.
  const decision: ApprovalDecision | null =
    params['decision'] === 'approve' || params['decision'] === 'deny'
      ? (params['decision'] as ApprovalDecision)
      : null;
  if (!id || !decision) return { ok: false, reason: 'not-found' };

  // Presence-sensitive: never turn a malformed choice into a legacy
  // first-option press, and never let a deny request smuggle an affirmative
  // choice digit.
  const rawChoice = params['choiceKey'];
  const hasChoiceKey = rawChoice !== undefined;
  if (
    hasChoiceKey &&
    (decision !== 'approve' || typeof rawChoice !== 'string' || !/^\d{1,2}$/.test(rawChoice))
  ) {
    return { ok: false, reason: 'invalid-choice-key' };
  }

  // Derived, never declared UPWARD. A first-party caller may declare itself
  // automated (a downgrade — see the header); nothing can declare itself human.
  const declaredAutomated = params['resolver'] === 'automated';

  return {
    id,
    decision,
    // Bounded and stripped by the registry (sanitizeResolvedBy) — this field is
    // persisted, logged, and echoed back to a racing client.
    resolvedBy: typeof params['resolvedBy'] === 'string' ? params['resolvedBy'] : '',
    resolver: ctx.isFirstParty && !declaredAutomated ? 'human' : 'automated',
    ...(hasChoiceKey ? { choiceKey: rawChoice as string } : {}),
  };
}
