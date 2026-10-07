/**
 * `turn_failed` push (contract §7): one per failed turn, sealed like every
 * notification. Lock-screen safe by construction: the reason picks a STATIC
 * body, and the provider's own `message` never travels here (it is
 * transcript-grade text, served only on routes behind `--allow-transcript`).
 */
import type { PushPayload } from '../../shared/push/pushEnvelope';
import type { TurnFailure, TurnFailureReason } from '../../shared/phoneTurnFailure';

export const TURN_FAILED_KIND = 'turn_failed';

const BODY: Readonly<Record<TurnFailureReason, string>> = {
  'rate-limited': 'The agent hit a rate limit and stopped.',
  quota: 'The agent ran out of quota and stopped.',
  auth: 'The agent could not sign in and stopped.',
  network: 'The agent lost its connection and stopped.',
  unknown: 'The agent stopped on an error.',
};

export function buildTurnFailedPushPayload(sessionId: string, failure: TurnFailure): PushPayload {
  return {
    title: 'Turn failed',
    body: BODY[failure.reason] ?? BODY.unknown,
    sessionId,
    kind: TURN_FAILED_KIND,
    ...(failure.turnId ? { turnId: failure.turnId } : {}),
    at: failure.at,
    reason: failure.reason,
    provider: failure.provider,
  };
}

/** Its own prefix: a failure banner must never replace a pane's approval banner (`ap-`). */
export function turnFailedPushCollapseId(sessionId: string): string {
  return `tf-${sessionId}`.slice(0, 64);
}
