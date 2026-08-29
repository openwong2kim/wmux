import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { generateId } from '../../../shared/types';
import { CHROME_PRESET_VALUES } from '../../../shared/chromePresets';

export interface ToolbarSnippet {
  id: string;
  label: string;
  text: string;
}

export type ToolbarPopover = 'explorer' | 'snippets' | 'rich' | 'schedule' | null;

/** Trigger rect in viewport coords. `right`/`bottom` are required: placePopover
 *  right-aligns the dialog against `right`, so a synthesised rect that reused
 *  `left` for it drove the dialog into the viewport's left pad. */
export interface FanOutAnchor {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface AgentToolbarSlice {
  /** Whether inject chrome (compose / attach / Multi Task) mounts. Persisted (default true). */
  agentToolbarEnabled: boolean;
  setAgentToolbarEnabled: (enabled: boolean) => void;

  /** Pinned = always-on strip; unpinned = reveal on approach. Persisted (default false). */
  agentToolbarPinned: boolean;
  setAgentToolbarPinned: (pinned: boolean) => void;

  /** Fan-out dialog target. Transient; null = closed. */
  fanOutWorkspaceId: string | null;
  fanOutAnchor: FanOutAnchor | null;
  openFanOut: (workspaceId: string, anchor?: FanOutAnchor | null) => void;
  closeFanOut: () => void;

  /** User-saved reusable prompts. Persisted (user-authored). */
  toolbarSnippets: ToolbarSnippet[];
  addSnippet: (label: string, text: string) => void;
  updateSnippet: (id: string, patch: Partial<Pick<ToolbarSnippet, 'label' | 'text'>>) => void;
  removeSnippet: (id: string) => void;

  /** Rich-input draft per pane (ptyId -> text). IN-MEMORY ONLY - never persisted. */
  richDraftByPane: Record<string, string>;
  setRichDraft: (ptyId: string, text: string) => void;
  clearRichDraft: (ptyId: string) => void;

  /** Which toolbar popover is open. Transient. */
  toolbarPopover: ToolbarPopover;
  setToolbarPopover: (popover: ToolbarPopover) => void;

  /** Command sent by the "New" button. Persisted (default '/clear'). */
  newConversationCommand: string;
  setNewConversationCommand: (cmd: string) => void;
}

export const createAgentToolbarSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  AgentToolbarSlice
> = (set) => ({
  agentToolbarEnabled: CHROME_PRESET_VALUES.standard.agentToolbarEnabled,
  setAgentToolbarEnabled: (enabled) => set((draft: StoreState) => {
    draft.agentToolbarEnabled = enabled;
  }),

  agentToolbarPinned: false,
  setAgentToolbarPinned: (pinned) => set((draft: StoreState) => {
    draft.agentToolbarPinned = pinned;
  }),

  toolbarSnippets: [],
  addSnippet: (label, text) => set((draft: StoreState) => {
    draft.toolbarSnippets.push({ id: generateId('snippet'), label, text });
  }),
  updateSnippet: (id, patch) => set((draft: StoreState) => {
    const s = draft.toolbarSnippets.find((x) => x.id === id);
    if (!s) return;
    if (patch.label !== undefined) s.label = patch.label;
    if (patch.text !== undefined) s.text = patch.text;
  }),
  removeSnippet: (id) => set((draft: StoreState) => {
    draft.toolbarSnippets = draft.toolbarSnippets.filter((x) => x.id !== id);
  }),

  richDraftByPane: {},
  setRichDraft: (ptyId, text) => set((draft: StoreState) => {
    draft.richDraftByPane[ptyId] = text;
  }),
  clearRichDraft: (ptyId) => set((draft: StoreState) => {
    if (draft.richDraftByPane[ptyId] !== undefined) delete draft.richDraftByPane[ptyId];
  }),

  fanOutWorkspaceId: null,
  fanOutAnchor: null,
  openFanOut: (workspaceId, anchor) => set((draft: StoreState) => {
    if (draft.fanOutWorkspaceId === workspaceId) {
      draft.fanOutWorkspaceId = null;
      draft.fanOutAnchor = null;
      return;
    }
    draft.fanOutWorkspaceId = workspaceId;
    draft.fanOutAnchor = anchor ?? null;
    draft.toolbarPopover = null;
  }),
  closeFanOut: () => set((draft: StoreState) => {
    draft.fanOutWorkspaceId = null;
    draft.fanOutAnchor = null;
  }),

  toolbarPopover: null,
  setToolbarPopover: (popover) => set((draft: StoreState) => {
    draft.toolbarPopover = popover;
  }),

  newConversationCommand: '/clear',
  setNewConversationCommand: (cmd) => set((draft: StoreState) => {
    draft.newConversationCommand = cmd;
  }),
});
