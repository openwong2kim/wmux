/**
 * The only text wmux types for an agent whose plain prompt it cannot recognise
 * (daemon/deliveryComposer.ts): one line of fixed words and ids, pointing at
 * what the agent reads itself. Never a body, never the boxed envelope.
 *
 * The line starts with `wmux:`, a word with no glob or operator character in
 * sh, bash, zsh, dash, fish, PowerShell or cmd, so a shell given the line by
 * mistake looks for a command named `wmux:` and finds none (ksh and csh read
 * the word as a label and look for the next fixed word instead). Everything
 * after it is words, ids and `.` `_` `-`, so the line cannot carry syntax.
 */

const POINTER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;

export type PointerTarget =
  | { kind: 'task'; taskId: string }
  | { kind: 'tasks' }
  | { kind: 'mention'; channelId: string; seq: number }
  | { kind: 'mentions' };

/** The pointer line, or null when an id has another shape. */
export function deliveryPointer(target: PointerTarget): string | null {
  switch (target.kind) {
    case 'task':
      if (!POINTER_ID.test(target.taskId)) return null;
      return `wmux: A2A task ${target.taskId} is waiting for you. Read it with a2a_task_query task_id ${target.taskId}`;
    case 'tasks':
      return 'wmux: A2A tasks are waiting for you. Read them with a2a_task_query';
    case 'mention':
      if (!POINTER_ID.test(target.channelId) || !Number.isSafeInteger(target.seq) || target.seq < 1) return null;
      return `wmux: channel ${target.channelId} has a mention for you. Read it with wmux channel read ${target.channelId} --since ${target.seq}`;
    case 'mentions':
      return 'wmux: channels have mentions for you. List them with wmux channel unread';
  }
}

/**
 * The pointer for a batch: one task or one channel is named (a channel from its
 * earliest mention, as `--since` is inclusive); several are listed by the
 * command that shows them all.
 */
export function pointerForBatch(taskIds: readonly string[], mentions: readonly { channelId: string; seq: number }[]): string | null {
  const tasks = [...new Set(taskIds)];
  if (tasks.length > 1) return deliveryPointer({ kind: 'tasks' });
  if (tasks.length === 1) return deliveryPointer({ kind: 'task', taskId: tasks[0] });
  const channels = [...new Set(mentions.map((m) => m.channelId))];
  if (channels.length > 1) return deliveryPointer({ kind: 'mentions' });
  if (channels.length === 0) return null;
  const seq = Math.min(...mentions.map((m) => m.seq));
  return deliveryPointer({ kind: 'mention', channelId: channels[0], seq });
}
