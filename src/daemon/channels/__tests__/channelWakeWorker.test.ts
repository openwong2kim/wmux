// Channels v2 Step 3a — wake worker tests.
// Pins the safety rules that came out of the live P3' pre-verification:
//   F2 split-write (text, THEN Enter as a separate write),
//   quiet gate, target discipline (never guess), mention backoff + cap +
//   exhaustion broadcast, plain-unread once-per-head-advance, ack reset.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChannelWakeWorker,
  pickTarget,
  MENTION_NUDGE_CAP,
  MENTION_NUDGE_BACKOFF_MS,
  WAKE_QUIET_MS,
  WAKE_TICK_MS,
  EXHAUSTED_REANNOUNCE_MS,
  type WakeUnreadEntry,
  type WakeSessionView,
} from '../channelWakeWorker';

function entry(partial: Partial<WakeUnreadEntry>): WakeUnreadEntry {
  return {
    channelId: 'ch-1',
    name: 'general',
    memberId: 'codex',
    lastReadSeq: 2,
    headSeq: 4,
    unread: 2,
    mentionUnread: 0,
    trimmedBeforeCursor: 0,
    ...partial,
  };
}

function session(partial: Partial<WakeSessionView>): WakeSessionView {
  return {
    id: 'pty-1',
    lastDetectedAgent: 'codex',
    lastActivityMs: 0, // long quiet by default
    workspaceId: 'ws-b',
    ...partial,
  };
}

interface Harness {
  worker: ChannelWakeWorker;
  writes: Array<{ sessionId: string; data: string }>;
  broadcasts: Array<Record<string, unknown>>;
  logs: string[];
  setEntries(e: WakeUnreadEntry[]): void;
  setSessions(s: WakeSessionView[]): void;
  setNow(ms: number): void;
  /** Non-null ⇒ the next write() calls throw it (dead-PTY simulation). */
  setWriteError(err: Error | null): void;
}

function makeHarness(): Harness {
  let entries: WakeUnreadEntry[] = [];
  let sessions: WakeSessionView[] = [];
  let nowMs = 1_000_000;
  let writeError: Error | null = null;
  const writes: Array<{ sessionId: string; data: string }> = [];
  const broadcasts: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const worker = new ChannelWakeWorker({
    memberWorkspaces: () => ['ws-b'],
    unreadFor: () => entries,
    listLiveSessions: () => sessions,
    write: (sessionId, data) => {
      if (writeError) throw writeError;
      writes.push({ sessionId, data });
    },
    broadcast: (event) => broadcasts.push(event),
    log: (_level, message) => logs.push(message),
    now: () => nowMs,
    enterDelayMs: 1,
  });
  return {
    worker,
    writes,
    broadcasts,
    logs,
    setEntries: (e) => (entries = e),
    setSessions: (s) => (sessions = s),
    setNow: (ms) => (nowMs = ms),
    setWriteError: (err) => (writeError = err),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const flushEnter = () => vi.advanceTimersByTime(5);

describe('ChannelWakeWorker — injection mechanics', () => {
  it('injects the nudge line and the Enter as TWO separate writes (F2)', () => {
    const h = makeHarness();
    h.setEntries([entry({ unread: 2, mentionUnread: 1 })]);
    h.setSessions([session({})]);
    h.worker.tickOnce();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].sessionId).toBe('pty-1');
    expect(h.writes[0].data).toContain('#general: 2 unread (1 mention you)');
    expect(h.writes[0].data).toContain('wmux channel read ch-1 --since 3');
    expect(h.writes[0].data).not.toContain('\r');
    flushEnter();
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1].data).toBe('\r');
  });

  it('respects the quiet gate: a recently-active pane is skipped, then nudged once quiet', () => {
    const h = makeHarness();
    h.setNow(1_000_000);
    h.setEntries([entry({ mentionUnread: 1 })]);
    h.setSessions([session({ lastActivityMs: 1_000_000 - (WAKE_QUIET_MS - 1) })]);
    h.worker.tickOnce();
    expect(h.writes).toHaveLength(0);
    // Quiet long enough now.
    h.setNow(1_000_000 + WAKE_QUIET_MS);
    h.worker.tickOnce();
    expect(h.writes).toHaveLength(1);
  });

  it('a JUST-active pane (lastActivityMs≈now) is held off by the quiet gate — GLM fail-safe', () => {
    // The daemon adapter seeds a broken/missing lastActivity to Date.now()
    // rather than 0 (which would read as "quiet since the epoch" and always
    // pass the gate). Model that here: lastActivityMs === now ⇒ gate holds.
    const h = makeHarness();
    h.setNow(1_000_000);
    h.setEntries([entry({ mentionUnread: 1 })]);
    h.setSessions([session({ lastActivityMs: 1_000_000 })]);
    h.worker.tickOnce();
    expect(h.writes).toHaveLength(0);
  });

  it('strips control characters from the injected line', () => {
    const h = makeHarness();
    h.setEntries([entry({ name: 'gen\x1b[31meral', mentionUnread: 1 })]);
    h.setSessions([session({})]);
    h.worker.tickOnce();
    // eslint-disable-next-line no-control-regex
    expect(h.writes[0].data).not.toMatch(/[\x00-\x1f\x7f]/);
  });
});

