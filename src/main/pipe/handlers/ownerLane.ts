// The fan-out owner lane's input decisions: what is on a task pane's screen,
// whether the owner setting lets the task's orchestrator write there, the
// log line every lane write gets, and the coalesced notice in the task
// workspace.

import { approvalOnScreen } from '../../../daemon/approvals/approvalOnScreen';
import { parsePlanPrompt, parseTerminalPrompt } from '../../../daemon/approvals/terminalPromptParse';
import { resolveAgentSlug } from '../../../shared/ptyMessageDelivery';
import { agentRow } from '../../../shared/agentIdentity';
import type { FanoutOwnerAnswers } from '../../../shared/workerLaunch';
import type { FolderTrustState } from '../../../daemon/folderTrustState';

/**
 * What a task pane shows, as the owner lane reads it. `menu` is a selection
 * menu wmux identified (an AskUserQuestion select its hook reported, or the
 * menu of a pane held at its usage limit); `dialog` is any other selection
 * dialog on screen.
 */
export type OwnerLaneScreen = 'none' | 'menu' | 'dialog' | 'permission' | 'plan' | 'trust' | 'unknown';

/** The pending approval record's kind for an AskUserQuestion select. */
const QUESTION_RECORD_KIND = 'awaiting_input';

/** A pending approval record on the pane, by its kind. */
export function screenOfRecord(kind: string | undefined): OwnerLaneScreen {
  return kind === QUESTION_RECORD_KIND ? 'menu' : 'permission';
}

/** What the screen text alone shows. */
export function classifyOwnerLaneScreen(screen: string): 'none' | 'dialog' | 'permission' | 'plan' {
  const rows = screen.split('\n').slice(-60);
  if (parsePlanPrompt(rows)) return 'plan';
  if (!approvalOnScreen(screen)) return 'none';
  return parseTerminalPrompt(rows) ? 'permission' : 'dialog';
}

/**
 * What a task pane shows, from what main can read of it: a folder-trust
 * prompt first; a screen that cannot be read whole is `unknown`; a permission
 * or plan prompt the screen shows; then a pending approval record (it may be
 * older than the screen); then any other dialog, a `menu` only on a pane held
 * at its usage limit.
 */
export function ownerLaneScreenOf(facts: {
  trust: FolderTrustState | null;
  /** The pending record's kind, '' for one without; null for no record. */
  recordKind: string | null;
  /** null: no screen could be read. */
  screen: string | null;
  usageLimited: boolean;
}): OwnerLaneScreen {
  if (facts.trust === 'trust') return 'trust';
  if (facts.screen === null || facts.trust === 'unknown') return 'unknown';
  const shown = classifyOwnerLaneScreen(facts.screen);
  if (shown === 'plan' || shown === 'permission') return shown;
  if (facts.recordKind !== null) return screenOfRecord(facts.recordKind);
  if (shown === 'dialog') return facts.usageLimited ? 'menu' : 'dialog';
  return 'none';
}

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
