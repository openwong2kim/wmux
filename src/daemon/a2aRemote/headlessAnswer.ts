// The asking PC's answer to the question a headless worker shows (`kind:
// 'answer'`, A2A_FEATURE_ANSWER), typed as one digit into Claude Code's
// AskUserQuestion picker.
//
// Headless sessions run in auto permission mode, where the agent's
// AskUserQuestion call reaches its transcript only once the picker closes, and
// they run without hooks: the screen is the only place the picker can be read.
// So the picker is read off the session's visible grid (approvals/askPicker),
// and only one shape is answered: ONE single-select question with its
// free-text row and no preview. Its id is a hash of the session, the header,
// the question and its labels: an answer names it, and is refused when the
// screen shows anything else. No screen text leaves this PC.
//
// The key goes in under the same fences as the phone's stepwise answer
// (ApprovalRegistry): the session's delivery lock, a fresh read whose mark
// (output bytes, key revision, PTY incarnation) is checked again in the same
// synchronous block as the write, an untouched picker, and confirmation of
// Claude's own "User answered" block after the key. Anything else is refused
// before a key is typed.

import crypto from 'node:crypto';
import {
  askAnswerSteps,
  askConfirmBaseline,
  askPickerUntouchedRead,
  isFreeTextPlaceholder,
  parseAskPicker,
  type AskAnswer,
  type AskFormQuestion,
  type AskPickerScreen,
} from '../approvals/askPicker';
import { STEP_POLL_MS, awaitAnswerConfirmed, markSince, type PromptScreenMark } from '../approvals/ApprovalRegistry';
import { showsScreenReaderKeyRow } from '../approvals/screenReaderKeyRow';
import { A2A_REMOTE_STATUS_LIMITS, type A2aRemoteAnswerReason, type A2aRemoteAnswerV1 } from '../../shared/a2aRemote';

/** The visible grid with the session's state at the same instant (`readPromptScreen`). */
export interface PromptScreen {
  rows: readonly string[];
  mark: PromptScreenMark;
  unknown?: readonly string[];
}

/** A picker this PC answers: its id, its number of choices (the free-text row not counted), and the form read off it. */
export interface ScreenPicker {
  pickerId: string;
  optionCount: number;
  question: AskFormQuestion;
  screen: AskPickerScreen;
}

/** The one-question single-select picker on `rows`, or why there is none this PC answers. */
export function screenPicker(sessionId: string, rows: readonly string[]): ScreenPicker | { refused: 'no-picker' | 'not-single-select' } {
  // Claude Code's screen-reader layout draws no picker the keys can drive.
  if (showsScreenReaderKeyRow(rows)) return { refused: 'not-single-select' };
  const screen = parseAskPicker(rows);
  if (!screen) return { refused: 'no-picker' };
  if (screen.view !== 'question' || screen.topCut || screen.tabs.length !== 1 || screen.submitTab
    || screen.multiSelect || screen.preview || screen.submitRow) {
    return { refused: 'not-single-select' };
  }
  // The free-text row is the last one; every other row is a choice, numbered from 1.
  const free = screen.options[screen.options.length - 1];
  if (!free || !isFreeTextPlaceholder(free.label)) return { refused: 'not-single-select' };
  const options = screen.options.slice(0, -1).map((row) => ({
    key: row.key,
    label: row.label,
    ...((row.more ?? []).length > 0 ? { description: row.more!.join(' ') } : {}),
  }));
  if (options.length === 0 || options.length > A2A_REMOTE_STATUS_LIMITS.OPTIONS_MAX || options.some((o, i) => o.key !== String(i + 1))) {
    return { refused: 'not-single-select' };
  }
  const header = screen.tabs[0]!.label;
  const question: AskFormQuestion = { id: 'q0', header, text: screen.question, multiSelect: false, allowOther: true, options };
  const pickerId = crypto.createHash('sha256')
    .update([sessionId, header, screen.question, ...options.map((o) => `${o.label}\t${o.description ?? ''}`)].join('\n'))
    .digest('hex')
    .slice(0, 16);
  return { pickerId, optionCount: options.length, question, screen };
}

