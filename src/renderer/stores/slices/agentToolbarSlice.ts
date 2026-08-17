import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { generateId } from '../../../shared/types';
import { CHROME_PRESET_VALUES } from '../../../shared/chromePresets';

export interface ToolbarSnippet {
  id: string;
  label: string;
  text: string;
}

export type ToolbarPopover = 'explorer' | 'snippets' | 'rich' | null;
export type ComposeTarget = 'pane' | 'workspace';

export interface ComposeContext {
  paneId: string;
  ptyId: string;
}

export interface FanOutAnchor {
  top: number;
  left: number;
}

export interface AgentToolbarSlice {
  /** Whether inject chrome (compose / attach / Multi Task) mounts. Persisted (default true). */
  agentToolbarEnabled: boolean;
  setAgentToolbarEnabled: (enabled: boolean) => void;

  /** Compose blast radius. Transient — reset to 'pane' on every open. */
  composeTarget: ComposeTarget;
  setComposeTarget: (target: ComposeTarget) => void;

  /** Focused pane + pty the open compose popover writes to. Transient. */
  composeContext: ComposeContext | null;
  setComposeContext: (ctx: ComposeContext | null) => void;
  openCompose: (ctx: ComposeContext) => void;
  closeCompose: () => void;

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

  composeTarget: 'pane',
  setComposeTarget: (target) => set((draft: StoreState) => {
    draft.composeTarget = target;
  }),

  composeContext: null,
  setComposeContext: (ctx) => set((draft: StoreState) => {
    draft.composeContext = ctx;
  }),
  openCompose: (ctx) => set((draft: StoreState) => {
    draft.composeContext = ctx;
    draft.composeTarget = 'pane';
    draft.toolbarPopover = 'rich';
  }),
  closeCompose: () => set((draft: StoreState) => {
    draft.toolbarPopover = null;
    draft.composeContext = null;
    draft.composeTarget = 'pane';
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
