import { describe, it, expect } from 'vitest';
import { selectRecoverableSessions } from '../recoverySelector';
import type { DaemonSession, DaemonSessionState } from '../types';

function session(
  id: string,
  state: DaemonSessionState,
  lastActivity: string,
): DaemonSession {
  return {
    id,
    state,
    createdAt: '2026-04-17T00:00:00.000Z',
    lastActivity,
    pid: 1234,
    cmd: 'bash',
    cwd: '/tmp',
    env: {},
    cols: 80,
    rows: 24,
    deadTtlHours: 24,
  };
}

describe('selectRecoverableSessions', () => {
  it('returns every session when count is under the cap', () => {
    const sessions = [
      session('a', 'suspended', '2026-05-09T10:00:00.000Z'),
      session('b', 'detached', '2026-05-09T11:00:00.000Z'),
      session('c', 'attached', '2026-05-09T12:00:00.000Z'),
    ];
    const { recoverableIds, cappedCount } = selectRecoverableSessions(
      sessions,
      10,
    );
    expect(recoverableIds.size).toBe(3);
    expect(recoverableIds.has('a')).toBe(true);
    expect(recoverableIds.has('b')).toBe(true);
    expect(recoverableIds.has('c')).toBe(true);
    expect(cappedCount).toBe(0);
  });

  it('caps at the limit and keeps the most recently active sessions', () => {
    // The v2.8.1 incident shape: 50 non-dead sessions, cap=40 → 10 capped.
    const sessions: DaemonSession[] = [];
    for (let i = 0; i < 50; i++) {
      // i=0 is oldest, i=49 is most recent.
      const ts = new Date(2026, 4, 1, 0, 0, i).toISOString();
      sessions.push(session(`s-${i}`, 'suspended', ts));
    }
    const { recoverableIds, cappedCount } = selectRecoverableSessions(
      sessions,
      40,
    );
    expect(recoverableIds.size).toBe(40);
    expect(cappedCount).toBe(10);

    // The 10 oldest (s-0..s-9) must NOT be recovered.
    for (let i = 0; i < 10; i++) {
      expect(recoverableIds.has(`s-${i}`)).toBe(false);
    }
    // The 40 most recent (s-10..s-49) must be recovered.
    for (let i = 10; i < 50; i++) {
      expect(recoverableIds.has(`s-${i}`)).toBe(true);
    }
  });

  it('excludes dead sessions from the queue regardless of recency', () => {
    // A very fresh dead session should never crowd out a live suspended one.
    const sessions = [
      session('dead-fresh', 'dead', '2026-05-09T12:00:00.000Z'),
      session('alive-old', 'suspended', '2026-05-09T08:00:00.000Z'),
    ];
    const { recoverableIds, cappedCount } = selectRecoverableSessions(
      sessions,
      40,
    );
    expect(recoverableIds.has('dead-fresh')).toBe(false);
    expect(recoverableIds.has('alive-old')).toBe(true);
    expect(cappedCount).toBe(0);
  });

  it('REGRESSION #4: cap below the recoverable count keeps the overflow SUSPENDED, never dead (codex #4)', () => {
    // When maxSessions is lowered below the persisted recoverable count, the
    // daemon derives cap = min(maxSessions, 40) (see index.ts main()). The
    // overflow must stay suspended: it lands in cappedCount, never in
    // recoverableIds, so recoverSessions preserves it verbatim
    // (buildState + preservedFromState) and never calls createSession for
    // it — which means it can never trip the MAX_SESSIONS throw → catch →
    // dead-mark path. cap ≤ maxSessions by construction also guarantees
    // recovery itself can't exhaust the cap. This is the data-loss guard.
    const sessions: DaemonSession[] = [];
    for (let i = 0; i < 10; i++) {
      const ts = new Date(2026, 4, 1, 0, 0, i).toISOString();
      sessions.push(session(`s-${i}`, 'suspended', ts));
    }
    const maxSessions = 5;
    const cap = Math.min(maxSessions, 40); // mirror index.ts main()
    const { recoverableIds, cappedCount } = selectRecoverableSessions(sessions, cap);
    expect(recoverableIds.size).toBe(5); // recover up to the cap
    expect(cappedCount).toBe(5); // overflow stays suspended, NOT dead-marked
    expect(recoverableIds.size).toBeLessThanOrEqual(maxSessions); // never exceeds the ceiling
  });

  it('handles cap=0 by skipping every session', () => {
    // Defensive: a config that disables recovery should not throw.
    const sessions = [
      session('a', 'suspended', '2026-05-09T10:00:00.000Z'),
      session('b', 'detached', '2026-05-09T11:00:00.000Z'),
    ];
    const { recoverableIds, cappedCount } = selectRecoverableSessions(
      sessions,
      0,
    );
    expect(recoverableIds.size).toBe(0);
    expect(cappedCount).toBe(2);
  });

  it('handles empty input', () => {
    const { recoverableIds, cappedCount } = selectRecoverableSessions([], 40);
    expect(recoverableIds.size).toBe(0);
    expect(cappedCount).toBe(0);
  });

  it('does not mutate the input array', () => {
    const sessions = [
      session('a', 'suspended', '2026-05-09T08:00:00.000Z'),
      session('b', 'suspended', '2026-05-09T12:00:00.000Z'),
    ];
    const original = sessions.map((s) => s.id);
    selectRecoverableSessions(sessions, 1);
    expect(sessions.map((s) => s.id)).toEqual(original);
  });

  it('treats detached and attached identically for cap purposes', () => {
    // detached/attached aren't expected on disk (shutdown demotes to
    // suspended) but a hand-edited or migrated state file might carry
    // them. The cap policy is state-agnostic except for `dead`.
    const sessions = [
      session('detached', 'detached', '2026-05-09T08:00:00.000Z'),
      session('attached', 'attached', '2026-05-09T09:00:00.000Z'),
      session('suspended', 'suspended', '2026-05-09T10:00:00.000Z'),
    ];
    const { recoverableIds, cappedCount } = selectRecoverableSessions(
      sessions,
      2,
    );
    expect(recoverableIds.size).toBe(2);
    expect(recoverableIds.has('suspended')).toBe(true);
    expect(recoverableIds.has('attached')).toBe(true);
    expect(recoverableIds.has('detached')).toBe(false);
    expect(cappedCount).toBe(1);
  });
});
