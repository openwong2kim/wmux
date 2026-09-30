// Asks the person, once per (agent, app) per run, whether an agent may see and
// drive that app. Rides the same ApprovalQueue consent path as the live
// browser-tab borrow (liveBorrowApproval.ts), with the same fail-closed rules:
// a queue that throws, a prompt nobody answers, or a withdrawn prompt all come
// back as "no".

import type { ApprovalQueue } from '../mcp/ApprovalQueue';
import type { AppInfo, WindowInfo } from '../../shared/computer/protocol';
import type { ConsentRequester } from './ComputerService';

export const COMPUTER_CONSENT_DEADLINE_MS = 120_000;
const TITLE_PART_MAX_CHARS = 80;

function clean(text: string): string {
  // Window titles are controlled by the target app; strip control characters
  // and our own quote delimiter so a title cannot forge the rest of the line.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/"/g, "'").trim().slice(0, TITLE_PART_MAX_CHARS);
}

export function computerConsentTitle(clientName: string, app: AppInfo, window: WindowInfo): string {
  const title = clean(window.title);
  return `${clean(clientName) || 'An agent'} wants to see and control ${clean(app.name) || 'an app'}${title ? ` ("${title}")` : ''}`;
}

export function createComputerConsentRequester(deps: {
  queue: () => Pick<ApprovalQueue, 'requestConsent' | 'cancelPrompt'> | null;
  deadlineMs?: number;
}): ConsentRequester {
  const deadlineMs = deps.deadlineMs ?? COMPUTER_CONSENT_DEADLINE_MS;
  return async ({ clientName, app, window }) => {
    const queue = deps.queue();
    if (!queue) return false;
    let handle;
    try {
      handle = queue.requestConsent({
        kind: 'computer-app',
        dedupeKey: `${clientName}::${app.id}`,
        clientName,
        title: computerConsentTitle(clientName, app, window),
        deadlineAt: Date.now() + deadlineMs,
      });
    } catch {
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), deadlineMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([handle.resolution.then((r) => r.approved), expiry]);
      if (outcome === 'timeout') {
        queue.cancelPrompt(handle.promptId, 'computer-use request expired');
        return false;
      }
      return outcome;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
      handle.resolution.catch(() => {
        /* already answered above */
      });
    }
  };
}
