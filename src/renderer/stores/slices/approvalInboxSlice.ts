import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
// Type-only import: the renderer never imports ApprovalQueue's runtime (it lives
// in the main process). We only borrow the wire-shape of the prompt info that
// rides the permissionPrompt.onOpen IPC channel, so there is no main/renderer
// runtime coupling — `import type` is erased at compile time.
import type { ApprovalPromptInfo } from '../../../main/mcp/ApprovalQueue';

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
}

export const createApprovalInboxSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  ApprovalInboxSlice
> = (set) => ({
  mcpPrompts: {},
  mcpPromptOrder: [],

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
