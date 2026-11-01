// "Add a seat on this PC…": the CEO hears of the new seat in one line
// (shared/company.ts companyHireNotice) once the seat's agent is up. Never
// before: a brief to a pane with no agent is only stored, so an early line
// would send the CEO into a brief its seat never gets.
//
// The line goes through the delivery gate with the typing hold (it never
// answers an approval prompt and waits while someone types), and only while
// the CEO pane's agent may take it (a2aTurnEndReminder eligibility: alive,
// not mid-turn, not held at a usage limit). A refused line is tried again on
// a later change, a few times at most; a delivered one never again. The watch
// ends with the line, when the seat's pane closes, or when the workspace is
// no longer a company. It lives in memory: an app restart drops it.

import { useStore, type StoreState } from '../stores';
import { companyHireNotice, type CompanyHireNoticeInput } from '../../shared/company';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import type { PaneLeaf } from '../../shared/types';
import { gatedSubmitToPty } from '../utils/ptyMessageDelivery';
import { eligibility } from './a2aTurnEndReminder';

/** How long the gate may hold the line while someone types in the CEO pane. */
export const HIRE_NOTICE_DEADLINE_MS = 120_000;
/** Deliveries tried before the watch gives up. */
export const HIRE_NOTICE_TRIES = 3;

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
  let tries = 0;
  let sending = false;
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
    if (!agentPty(leaf, state.surfaceAgent)) return;
    const ceoLeaf = leaves.find((l) => l.id === ws.company?.coordinatorPaneId);
    const ceoPty = ceoLeaf ? agentPty(ceoLeaf, state.surfaceAgent) : null;
    if (!ceoPty || eligibility(ceoPty) !== 'write') return;
    // Claimed before the await, so a change while it is out sends nothing more.
    sending = true;
    tries += 1;
    const agent = state.surfaceAgent[ceoPty]?.name ?? null;
    void gatedSubmitToPty(ceoPty, text, {
      agent,
      waitQuiet: true,
      ...(agent ? { expectAgent: agent } : {}),
      deadlineAt: Date.now() + HIRE_NOTICE_DEADLINE_MS,
    }).then((result) => {
      sending = false;
      if (result.ok || tries >= HIRE_NOTICE_TRIES) stop();
    });
  };
  unsubscribe = useStore.subscribe(check);
  check(useStore.getState());
  return stop;
}
