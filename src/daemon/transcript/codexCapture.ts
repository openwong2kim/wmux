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
//     appears; the search started for that id applies it then;
//   - a pane with NO rollout-backed binding is not bound either. A fresh pane
//     (a fan-out worker started with an argv prompt, especially) usually hears
//     the title thread first; binding that id left the pane path-less and
//     `no-transcript-path` for good when the real thread was interrupted
//     before its first notify. The pane waits for the real id's rollout, or
//     for the cwd fallback (codexRolloutByCwd.ts), instead.

import type { ResumeBinding } from '../../shared/agentResume';
import type { AgentSignal } from '../../shared/hooks/signal-types';
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
  // Never bind an id whose rollout is not on disk — held back behind a bound
  // pane (isProvisionalCapture) or on a pane with no rollout yet. A real
  // session's rollout is on disk within seconds of its turn completing, so a
  // short search is enough to adopt a late one; a title thread's search just
  // expires. Past it, the id's next notify rescans.
  discovery?.start(id, next.sessionId, next.cwd, 'codex', HELD_BACK_SEARCH_MS);
  return { apply: false };
}

/** How long a stop's rollout may take to appear before the stop is judged a
 *  title thread's. A real thread's rollout is written when its TUI starts. */
export const STOP_ROLLOUT_GRACE_MS = 3_000;
const STOP_ROLLOUT_POLL_MS = 500;

export interface CodexStopGateOptions {
  /** The pane's current binding: a stop for the thread it is already bound to needs no scan. */
  bound?: ResumeBinding;
  env?: Record<string, string>;
  /** The rollout appeared within the grace: handle the stop now, late. */
  admit: () => void;
  /** No rollout within the grace: the stop is not the pane's turn end. */
  drop: () => void;
  graceMs?: number;
  pollMs?: number;
}

/**
 * The title thread's notify arrives as a pane-exact `agent.stop`, often seconds
 * into a long first turn, and used to settle the pane as done. A stop counts as
 * the pane's turn end only for a thread with a rollout. Returns 'pass' when the
 * caller handles the signal now; on 'deferred' exactly one of `admit`/`drop`
 * runs once the grace decides. Dropped, not downgraded: the stop then touches
 * no hook authority, so the screen detector keeps judging a Codex that writes
 * no rollouts at all.
 */
export function gateCodexStop(
  signal: Pick<AgentSignal, 'agent' | 'kind' | 'agentSessionId' | 'payload'>,
  opts: CodexStopGateOptions,
): 'pass' | 'deferred' {
  const id = signal.agentSessionId;
  if (signal.agent !== 'codex' || signal.kind !== 'agent.stop' || !id) return 'pass';
  // A legacy payload names its own transcript; HookIngest vets that path.
  if (typeof signal.payload?.transcript_path === 'string') return 'pass';
  if (opts.bound?.agent === 'codex' && opts.bound.sessionId === id && opts.bound.transcriptPath) return 'pass';
  if (findCodexTranscript(id, opts.env)) return 'pass';
  const deadline = Date.now() + (opts.graceMs ?? STOP_ROLLOUT_GRACE_MS);
  const pollMs = opts.pollMs ?? STOP_ROLLOUT_POLL_MS;
  const tick = (): void => {
    if (findCodexTranscript(id, opts.env)) opts.admit();
    else if (Date.now() >= deadline) opts.drop();
    else setTimeout(tick, pollMs).unref?.();
  };
  setTimeout(tick, pollMs).unref?.();
  return 'deferred';
}
