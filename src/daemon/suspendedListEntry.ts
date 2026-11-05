// #2398 — the entry daemon.listSessions appends, when asked includeSuspended,
// for a suspended session that lives only in sessions.json (the recovery cap
// left it there).

import type { DaemonSession } from './types';

/**
 * `exec` and `supervision` as a live entry carries them: they decide whether
 * the session starts on its own (recoversInBackground), and a graceful
 * shutdown leaves exec units and supervised sessions suspended like any
 * other, so the cap can leave one here. Without them main's pty:reconnect
 * and the renderer's reconcile held a cap-skipped unit as a plain shell, and
 * a `restart: always` service in a workspace nobody opened stayed down.
 * `bindingUsable` is the caller's guard on the resume binding (usable, and
 * its transcript still exists).
 */
export function suspendedListEntry(s: DaemonSession, bindingUsable: boolean) {
  return {
    id: s.id,
    // `cmd` as every live entry has it (pty:reconnect records and returns
    // it after a promote, #2398); `shell` kept for older readers.
    cmd: s.cmd,
    shell: s.cmd,
    state: 'suspended' as const,
    cwd: s.cwd,
    createdAt: s.createdAt,
    lastActivity: s.lastActivity,
    // #3049 — as a live entry has it: main grants a restored user shell its
    // credentials only when this matches main's own record of the pane.
    ...(s.incarnationId ? { incarnationId: s.incarnationId } : {}),
    ...(s.exec ? { exec: s.exec } : {}),
    ...(s.supervision ? { supervision: s.supervision } : {}),
    // #2398 §6-4 option B: its agent's resume binding, under the same guard
    // as a live pane's durable one, so a hidden pane can resume it on start.
    ...(bindingUsable ? { resumeBinding: s.resumeBinding } : {}),
  };
}
