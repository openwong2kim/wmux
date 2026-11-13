/**
 * The only text wmux types for an agent whose plain prompt it cannot recognise
 * (daemon/deliveryComposer.ts): one line of fixed words and ids, pointing at
 * what the agent reads itself. Never a body, never the boxed envelope.
 *
 * The tag is `[wmux]`, as on every line wmux types, so an agent knows the line
 * is wmux's. Run by a shell by mistake it is still a no-op: zsh reports no glob
 * match, sh and bash find no such command, PowerShell rejects it as a type
 * name. Everything after it is words, ids and `.` `_` `-`, so the line cannot
 * carry syntax.
 */

const POINTER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;

export type PointerTarget =
  | { kind: 'task'; taskId: string }
  | { kind: 'mention'; channelId: string; seq: number };

/** The pointer line, or null when an id has another shape. */
export function deliveryPointer(target: PointerTarget): string | null {
  if (target.kind === 'task') {
    if (!POINTER_ID.test(target.taskId)) return null;
    return `[wmux] A2A task ${target.taskId} is waiting for you. Read it with a2a_task_query task_id ${target.taskId}`;
  }
  if (!POINTER_ID.test(target.channelId) || !Number.isSafeInteger(target.seq) || target.seq < 1) return null;
  return `[wmux] channel ${target.channelId} has a mention for you. Read it with wmux channel read ${target.channelId} --since ${target.seq}`;
}
