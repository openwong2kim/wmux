// ─── `wmux task` — clean up your workspace's A2A tasks (#3068) ──────────────
//
// The same call as the a2a_task_cancel tool, on the MAIN pipe: main takes the
// caller's workspace from its pane (a2aCaller.ts), so this command can only
// reach tasks its own workspace sent or received.

import { sendRequest } from '../client';
import { ensureOk, printResult } from '../utils';
import { resolveSenderPtyId } from './channel';
import { ENV_KEYS } from '../../shared/constants';
import { A2A_BULK_CANCEL_MAX, A2A_BULK_CANCEL_STATES } from '../../shared/a2aTaskCleanup';

export const TASK_HELP = `
wmux task — your workspace's A2A tasks

  wmux task cancel <task-id…> [--reason <text>] [--dry-run]
      Cancel tasks your workspace sent or received (at most ${A2A_BULK_CANCEL_MAX}).
  wmux task cancel --state <state> --older-than-days <n> [--reason <text>] [--dry-run]
      Cancel your workspace's tasks in <state> (${A2A_BULK_CANCEL_STATES.join(', ')})
      that have not changed for <n> days or more.

  --dry-run lists what would be canceled and changes nothing. Each cancel is
  recorded in the task log as your workspace. Tasks of other workspaces are
  refused, as with a single cancel.
`;

/** The a2a.task.cancel params for `wmux task cancel <args>`, or an error to print. */
export function buildTaskCancelParams(args: readonly string[]): Record<string, unknown> | { error: string } {
  const ids: string[] = [];
  const params: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = (): string | undefined => {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) return undefined;
      i += 1;
      return v;
    };
    if (a === '--dry-run') params.dryRun = true;
    else if (a === '--reason') {
      const v = value();
      if (v === undefined) return { error: '--reason needs a text' };
      params.reason = v;
    } else if (a === '--state') {
      const v = value();
      if (v === undefined) return { error: '--state needs a state' };
      params.state = v;
    } else if (a === '--older-than-days') {
      const v = value();
      const n = v === undefined ? NaN : Number(v);
      if (!Number.isFinite(n) || n < 0) return { error: '--older-than-days needs a number of days, 0 or more' };
      params.olderThanDays = n;
    } else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else ids.push(a);
  }
  const filter = params.state !== undefined || params.olderThanDays !== undefined;
  if (filter && ids.length > 0) return { error: 'give task ids or --state with --older-than-days, not both' };
  if (filter && (params.state === undefined || params.olderThanDays === undefined)) {
    return { error: '--state and --older-than-days go together' };
  }
  if (!filter && ids.length === 0) return { error: 'name a task id, or --state with --older-than-days' };
  if (!filter) params.taskIds = ids;
  return params;
}

export async function handleTask(sub: string | undefined, args: string[], jsonMode: boolean): Promise<void> {
  if (sub !== 'cancel') {
    console.log(TASK_HELP);
    if (sub !== undefined && sub !== 'help' && sub !== '--help') process.exit(1);
    return;
  }
  const built = buildTaskCancelParams(args);
  if ('error' in built && typeof built.error === 'string') {
    console.error(`Error: ${built.error}\n${TASK_HELP}`);
    process.exit(1);
  }
  const workspaceId = process.env[ENV_KEYS.WORKSPACE_ID]?.trim() ?? '';
  const senderPtyId = await resolveSenderPtyId();
  if (!workspaceId || !senderPtyId) {
    console.error('Error: run this from a shell inside a wmux pane (no workspace or pane identity).');
    process.exit(1);
  }
  const response = await sendRequest('a2a.task.cancel', { ...built, workspaceId, senderPtyId });
  if (jsonMode) {
    printResult(response);
    return;
  }
  ensureOk(response);
  console.log(formatBulkResult(response.result));
}

/** One line per task: what changed, what was refused and why. */
export function formatBulkResult(result: unknown): string {
  const r = (result ?? {}) as {
    dryRun?: boolean;
    canceled?: string[];
    wouldCancel?: string[];
    refused?: Array<{ taskId: string; error: string }>;
    unchanged?: Array<{ taskId: string; state: string }>;
    more?: number;
  };
  const lines: string[] = [];
  const changed = (r.dryRun ? r.wouldCancel : r.canceled) ?? [];
  for (const id of changed) lines.push(`${r.dryRun ? 'would cancel' : 'canceled'}  ${id}`);
  for (const u of r.unchanged ?? []) lines.push(`unchanged     ${u.taskId} (already ${u.state})`);
  for (const f of r.refused ?? []) lines.push(`refused       ${f.taskId}: ${f.error}`);
  lines.push(`${changed.length} ${r.dryRun ? 'would be canceled (dry run, nothing changed)' : 'canceled'}, ${r.refused?.length ?? 0} refused, ${r.unchanged?.length ?? 0} unchanged`);
  if (r.more) lines.push(`${r.more} more match past the first ${A2A_BULK_CANCEL_MAX}; run it again for them`);
  return lines.join('\n');
}
