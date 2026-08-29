// Atomic, daemon-owned delivery for one scheduled prompt occurrence.

import type { AgentSlug } from '../shared/agentIdentity';
import type { SessionPromptScheduleResult } from '../shared/sessionPromptSchedule';
import type { AgentStatus } from '../shared/types';
import {
  formatBracketedPastePayload,
  isMultilinePtyPayload,
} from '../shared/ptyMessageDelivery';

export const SESSION_PROMPT_SUBMIT_DELAY_MS = 100;

export interface ScheduledPromptAgentState {
  slug: AgentSlug;
  incarnationId: string | null;
  status: AgentStatus;
  inputQuiet: boolean;
  inputRevision: number;
}

export interface ScheduledPromptDeliveryDeps {
  getAgentState: () => ScheduledPromptAgentState | null;
  /** Returns false if the session disappeared before this write. */
  write: (data: string) => boolean;
  delay?: (ms: number) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isReady(status: AgentStatus): boolean {
  return status === 'idle' || status === 'waiting' || status === 'complete';
}

function isSafeAfterPaste(before: AgentStatus, after: AgentStatus): boolean {
  if (isReady(after)) return true;

  // An unsettled idle pane can echo the bracketed paste as terminal output.
  // ActivityMonitor then briefly reports `running` even though no turn was
  // submitted. Identity and the exact input revision remain the safety proof.
  return before === 'idle' && after === 'running';
}

/**
 * Paste and submit while the daemon still owns the authoritative process,
 * activity, and input streams. Identity is checked before both writes. The
 * input revision must advance exactly once (our paste), so human input during
 * the submit delay aborts Enter instead of executing a mixed draft.
 */
export async function deliverScheduledPrompt(
  expectedSlug: AgentSlug,
  expectedIncarnationId: string,
  prompt: string,
  deps: ScheduledPromptDeliveryDeps,
): Promise<SessionPromptScheduleResult> {
  const before = deps.getAgentState();
  if (!before || before.slug !== expectedSlug) return 'unavailable';
  if (before.incarnationId !== expectedIncarnationId) return 'session_changed';
  if (!isReady(before.status) || !before.inputQuiet) return 'busy';

  try {
    if (!deps.write(formatBracketedPastePayload(prompt))) return 'unavailable';
  } catch {
    return 'error';
  }

  await (deps.delay ?? sleep)(SESSION_PROMPT_SUBMIT_DELAY_MS);
  const after = deps.getAgentState();
  if (
    !after ||
    after.slug !== expectedSlug ||
    after.incarnationId !== expectedIncarnationId ||
    !isSafeAfterPaste(before.status, after.status) ||
    after.inputRevision !== before.inputRevision + 1
  ) {
    // The paste may already be visible. Never retry or press Enter after the
    // safety proof changed; the persisted occurrence is consumed as error.
    return 'error';
  }

  try {
    const submit = isMultilinePtyPayload(prompt) ? '\r\r' : '\r';
    return deps.write(submit) ? 'sent' : 'error';
  } catch {
    return 'error';
  }
}
