/**
 * Fold-to-view mapping: the folded session becomes a flat list of transcript
 * rows. Each user block opens a turn; the turn's blocks follow it and a footer
 * closes it once the turn ended (or ticks while it is open). A live question
 * sits at the end of the open turn.
 */
import type { Block, Session } from '../../../shared/chatv2/session';
import type { UserQuestionPrompt } from '../../../shared/chatv2/userQuestion';
import { turnModelLabel } from './format';

export type ToolState = 'running' | 'done' | 'failed';

export type TranscriptRow =
  | { kind: 'user'; key: string; block: Block }
  | { kind: 'assistant'; key: string; block: Block }
  | { kind: 'reasoning'; key: string; block: Block }
  | { kind: 'tool'; key: string; block: Block; state: ToolState }
  | { kind: 'subagent'; key: string; block: Block; state: ToolState }
  | { kind: 'tasks'; key: string; block: Block }
  | { kind: 'plan'; key: string; block: Block }
  | { kind: 'image'; key: string; block: Block }
  | { kind: 'notice'; key: string; block: Block; tone: 'error' | 'interrupt' }
  | { kind: 'meta'; key: string; block: Block }
  | { kind: 'question'; key: string; prompt: UserQuestionPrompt }
  | {
      kind: 'footer';
      key: string;
      /** The user block that opened the turn. */
      turnId: string;
      model: string;
      startedAt?: number;
      durationMs?: number;
      outcome?: Block['outcome'];
      /** The turn is still open: the footer ticks from `startedAt`. */
      live: boolean;
    };

export function toolState(block: Block): ToolState {
  const status = block.tool?.status;
  if (status === 'failed' || status === 'cancelled' || status === 'error') return 'failed';
  if (status === 'completed' || status === 'done' || status === 'success') return 'done';
  // The fold clears `streaming` when the turn ends, so a call it never closed stops reading as live.
  return block.streaming || (!!block.approval && !block.approval.decided) ? 'running' : 'done';
}

function blockRow(block: Block): TranscriptRow | null {
  const key = block.id;
  switch (block.role) {
    case 'user':
      return { kind: 'user', key, block };
    case 'assistant':
      return block.text.trim() || block.streaming ? { kind: 'assistant', key, block } : null;
    case 'reasoning':
      return block.text.trim() ? { kind: 'reasoning', key, block } : null;
    case 'tool':
    case 'approval':
      return block.agentRun
        ? { kind: 'subagent', key, block, state: toolState(block) }
        : { kind: 'tool', key, block, state: toolState(block) };
    case 'tasks':
      return block.taskList?.items.length ? { kind: 'tasks', key, block } : null;
    case 'plan':
      return { kind: 'plan', key, block };
    case 'image':
      return { kind: 'image', key, block };
    case 'system':
      return block.notice ? { kind: 'notice', key, block, tone: block.notice } : block.text.trim() ? { kind: 'meta', key, block } : null;
    default:
      return null;
  }
}

function footer(session: Session, user: Block, open: boolean): TranscriptRow | null {
  const live = open && !!session.busy;
  if (!live && !user.outcome && user.durationMs == null) return null;
  return {
    kind: 'footer',
    key: `${user.id}:footer`,
    turnId: user.id,
    model: turnModelLabel(user.turnModel?.harness ?? session.harness, user.turnModel?.id ?? session.model),
    ...(user.startedAt != null ? { startedAt: user.startedAt } : {}),
    ...(user.durationMs != null ? { durationMs: user.durationMs } : {}),
    ...(user.outcome ? { outcome: user.outcome } : {}),
    live,
  };
}

export function sessionRows(session: Session): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let turn: Block | null = null;
  const close = (open: boolean) => {
    if (!turn) return;
    const row = footer(session, turn, open);
    if (row) rows.push(row);
  };
  for (const block of session.blocks) {
    if (block.role === 'user') {
      close(false);
      turn = block;
    }
    const row = blockRow(block);
    if (row) rows.push(row);
  }
  if (session.pendingQuestion) rows.push({ kind: 'question', key: `q:${session.pendingQuestion.requestId}`, prompt: session.pendingQuestion });
  close(true);
  return rows;
}

/** Requests a person can answer now, oldest first (approvals on blocks, then the question). */
export function pendingRequests(session: Session): string[] {
  const ids = session.blocks.filter((b) => b.approval && !b.approval.decided).map((b) => b.approval!.requestId);
  if (session.pendingQuestion) ids.push(session.pendingQuestion.requestId);
  return ids;
}
