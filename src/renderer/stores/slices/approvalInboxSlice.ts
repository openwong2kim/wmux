import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
// Type-only import: the renderer never imports ApprovalQueue's runtime (it lives
// in the main process). We only borrow the wire-shape of the prompt info that
// rides the permissionPrompt.onOpen IPC channel, so there is no main/renderer
// runtime coupling — `import type` is erased at compile time.
import type { ApprovalPromptInfo } from '../../../main/mcp/ApprovalQueue';
import {
  appendAutoRejected,
  isAutoRejection,
  type AutoRejectedEntry,
} from '../../components/FleetView/approvalCountdown';

// ─── S-C2 Approval Inbox — renderer-aggregated MCP permission prompts ─────────
//
// MCP permission prompts arrive one at a time over `permissionPrompt.onOpen`
// and leave over `permissionPrompt.onClosed` (Open Decision #1: renderer-
// aggregated source, no daemon `listPending()` round-trip). This slice is the
// single renderer-side copy of "which MCP prompts are currently outstanding";
// the bridge hook (useApprovalInboxBridge) owns the subscription and dispatches
// add/remove here. The selector (selectApprovalInbox) derives the unified inbox
// list from this state plus the A2A pendingExecuteApproval.

export interface ApprovalInboxSlice {
  /** promptId -> prompt info. The authoritative record for each open prompt. */
  mcpPrompts: Record<string, ApprovalPromptInfo>;
  /** Insertion order of promptIds; drives "latest" + the list render order. */
  mcpPromptOrder: string[];

  /** Idempotent on promptId: overwrites the info, appends to order only once. */
  addMcpPrompt: (info: ApprovalPromptInfo) => void;
  /** Idempotent: removes from both maps; no-op when the id is unknown. */
  removeMcpPrompt: (promptId: string) => void;

  /**
   * C-3 (review fix) — the approvals nobody answered, newest first and capped.
   *
   * It lives HERE, not in the Fleet list, for one reason: a deadline fires
   * whether or not anyone is looking at the Approvals tab. A component-local log
   * was empty exactly when it mattered — "what happened while I was away".
   * Entries are written at the REMOVAL point, where the row's own deadline and
   * the true removal instant are both in hand.
   */
  approvalAutoRejected: AutoRejectedEntry[];
  /** Classify one departing approval and log it if the deadline killed it. */
  noteApprovalRemoved: (entry: {
    key: string;
    label: string;
    deadlineAt?: number;
    removedAt: number;
  }) => void;
}

/** Shared by both removal points (MCP prompt here, A2A execute approval in
 *  a2aSlice) so one rule decides what counts as an auto-rejection. */
export function recordApprovalRemoval(
  state: { approvalAutoRejected: AutoRejectedEntry[] },
  entry: { key: string; label: string; deadlineAt?: number; removedAt: number },
): void {
  if (!isAutoRejection({ ...(entry.deadlineAt !== undefined ? { deadlineAt: entry.deadlineAt } : {}), removedAt: entry.removedAt })) {
    return;
  }
  state.approvalAutoRejected = appendAutoRejected(state.approvalAutoRejected, {
    key: entry.key,
    label: entry.label,
    at: entry.deadlineAt as number,
  });
}

export const createApprovalInboxSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  ApprovalInboxSlice
> = (set) => ({
  mcpPrompts: {},
  mcpPromptOrder: [],
  approvalAutoRejected: [],

  noteApprovalRemoved: (entry) => set((state: StoreState) => {
    recordApprovalRemoval(state, entry);
  }),

  addMcpPrompt: (info) => set((state: StoreState) => {
    const isNew = !(info.promptId in state.mcpPrompts);
    // Overwrite the record either way — a coalesced re-open may carry a wider
    // capability snapshot; the latest wins.
    state.mcpPrompts[info.promptId] = info;
    // De-dup the order list so a re-open never produces a duplicate row.
    if (isNew) {
      state.mcpPromptOrder.push(info.promptId);
    }
  }),

  removeMcpPrompt: (promptId) => set((state: StoreState) => {
    // Classify BEFORE the record goes: its deadline is the only evidence of
    // why it left. `deadlineAt` is read structurally — it is stamped by the
    // daemon and absent on a prompt that never got one, which simply means
    // "not an auto-rejection".
    const info = state.mcpPrompts[promptId] as (ApprovalPromptInfo & { deadlineAt?: number }) | undefined;
    if (info) {
      recordApprovalRemoval(state, {
        key: `mcp:${promptId}`,
        label: info.clientName,
        ...(typeof info.deadlineAt === 'number' ? { deadlineAt: info.deadlineAt } : {}),
        removedAt: Date.now(),
      });
    }
    if (!(promptId in state.mcpPrompts)) {
      // Still filter the order list defensively, but the common no-op path is
      // an unknown id (e.g. a duplicate PERMISSION_PROMPT_CLOSED push after an
      // optimistic local removal) — nothing to do.
      const idx = state.mcpPromptOrder.indexOf(promptId);
      if (idx !== -1) state.mcpPromptOrder.splice(idx, 1);
      return;
    }
    delete state.mcpPrompts[promptId];
    state.mcpPromptOrder = state.mcpPromptOrder.filter((id) => id !== promptId);
  }),
});
