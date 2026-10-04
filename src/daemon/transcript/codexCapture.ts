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
import { findCodexTranscriptCandidates, type TranscriptDiscovery } from './TranscriptDiscovery';

/** Search window for an id held back behind a rollout-bound pane. */
export const HELD_BACK_SEARCH_MS = 30_000;

export type CodexCaptureDecision = { apply: false } | { apply: true; binding: ResumeBinding };

/** The vetted rollout path for `id`, if it is on disk now (day-folder bounded for a UUIDv7 id). */
export function findCodexTranscript(id: string, env?: Record<string, string>): string | undefined {
  return findCodexTranscriptCandidates(id, env).find((file) => checkNativeTranscriptPath('codex', file, id, env).ok);
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

type GateSignal = Pick<AgentSignal, 'agent' | 'kind' | 'agentSessionId' | 'payload'>;

export interface CodexStopGateOptions<S extends GateSignal> {
  /** The pane's current binding: a stop for the thread it is already bound to needs no scan. */
  bound?: ResumeBinding;
  env?: Record<string, string>;
  /** A WSL pane: its rollouts live in the distro, which this process does not scan. */
  wsl?: boolean;
  /** The rollout appeared within the grace: handle the stop now, late. */
  admit: (signal: S) => void;
  /** No rollout within the grace: the stop is not the pane's turn end. */
  drop: () => void;
  graceMs?: number;
  pollMs?: number;
}

/** The signal with its found rollout attached, so admission needs no second scan (HookIngest still vets it). */
function withRollout<S extends GateSignal>(signal: S, file: string): S {
  return { ...signal, payload: { ...signal.payload, transcript_path: file } };
}

/**
 * The title thread's notify arrives as a pane-exact `agent.stop`, often seconds
 * into a long first turn, and used to settle the pane as done. Returns the
 * signal to handle now (with its rollout path attached when one was found), or
 * null when the stop is held; then exactly one of `admit`/`drop` runs once the
 * grace decides.
 *
 * A stop is held only when this process can prove where the pane's rollouts
 * are written: the pane is bound to a rollout that the pane env's sessions root
 * contains. Without that proof (a fresh unbound pane, a WSL pane, CODEX_HOME
 * set in a shell rc file, an unreadable root) a missing rollout says nothing
 * about the thread, and the stop passes as before. Dropped, not downgraded: the
 * stop then touches no hook authority, so the screen detector still judges.
 */
export function gateCodexStop<S extends GateSignal>(signal: S, opts: CodexStopGateOptions<S>): S | null {
  const id = signal.agentSessionId;
  if (signal.agent !== 'codex' || signal.kind !== 'agent.stop' || !id || opts.wsl) return signal;
  // A legacy payload names its own transcript; HookIngest vets that path.
  if (typeof signal.payload?.transcript_path === 'string') return signal;
  const bound = opts.bound?.agent === 'codex' ? opts.bound : undefined;
  if (bound?.transcriptPath && bound.sessionId === id) return withRollout(signal, bound.transcriptPath);
  const found = findCodexTranscript(id, opts.env);
  if (found) return withRollout(signal, found);
  const rootProven = !!bound?.transcriptPath
    && checkNativeTranscriptPath('codex', bound.transcriptPath, bound.sessionId, opts.env).ok;
  if (!rootProven) return signal;
  const deadline = Date.now() + (opts.graceMs ?? STOP_ROLLOUT_GRACE_MS);
  const pollMs = opts.pollMs ?? STOP_ROLLOUT_POLL_MS;
  const tick = (): void => {
    const late = findCodexTranscript(id, opts.env);
    if (late) opts.admit(withRollout(signal, late));
    else if (Date.now() >= deadline) opts.drop();
    else setTimeout(tick, pollMs).unref?.();
  };
  setTimeout(tick, pollMs).unref?.();
  return null;
}
