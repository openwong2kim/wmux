/**
 * External sessions placed in this computer's sidebar (placement B,
 * 2026-11-01): by workspace folder, the rest "Outside wmux". The matching is
 * in Sidebar/externalSessionPlacement.ts; this file keeps it off the hot path.
 */
import type { StoreState } from '../index';
import type { ExternalSession } from '../../../shared/externalSessions';
import type { AgentStatus } from '../../../shared/types';
import { listedWorkspaces } from '../../../shared/pcRail';
import { selectBotTaskOwners, withoutBotTasks } from '../../components/Sidebar/botTasks';
import {
  externalAgentStatus,
  placeExternalSessions,
  workspaceFolder,
  type ExternalPlacement,
} from '../../components/Sidebar/externalSessionPlacement';

type PlacementState = Pick<StoreState, 'externalSessions' | 'workspaces' | 'fanoutOrigin' | 'readOnly'>;

const NO_SESSIONS: ExternalSession[] = [];
const EMPTY: ExternalPlacement = { byWorkspace: {}, outside: NO_SESSIONS };

// One pass per store state, shared by every row on the same write; the
// placement itself is redone only when the sessions or a folder changed.
const perState = new WeakMap<object, ExternalPlacement>();
let lastPlacement: { sessions: readonly ExternalSession[]; signature: string; out: ExternalPlacement } | null = null;

export function selectExternalPlacement(state: PlacementState): ExternalPlacement {
  const sessions = state.externalSessions ?? NO_SESSIONS;
  // A read-only view (another computer's list, the web mirror) is not where
  // this computer's outside sessions live.
  if (state.readOnly || sessions.length === 0) return EMPTY;
  const cached = perState.get(state);
  if (cached) return cached;
  // Only the rows this sidebar lists: no other computer's shadow
  // workspaces, no bot workers (they live on the Bots page).
  const folders = withoutBotTasks(listedWorkspaces(state.workspaces), selectBotTaskOwners(state))
    .map((ws) => ({ id: ws.id, folder: workspaceFolder(ws) }));
  const signature = folders.map((f) => `${f.id}\u0000${f.folder ?? ''}`).join('\n');
  const out = lastPlacement && lastPlacement.sessions === sessions && lastPlacement.signature === signature
    ? lastPlacement.out
    : placeExternalSessions(sessions, folders);
  lastPlacement = { sessions, signature, out };
  perState.set(state, out);
  return out;
}

/** The sessions in `workspaceId`'s roster (reference-stable between placements). */
export function selectWorkspaceExternalSessions(state: PlacementState, workspaceId: string): ExternalSession[] {
  return selectExternalPlacement(state).byWorkspace[workspaceId] ?? NO_SESSIONS;
}

/**
 * The workspace row's view of its external sessions as one string, so the
 * row re-renders only when a mark or a question changes: each session's
 * status mark joined by `,`, then the first waiting question after a NUL.
 */
export function selectWorkspaceExternalSummary(state: PlacementState, workspaceId: string): string {
  const sessions = selectWorkspaceExternalSessions(state, workspaceId);
  if (sessions.length === 0) return '';
  const question = sessions.find((s) => s.state === 'needs-you' && s.pendingQuestion?.trim())?.pendingQuestion?.trim() ?? '';
  return `${sessions.map((s) => externalAgentStatus(s.state)).join(',')}\u0000${question}`;
}

export interface ExternalSummary {
  statuses: AgentStatus[];
  needYou: number;
  question: string;
}

const NO_SUMMARY: ExternalSummary = { statuses: [], needYou: 0, question: '' };

export function parseExternalSummary(key: string): ExternalSummary {
  if (!key) return NO_SUMMARY;
  const [marks, question = ''] = key.split('\u0000');
  const statuses = marks.split(',') as AgentStatus[];
  return { statuses, needYou: statuses.filter((s) => s === 'awaiting_input').length, question };
}

/** Sessions waiting on the owner, wherever they are placed: the Fleet badge's share. */
export function selectExternalNeedsYouCount(state: Pick<StoreState, 'externalSessions' | 'readOnly'>): number {
  if (state.readOnly) return 0;
  let n = 0;
  for (const s of state.externalSessions ?? NO_SESSIONS) if (s.state === 'needs-you') n += 1;
  return n;
}
