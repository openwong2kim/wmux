/**
 * A chat-v2 chat's run state, outside its pane. The sidebar roster, Fleet and
 * fleet.triage read a pane's agent state from the store's per-pty maps
 * (`surfaceAgent`, `surfaceAgentStatus`, the turn latch), which terminal
 * agents feed through METADATA_UPDATE. A chat driver reports nothing there,
 * so this mirror writes the same maps from the chat's binding: running while a
 * turn runs, needs-you while an approval or question waits, complete when the
 * turn ends.
 *
 * Source: the bindings controller.ts publishes (`knownBinding`). A chat whose
 * view is not mounted (a background tab, another workspace, terminal view)
 * has no controller and gets no pushes, so its binding is asked for again on
 * a slow cadence until the view covers the pane again.
 */
import { useSyncExternalStore } from 'react';
import type { ChatV2Agent, ChatV2Binding } from '../../../shared/chatv2/ipc';
import type { AgentStatus } from '../../../shared/types';
import { agentRow } from '../../../shared/agentIdentity';
import { getWorkspacePtyIds } from '../../../shared/paneUtils';
import { useStore } from '../../stores';
import { getChatV2Bridge } from './bridge';
import { knownBinding, onKnownBindings, setKnownBinding } from './controller';
import { isChatV2Covering } from './coverage';

/** How often a chat with no mounted view is asked for its binding. */
export const CHAT_STATUS_POLL_MS = 5_000;

/** The binding of a chat that holds the pane (a live record, not a tombstone). */
function heldBinding(ptyId: string): ChatV2Binding | null {
  const binding = knownBinding(ptyId);
  return binding && binding.status !== 'handed-off' ? binding : null;
}

/** True while a chat-v2 chat holds the pane: its anchor shell idling at a prompt is not "the agent left". */
export function chatHoldsPane(ptyId: string): boolean {
  return heldBinding(ptyId) !== null;
}

/** A held chat's agent status before turn-end promotion (null = not held). */
export function chatAgentStatus(binding: ChatV2Binding | null | false | undefined): AgentStatus | null {
  if (!binding) return null;
  switch (binding.status) {
    case 'starting':
    case 'running': return 'running';
    case 'needs-input': return 'awaiting_input';
    case 'failed': return 'error';
    case 'stopped': return binding.error ? 'error' : 'idle';
    case 'idle': return 'idle';
    case 'handed-off': return null;
  }
}

/** The agent's display name, from its registry row. */
export function chatAgentName(agent: ChatV2Agent): string {
  return agentRow(agent)?.display ?? agent;
}

/** The label a terminal tab shows while a chat holds it in chat view; undefined = its own title. */
export function chatTabLabel(surface: { ptyId?: string; viewMode?: 'terminal' | 'chat'; userName?: string }, chatViewEnabled: boolean): string | undefined {
  if (!chatViewEnabled || surface.viewMode !== 'chat' || !surface.ptyId || surface.userName) return undefined;
  const binding = heldBinding(surface.ptyId);
  return binding ? chatAgentName(binding.agent) : undefined;
}

type TabSurface = Parameters<typeof chatTabLabel>[0];

/**
 * Re-renders the caller when the chat label of any of `surfaces` changes, and
 * only then: a binding is republished on every push of a streaming turn.
 * Read each label with chatTabLabel.
 */
export function useChatTabLabels(surfaces: readonly TabSurface[], chatViewEnabled: boolean): string {
  return useSyncExternalStore(onKnownBindings, () => surfaces.map((s) => chatTabLabel(s, chatViewEnabled) ?? '').join('\n'));
}

/** What the mirror last wrote per pty. */
const mirrored = new Map<string, { status: AgentStatus; agent: ChatV2Agent }>();

/** Bring one pane's store entries in line with its chat binding. */
function apply(ptyId: string): void {
  const binding = knownBinding(ptyId);
  const held = heldBinding(ptyId);
  const prev = mirrored.get(ptyId);
  const store = useStore.getState();
  if (!held) {
    if (!prev) return;
    mirrored.delete(ptyId);
    // The chat let go of the pane: end its turn (drops the mark and the latch).
    store.setSurfaceAgentStatus(ptyId, 'idle');
    // A handoff types the agent's TUI into the pane, whose detection takes the
    // identity over; the liveness poll drops it if none starts.
    if (binding && binding.status === 'handed-off') store.setSurfaceAgent(ptyId, undefined, 'idle');
    else store.clearSurfaceAgent(ptyId);
    return;
  }
  let status = chatAgentStatus(held) as AgentStatus;
  // A turn that ran (or waited on the person) and is over reads as finished,
  // like a terminal agent's Stop, until the next turn.
  if (status === 'idle' && (prev?.status === 'running' || prev?.status === 'awaiting_input' || prev?.status === 'complete')) status = 'complete';
  const name = chatAgentName(held.agent);
  const slug = agentRow(held.agent)?.slug;
  if (prev && prev.agent === held.agent && prev.status === status) {
    // No new state. Restore only what another writer dropped (a settle edge
    // for the anchor shell), without raising the attention mark again.
    const agent = store.surfaceAgent[ptyId];
    if (agent?.name !== name || agent.status !== status) store.setSurfaceAgent(ptyId, name, status, slug);
    if (status === 'running' && store.surfaceTurnOpenAt[ptyId] === undefined) store.markSurfaceTurnOpen(ptyId);
    return;
  }
  mirrored.set(ptyId, { status, agent: held.agent });
  store.setSurfaceAgent(ptyId, name, status, slug);
  store.setSurfaceAgentStatus(ptyId, status);
  // The latch carries 'running' (the roster reads a running lifecycle with no
  // latch as idle); every other status above withdraws it.
  if (status === 'running') store.markSurfaceTurnOpen(ptyId);
}

function applyAll(): void {
  const ptyIds = new Set<string>(mirrored.keys());
  for (const ws of useStore.getState().workspaces) for (const id of getWorkspacePtyIds(ws)) ptyIds.add(id);
  for (const ptyId of ptyIds) apply(ptyId);
}

/** Ask the host again for each held chat whose view is not mounted (it gets no pushes). */
function refreshUncovered(): void {
  const bridge = getChatV2Bridge();
  if (!bridge) return;
  for (const ptyId of mirrored.keys()) {
    if (isChatV2Covering(ptyId)) continue;
    bridge.call('bindingForPane', { paneId: ptyId }).then((result) => {
      // A view mounted meanwhile publishes fresher state than this answer.
      if (!result.ok || isChatV2Covering(ptyId)) return;
      const current = knownBinding(ptyId);
      const next = result.binding;
      if (current && next && current.chatSessionId === next.chatSessionId && current.status === next.status && current.error?.code === next.error?.code) return;
      setKnownBinding(ptyId, next);
    }, () => undefined);
  }
}

/** Start mirroring every pane's chat state into the agent-status maps. Returns the stop. */
export function startChatStatusMirror(pollMs = CHAT_STATUS_POLL_MS): () => void {
  applyAll();
  const off = onKnownBindings(applyAll);
  const timer = setInterval(() => { applyAll(); refreshUncovered(); }, pollMs);
  return () => {
    off();
    clearInterval(timer);
    mirrored.clear();
  };
}
