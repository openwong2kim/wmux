// "Add a seat on this PC…": the CEO hears of the new seat in one line
// (shared/company.ts companyHireNotice) once the seat's agent is up. Never
// before: a brief to a pane with no agent is only stored, so an early line
// would send the CEO into a brief its seat never gets. Not while the seat's
// agent waits on a question or a permission screen either (its first-run
// folder check, say): a brief to it is held there, not delivered.
//
// The line goes through the delivery gate with the typing hold (it never
// answers an approval prompt and waits while someone types), and only while
// the CEO pane's agent may take it (a2aTurnEndReminder eligibility: alive,
// not mid-turn, not held at a usage limit). A refused line (a draft the
// person left in the CEO's prompt, say) is tried again only once the CEO
// pane's agent has moved on, so a draft sent or a turn ended lets it through
// and nothing retries in a loop; a delivered one never again. The watch ends
// with the line, when the seat's pane closes, or when the workspace is no
// longer a company. It lives in memory: an app restart drops it.

import { useStore, type StoreState } from '../stores';
import { companyHireNotice, type CompanyHireNoticeInput } from '../../shared/company';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import type { PaneLeaf } from '../../shared/types';
import { gatedSubmitToPty } from '../utils/ptyMessageDelivery';
import { eligibility } from './a2aTurnEndReminder';

/** How long the gate may hold the line while someone types in the CEO pane. */
export const HIRE_NOTICE_DEADLINE_MS = 120_000;

export interface HireNoticeWatch extends CompanyHireNoticeInput {
  workspaceId: string;
  /** The seat's pane. */
  paneId: string;
}

/** The pty of the first surface in `leaf` that runs an agent. */
function agentPty(leaf: PaneLeaf, surfaceAgent: StoreState['surfaceAgent']): string | null {
  return leaf.surfaces.find((sf) => !!sf.ptyId && !!surfaceAgent[sf.ptyId]?.name)?.ptyId ?? null;
}

/** Watch one hired seat until its CEO is told; returns a stop. */
export function watchHireNotice(seat: HireNoticeWatch): () => void {
  const text = companyHireNotice(seat);
  let sending = false;
  // The CEO agent's status a refused line was tried in; the next try waits
  // until the status has been another one (the same status is broadcast again).
  let refusedIn: string | undefined;
  let stopped = false;
  let unsubscribe: () => void = () => undefined;
  const stop = (): void => {
    stopped = true;
    unsubscribe();
  };
  const check = (state: StoreState): void => {
    if (stopped || sending) return;
    const ws = state.workspaces.find((w) => w.id === seat.workspaceId);
    const leaves = ws ? getWorkspaceLeafPanes(ws) : [];
    const leaf = leaves.find((l) => l.id === seat.paneId);
    if (!ws?.company || !leaf) {
      stop();
      return;
    }
    const seatPty = agentPty(leaf, state.surfaceAgent);
    if (!seatPty || state.surfaceAgent[seatPty]?.status === 'awaiting_input') return;
    const ceoLeaf = leaves.find((l) => l.id === ws.company?.coordinatorPaneId);
    const ceoPty = ceoLeaf ? agentPty(ceoLeaf, state.surfaceAgent) : null;
    if (!ceoPty) return;
    const ceoState = state.surfaceAgent[ceoPty];
    if (refusedIn !== undefined) {
      if (ceoState?.status === refusedIn) return;
      refusedIn = undefined;
    }
    if (eligibility(ceoPty) !== 'write') return;
    // Claimed before the await, so a change while it is out sends nothing more.
    sending = true;
    const agent = ceoState?.name ?? null;
    void gatedSubmitToPty(ceoPty, text, {
      agent,
      waitQuiet: true,
      ...(agent ? { expectAgent: agent } : {}),
      deadlineAt: Date.now() + HIRE_NOTICE_DEADLINE_MS,
    }).then((result) => {
      sending = false;
      if (result.ok) stop();
      else refusedIn = ceoState?.status;
    });
  };
  unsubscribe = useStore.subscribe(check);
  check(useStore.getState());
  return stop;
}
