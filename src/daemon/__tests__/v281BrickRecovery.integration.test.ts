/**
 * v2.8.1 brick-recovery integration test.
 *
 * Exercises the full Bug 1 fix chain against real disk I/O with
 * synthesized state, in the order the daemon performs at startup:
 *
 *   1. StateWriter.load — applies 7-day suspended TTL prune
 *   2. selectRecoverableSessions — applies 40-session recovery cap
 *
 * The unit tests cover each step in isolation; this test verifies the
 * INTERACTION. End state must look like alphabeen's worst-case scenario
 * (50 suspended, machine bricked) recovers cleanly: stale entries
 * vanish, cap leaves headroom, and the surviving set is exactly the
 * most-recently-active 40.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateWriter } from '../StateWriter';
import { selectRecoverableSessions } from '../recoverySelector';
import type { DaemonState, DaemonSession, DaemonSessionState } from '../types';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_RECOVER_SESSIONS = 40; // mirrors src/daemon/index.ts

let tmpDir: string;
let writer: StateWriter;

function session(
  id: string,
  state: DaemonSessionState,
  lastActivity: string,
): DaemonSession {
  return {
    id,
    state,
    createdAt: '2026-04-01T00:00:00.000Z',
    lastActivity,
    pid: 4242,
    cmd: 'powershell.exe',
    cwd: 'C:\\Users\\test',
    env: {},
    cols: 120,
    rows: 30,
    deadTtlHours: 24,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-v281-integration-'));
  writer = new StateWriter(tmpDir);
});

afterEach(() => {
  writer.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('v2.8.1 brick recovery — full Bug 1 flow', () => {
  it('a 50-session brick scenario reduces to 40 recoverable + 5 capped + 5 pruned', () => {
    // Synthesize alphabeen's machine post-brick:
    //   5 sessions stale beyond the 7-day suspended TTL
    //   25 active suspended sessions with timestamps spread across the last 24h
    //   20 detached (interrupted-by-X-button) sessions, recent
    //   Total: 50 — exactly the v2.8.0 hard-cap point
    const now = Date.now();
    const sessions: DaemonSession[] = [];

    for (let i = 0; i < 5; i++) {
      sessions.push(
        session(
          `stale-${i}`,
          'suspended',
          new Date(now - (8 + i) * DAY).toISOString(),
        ),
      );
    }
    for (let i = 0; i < 25; i++) {
      sessions.push(
        session(
          `recent-suspended-${i}`,
          'suspended',
          new Date(now - i * HOUR).toISOString(),
        ),
      );
    }
    for (let i = 0; i < 20; i++) {
      sessions.push(
        session(
          `detached-${i}`,
          'detached',
          new Date(now - i * 5 * 60 * 1000).toISOString(),
        ),
      );
    }
    expect(sessions.length).toBe(50);

    const initial: DaemonState = { version: 1, sessions };
    writer.saveImmediate(initial);

    // Step 1: disk → load. 7-day TTL drops the 5 stale-* entries.
    const loaded = writer.load();
    expect(loaded.sessions).toHaveLength(45);
    const loadedIds = new Set(loaded.sessions.map((s) => s.id));
    for (let i = 0; i < 5; i++) {
      expect(loadedIds.has(`stale-${i}`)).toBe(false);
    }

    // Step 2: cap policy. 45 surviving > cap 40 → 5 oldest survivors capped.
    const { recoverableIds, cappedCount } = selectRecoverableSessions(
      loaded.sessions,
      MAX_RECOVER_SESSIONS,
    );
    expect(recoverableIds.size).toBe(40);
    expect(cappedCount).toBe(5);

    // The 20 detached/* sessions are the most recent (≤ 5 minutes ago)
    // so they all clear the cap. Among the 25 recent-suspended/* the
    // five oldest (i = 20..24, stamped 20–24h ago) are the ones capped.
    for (let i = 0; i < 20; i++) {
      expect(recoverableIds.has(`detached-${i}`)).toBe(true);
    }
    for (let i = 0; i < 20; i++) {
      expect(recoverableIds.has(`recent-suspended-${i}`)).toBe(true);
    }
    for (let i = 20; i < 25; i++) {
      expect(recoverableIds.has(`recent-suspended-${i}`)).toBe(false);
    }

    // The combined effect: the v2.8.0 lockout is broken on first
    // launch — only 40 PTYs spawn during recovery, leaving headroom
    // for new panes well below MAX_SESSIONS.
    expect(recoverableIds.size).toBeLessThan(200);
  });

  it('a 12-session healthy machine recovers all 12 unchanged', () => {
    // Sanity check: a normal user (e.g., the maintainer's actual
    // ~/.wmux/sessions.json shows 12 detached) is not affected by the
    // hotfix — every session under the cap recovers identically.
    const now = Date.now();
    const sessions: DaemonSession[] = Array.from({ length: 12 }, (_, i) =>
      session(
        `daemon-${i}`,
        'detached',
        new Date(now - i * 30 * 60 * 1000).toISOString(),
      ),
    );
    writer.saveImmediate({ version: 1, sessions });

    const loaded = writer.load();
    expect(loaded.sessions).toHaveLength(12);

    const { recoverableIds, cappedCount } = selectRecoverableSessions(
      loaded.sessions,
      MAX_RECOVER_SESSIONS,
    );
    expect(recoverableIds.size).toBe(12);
    expect(cappedCount).toBe(0);
    for (let i = 0; i < 12; i++) {
      expect(recoverableIds.has(`daemon-${i}`)).toBe(true);
    }
  });

  it('TTL prune leaves dead-session-with-tight-deadTtlHours alone for suspended siblings', () => {
    // Regression guard for a subtle confusion the implementation must
    // avoid: deadTtlHours is a per-session field that ONLY governs
    // dead-state TTL, never suspended. A dead session with a 1h TTL
    // and a suspended session with the same id pattern, both 25h old:
    // dead is gone, suspended survives (well within the 7-day window).
    const now = Date.now();
    writer.saveImmediate({
      version: 1,
      sessions: [
        session('dead-tight', 'dead', new Date(now - 25 * HOUR).toISOString()),
        {
          ...session(
            'suspended-tight',
            'suspended',
            new Date(now - 25 * HOUR).toISOString(),
          ),
          deadTtlHours: 1, // intentionally tight — must NOT affect suspended
        },
      ],
    });

    const loaded = writer.load();
    const ids = loaded.sessions.map((s) => s.id);
    expect(ids).not.toContain('dead-tight');
    expect(ids).toContain('suspended-tight');
  });
});
