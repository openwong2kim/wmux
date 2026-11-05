// Agent markers (shared/computer/agentMarker.ts): each agent that sends input
// gets its own colour when it first sends input, kept for the life of main.
// A new agent takes the colour the fewest recently active agents hold, so
// agents that came and went do not use up the palette. The marker rides on every input request so the helper's overlay
// draws that agent's halo, pill, pointer and caret in it; a pane-keyed agent's
// colour also marks its pane in wmux.

import { createHash } from 'node:crypto';
import { AGENT_MARKER_COLORS, agentMarkerColor, type AgentMarker, type AgentMarkerEntry } from '../../shared/computer/agentMarker';
import { AGENT_ROWS } from '../../shared/agentIdentity';
import type { ComputerAgent } from './ComputerService';

/** The pill's longest text, so it stays short on screen. */
export const AGENT_MARKER_LABEL_MAX = 40;
const CLIENT_MAX = 20;
/** An agent that sent input this recently still counts as holding its colour. */
const RECENT_MS = 30 * 60_000;

export interface AgentMarkerDeps {
  /** The pane's #tag (`#backend`) when it has one, else null. Read on every input, so a rename shows. */
  paneTag?: (ptyId: string) => string | null;
  /** Every pane's colour, called each time a pane gets one. */
  onPaneColour?: (entries: AgentMarkerEntry[]) => void;
  now?: () => number;
}

export class AgentMarkers {
  private readonly slots = new Map<string, { id: string; color: string; agent: ComputerAgent; lastUsed: number }>();

  constructor(private readonly deps: AgentMarkerDeps = {}) {}

  /** The agent's marker. Its first call takes a free palette colour; later calls keep it. */
  markerFor(agent: ComputerAgent): AgentMarker {
    const now = (this.deps.now ?? Date.now)();
    let slot = this.slots.get(agent.key);
    if (slot) {
      // The workspace may have been renamed since; the colour stays.
      slot.agent = agent;
      slot.lastUsed = now;
    } else {
      slot = { id: markerId(agent.key), color: this.freeColour(now), agent, lastUsed: now };
      this.slots.set(agent.key, slot);
      // On the input path: a failed push never fails the action.
      try {
        if (agent.ptyId) this.deps.onPaneColour?.(this.entries());
      } catch (err) {
        console.warn('[computer] agent marker push failed:', err);
      }
    }
    return { id: slot.id, label: this.labelFor(agent), color: slot.color };
  }

  /** The pill text of an agent that has a marker, or undefined. */
  labelOf(key: string): string | undefined {
    const slot = this.slots.get(key);
    return slot && this.labelFor(slot.agent);
  }

  /** One colour per pane (its first agent's), for the renderer; agents without a pane are not listed. */
  entries(): AgentMarkerEntry[] {
    const byPty = new Map<string, string>();
    for (const { agent, color } of this.slots.values()) {
      if (agent.ptyId && !byPty.has(agent.ptyId)) byPty.set(agent.ptyId, color);
    }
    return [...byPty].map(([ptyId, color]) => ({ ptyId, color }));
  }

  /**
   * The palette colour the fewest agents active in the last RECENT_MS hold,
   * the earlier one on a tie: palette order while there are free colours, and
   * the 11th of 10 busy agents starts the palette over.
   */
  private freeColour(now: number): string {
    const held = new Map<string, number>();
    for (const slot of this.slots.values()) {
      if (now - slot.lastUsed < RECENT_MS) held.set(slot.color, (held.get(slot.color) ?? 0) + 1);
    }
    let best = agentMarkerColor(0);
    let fewest = Infinity;
    for (const color of AGENT_MARKER_COLORS) {
      const count = held.get(color) ?? 0;
      if (count < fewest) {
        best = color;
        fewest = count;
      }
    }
    return best;
  }

  /**
   * The pane's #tag, else the workspace name, then the client: "#api-1 · Claude
   * Code". An agent with neither a pane nor a workspace reads "outside wmux ·
   * <client>". The client name is the caller's own choice, so it loses `#` and
   * `·` and cannot pass for a pane's tag.
   */
  private labelFor(agent: ComputerAgent): string {
    if (!agent.client) return shorten(agent.label, AGENT_MARKER_LABEL_MAX);
    let tag: string | null = null;
    try {
      tag = agent.ptyId ? this.deps.paneTag?.(agent.ptyId) ?? null : null;
    } catch {
      tag = null;
    }
    const client = shorten(clientDisplayName(plainClientName(agent.client)), CLIENT_MAX);
    const where = tag ?? agent.workspaceName ?? (agent.ptyId ? undefined : 'outside wmux');
    // Code points, as shorten counts them; at least one character of `where`.
    const room = Math.max(2, AGENT_MARKER_LABEL_MAX - Array.from(client).length - 3);
    return where ? `${shorten(where, room)} · ${client}` : client;
  }
}

/** Stable per agent and opaque: the key carries pane ids the helper has no use for. */
function markerId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/** The client name without the tag and separator marks a pill is built from. */
function plainClientName(client: string): string {
  return client.replace(/[#·]+/g, ' ').replace(/\s+/g, ' ').trim() || 'agent';
}

/** An MCP client name that spells an agent's name ("claude-code") reads as that name ("Claude Code"). */
function clientDisplayName(client: string): string {
  const flat = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, '-');
  return AGENT_ROWS.find((row) => flat(row.display) === flat(client))?.display ?? client;
}

function shorten(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}