describe('ChannelWakeWorker — re-nudge policy', () => {
  it('mention unread: re-nudges with backoff up to the cap, then hands off (once per re-announce window)', () => {
    const h = makeHarness();
    h.setEntries([entry({ mentionUnread: 1 })]);
    h.setSessions([session({})]);
    let t = 1_000_000;
    for (let i = 0; i < MENTION_NUDGE_CAP; i++) {
      h.setNow(t);
      h.worker.tickOnce();
      flushEnter();
      // Immediately re-ticking within the backoff window must NOT re-nudge.
      h.worker.tickOnce();
      expect(h.writes.filter((w) => w.data !== '\r')).toHaveLength(i + 1);
      t += (MENTION_NUDGE_BACKOFF_MS[i + 1] ?? 0) + 1;
    }
    // Budget exhausted → no more writes; the handoff announced ONCE (the
    // immediate in-window re-tick inside the loop above fired it).
    const announced = () => h.broadcasts.filter((b) => b['type'] === 'channel.nudgeExhausted');
    expect(announced()).toHaveLength(1);
    expect(announced()[0]).toMatchObject({ channelId: 'ch-1', workspaceId: 'ws-b', memberId: 'codex' });
    // Ticks INSIDE the re-announce window stay silent…
    h.setNow(t + 1_000);
    h.worker.tickOnce();
    expect(announced()).toHaveLength(1);
    expect(h.writes.filter((w) => w.data !== '\r')).toHaveLength(MENTION_NUDGE_CAP);
    // …and the handoff re-announces once the window elapses: the broadcast
    // reaches only CURRENTLY connected clients — headless it lands on
    // nobody, so eventual delivery needs the slow cadence (Codex round-4).
    // Ack (unread=0) still ends the episode entirely (test below).
    h.setNow(t + 1_000 + EXHAUSTED_REANNOUNCE_MS + 1);
    h.worker.tickOnce();
    expect(announced()).toHaveLength(2);
    expect(h.writes.filter((w) => w.data !== '\r')).toHaveLength(MENTION_NUDGE_CAP); // still no new nudges
  });

  it('ack (unread=0) resets the episode: a fresh unread gets a fresh nudge budget', () => {
    const h = makeHarness();
    h.setSessions([session({})]);
    h.setEntries([entry({ mentionUnread: 1 })]);
    h.worker.tickOnce();
    expect(h.writes.filter((w) => w.data !== '\r')).toHaveLength(1);
    // Ack lands → unread 0 → tracker cleared.
    h.setEntries([entry({ unread: 0, mentionUnread: 0 })]);
    h.worker.tickOnce();
    // New mention episode nudges immediately again (budget reset).
    h.setEntries([entry({ mentionUnread: 1, headSeq: 9, lastReadSeq: 8, unread: 1 })]);
    h.worker.tickOnce();
    expect(h.writes.filter((w) => w.data !== '\r')).toHaveLength(2);
  });

  it('plain unread: nudges ONCE, and again only after the head advances', () => {
    const h = makeHarness();
    h.setSessions([session({})]);
    h.setEntries([entry({ unread: 2, mentionUnread: 0, headSeq: 4 })]);
    h.worker.tickOnce();
    h.worker.tickOnce();
    expect(h.writes.filter((w) => w.data !== '\r')).toHaveLength(1);
    // New message arrives (head advances) → one more nudge allowed.
    h.setEntries([entry({ unread: 3, mentionUnread: 0, headSeq: 5 })]);
    h.worker.tickOnce();
    h.worker.tickOnce();
    expect(h.writes.filter((w) => w.data !== '\r')).toHaveLength(2);
  });
});

describe('ChannelWakeWorker — crash safety (an accelerator must never kill the daemon)', () => {
  it('a PTY write that throws is contained and does NOT burn the nudge budget', () => {
    const h = makeHarness();
    h.setEntries([entry({ mentionUnread: 1 })]);
    h.setSessions([session({})]);
    // The pane dies between target selection and the write: node-pty throws
    // synchronously on a destroyed stream.
    h.setWriteError(new Error('write EPIPE'));
    expect(() => h.worker.tickOnce()).not.toThrow();
    expect(h.writes).toHaveLength(0);
    expect(h.logs.some((l) => l.includes('nudge write') && l.includes('failed'))).toBe(true);
    // Budget preserved (G5: never spend nudges into a void) — the very next
    // tick retries and the nudge lands.
    h.setWriteError(null);
    h.worker.tickOnce();
    expect(h.writes.filter((w) => w.data !== '\r')).toHaveLength(1);
  });

  it('a throwing dep inside a scheduled sweep never escapes the timer', () => {
    const logs: string[] = [];
    const worker = new ChannelWakeWorker({
      memberWorkspaces: () => {
        throw new Error('state corrupted');
      },
      unreadFor: () => [],
      listLiveSessions: () => [],
      write: () => undefined,
      broadcast: () => undefined,
      log: (_level, message) => logs.push(message),
      now: () => 0,
    });
    worker.start();
    // A bare setInterval callback that throws = uncaught exception = daemon
    // down. safeTick must swallow + log instead.
    expect(() => vi.advanceTimersByTime(WAKE_TICK_MS + 1)).not.toThrow();
    expect(logs.some((l) => l.includes('sweep failed'))).toBe(true);
    worker.stop();
  });

  it('the post fast-path kick is guarded the same way', () => {
    const logs: string[] = [];
    const worker = new ChannelWakeWorker({
      memberWorkspaces: () => {
        throw new Error('state corrupted');
      },
      unreadFor: () => [],
      listLiveSessions: () => [],
      write: () => undefined,
      broadcast: () => undefined,
      log: (_level, message) => logs.push(message),
      now: () => 0,
    });
    worker.notifyChannelActivity();
    expect(() => vi.advanceTimersByTime(1_500)).not.toThrow();
    expect(logs.some((l) => l.includes('sweep failed'))).toBe(true);
    worker.stop();
  });
});

