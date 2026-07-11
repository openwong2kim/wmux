// ─── Command Deck — Commander brain thread state (Phase 2, P2d) ──────────────
//
// Pure, store-free logic behind the Commander BRAIN conversation (distinct from
// the Phase 1 fan-out threads). The brain stream is NOT channel semantics — it
// is an orchestrator turn — so it lives in deckSlice as its own message array,
// never forced into the channels plumbing (design D1/P2d).
//
// Kept pure so the reducer (normalized BrainEvent → message-array mutation) and
// the fleet-context builder are unit-testable with no store and no Electron.

import type { BrainEvent } from '../../../main/deck/BrainAdapter';
import type { Workspace } from '../../../shared/types';
import type { AgentSlug } from '../../../shared/events';
import type { Channel } from '../../../shared/channels';
import { findLeafPanes } from '../../hooks/a2aAddressing';
import { computePaneAutoName, paneDisplayName } from '../../utils/paneNaming';

/** A tool call the brain made, shown as a chip. `ok` undefined = still running
 *  (spinner); true/false = returned. `paneId`/`workspaceId` are parsed from the
 *  tool input when present so the chip can offer a pane-jump (litmus test: every
 *  action in the chat is one click from its evidence). */
export interface DeckToolChip {
  toolId?: string;
  /** Bare tool name without the `mcp__wmux__` prefix, for display. */
  name: string;
  inputSummary: string;
  ok?: boolean;
  /** Pane / workspace the tool targeted (when any), for the chip's jump button. */
  paneId?: string;
  workspaceId?: string;
}

export type DeckBrainRole = 'user' | 'assistant';
export type DeckBrainStatus = 'streaming' | 'done' | 'error';

export interface DeckBrainMessage {
  id: string;
  role: DeckBrainRole;
  text: string;
  /** Assistant only: the tool chips for this turn, in call order. */
  tools?: DeckToolChip[];
  /** Assistant only. */
  status?: DeckBrainStatus;
  /** Assistant only: populated on an `error` event. */
  errorText?: string;
}

/** Strip the `mcp__wmux__` (or any `mcp__x__`) prefix for a compact chip label. */
export function shortToolName(name: string): string {
  const m = /^mcp__[^_]+__(.+)$/.exec(name);
  return m ? m[1] : name;
}

/**
 * Apply one normalized BrainEvent to the brain message array, returning a NEW
 * array (pure — the slice wraps this). Events mutate the trailing ASSISTANT
 * message (the in-flight turn's response), which the caller appends when the
 * human sends. A defensive no-op when there is no open assistant message (an
 * event arriving after the turn closed) rather than throwing.
 */
export function applyBrainEvent(
  messages: DeckBrainMessage[],
  event: BrainEvent,
): DeckBrainMessage[] {
  const idx = lastAssistantIndex(messages);
  if (idx < 0) return messages;
  const target = messages[idx];
  let next: DeckBrainMessage;

  switch (event.type) {
    case 'text-delta':
      next = { ...target, text: target.text + event.text };
      break;
    case 'tool-start': {
      const chip: DeckToolChip = {
        ...(event.toolId ? { toolId: event.toolId } : {}),
        name: shortToolName(event.name),
        inputSummary: event.inputSummary,
        ...(event.paneId ? { paneId: event.paneId } : {}),
        ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
      };
      next = { ...target, tools: [...(target.tools ?? []), chip] };
      break;
    }
    case 'tool-end': {
      const tools = (target.tools ?? []).slice();
      // Close the matching still-open chip (by id when present, else the last
      // open chip with the same name) — a tool-end without a start is ignored.
      const short = shortToolName(event.name);
      let ci = -1;
      for (let i = tools.length - 1; i >= 0; i--) {
        const c = tools[i];
        if (c.ok !== undefined) continue;
        if (event.toolId ? c.toolId === event.toolId : c.name === short) {
          ci = i;
          break;
        }
      }
      if (ci < 0) return messages;
      tools[ci] = { ...tools[ci], ok: event.ok };
      next = { ...target, tools };
      break;
    }
    case 'turn-end':
      next = { ...target, status: 'done' };
      break;
    case 'error':
      next = { ...target, status: 'error', errorText: event.message };
      break;
    default:
      return messages;
  }

  const copy = messages.slice();
  copy[idx] = next;
  return copy;
}

function lastAssistantIndex(messages: DeckBrainMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return i;
  }
  return -1;
}

/**
 * Build the one-shot fleet snapshot injected into the brain's first turn:
 * a compact, token-budgeted list of live agent panes (coordinate + agent) and
 * the channel catalog. Main re-caps this to ~2KB; we keep it terse here.
 * Pure + exported for unit testing.
 */
export function buildFleetContextSummary(args: {
  workspaces: Workspace[];
  surfaceAgent: Record<string, { name: string; slug?: AgentSlug } | undefined>;
  paneLabel: Record<string, string>;
  channels: Record<string, Channel>;
  maxChars?: number;
}): string {
  const { workspaces, surfaceAgent, paneLabel, channels, maxChars = 2000 } = args;
  const lines: string[] = ['Current wmux fleet:'];
  const paneLines: string[] = [];
  for (const w of workspaces) {
    const wsOrdinal = w.wsOrdinal ?? 0;
    for (const leaf of findLeafPanes(w.rootPane)) {
      const agentSurfaces = leaf.surfaces.filter(
        (s) => s.surfaceType !== 'browser' && !!s.ptyId && !!surfaceAgent[s.ptyId]?.name,
      );
      const repr = agentSurfaces.find((s) => s.id === leaf.activeSurfaceId) ?? agentSurfaces[0];
      if (!repr) continue;
      const autoName = computePaneAutoName(wsOrdinal, leaf.ordinal ?? 0, surfaceAgent[repr.ptyId]?.slug);
      const label = paneDisplayName(paneLabel[leaf.id], autoName);
      const agent = surfaceAgent[repr.ptyId]?.name ?? 'agent';
      paneLines.push(`- ${autoName} [${agent}] in "${w.name}"${label !== autoName ? ` (${label})` : ''}`);
    }
  }
  if (paneLines.length > 0) {
    lines.push(`${paneLines.length} agent pane(s):`);
    lines.push(...paneLines);
  } else {
    lines.push('No agent panes are running yet.');
  }
  const channelNames = Object.values(channels)
    .filter((c) => c.status === 'active')
    .map((c) => `#${c.name}`);
  if (channelNames.length > 0) {
    lines.push(`Channels: ${channelNames.join(', ')}`);
  }
  const out = lines.join('\n');
  return out.length > maxChars ? out.slice(0, maxChars) + '\n…(truncated)' : out;
}
