import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { generateId } from '../../../shared/types';

export interface ToolbarSnippet {
  id: string;
  label: string;
  text: string;
}

export type ToolbarPopover = 'explorer' | 'snippets' | 'rich' | null;

export interface AgentToolbarSlice {
  /** Whether the bottom toolbar mounts. Persisted (default true). */
  agentToolbarEnabled: boolean;
  setAgentToolbarEnabled: (enabled: boolean) => void;

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
  agentToolbarEnabled: true,
  setAgentToolbarEnabled: (enabled) => set((draft: StoreState) => {
    draft.agentToolbarEnabled = enabled;
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

  toolbarPopover: null,
  setToolbarPopover: (popover) => set((draft: StoreState) => {
    draft.toolbarPopover = popover;
  }),

  newConversationCommand: '/clear',
  setNewConversationCommand: (cmd) => set((draft: StoreState) => {
    draft.newConversationCommand = cmd;
  }),
});
