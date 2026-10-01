// Asks the person, once per (agent, app) per run, whether an agent may see and
// drive that app. Rides the same ApprovalQueue consent path as the live
// browser-tab borrow (liveBorrowApproval.ts). Fail-closed, but honest about
// why: only an explicit click on Deny comes back as `denied`. A prompt nobody
// answered, a prompt withdrawn by the stop key, and a queue that is missing or
// throws all come back as something else, so the caller can refuse this call
// without recording a refusal the person never made.

import type { ApprovalQueue } from '../mcp/ApprovalQueue';
import type { AppInfo, WindowInfo } from '../../shared/computer/protocol';
import type { ComputerAgent, ConsentAnswer, ConsentRequester } from './ComputerService';

export const COMPUTER_CONSENT_DEADLINE_MS = 120_000;
const TITLE_PART_MAX_CHARS = 80;

function clean(text: string): string {
  // Window titles are controlled by the target app; strip control characters
  // and our own quote delimiter so a title cannot forge the rest of the line.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/"/g, "'").trim().slice(0, TITLE_PART_MAX_CHARS);
}

/**
 * The headline names the asking session by its label (client name and the
 * workspace by its name, computer.rpc.ts), so the person can tell which of
 * several agents of one kind is asking.
 */
export function computerConsentTitle(agent: Pick<ComputerAgent, 'label'>, app: AppInfo, window: WindowInfo): string {
  const title = clean(window.title);
  return `${cleanLabel(agent.label) || 'An agent'} wants to see and control ${clean(app.name) || 'an app'}${title ? ` ("${title}")` : ''}`;
}

/** Labels quote a workspace name; keep the quotes, drop control characters. */
function cleanLabel(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, TITLE_PART_MAX_CHARS * 2);
}

export function createComputerConsentRequester(deps: {
  queue: () => Pick<ApprovalQueue, 'requestConsent' | 'cancelPrompt'> | null;
  deadlineMs?: number;
}): ConsentRequester {
  const deadlineMs = deps.deadlineMs ?? COMPUTER_CONSENT_DEADLINE_MS;
  return async ({ agent, app, window, epoch, signal }): Promise<ConsentAnswer> => {
    if (signal.aborted) return 'withdrawn';
    const queue = deps.queue();
    if (!queue) return 'unavailable';
    let handle;
    try {
      handle = queue.requestConsent({
        kind: 'computer-app',
        // The epoch (bumped by the stop key) keeps a call made after a stop
        // from ever joining a prompt raised before it, even if withdrawing
        // that prompt raced with the new call.
        // Keyed on the agent session, never the label two sessions can share.
        dedupeKey: `${agent.key}::${app.id}::${epoch}`,
        clientName: cleanLabel(agent.label),
        title: computerConsentTitle(agent, app, window),
        deadlineAt: Date.now() + deadlineMs,
      });
    } catch {
      return 'unavailable';
    }
    const promptId = handle.promptId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const expiry = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), deadlineMs);
      timer.unref?.();
    });
    const withdrawn = new Promise<'withdrawn'>((resolve) => {
      onAbort = () => resolve('withdrawn');
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const outcome = await Promise.race([
        handle.resolution.then((r): ConsentAnswer => (r.approved ? 'approved' : 'denied')),
        expiry,
        withdrawn,
      ]);
      // Take the prompt off screen: nobody is waiting for its answer any more.
      if (outcome === 'expired') queue.cancelPrompt(promptId, 'computer-use request expired');
      if (outcome === 'withdrawn') queue.cancelPrompt(promptId, 'stopped by the user');
      return outcome;
    } catch {
      // The queue cancelled the prompt (window closed, queue torn down): the
      // person never answered it.
      return signal.aborted ? 'withdrawn' : 'unavailable';
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      handle.resolution.catch(() => {
        /* already answered above */
      });
    }
  };
}
