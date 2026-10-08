import { isRemoteTaskId } from '../../shared/a2aRemote';
import type { Message } from '../../shared/types';
import type { CreateTaskInput } from './A2aTaskService';

/**
 * Parse the public `a2a.task.create` RPC. Only id / title / from / to /
 * history pass: a `remote` marker is never read from a caller (only the
 * cross-host inbound path, inside the daemon, creates a remote task), and an
 * `rt-` id is refused so no plain task can sit on a remote task's id and turn
 * the real one into a conflict.
 */
export function parsePublicCreateTask(p: Record<string, unknown>): { ok: true; input: CreateTaskInput } | { ok: false; error: string } {
  const from = p.from as CreateTaskInput['from'] | undefined;
  const to = p.to as CreateTaskInput['to'] | undefined;
  if (!from?.workspaceId || !to?.workspaceId || typeof p.title !== 'string') {
    return { ok: false, error: 'a2a.task.create: from{workspaceId}, to{workspaceId}, and title are required' };
  }
  if (isRemoteTaskId(p.id)) return { ok: false, error: 'a2a.task.create: rt- ids belong to cross-host tasks' };
  return {
    ok: true,
    input: {
      ...(typeof p.id === 'string' ? { id: p.id } : {}),
      title: p.title,
      from,
      to,
      ...(Array.isArray(p.history) ? { history: p.history as Message[] } : {}),
    },
  };
}
