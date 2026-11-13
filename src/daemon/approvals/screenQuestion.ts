// What a pane's screen asks, read from its text and what the daemon knows of
// it: shared by main's fan-out owner lane (main/pipe/handlers/ownerLane.ts)
// and the daemon's headless status (a2aRemote/headlessDelivery.ts), so both
// tell a question the same way.

import { approvalOnScreen } from './approvalOnScreen';
import { parsePlanPrompt, parseTerminalPrompt } from './terminalPromptParse';
import type { FolderTrustState } from '../folderTrustState';

/**
 * What a task pane shows, as the owner lane and the headless status read it. `menu` is a selection
 * menu wmux identified (an AskUserQuestion select its hook reported, or the
 * menu of a pane held at its usage limit); `dialog` is any other selection
 * dialog on screen.
 */
export type ScreenQuestion = 'none' | 'menu' | 'dialog' | 'permission' | 'plan' | 'trust' | 'unknown';

/** The pending approval record's kind for an AskUserQuestion select. */
export const QUESTION_RECORD_KIND = 'awaiting_input';

/** A pending approval record on the pane, by its kind. */
export function screenOfRecord(kind: string | undefined): ScreenQuestion {
  return kind === QUESTION_RECORD_KIND ? 'menu' : 'permission';
}

/** What the screen text alone shows. */
export function classifyScreenQuestion(screen: string): 'none' | 'dialog' | 'permission' | 'plan' {
  const rows = screen.split('\n').slice(-60);
  if (parsePlanPrompt(rows)) return 'plan';
  if (!approvalOnScreen(screen)) return 'none';
  return parseTerminalPrompt(rows) ? 'permission' : 'dialog';
}

/**
 * What a pane shows, from what can be read of it: a folder-trust
 * prompt first; a screen that cannot be read whole is `unknown`; a permission
 * or plan prompt the screen shows; then a pending approval record (it may be
 * older than the screen); then any other dialog, a `menu` only on a pane held
 * at its usage limit.
 */
export function screenQuestionOf(facts: {
  trust: FolderTrustState | null;
  /** The pending record's kind, '' for one without; null for no record. */
  recordKind: string | null;
  /** null: no screen could be read. */
  screen: string | null;
  usageLimited: boolean;
}): ScreenQuestion {
  if (facts.trust === 'trust') return 'trust';
  if (facts.screen === null || facts.trust === 'unknown') return 'unknown';
  const shown = classifyScreenQuestion(facts.screen);
  if (shown === 'plan' || shown === 'permission') return shown;
  if (facts.recordKind !== null) return screenOfRecord(facts.recordKind);
  if (shown === 'dialog') return facts.usageLimited ? 'menu' : 'dialog';
  return 'none';
}
