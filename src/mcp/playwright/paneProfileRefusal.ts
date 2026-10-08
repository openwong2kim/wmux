// Leaf module (no wmux imports beyond shared constants) so toolError.ts, the
// scope funnel and the engine can all recognize the refusal without a cycle.
import { PANE_PROFILE_UNRESOLVED_CODE } from '../../shared/chromePaneBinding';

const EXPLANATION =
  'the browser profile for this pane could not be resolved. This workspace binds browser profiles per pane, ' +
  'and wmux could not tell which pane this session runs in, so the browser call was refused. Do not retry ' +
  'through another browser, profile or account: it would act as a different signed-in user. Ask the user to ' +
  "check the pane's browser profile, or restart this agent from inside that pane.";

/**
 * main's fail-closed refusal for a workspace with pane-bound browser profiles
 * when it cannot tell which pane the caller is (src/shared/chromePaneBinding.ts).
 * Carries the agent-facing explanation; main's own detail rides along.
 */
export class PaneProfileUnresolvedError extends Error {
  readonly code = PANE_PROFILE_UNRESOLVED_CODE;

  constructor(detail?: string) {
    super(`${PANE_PROFILE_UNRESOLVED_CODE}: ${EXPLANATION}${detail ? ` (${detail})` : ''}`);
    this.name = 'PaneProfileUnresolvedError';
  }
}

/**
 * The pane-profile refusal hidden in `error`, or null. Recognizes the typed
 * error and main's raw `PANE_PROFILE_UNRESOLVED: …` message, also when another
 * layer wrapped it, and turns the latter into the typed one.
 */
export function paneProfileRefusal(error: unknown): PaneProfileUnresolvedError | null {
  if (error instanceof PaneProfileUnresolvedError) return error;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const at = message.indexOf(`${PANE_PROFILE_UNRESOLVED_CODE}:`);
  if (at < 0) return null;
  let detail = message.slice(at + PANE_PROFILE_UNRESOLVED_CODE.length + 1).trim();
  // Already explained once (a layer re-wrapped the typed error): keep only
  // main's detail, so the explanation is never repeated.
  if (detail.startsWith(EXPLANATION)) detail = detail.slice(EXPLANATION.length).trim().replace(/^\((.*)\)$/s, '$1');
  return new PaneProfileUnresolvedError(detail.slice(0, 200) || undefined);
}
