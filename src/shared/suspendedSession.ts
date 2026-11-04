// #2398 — what happens to a suspended session (a WSL placeholder, or one the
// recovery cap left on disk) that nobody has shown: shared by the daemon's
// boot-time background promote and main's pty:reconnect, so the two never
// disagree about which sessions start on their own.

/**
 * Owner decision §6-4: the daemon promotes a pending recovery in the
 * background right after boot only for an exec unit or a supervised session,
 * which must run whether or not anyone looks at it. A plain shell starts when
 * its pane is first shown.
 */
export function recoversInBackground(session: { exec?: unknown; supervision?: unknown }): boolean {
  return !!session.exec || !!session.supervision;
}

/**
 * Whether a daemon.promoteSession call started the session itself (#2398):
 * succeeded, the session was not already running, and the call did not join
 * the daemon's boot background start of it (`joined`). Decided from what the
 * daemon did, never from why the call was made: a 'join' finds nothing to
 * join when the background start failed or never covered the session (past
 * its cap), and then this call spawns it. Joining another caller's promote
 * counts as started too: that caller (a raw write, a shown pane) just started
 * it, and a stop key must not land in it. A daemon from before `joined`
 * existed cannot say, so its answer counts as started: a stop key is refused
 * rather than land in a session just started.
 */
export function promoteStartedSession(result: { ok: boolean; alreadyActive?: boolean; joined?: boolean }): boolean {
  return result.ok && result.alreadyActive !== true && result.joined !== true;
}

/**
 * What pty:reconnect does with a suspended session: 'promote' — the caller
 * asks for that explicitly (a shown pane, a raw write, a resume on start);
 * 'join' — the caller did not ask, but the session starts anyway: the daemon
 * starts it in the background (an exec unit or supervised session), or main
 * does, with its credentials (a held user shell, `startPending`, #3049), so the call
 * promotes too: it joins that start when one is in flight, and spawns the
 * session itself when none is (the start failed, or never covered it),
 * which promoteStartedSession then reports as started; 'join-only' — the
 * same unit, for a caller that must never start anything (a stop key,
 * a repaint): it joins a start already in flight and otherwise is answered
 * like 'hold'; 'hold' — otherwise: attached to nothing, kept in use, and
 * answered `deferred`. A reconnect that does not say never starts any other
 * plain shell.
 */
export function suspendedReconnectAction(
  session: { exec?: unknown; supervision?: unknown; startPending?: boolean },
  opts: { promote?: boolean; joinOnly?: boolean } | undefined,
): 'promote' | 'join' | 'join-only' | 'hold' {
  if (opts?.promote === true) return 'promote';
  if (!recoversInBackground(session) && session.startPending !== true) return 'hold';
  return opts?.joinOnly === true ? 'join-only' : 'join';
}

/**
 * #2398 — how pty:reconnect goes on from daemon.promoteSession's answer:
 * 'held' — a join-only call found no start in flight and the session not
 * running: answered like a hold, never as a failed recovery (which would
 * raise the pane's Retry banner for a key); 'failed' — the start failed and
 * the recovery stays pending; 'attach' — the session runs.
 */
export function promoteOutcome(result: { ok: boolean; notInFlight?: boolean }): 'held' | 'failed' | 'attach' {
  if (result.notInFlight === true) return 'held';
  return result.ok ? 'attach' : 'failed';
}

/**
 * pty:reconnect's answer for a suspended session it holds: not attached,
 * not failed, with the session's guarded resume binding (the daemon
 * surfaces it only while its transcript lives), so the renderer can promote
 * it at boot after all when resume-on-start would bring that agent back.
 */
export function heldReconnectAnswer<B>(session: { resumeAgent?: string; resumeBinding?: B }): {
  success: false;
  deferred: true;
  resumeAgent?: string;
  resumeBinding?: B;
} {
  return {
    success: false,
    deferred: true,
    ...(session.resumeAgent ? { resumeAgent: session.resumeAgent } : {}),
    ...(session.resumeBinding ? { resumeBinding: session.resumeBinding } : {}),
  };
}