describe('pickTarget — never guess', () => {
  it('prefers the slug-matching non-claude session', () => {
    const target = pickTarget(
      [
        session({ id: 'a', lastDetectedAgent: 'claude' }),
        session({ id: 'b', lastDetectedAgent: 'codex' }),
        session({ id: 'c', lastDetectedAgent: undefined }),
      ],
      'ws-b',
      'codex',
    );
    expect(target?.id).toBe('b');
  });

  it('falls back to the ONLY eligible session when no slug matches', () => {
    const target = pickTarget(
      [
        session({ id: 'a', lastDetectedAgent: 'claude', attached: true }),
        session({ id: 'b', lastDetectedAgent: undefined }),
      ],
      'ws-b',
      'reviewer',
    );
    expect(target?.id).toBe('b');
  });

  it('returns null on ambiguity (two non-claude sessions, no slug match)', () => {
    expect(
      pickTarget(
        [session({ id: 'a', lastDetectedAgent: undefined }), session({ id: 'b', lastDetectedAgent: 'codex' })],
        'ws-b',
        'reviewer',
      ),
    ).toBeNull();
  });

  it('an ATTACHED claude pane is never picked (the renderer Stop-hook path owns it)', () => {
    const attachedClaude = session({ id: 'a', lastDetectedAgent: 'claude', attached: true });
    expect(pickTarget([attachedClaude], 'ws-b', 'codex')).toBeNull();
    // …even when the memberId literally says "claude" — the generic injector
    // must not double-nudge a pane the renderer path already delivers to.
    expect(pickTarget([attachedClaude], 'ws-b', 'claude')).toBeNull();
  });

  it('a DETACHED claude pane IS a target — headless has no Stop-hook path (Codex round-3)', () => {
    // No renderer attached (the reboot-recovery / GUI-closed window): the
    // worker is the ONLY delivery path, so a Claude-only workspace must not
    // stay silent forever (it never even reached the exhaustion handoff —
    // no nudge was ever spent).
    const headless = session({ id: 'a', lastDetectedAgent: 'claude' });
    expect(pickTarget([headless], 'ws-b', 'claude')?.id).toBe('a');
    // Fallback rule too: the only eligible pane in the workspace.
    expect(pickTarget([headless], 'ws-b', 'codex')?.id).toBe('a');
  });

  it('an attached claude MEMBER never reroutes to an unrelated pane (Codex round-4)', () => {
    // GUI alive: claude's delivery is owned by the renderer path. With one
    // other eligible pane around, the single-pane fallback must NOT fire
    // for memberId "claude" — that would double-deliver into the wrong
    // pane and burn claude's budget there.
    const attachedClaude = session({ id: 'a', lastDetectedAgent: 'claude', attached: true });
    const shell = session({ id: 'b', lastDetectedAgent: undefined });
    expect(pickTarget([attachedClaude, shell], 'ws-b', 'claude')).toBeNull();
    // …while a DIFFERENT member still falls back to that only eligible pane
    // (it may well be where that agent actually runs, sans detection).
    expect(pickTarget([attachedClaude, shell], 'ws-b', 'codex')?.id).toBe('b');
  });

  it('never targets a session from another workspace', () => {
    expect(pickTarget([session({ id: 'a', workspaceId: 'ws-other' })], 'ws-b', 'codex')).toBeNull();
  });

  it('never targets a deferred (recovered-not-yet-activated) session — dogfood G5', () => {
    // After a daemon crash+respawn the recovered pane is bookkept 'attached'
    // but renders nothing and the pre-crash agent process is gone. Live
    // dogfood showed the worker burning mention nudges into that void.
    expect(pickTarget([session({ id: 'a', deferred: true })], 'ws-b', 'codex')).toBeNull();
    // …and a deferred slug-match must not shadow a live fallback either.
    const target = pickTarget(
      [session({ id: 'a', deferred: true, lastDetectedAgent: 'codex' }), session({ id: 'b', lastDetectedAgent: undefined })],
      'ws-b',
      'codex',
    );
    expect(target?.id).toBe('b');
  });
});
