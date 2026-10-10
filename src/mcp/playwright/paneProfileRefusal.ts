// Leaf module (no wmux imports beyond shared constants) so toolError.ts, the
// scope funnel and the engine can all recognize the refusal without a cycle.
import { PANE_PROFILE_UNRESOLVED_CODE } from '../../shared/chromePaneBinding';
import { browserPolicyRefusal } from '../../shared/browserPolicy';

const EXPLANATION =
  'the browser profile for this pane could not be resolved. This workspace binds browser profiles per pane, ' +
  'and wmux could not tell which pane this session runs in, so the browser call was refused. Do not retry ' +
  'through another browser, profile or account: it would act as a different signed-in user. Ask the user to ' +
  "check the pane's browser profile, or restart this agent from inside that pane.";

/**
 * main's fail-closed refusal for a workspace with pane-bound browser profiles
 * when it cannot tell which pane the caller is (src/shared/chromePaneBinding.ts).
 * Carries only the agent-facing explanation: main's own text says the same
 * thing, and repeating it reads as two errors.
 */
export class PaneProfileUnresolvedError extends Error {
  readonly code = PANE_PROFILE_UNRESOLVED_CODE;

  constructor() {
    super(`${PANE_PROFILE_UNRESOLVED_CODE}: ${EXPLANATION}`);
    this.name = 'PaneProfileUnresolvedError';
  }
}

/**
 * The code as a message PREFIX, optionally after one `<rpc.method>: ` segment
 * (main answers `${method}: PANE_PROFILE_UNRESOLVED: …`). Never a substring
 * anywhere else: a page title or URL quoted inside some other error must not
 * turn that error into this refusal.
 */
const REFUSAL_PREFIX = new RegExp(
  `^(?:[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*:[ \\t]+)?${PANE_PROFILE_UNRESOLVED_CODE}:`,
);

/**
 * The pane-profile refusal `error` carries, or null: the typed error itself, or
 * main's raw message turned into the typed one.
 */
export function paneProfileRefusal(error: unknown): PaneProfileUnresolvedError | null {
  if (error instanceof PaneProfileUnresolvedError) return error;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return REFUSAL_PREFIX.test(message) ? new PaneProfileUnresolvedError() : null;
}

/**
 * Either refusal main answers a browser call with when the caller's pane may
 * not act — the pane-profile refusal above, or a protected pane's
 * policy_denied / needs_consent (src/shared/browserPolicy.ts). Both are final
 * answers: every retry, fallback or "unknown → carry on" path must rethrow it.
 */
export function browserCallRefusal(error: unknown): Error | null {
  return paneProfileRefusal(error) ?? browserPolicyRefusal(error);
}