export interface HeadlessAnswerDeps {
  readPromptScreen(sessionId: string): Promise<PromptScreen | null>;
  /** The session's state right now, read synchronously just before the write. */
  promptScreenMark(sessionId: string): PromptScreenMark | null;
  /** Write one key; the session's new key revision, or null when nothing was written. */
  writeStepKey(sessionId: string, data: string): number | null;
  /** The session's delivery lock (paneDeliveryLock.ts): its token, or null when another writer kept it. */
  lock(sessionId: string): Promise<string | null>;
  unlock(sessionId: string, token: string): void;
  /**
   * Asked again right before the key, after the lock and the last read: the
   * task still open and owned, answers still on. A reason refuses the key.
   */
  stillAllowed?: () => A2aRemoteAnswerReason | null;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}

export type HeadlessAnswerResult = { outcome: 'answered' } | { outcome: 'not-answered'; reason: A2aRemoteAnswerReason };

const no = (reason: A2aRemoteAnswerReason): HeadlessAnswerResult => ({ outcome: 'not-answered', reason });

/** Type `answer` into the session's picker, under its delivery lock. Never throws. */
export async function answerPicker(deps: HeadlessAnswerDeps, sessionId: string, answer: A2aRemoteAnswerV1): Promise<HeadlessAnswerResult> {
  let token: string | null;
  try {
    token = await deps.lock(sessionId);
  } catch {
    token = null;
  }
  if (!token) return no('lock-busy');
  try {
    return await typeAnswer(deps, sessionId, answer);
  } catch {
    return no('unreadable');
  } finally {
    deps.unlock(sessionId, token);
  }
}

async function typeAnswer(deps: HeadlessAnswerDeps, sessionId: string, answer: A2aRemoteAnswerV1): Promise<HeadlessAnswerResult> {
  const now = deps.now ?? Date.now;
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
  // Output since the read (the agent drawing its spinner): read and prove again, once.
  for (let attempt = 0; attempt < 2; attempt++) {
    const read = await deps.readPromptScreen(sessionId);
    if (!read) return no('unreadable');
    const found = screenPicker(sessionId, read.rows);
    if ('refused' in found) return no(found.refused);
    if (found.pickerId !== answer.pickerId) return no('picker-changed');
    if (answer.option > found.optionCount) return no('option-out-of-range');
    const questions = [found.question];
    const answers: AskAnswer[] = [{ keys: [String(answer.option)] }];
    // Nobody has moved its cursor or answered it since it was drawn.
    const untouched = askPickerUntouchedRead(found.screen, questions, read.unknown, answers);
    if (untouched === 'unknown') return no('unreadable');
    if (untouched !== 'meets') return no('typed-meanwhile');
    const steps = askAnswerSteps(questions, answers);
    if (steps.length !== 1 || steps[0]!.expect.view !== 'closed') return no('not-single-select');
    // The "User answered" blocks already on screen, so only a new one confirms this answer.
    const baseline = askConfirmBaseline(read.rows);
    // ── Synchronous from here to the write: nothing can move in between. ──
    const refused = deps.stillAllowed?.() ?? null;
    if (refused) return no(refused);
    const since = markSince(deps.promptScreenMark(sessionId), read.mark.keyInputRevision, read.mark.incarnation, read.mark.bytes);
    if (since === 'moved') return no('typed-meanwhile');
    if (since === 'retry') {
      await delay(STEP_POLL_MS);
      continue;
    }
    const written = deps.writeStepKey(sessionId, steps[0]!.key);
    if (written === null) return no('no-agent');
    const confirmed = await awaitAnswerConfirmed({
      read: () => deps.readPromptScreen(sessionId).catch(() => null),
      baseline,
      questions,
      answers,
      incarnation: read.mark.incarnation ?? '',
      now,
      delay,
    });
    return confirmed ? { outcome: 'answered' } : no('unconfirmed');
  }
  return no('typed-meanwhile');
}
