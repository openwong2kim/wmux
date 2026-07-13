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
  /** Epoch ms when the message was created (turn open). Optional because
   *  messages from before this field existed carry none — render guards. */
  ts?: number;
  /** Assistant only: the tool chips for this turn, in call order. */
  tools?: DeckToolChip[];
  /** Assistant only. */
  status?: DeckBrainStatus;
  /** Assistant only: populated on an `error` event. */
  errorText?: string;
}

/** Chat timestamp — LOCAL wall-clock HH:MM (chat convention). The thread
 *  timestamps previously rendered `toISOString().slice(11,19)` = UTC, which
 *  reads 9h off on a KST machine — always go through this instead. */
export function formatChatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
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
 * Build the one-shot workspace snapshot injected into the brain's first turn
 * (M1.5 — one orchestrator per workspace): a compact, token-budgeted list of
 * the OWN workspace's live agent panes (coordinate + agent), a one-line
 * roster of the other workspaces (existence only — the brain must know its
 * boundary and hand cross-workspace requests back to the operator), and the
 * channel catalog (company-level, the comms bus). Main re-caps this to ~2KB;
 * we keep it terse here. Pure + exported for unit testing.
 */
export function buildWorkspaceContextSummary(args: {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  surfaceAgent: Record<string, { name: string; slug?: AgentSlug } | undefined>;
  paneLabel: Record<string, string>;
  /** Operator-assigned pane roles (paneId → role), the orchestrator-role mirror.
   *  Optional so existing callers/tests stay terse; omitted → no role hints. */
  paneRole?: Record<string, string>;
  channels: Record<string, Channel>;
  maxChars?: number;
}): string {
  const { workspaces, activeWorkspaceId, surfaceAgent, paneLabel, paneRole, channels, maxChars = 2000 } = args;
  const own = workspaces.find((w) => w.id === activeWorkspaceId);
  const lines: string[] = [
    own
      ? `You are the orchestrator for workspace "${own.name}". Your agents live in this workspace only.`
      : 'Your workspace:',
  ];
  const paneLines: string[] = [];
  const countAgentPanes = (w: Workspace): number => {
    let n = 0;
    for (const leaf of findLeafPanes(w.rootPane)) {
      if (
        leaf.surfaces.some(
          (s) => s.surfaceType !== 'browser' && !!s.ptyId && !!surfaceAgent[s.ptyId]?.name,
        )
      ) {
        n++;
      }
    }
    return n;
  };
  if (own) {
    const wsOrdinal = own.wsOrdinal ?? 0;
    for (const leaf of findLeafPanes(own.rootPane)) {
      const agentSurfaces = leaf.surfaces.filter(
        (s) => s.surfaceType !== 'browser' && !!s.ptyId && !!surfaceAgent[s.ptyId]?.name,
      );
      const repr = agentSurfaces.find((s) => s.id === leaf.activeSurfaceId) ?? agentSurfaces[0];
      if (!repr) continue;
      const autoName = computePaneAutoName(wsOrdinal, leaf.ordinal ?? 0, surfaceAgent[repr.ptyId]?.slug);
      const label = paneDisplayName(paneLabel[leaf.id], autoName);
      const agent = surfaceAgent[repr.ptyId]?.name ?? 'agent';
      const role = paneRole?.[leaf.id]?.trim();
      paneLines.push(
        `- ${autoName} [${agent}]${label !== autoName ? ` (${label})` : ''}${role ? ` — role: ${role}` : ''}`,
      );
    }
  }
  if (paneLines.length > 0) {
    lines.push(`${paneLines.length} agent pane(s):`);
    lines.push(...paneLines);
  } else {
    lines.push('No agent panes are running here yet.');
  }
  // Existence-only roster: the brain knows the other workspaces are there
  // (and can say "ask that workspace's orchestrator"), but gets no pane
  // detail — it cannot target them anyway (token confinement).
  const others = workspaces.filter((w) => w.id !== activeWorkspaceId);
  if (others.length > 0) {
    const roster = others
      .map((w) => {
        const n = countAgentPanes(w);
        return `"${w.name}" (${n > 0 ? `${n} agent pane(s)` : 'idle'})`;
      })
      .join(', ');
    lines.push(
      `Other workspaces (outside your scope — the operator drives them from their own tabs): ${roster}`,
    );
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
