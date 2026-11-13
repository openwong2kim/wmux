// The fan-out owner lane's input decisions: what is on a task pane's screen,
// whether the owner setting lets the task's orchestrator write there, the
// log line every lane write gets, and the coalesced notice in the task
// workspace.

import type { ScreenQuestion } from '../../../daemon/approvals/screenQuestion';
import { resolveAgentSlug } from '../../../shared/ptyMessageDelivery';
import { agentRow } from '../../../shared/agentIdentity';
import type { FanoutOwnerAnswers } from '../../../shared/workerLaunch';

/** What a task pane shows, as the owner lane reads it (daemon/approvals/screenQuestion.ts). */
export type OwnerLaneScreen = ScreenQuestion;

export {
  screenOfRecord,
  classifyScreenQuestion as classifyOwnerLaneScreen,
  screenQuestionOf as ownerLaneScreenOf,
} from '../../../daemon/approvals/screenQuestion';

/**
 * What the owner setting does with one write:
 * - `allow`: written, whatever is on screen;
 * - `refuse`: not written;
 * - `default`: the gate every other caller gets decides.
 *
 * `menus` lets through an identified menu (`menu`) on a pane that draws
 * Claude Code's dialogs only; another agent's dialogs are not told apart
 * from its menus. Ctrl+C and Escape keep the default gate under `menus` and
 * `off`, which lets them stop the worker; the screen is not read for them.
 */
export function ownerLaneVerdict(
  setting: FanoutOwnerAnswers,
  screen: OwnerLaneScreen,
  opts: { claudePane: boolean; stopKey: boolean },
): 'allow' | 'refuse' | 'default' {
  if (setting === 'all') return 'allow';
  if (setting === 'off' || opts.stopKey) return 'default';
  if (screen === 'none' || (screen === 'menu' && opts.claudePane)) return 'allow';
  return 'refuse';
}

/** Whether the daemon's agent for a pane draws Claude Code's dialogs, the
 *  ones whose menus the screen reading tells from its other prompts. */
export function drawsClaudeDialogs(agent: string | null | undefined): boolean {
  return agentRow(resolveAgentSlug(agent))?.dialogs !== undefined;
}

/** The refusal a write gets under `menus`. */
export function ownerLaneRefusalMessage(op: string, ptyId: string, screen: OwnerLaneScreen): string {
  const shown = screen === 'menu' ? "a selection menu on a pane wmux cannot confirm is Claude Code's" : SCREEN_WORDS[screen];
  return (
    `${op}: pane "${ptyId}" is showing ${shown}. The fan-out setting "ownerAnswers" is "menus", ` +
    "which lets a task's orchestrator answer only Claude Code's question and usage-limit menus. " +
    'A human answers it in the pane; ctrl+c still stops the worker.'
  );
}

const SCREEN_WORDS: Record<OwnerLaneScreen, string> = {
  none: 'no prompt',
  menu: 'a selection menu',
  dialog: 'a dialog that is not a question or usage-limit menu wmux recognizes',
  permission: 'a permission prompt',
  plan: 'a plan approval prompt',
  trust: 'a folder-trust prompt',
  unknown: 'a screen that could not be read whole',
};

export interface OwnerLaneWrite {
  /** The caller's pane, when it named one. */
  callerPtyId?: string;
  callerWorkspaceId: string;
  ptyId: string;
  taskWorkspaceId: string;
  /** `key enter`, `text 42 bytes`. */
  input: string;
  /** 'not read' for a stop key, which every setting lets stop the worker. */
  screen: OwnerLaneScreen | 'not read';
  setting: FanoutOwnerAnswers;
  outcome: 'allowed' | 'refused';
}

/** The main-log line for one owner-lane write. */
export function ownerLaneLogLine(w: OwnerLaneWrite): string {
  const caller = w.callerPtyId
    ? `pane ${JSON.stringify(w.callerPtyId)} (ws ${JSON.stringify(w.callerWorkspaceId)})`
    : `ws ${JSON.stringify(w.callerWorkspaceId)}`;
  return (
    `[owner-lane] ${caller} → pane ${JSON.stringify(w.ptyId)} (task ws ${JSON.stringify(w.taskWorkspaceId)}): ` +
    `${w.input}; screen ${w.screen}; setting ${w.setting}; ${w.outcome}`
  );
}

/** The main-log line for a delivery the owner lane let past a folder-trust
 *  verdict main could not decide. */
export function ownerLaneDeliveryLogLine(d: {
  callerWorkspaceId: string;
  ptyId: string;
  taskWorkspaceId: string;
  reason?: string;
}): string {
  return (
    `[owner-lane] delivery from ws ${JSON.stringify(d.callerWorkspaceId)} → pane ${JSON.stringify(d.ptyId)} ` +
    `(task ws ${JSON.stringify(d.taskWorkspaceId)}): folder-trust unknown${d.reason ? ` (${d.reason})` : ''} passed; setting all`
  );
}

/** The main-log line for a write that left the caller's workspace and found
 *  no owner lane: why, so a refused orchestrator write can be traced. */
export function ownerLaneMissLogLine(method: string, callerPtyId: string | undefined, reason: string): string {
  const caller = callerPtyId ? `pane ${JSON.stringify(callerPtyId)}` : 'a caller with no pane';
  return `[owner-lane] ${method} from ${caller}: no owner lane for ${reason}`;
}

/**
 * The workspace that sent every task of a delivery, read from the daemon's
 * task rows (`a2a.task.query` on the target's workspace): for each task, the
 * side that is not the target's workspace. Null when a task is missing, has
 * the target's workspace on both sides or on neither, or when two tasks name
 * different senders. Pure.
 */
export function deliverySenderOf(tasks: readonly unknown[], taskIds: readonly string[], targetWorkspaceId: string): string | null {
  if (taskIds.length === 0 || !targetWorkspaceId) return null;
  let sender: string | null = null;
  for (const id of taskIds) {
    const task = tasks.find((t) => isRecord(t) && t.id === id);
    const metadata = isRecord(task) && isRecord(task.metadata) ? task.metadata : null;
    const from = metadata && isRecord(metadata.from) ? metadata.from.workspaceId : undefined;
    const to = metadata && isRecord(metadata.to) ? metadata.to.workspaceId : undefined;
    let side: unknown;
    if (to === targetWorkspaceId && from !== targetWorkspaceId) side = from;
    else if (from === targetWorkspaceId && to !== targetWorkspaceId) side = to;
    if (typeof side !== 'string' || side.length === 0) return null;
    if (sender !== null && sender !== side) return null;
    sender = side;
  }
  return sender;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** How long one notice in a task workspace covers further writes there. */
export const OWNER_LANE_NOTICE_WINDOW_MS = 60_000;

/**
 * One notice per task workspace per window: the first write in a window
 * raises it, the rest are covered by it (each is in the log).
 */
export function ownerLaneNotices(
  raise: (taskWorkspaceId: string) => void,
  now: () => number = Date.now,
): (taskWorkspaceId: string) => void {
  const lastRaised = new Map<string, number>();
  return (taskWorkspaceId) => {
    const at = now();
    const last = lastRaised.get(taskWorkspaceId);
    if (last !== undefined && at - last < OWNER_LANE_NOTICE_WINDOW_MS) return;
    for (const [ws, t] of lastRaised) if (at - t >= OWNER_LANE_NOTICE_WINDOW_MS) lastRaised.delete(ws);
    lastRaised.set(taskWorkspaceId, at);
    raise(taskWorkspaceId);
  };
}
