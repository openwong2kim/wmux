// One promote attempt per suspended session at a time (daemon.promoteSession,
// the boot background start of exec units and supervised sessions, and an
// attach that promotes all share it).

/** What a promote attempt answers — see `promoteSession` in index.ts. */
export type PromoteResult = {
  ok: boolean;
  alreadyActive?: boolean;
  /**
   * #2398 — this caller joined the boot background start already in flight
   * instead of starting the session: that start runs whatever any caller
   * does, so a stop key to the session is a real stop request. Not set for a
   * join of another caller's promote (a raw write, a shown pane): that caller
   * just started it, and a stop key must not land in it. Only the daemon
   * knows which.
   */
  joined?: boolean;
  /**
   * #2398 — a join-only call (a stop key, a repaint) found no attempt in
   * flight to join and the session not running, and started none: the
   * session was left as it was.
   */
  notInFlight?: boolean;
  /**
   * #3049 — this attempt started a restored user shell with the credential
   * values its caller passed. A caller that joined it shares the answer; one
   * that joined an attempt started without them (the fallback) does not.
   */
  credentialsApplied?: true;
  error?: { code: string; message: string };
};

/** Who started an attempt: the boot background start, or an RPC caller. */
export type PromoteOrigin = 'background' | 'rpc';

export interface PromoteOnce {
  (id: string, startFresh?: boolean, origin?: PromoteOrigin, joinOnly?: boolean, credentialEnv?: Record<string, string>): Promise<PromoteResult>;
  /** The session left (died, destroyed): drop who started it. */
  forget(id: string): void;
}

export function createPromoteOnce(
  promoteSession: (params: { id: string; fresh: boolean; credentialEnv?: Record<string, string> }) => Promise<PromoteResult>,
  /** Whether the session runs now (a live managed session). */
  isRunning: (id: string) => boolean = () => false,
): PromoteOnce {
  const promotionInFlight = new Map<string, { operation: Promise<PromoteResult>; startFresh: boolean; origin: PromoteOrigin }>();
  // #2398 — who started each session an attempt here started, until it
  // leaves (forget). One entry per live promoted session.
  const startedBy = new Map<string, PromoteOrigin>();
  const joinOf = (existing: { operation: Promise<PromoteResult>; origin: PromoteOrigin }) =>
    (existing.origin === 'background' ? existing.operation.then((r) => ({ ...r, joined: true })) : existing.operation);
  // #2398 — a join-only caller (a stop key) never starts the session: it
  // joins whatever attempt is in flight. With none, an attempt may have just
  // finished (the caller saw the session suspended a moment ago): one the
  // boot background start ran, or a start this daemon did not run here (boot
  // recovery), is answered as running, so the key reaches it; one another
  // caller ran is answered as started by that caller, as a join of it in
  // flight is (promoteStartedSession), so the key does not land in it. A
  // session that does not run is answered notInFlight.
  const joinOnlyAnswer = (id: string): Promise<PromoteResult> => {
    const existing = promotionInFlight.get(id);
    if (existing) return joinOf(existing);
    if (!isRunning(id)) return Promise.resolve({ ok: false, notInFlight: true });
    return Promise.resolve(startedBy.get(id) === 'rpc' ? { ok: true, alreadyActive: false } : { ok: true, alreadyActive: true });
  };
  // #3049 — `credentialEnv` goes with the attempt this call starts; a call
  // that joins one runs with whatever that attempt was started with.
  const promoteOnce = ((id: string, startFresh = false, origin: PromoteOrigin = 'rpc', joinOnly = false, credentialEnv?: Record<string, string>) => {
    if (joinOnly) return joinOnlyAnswer(id);
    const existing = promotionInFlight.get(id);
    // Same intent → one attempt, as before. A DIFFERENT intent must not be
    // answered by the one already running: start-fresh exists because the
    // ordinary promote fails, so handing back that promote's result would
    // answer a question the user did not ask (#1305). Queue behind it instead —
    // and if the one in flight happens to succeed, the idempotent
    // already-active check makes the second a no-op.
    if (existing && existing.startFresh === startFresh) return joinOf(existing);
    const run = () => promoteSession({ id, fresh: startFresh, ...(credentialEnv ? { credentialEnv } : {}) });
    const operation: Promise<PromoteResult> = (existing ? existing.operation.catch(() => undefined).then(run) : run())
      .then((r) => {
        // Recorded before the attempt leaves the in-flight map, so a
        // join-only call never sees neither.
        if (r.ok && r.alreadyActive !== true) startedBy.set(id, origin);
        return r;
      })
      .finally(() => {
        if (promotionInFlight.get(id)?.operation === operation) promotionInFlight.delete(id);
      });
    promotionInFlight.set(id, { operation, startFresh, origin });
    return operation;
  }) as PromoteOnce;
  promoteOnce.forget = (id) => { startedBy.delete(id); };
  return promoteOnce;
}
