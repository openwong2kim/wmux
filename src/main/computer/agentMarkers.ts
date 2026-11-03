// Agent markers (shared/computer/agentMarker.ts): each agent that sends input
// gets its own colour, in the order agents first send input, kept for the life
// of main. The marker rides on every input request so the helper's overlay
// draws that agent's halo, pill, pointer and caret in it; a pane-keyed agent's
// colour also marks its pane in wmux.

import { createHash } from 'node:crypto';
import { agentMarkerColor, type AgentMarker, type AgentMarkerEntry } from '../../shared/computer/agentMarker';
import { AGENT_ROWS } from '../../shared/agentIdentity';
import type { ComputerAgent } from './ComputerService';

/** The pill's longest text, so it stays short on screen. */
export const AGENT_MARKER_LABEL_MAX = 40;
const CLIENT_MAX = 20;

export interface AgentMarkerDeps {
  /** The pane's #tag (`#backend`) when it has one, else null. Read on every input, so a rename shows. */
  paneTag?: (ptyId: string) => string | null;
  /** Every pane's colour, called each time a pane gets one. */
  onPaneColour?: (entries: AgentMarkerEntry[]) => void;
}

export class AgentMarkers {
  private readonly slots = new Map<string, { id: string; color: string; agent: ComputerAgent }>();

  constructor(private readonly deps: AgentMarkerDeps = {}) {}

  /** The agent's marker. Its first call takes the next palette colour; later calls keep it. */
  markerFor(agent: ComputerAgent): AgentMarker {
    let slot = this.slots.get(agent.key);
    if (slot) {
      // The workspace may have been renamed since; the colour stays.
      slot.agent = agent;
    } else {
      slot = { id: markerId(agent.key), color: agentMarkerColor(this.slots.size), agent };
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

  /** One colour per pane, for the renderer; agents without a pane are not listed. */
  entries(): AgentMarkerEntry[] {
    const byPty = new Map<string, string>();
    for (const { agent, color } of this.slots.values()) {
      if (agent.ptyId) byPty.set(agent.ptyId, color);
    }
    return [...byPty].map(([ptyId, color]) => ({ ptyId, color }));
  }

  /** The pane's #tag, else the workspace name, then the client: "#api-1 · Claude Code". */
  private labelFor(agent: ComputerAgent): string {
    if (!agent.client) return shorten(agent.label, AGENT_MARKER_LABEL_MAX);
    let tag: string | null = null;
    try {
      tag = agent.ptyId ? this.deps.paneTag?.(agent.ptyId) ?? null : null;
    } catch {
      tag = null;
    }
    const client = shorten(clientDisplayName(agent.client), CLIENT_MAX);
    const where = tag ?? agent.workspaceName;
    return where ? `${shorten(where, AGENT_MARKER_LABEL_MAX - client.length - 3)} · ${client}` : client;
  }
}

/** Stable per agent and opaque: the key carries pane ids the helper has no use for. */
function markerId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
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
