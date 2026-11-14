// Daemon-owned delivery of the fan-out caller nudge (one fixed line telling a
// pane agent that its fan-out workers moved; see shared/fanoutCallerNudge) and
// of the PR owner nudge that shares its queue (shared/prOwnerNudge).
//
// Reuses deliverScheduledPrompt for the write itself — process identity
// (slug + incarnation) before the paste and before the Enter, a live process,
// an idle composer, and an input revision that moved by exactly our paste, so
// a key pressed between the paste and the Enter cancels the Enter.
//
// On top of that, a person at the keyboard wins: the line waits while the
// composer holds an unsubmitted draft or a key reached the pane within the
// last CALLER_NUDGE_QUIET_MS. Those answers are 'held' (nothing written) so
// the sender keeps the line and tries again later.

import type { SessionPromptScheduleResult } from '../shared/sessionPromptSchedule';
import { isCallerNudge } from '../shared/prOwnerNudge';
import type { ScheduledPromptDeliveryDeps } from './sessionPromptDelivery';

export const CALLER_NUDGE_QUIET_MS = 10_000;

/** `approval_pending`: nothing written, the pane is on a folder-trust prompt (or cannot rule one out). */
export type CallerNudgeResult = 'sent' | 'held' | 'approval_pending' | 'session_changed' | 'unavailable' | 'error';

export interface CallerNudgeReply {
  result: CallerNudgeResult;
  /** The paste was attempted: the line may be in the composer. */
  pasted: boolean;
}

export interface CallerNudgeDeps {
  /** The pane is held at a usage limit. */
  usageHeld: () => boolean;
  /** The session's input state; undefined when the session is gone. */
  input: () => { hasDraft(): boolean; isKeyInputQuietFor(ms: number): boolean } | undefined;
  /** Lets the screen clear a draft mark that outlived its draft (draftScreen.ts). */
  refreshDraft?: () => Promise<unknown>;
  /** deliverScheduledPrompt bound to the session, slug and incarnation. */
  deliver: (opts: Pick<ScheduledPromptDeliveryDeps, 'authorized' | 'onWrite'>) => Promise<SessionPromptScheduleResult>;
  quietMs?: number;
}

export async function deliverCallerNudge(prompt: string, deps: CallerNudgeDeps): Promise<CallerNudgeReply> {
  if (!isCallerNudge(prompt)) return { result: 'error', pasted: false };
  if (deps.usageHeld()) return { result: 'held', pasted: false };
  const input = deps.input();
  if (!input) return { result: 'unavailable', pasted: false };
  const quietMs = deps.quietMs ?? CALLER_NUDGE_QUIET_MS;
  const quiet = (): boolean => !input.hasDraft() && input.isKeyInputQuietFor(quietMs);
  // Checked here as well as in `authorized`: a refusal there reads as 'error',
  // the same answer as an abort after the paste.
  await deps.refreshDraft?.();
  if (!quiet()) return { result: 'held', pasted: false };
  let pasted = false;
  const result = await deps.deliver({
    // Our own paste makes a draft, so the submit stage leans on the
    // input-revision proof instead.
    authorized: async (stage) => stage === 'submit' || quiet(),
    onWrite: (stage) => {
      if (stage === 'paste') pasted = true;
    },
  });
  switch (result) {
    case 'sent':
      return { result: 'sent', pasted: true };
    case 'busy':
      return { result: 'held', pasted };
    case 'session_changed':
      return { result: 'session_changed', pasted };
    case 'folder_trust':
      return { result: 'approval_pending', pasted: false };
    case 'unavailable':
      return { result: 'unavailable', pasted };
    case 'error':
      return { result: !pasted && !quiet() ? 'held' : 'error', pasted };
    default: {
      // Every delivery result is mapped above; a new one fails typecheck here.
      const unmapped: never = result;
      void unmapped;
      return { result: 'error', pasted };
    }
  }
}
