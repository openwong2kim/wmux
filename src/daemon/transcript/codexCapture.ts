// #1624 — which Codex resume captures may bind a pane, and which ids get a
// rollout search.
//
// During its first turn Codex also completes an internal title-generation
// thread. Its notify inherits the pane env, so it arrives pane-exact, but it
// never writes a rollout. At notify time it cannot be told apart from a real
// session whose rollout is simply not on disk yet, so the rule is about
// rollouts, not ids:
//   - an id whose rollout exists binds at once (with its path);
//   - otherwise the pane's first pending search wins: a second id with no
//     rollout neither binds nor replaces that search;
//   - a pane already bound to a rollout keeps it until the new id's rollout
//     appears; the search started for that id applies it then.

import { isProvisionalCapture, type ResumeBinding } from '../../shared/agentResume';
import { checkNativeTranscriptPath } from './providers';
import { scanForCodexTranscript, type TranscriptDiscovery } from './TranscriptDiscovery';

/** Search window for an id held back behind a rollout-bound pane. */
export const HELD_BACK_SEARCH_MS = 30_000;

export type CodexCaptureDecision = { apply: false } | { apply: true; binding: ResumeBinding };

/** The vetted rollout path for `id`, if it is on disk now. */
export function findCodexTranscript(id: string, env?: Record<string, string>): string | undefined {
  return scanForCodexTranscript(id, env).find((file) => checkNativeTranscriptPath('codex', file, id, env).ok);
}

/** Decide one Codex capture for pane `id`, starting or cancelling its rollout search as needed. */
export function admitCodexCapture(
  id: string,
  prev: ResumeBinding | undefined,
  next: ResumeBinding,
  env: Record<string, string> | undefined,
  discovery: Pick<TranscriptDiscovery, 'start' | 'cancel' | 'pendingFor'> | null | undefined,
): CodexCaptureDecision {
  const found = next.transcriptPath ?? findCodexTranscript(next.sessionId, env);
  if (found) {
    discovery?.cancel(id);
    return { apply: true, binding: { ...next, transcriptPath: found } };
  }
  const pending = discovery?.pendingFor(id);
  if (pending?.agent === 'codex' && pending.agentSessionId !== next.sessionId) return { apply: false };
  if (isProvisionalCapture(prev, next)) {
    // Held back. A real session's rollout is on disk within seconds of its turn
    // completing, so a short search is enough to adopt a late one; a title
    // thread's search just expires. Past it, the id's next notify rescans.
    discovery?.start(id, next.sessionId, next.cwd, 'codex', HELD_BACK_SEARCH_MS);
    return { apply: false };
  }
  discovery?.start(id, next.sessionId, next.cwd, 'codex');
  return { apply: true, binding: next };
}
