import type { AgentStatus } from '../../shared/types';
import { findLeaf } from '../../shared/paneUtils';
import type { StoreState } from '../stores';
import { selectWorkspaceAgentRoster } from '../stores/selectors/workspaceAgentRoster';
import { computePaneAutoName } from './paneNaming';
import { composeOwnerHost } from '../terminal/composeChord';

/**
 * "Mention an agent": put another agent's address into the focused agent's
 * input, so it can reach that agent with send_message. Replaces dragging a
 * workspace card or pane tab into the terminal, which pasted a whole markdown
 * block. Everything here is pure; the picker and the sidebar `@` button do the
 * writing (see agentMentionInsert.ts).
 */

/** The pane the reference is inserted into: the focused one. */
export interface MentionSource {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
  ptyId: string;
  /** The pane shows Chat view: the text goes to the composer, not the PTY. */
  chat: boolean;
}

type SourceState = Pick<StoreState, 'workspaces' | 'activeWorkspaceId' | 'surfaceAgent' | 'chatViewEnabled'>
  & Partial<Pick<StoreState, 'agentAliveByPtyId' | 'commandRunningByPtyId'>>;

/**
 * The focused pane, when it is one a mention can go into: a terminal running a
 * detected agent, or a pane in Chat view. Null for a plain shell — the
 * shortcut then is not claimed and the key reaches the terminal (F2 is mc's
 * and htop's), whatever key the user bound it to.
 */
export function focusedMentionSource(state: SourceState): MentionSource | null {
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws) return null;
  const leaf = findLeaf(ws.rootPane, ws.activePaneId);
  if (!leaf) return null;
  const surface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  if (!surface || (surface.surfaceType ?? 'terminal') !== 'terminal' || !surface.ptyId) return null;
  const chat = !!state.chatViewEnabled && surface.viewMode === 'chat';
  if (!chat) {
    if (!state.surfaceAgent[surface.ptyId]?.name) return null;
    // The agent name outlives the agent by up to one detection poll (~15 s).
    // An agent that just exited back to its shell is a shell again: F2 there
    // belongs to mc / htop, not to the picker.
    if (state.agentAliveByPtyId?.[surface.ptyId] === false) return null;
    if (state.commandRunningByPtyId?.[surface.ptyId] === false) return null;
  }
  return { workspaceId: ws.id, paneId: leaf.id, surfaceId: surface.id, ptyId: surface.ptyId, chat };
}

/**
 * The mention source for a keydown, or null when the key is not the picker's.
 *
 * The source is the store's active leaf, but a key can come from another
 * terminal: a floating pane or a Command Deck brain embed runs its own shell
 * (mc, htop) while a leaf agent stays "active". A key typed into one of those
 * belongs to that terminal and must reach it — the same ownership rule the
 * Rich Input chord follows (#1280). A key from outside any terminal (the Chat
 * view composer, the sidebar) is the active pane's.
 */
export function mentionSourceForKey(state: SourceState, target: EventTarget | null): MentionSource | null {
  const source = focusedMentionSource(state);
  if (!source) return null;
  const owner = composeOwnerHost(target).ptyId;
  return owner && owner !== source.ptyId ? null : source;
}

export interface MentionPaneTarget {
  kind: 'pane';
  key: string;
  workspaceId: string;
  workspaceName: string;
  paneId: string;
  /** Only when the pane has several tabs — the pane id alone is then not one agent. */
  surfaceId?: string;
  agentName: string;
  /** The tab title or the pane's label, when it says more than the agent name. */
  title?: string;
  /** `w115-55` — the pane coordinate shown on tabs. */
  coordinate: string;
  status: AgentStatus;
}

export interface MentionWorkspaceTarget {
  kind: 'workspace';
  key: string;
  workspaceId: string;
  workspaceName: string;
  panes: { paneId: string; surfaceId?: string; agentName: string }[];
}

export type MentionTarget = MentionPaneTarget | MentionWorkspaceTarget;

// Agents put a status glyph in front of their tab title (`✳ Claude Code`), so
// a title is only worth showing when it says more than the agent's name.
function sameName(title: string, agentName: string): boolean {
  const bare = (v: string) => v.replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase();
  return bare(title) === bare(agentName);
}

type TargetState = Parameters<typeof selectWorkspaceAgentRoster>[0];

/**
 * Every agent the focused one could address, one row per agent pane, across
 * workspaces in sidebar order. A workspace running two or more of them also
 * gets a workspace row (after its panes). The focused pane itself is left out;
 * so are stashed panes (nobody is looking at them, and a send does not reach
 * them) and remote mirrors (no local pane a send can pin).
 */
