// ─── Owner approvals, as the renderer holds them ────────────────────────────
//
// One shared list of approval requests (main/factory/approvals.ts) for every
// approval card, the composer's "Approve N pending" chip and Settings' rules
// list: read through `window.electronAPI.approvals` (main-window IPC), and
// read again on every BOT_EVENT push (main sends `approvals-changed`). The
// decisions are main's; this module only asks for them.
import { useSyncExternalStore } from 'react';
import type { ElectronAPI } from '../../../preload/preload';
import type { ApprovalAction, ApprovalRequest } from '../../../shared/botApproval';
import { APPROVAL_NEVER_BY_RULE } from '../../../shared/botApproval';
import type { RoomCard } from '../../../shared/room';

export type ApprovalsApi = ElectronAPI['approvals'];
/** A request as main shows it to the main window. */
export type ApprovalView = ApprovalRequest & { executeAfter?: number; effectId?: string; ruleSkipped?: string };

let apiOverride: ApprovalsApi | null | undefined;

export function approvalsApi(): ApprovalsApi | null {
  if (apiOverride !== undefined) return apiOverride;
  return (globalThis as { electronAPI?: Partial<ElectronAPI> }).electronAPI?.approvals ?? null;
}

type Listener = () => void;
interface Snapshot { byId: ReadonlyMap<string, ApprovalView>; list: readonly ApprovalView[] }

const EMPTY: Snapshot = { byId: new Map(), list: [] };
let snapshot: Snapshot = EMPTY;
const listeners = new Set<Listener>();
let offEvents: (() => void) | null = null;
let inFlight: Promise<void> | null = null;
let again = false;

function publish(next: Snapshot): void {
  snapshot = next;
  for (const l of [...listeners]) l();
}

/** Read the requests from main (coalesced: one read at a time, one more if
 *  asked meanwhile). */
export function refreshApprovals(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  const api = approvalsApi();
  if (!api) return Promise.resolve();
  inFlight = (async () => {
    try {
      const r = await api.list();
      if (r && r.ok) publish({ byId: new Map(r.requests.map((q) => [q.requestId, q as ApprovalView])), list: r.requests as ApprovalView[] });
    } catch {
      /* the cards keep what they last read */
    } finally {
      inFlight = null;
      if (again) {
        again = false;
        void refreshApprovals();
      }
    }
  })();
  return inFlight;
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  if (listeners.size === 1) {
    const factory = (globalThis as { electronAPI?: Partial<ElectronAPI> }).electronAPI?.factory;
    offEvents = factory?.onBotEvent ? factory.onBotEvent(() => void refreshApprovals()) : null;
    void refreshApprovals();
  }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) {
      offEvents?.();
      offEvents = null;
    }
  };
}

/** The requests main holds (empty outside the app window). */
export function useApprovals(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}

/** Tests: replace the bridge and drop what was read. */
export function setApprovalsApiForTests(api: ApprovalsApi | null | undefined): void {
  apiOverride = api;
  snapshot = EMPTY;
  inFlight = null;
  again = false;
}

/** What an approval card shows now. Pure. */
export type ApprovalPhase =
  | { phase: 'pending'; canAlways: boolean }
  | { phase: 'undo'; secondsLeft: number }
  | { phase: 'merging' }
  | { phase: 'approved'; byRule: boolean; recordedOnly: boolean }
  | { phase: 'executed'; byRule: boolean }
  /** `reason` is main's code; `text` the same in the owner's words. */
  | { phase: 'refused'; headMoved: boolean; reason: string; text: string | null }
  | { phase: 'denied' }
  | { phase: 'expired' }
  | { phase: 'unknown' };

export function approvalPhase(r: ApprovalView | undefined, now: number): ApprovalPhase {
  if (!r) return { phase: 'unknown' };
  switch (r.state) {
    case 'pending':
      // A rule carries out merges only (never a release or a default-branch push).
      return { phase: 'pending', canAlways: r.action === 'merge' && !APPROVAL_NEVER_BY_RULE.has(r.action) };
    case 'approved':
      // An approved skill is in place already: approving was the act.
      if (r.action !== 'merge') return { phase: 'approved', byRule: r.decidedBy === 'rule', recordedOnly: r.action !== 'skill' };
      if (!r.effectId && r.executeAfter !== undefined && now < r.executeAfter) {
        return { phase: 'undo', secondsLeft: Math.max(1, Math.ceil((r.executeAfter - now) / 1000)) };
      }
      return { phase: 'merging' };
    case 'executed':
      return { phase: 'executed', byRule: r.decidedBy === 'rule' };
    case 'refused':
      return { phase: 'refused', headMoved: r.refusal === 'head-moved', reason: r.refusal ?? '', text: r.refusalText?.trim() || null };
    case 'denied':
      return { phase: 'denied' };
    case 'expired':
      return { phase: 'expired' };
    default:
      return { phase: 'unknown' };
  }
}

/** The pending requests an "Approve N pending" chip approves: those whose
 *  card the conversation shows, wherever the card's thread is (a room's or a
 *  1:1's whole view shows its PR threads' cards too) — in a 1:1 only that
 *  bot's, and, while the view is narrowed to one thread, only that
 *  thread's. A group conversation is one workspace's room (`workspaceId`);
 *  a 1:1 spans rooms (none). Pure. */
export function pendingForChip(
  list: readonly ApprovalView[],
  cards: readonly Pick<RoomCard, 'id'>[],
  scope: { workspaceId?: string; threadId?: string | null; botId?: string },
): ApprovalView[] {
  const shown = new Set(cards.map((c) => c.id));
  // A skill is approved on its own card, where its change is shown.
  return list.filter((r) => r.state === 'pending' && r.action !== 'skill'
    && (!scope.workspaceId || r.workspaceId === scope.workspaceId)
    && (!scope.threadId || r.threadId === scope.threadId)
    && (!scope.botId || r.botId === scope.botId) && !!r.cardId && shown.has(r.cardId));
}

/** The i18n key of an act's name. */
export function actionKey(action: ApprovalAction): string {
  return `room.approval.action.${action}`;
}
