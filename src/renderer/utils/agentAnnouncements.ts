// ─── What a screen reader hears about the agents ────────────────────────────
//
// Pure helpers for the agent-state announcer (components/Accessibility/
// AgentStateAnnouncer.tsx). `diffAgentStates` turns two snapshots of the panes'
// agent state into the changes worth saying; `rateLimitAnnouncements` keeps
// those from flooding the screen reader. No store, no clock, no i18n here: the
// component supplies the snapshots, the time and the words.

import type { AgentStatus } from '../../shared/types';

/** One pane's agent, as the announcer sees it. */
export interface AgentPaneState {
  ptyId: string;
  /** The pane tag as the sidebar shows it (`paneTag`, e.g. `#w1-2`). */
  tag: string;
  /** The agent's display name; '' when the pane has no agent. */
  agent: string;
  agentStatus: AgentStatus;
}

export type AgentAnnouncementKind = 'needsYou' | 'finished' | 'error';

export interface AgentAnnouncement {
  kind: AgentAnnouncementKind;
  tag: string;
  agent: string;
}

function announcementKind(prev: AgentStatus, next: AgentStatus): AgentAnnouncementKind | null {
  if (prev === next) return null;
  if (next === 'awaiting_input') return 'needsYou';
  if (next === 'error') return 'error';
  if (prev === 'running' && (next === 'waiting' || next === 'complete')) return 'finished';
  return null;
}

/**
 * The changes to announce between two snapshots, in the new snapshot's order.
 * A pane announces only when it had an agent in both snapshots, so an agent
 * or a pane that appears is not read as a change, and the first snapshot
 * (`prev` null) announces nothing.
 */
export function diffAgentStates(
  prev: readonly AgentPaneState[] | null,
  next: readonly AgentPaneState[],
): AgentAnnouncement[] {
  const before = new Map((prev ?? []).filter((p) => p.agent).map((p) => [p.ptyId, p.agentStatus]));
  const out: AgentAnnouncement[] = [];
  for (const pane of next) {
    if (!pane.agent) continue;
    const prevStatus = before.get(pane.ptyId);
    if (prevStatus === undefined) continue;
    const kind = announcementKind(prevStatus, pane.agentStatus);
    if (kind) out.push({ kind, tag: pane.tag, agent: pane.agent });
  }
  return out;
}

/** At most one announcement per this many milliseconds. */
export const ANNOUNCE_INTERVAL_MS = 2000;
/** Lines one announcement carries at most; older ones are dropped first. */
export const ANNOUNCE_MAX_LINES = 3;

export interface RateState {
  /** When the last announcement went out; null before the first. */
  lastAnnouncedAt: number | null;
  /** Lines held for the next announcement, oldest first. */
  pending: readonly string[];
}

export const EMPTY_RATE_STATE: RateState = { lastAnnouncedAt: null, pending: [] };

export interface RateStep {
  state: RateState;
  /** The text to announce now, or null. */
  announce: string | null;
  /** Call again with no lines after this many ms to flush what is held; null when nothing is. */
  retryInMs: number | null;
}

/**
 * Adds `lines` at time `now`. Announces at once when the last announcement is
 * at least ANNOUNCE_INTERVAL_MS old; otherwise holds the lines, and says when
 * to call again. Held lines are joined into one announcement, keeping only the
 * newest ANNOUNCE_MAX_LINES.
 */
export function rateLimitAnnouncements(state: RateState, lines: readonly string[], now: number): RateStep {
  const pending = [...state.pending, ...lines].slice(-ANNOUNCE_MAX_LINES);
  if (pending.length === 0) return { state, announce: null, retryInMs: null };
  const freeAt = state.lastAnnouncedAt === null ? now : state.lastAnnouncedAt + ANNOUNCE_INTERVAL_MS;
  if (now >= freeAt) {
    return { state: { lastAnnouncedAt: now, pending: [] }, announce: pending.join('. '), retryInMs: null };
  }
  return { state: { lastAnnouncedAt: state.lastAnnouncedAt, pending }, announce: null, retryInMs: freeAt - now };
}