export function buildMentionTargets(state: TargetState, excludePtyId: string | null): MentionTarget[] {
  const out: MentionTarget[] = [];
  for (const ws of state.workspaces) {
    const rows = selectWorkspaceAgentRoster(state, ws.id).rows.filter(
      (r) => !r.stashed && !r.remote && r.agentName && r.ptyId !== excludePtyId,
    );
    const panes: MentionPaneTarget[] = rows.map((r) => {
      const leaf = findLeaf(ws.rootPane, r.paneId);
      const coordinate = computePaneAutoName(ws.wsOrdinal ?? 0, leaf?.ordinal ?? 0);
      const label = state.paneLabel[r.paneId]?.trim();
      const title = r.surfaceTitle ?? (label || undefined);
      return {
        kind: 'pane',
        key: `pane:${r.ptyId}`,
        workspaceId: ws.id,
        workspaceName: ws.name,
        paneId: r.paneId,
        ...(r.surfaceCount > 1 && { surfaceId: r.surfaceId }),
        agentName: r.agentName,
        ...(title && !sameName(title, r.agentName) && { title }),
        coordinate,
        status: r.status,
      };
    });
    out.push(...panes);
    if (panes.length >= 2) {
      out.push({
        kind: 'workspace',
        key: `ws:${ws.id}`,
        workspaceId: ws.id,
        workspaceName: ws.name,
        panes: panes.map((p) => ({
          paneId: p.paneId,
          ...(p.surfaceId && { surfaceId: p.surfaceId }),
          agentName: p.agentName,
        })),
      });
    }
  }
  return out;
}

/** Type-ahead: every whitespace-separated word must appear somewhere in the row. */
export function filterMentionTargets(targets: readonly MentionTarget[], query: string): MentionTarget[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...targets];
  return targets.filter((t) => {
    const hay = (t.kind === 'pane'
      ? [t.agentName, t.title ?? '', t.coordinate, t.workspaceName, t.paneId]
      : [t.workspaceName, t.workspaceId, ...t.panes.map((p) => p.agentName)]
    ).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// Names come from tab titles and workspace names the user (or a TUI) set; the
// reference must stay one line with balanced quotes, or a non-bracketed
// prompt would submit half of it.
function oneLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/"/g, "'").trim();
}

function paneAddress(p: { paneId: string; surfaceId?: string }): string {
  return p.surfaceId ? `pane ${p.paneId} surface ${p.surfaceId}` : `pane ${p.paneId}`;
}

/**
 * The one-line reference inserted at the cursor. Carries exactly what
 * send_message needs — workspace id, pane id (and surface id when the pane
 * has several tabs) — plus the names a human reads. A workspace reference
 * lists its agent panes instead of naming one: send_message refuses an
 * unaddressed send to a workspace with several agents, and the reference
 * must not suggest otherwise.
 */
export function buildMentionReference(target: MentionTarget): string {
  const ws = `workspace "${oneLine(target.workspaceName)}" (${target.workspaceId})`;
  if (target.kind === 'pane') {
    return `[wmux agent "${oneLine(target.agentName)}" · ${ws} · ${paneAddress(target)} · reach it with wmux send_message]`;
  }
  const panes = target.panes.map((p) => `"${oneLine(p.agentName)}" ${paneAddress(p)}`).join(', ');
  return `[wmux ${ws} · agents: ${panes} · reach one with wmux send_message and its pane_id]`;
}

/**
 * The `a2a.task.send` params for ⌘Enter / Ctrl+Enter: the same call
 * send_message makes with pane_id, sent as the focused pane. `senderPtyId`
 * is what lets a same-workspace send reach a sibling instead of being held as
 * unverified; a workspace row sends unaddressed, so a workspace with several
 * agents refuses it — reported, never retargeted.
 */
/**
 * A direct send is written by the person at the keyboard, not by the focused
 * agent — but it has to leave as that agent's pane (senderPtyId), or a
 * same-workspace send is held as unverified. The a2a task has no field for a
 * human author, so the text says it, and the receiver does not answer a peer
 * agent that never spoke.
 */
export const HUMAN_SEND_PREFIX = '[sent by the user from wmux, not by an agent]';

/**
 * The `a2a.task.send` params for ⌘Enter / Ctrl+Enter: the same call
 * send_message makes with pane_id, sent as the focused pane. A workspace row
 * has no single pane to address, so it has no params at all (the picker never
 * sends it — a workspace running several agents refuses unaddressed sends).
 */
export function buildMentionSendParams(
  source: Pick<MentionSource, 'workspaceId' | 'ptyId'>,
  target: MentionPaneTarget,
  message: string,
): Record<string, unknown> {
  return {
    workspaceId: source.workspaceId,
    senderPtyId: source.ptyId,
    to: target.workspaceId,
    message: `${HUMAN_SEND_PREFIX} ${message}`,
    paneId: target.paneId,
    ...(target.surfaceId && { surfaceId: target.surfaceId }),
  };
}

export type MentionSendOutcome =
  | { kind: 'sent'; nudge: boolean }
  | { kind: 'stored'; reason: string }
  | { kind: 'refused'; reason: string };

/** What an `a2a.task.send` result means for the one-line feedback. */
export function describeMentionSendResult(result: unknown): MentionSendOutcome {
  const r = (result ?? {}) as { ok?: unknown; error?: unknown; delivery?: Record<string, unknown> };
  if (typeof r.error === 'string') {
    return { kind: 'refused', reason: r.error.replace(/^a2a\.task\.send:\s*/, '') };
  }
  if (r.ok === false) return { kind: 'refused', reason: 'refused' };
  const d = r.delivery ?? {};
  if (d.notified === true) return { kind: 'sent', nudge: d.mode === 'nudge' };
  return { kind: 'stored', reason: typeof d.reason === 'string' ? d.reason : 'not delivered' };
}
