// Atomic, daemon-owned delivery for one scheduled prompt occurrence.

import type { AgentSlug } from '../shared/agentIdentity';
import type { SessionPromptScheduleResult } from '../shared/sessionPromptSchedule';
import type { AgentStatus } from '../shared/types';
import {
  formatBracketedPastePayload,
  isMultilinePtyPayload,
} from '../shared/ptyMessageDelivery';

export const SESSION_PROMPT_SUBMIT_DELAY_MS = 100;
/** Claude Code reads a pasted image path asynchronously before the next paste. */
export const SESSION_PROMPT_ATTACHMENT_DELAY_MS = 600;

export interface ScheduledPromptAgentState {
  slug: AgentSlug;
  incarnationId: string | null;
  status: AgentStatus;
  inputQuiet: boolean;
  inputRevision: number;
}

export interface ScheduledPromptDeliveryDeps {
  getAgentState: () => ScheduledPromptAgentState | null;
  /** #1307 — a fresh liveness read of the tracked process, called
   *  before the paste and again before Enter; getAgentState's
   *  snapshot can lag the process table by a poll (~15-28s). */
  isAgentProcessAlive: () => Promise<boolean>;
  /** Returns false if the session disappeared before this write. */
  write: (data: string) => boolean;
  delay?: (ms: number) => Promise<void>;
  /** Native composer submission, when different from Claude multiline input. */
  submitKeys?: '\r';
  /** Chat only: the agent's composer queues a prompt typed during a turn. */
  acceptRunning?: boolean;
  /** Chat only: pasted one by one before the prompt (image paths). */
  leadingPastes?: readonly string[];
  /** Caller re-authorization, run immediately before the first write
   *  (`first-write`: the first leading paste, else the prompt paste) and
   *  again as the last await before the submit write (`submit`).
   *  `false` stops with `error` and writes nothing further. */
  authorized?: (stage: 'first-write' | 'submit') => Promise<boolean>;
  /** Called immediately before each write is attempted, so a caller can tell
   *  "nothing reached the PTY" from "the paste may be visible". `queued` is
   *  true on `submit` when the prompt was accepted while the turn ran. */
  onWrite?: (stage: 'paste' | 'submit', queued?: boolean) => void;
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
  const running = !!deps.acceptRunning && before.status === 'running';
  if (!(isReady(before.status) || running) || !before.inputQuiet) return 'busy';
  const leading = deps.leadingPastes ?? [];

  // A fresh read of the tracked pid, closing the gap between
  // getAgentState's snapshot above and the current process table.
  try {
    if (!(await deps.isAgentProcessAlive())) return 'unavailable';
  } catch {
    return 'unavailable';
  }

  // Between our own pastes nothing else may have reached the composer: the
  // same process, and exactly the writes we made so far.
  const untouched = (writes: number): boolean => {
    const now = deps.getAgentState();
    return !!now && now.slug === expectedSlug && now.incarnationId === expectedIncarnationId &&
      now.inputRevision === before.inputRevision + writes;
  };
  try {
    if (deps.authorized && !(await deps.authorized('first-write'))) return 'error';
  } catch {
    return 'error';
  }

  try {
    for (const [index, paste] of leading.entries()) {
      // Only the first write can still be refused cleanly; after it the
      // composer already holds our input.
      if (index > 0 && !untouched(index)) return 'error';
      deps.onWrite?.('paste');
      if (!deps.write(formatBracketedPastePayload(paste))) return index === 0 ? 'unavailable' : 'error';
      await (deps.delay ?? sleep)(SESSION_PROMPT_ATTACHMENT_DELAY_MS);
    }
    if (leading.length && !untouched(leading.length)) return 'error';
    deps.onWrite?.('paste');
    if (!deps.write(formatBracketedPastePayload(leading.length ? ` ${prompt}` : prompt))) return leading.length ? 'error' : 'unavailable';
  } catch {
    return 'error';
  }

  await (deps.delay ?? sleep)(SESSION_PROMPT_SUBMIT_DELAY_MS);
  // #1307 — the agent can exit inside the submit delay, leaving the paste in
  // the shell's input line. Checked before the state re-read, so the input
  // revision check stays the last thing before Enter.
  try {
    if (!(await deps.isAgentProcessAlive())) return 'error';
  } catch {
    return 'error';
  }

  // A grant withdrawn inside the submit delay must not be pressed through.
  // The last await before Enter: only synchronous state checks follow it.
  try {
    if (deps.authorized && !(await deps.authorized('submit'))) return 'error';
  } catch {
    return 'error';
  }

  const after = deps.getAgentState();
  if (
    !after ||
    after.slug !== expectedSlug ||
    after.incarnationId !== expectedIncarnationId ||
    !(isSafeAfterPaste(before.status, after.status) || running && after.status === 'running') ||
    after.inputRevision !== before.inputRevision + leading.length + 1
  ) {
    // The paste may already be visible. Never retry or press Enter after the
    // safety proof changed; the persisted occurrence is consumed as error.
    return 'error';
  }

  try {
    const submit = deps.submitKeys ?? (isMultilinePtyPayload(prompt) ? '\r\r' : '\r');
    // Still running at Enter: the agent's composer queues the prompt.
    deps.onWrite?.('submit', running && after.status === 'running');
    return deps.write(submit) ? 'sent' : 'error';
  } catch {
    return 'error';
  }
}
