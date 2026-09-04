// Channels v2 Step 3a — wake worker tests.
// Pins the safety rules that came out of the live P3' pre-verification:
//   F2 split-write (text, THEN Enter as a separate write),
//   quiet gate, target discipline (never guess), mention backoff + cap +
//   exhaustion broadcast, plain-unread once-per-head-advance, ack reset.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChannelWakeWorker,
  pickTarget,
  pickTargetWithPrincipal,
  MENTION_NUDGE_CAP,
  MENTION_NUDGE_BACKOFF_MS,
  WAKE_QUIET_MS,
  WAKE_TICK_MS,
  EXHAUSTED_REANNOUNCE_MS,
  BODY_PREVIEW_MAX_LEN,
  bodyPreview,
  mayCarryBody,
  type WakeUnreadEntry,
  type WakeSessionView,
  type WakeNudgeOutcome,
} from '../channelWakeWorker';
import {
  PrincipalService,
  type PrincipalWriterLike,
} from '../../principals/PrincipalService';
import {
  panePrincipalId,
  type PrincipalState,
} from '../../../shared/principals';

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
  outcomes: WakeNudgeOutcome[];
  logs: string[];
  setEntries(e: WakeUnreadEntry[]): void;
  setSessions(s: WakeSessionView[]): void;
  setNow(ms: number): void;
  /** Non-null ⇒ the next write() calls throw it (dead-PTY simulation). */
  setWriteError(err: Error | null): void;
}

function makeHarness(
  principalPtyIdOf?: (principalId: string) => string | undefined,
): Harness {
  let entries: WakeUnreadEntry[] = [];
  let sessions: WakeSessionView[] = [];
  let nowMs = 1_000_000;
  let writeError: Error | null = null;
  const writes: Array<{ sessionId: string; data: string }> = [];
  const broadcasts: Array<Record<string, unknown>> = [];
  const outcomes: WakeNudgeOutcome[] = [];
  const logs: string[] = [];
  const worker = new ChannelWakeWorker({
    memberWorkspaces: () => ['ws-b'],
    unreadFor: () => entries,
    listLiveSessions: () => sessions,
    principalPtyIdOf,
    write: (sessionId, data) => {
      if (writeError) throw writeError;
      writes.push({ sessionId, data });
    },
    broadcast: (event) => broadcasts.push(event),
    onNudgeOutcome: (outcome) => outcomes.push(outcome),
    log: (_level, message) => logs.push(message),
    now: () => nowMs,
    enterDelayMs: 1,
  });
  return {
    worker,
    writes,
    broadcasts,
    outcomes,
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

function restartedPrincipalService(
  principalId: string,
  workspaceId: string,
  paneId: string,
  ptyId: string,
): PrincipalService {
  const persisted: PrincipalState = {
    version: 1,
    principals: [{
      id: principalId,
      kind: 'pane-agent',
      display: 'w2-1(codex)',
      reachability: 'pty-nudge',
      liveness: 'live',
      workspaceId,
      paneId,
      ptyId,
      memberId: 'w2-1(codex)',
      agentSlug: 'codex',
      createdAt: 1,
      lastSeenAt: 1,
    }],
  };
  const clone = (): PrincipalState => ({
    version: persisted.version,
    principals: persisted.principals.map((principal) => ({ ...principal })),
  });
  const writer: PrincipalWriterLike = {
    load: clone,
    saveImmediate: () => true,
    saveDebounced: () => undefined,
  };
  return new PrincipalService({ writer, now: () => 2 });
}

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

describe('ChannelWakeWorker — principal routing after daemon restart', () => {
  it('wakes the exact rebuilt live session even though its registry row was backfilled stale', () => {
    const principalId = panePrincipalId('ws-b', 'pane-1');
    const principalService = restartedPrincipalService(
      principalId,
      'ws-b',
      'pane-1',
      'pty-exact',
    );
    expect(principalService.find(principalId)?.liveness).toBe('stale');

    const h = makeHarness((id) => principalService.ptyIdOf(id));
    h.setEntries([entry({ memberId: 'w2-1(codex)', principalId, mentionUnread: 1 })]);
    h.setSessions([
      session({ id: 'pty-sibling', lastDetectedAgent: 'codex' }),
      session({ id: 'pty-exact', lastDetectedAgent: 'codex' }),
    ]);

    h.worker.tickOnce();
    expect(h.writes).toEqual([
      expect.objectContaining({ sessionId: 'pty-exact' }),
    ]);
    flushEnter();
    expect(h.writes.map((write) => write.sessionId)).toEqual([
      'pty-exact',
      'pty-exact',
    ]);
  });

  it('does not wake a sibling when the stable principal target is no longer live', () => {
    const principalId = panePrincipalId('ws-b', 'pane-gone');
    const h = makeHarness((id) => (id === principalId ? 'pty-gone' : undefined));
    h.setEntries([entry({ memberId: 'codex', principalId, mentionUnread: 1 })]);
    h.setSessions([session({ id: 'pty-sibling', lastDetectedAgent: 'codex' })]);

    h.worker.tickOnce();
    flushEnter();
    expect(h.writes).toEqual([]);
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
    // The attached claude is deferred to the renderer, leaving a single
    // eligible pane 'b'. The fallback target must host an agent to receive
    // the nudge (a bare shell is excluded — see the agent-less shell test).
    const target = pickTarget(
      [
        session({ id: 'a', lastDetectedAgent: 'claude', attached: true }),
        session({ id: 'b', lastDetectedAgent: 'codex' }),
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
    // …and a DIFFERENT member does NOT fall back to that agent-less shell
    // either: the single-pane fallback now requires a detected agent, so a
    // bare shell hands off to polling (null) rather than eating a mis-typed
    // nudge (2026-07-05 dogfood regression guard).
    expect(pickTarget([attachedClaude, shell], 'ws-b', 'codex')).toBeNull();
  });

  it('never targets a session from another workspace', () => {
    expect(pickTarget([session({ id: 'a', workspaceId: 'ws-other' })], 'ws-b', 'codex')).toBeNull();
  });

  it('never targets a deferred (recovered-not-yet-activated) session — dogfood G5', () => {
    // After a daemon crash+respawn the recovered pane is bookkept 'attached'
    // but renders nothing and the pre-crash agent process is gone. Live
    // dogfood showed the worker burning mention nudges into that void.
    expect(pickTarget([session({ id: 'a', deferred: true })], 'ws-b', 'codex')).toBeNull();
    // …and a deferred slug-match must not shadow a live fallback either. The
    // live pane 'b' hosts an agent (a bare shell would not be nudged).
    const target = pickTarget(
      [session({ id: 'a', deferred: true, lastDetectedAgent: 'codex' }), session({ id: 'b', lastDetectedAgent: 'opencode' })],
      'ws-b',
      'codex',
    );
    expect(target?.id).toBe('b');
  });

  it('never nudges an agent-less shell — the single-pane fallback requires a detected agent (dogfood 2026-07-05)', () => {
    // Live -dev proof: the member's real claude pane was ATTACHED (deferred to
    // the renderer Stop-hook path), leaving a bare zsh (lastDetectedAgent none)
    // as the lone "eligible" pane. The old fallback auto-submitted
    // `wmux channel read ch-… --since N` into that shell, which ran the pasted
    // hint as a command. A shell with no agent is never a wake target.
    expect(
      pickTarget(
        [
          session({ id: 'shell', lastDetectedAgent: undefined }),
          session({ id: 'claude', lastDetectedAgent: 'claude', attached: true }),
        ],
        'ws-b',
        'reviewer',
      ),
    ).toBeNull();
  });

  it('an agent-less shell as the ONLY live pane hands off to polling (null), never a shell nudge', () => {
    expect(pickTarget([session({ id: 'shell', lastDetectedAgent: undefined })], 'ws-b', 'codex')).toBeNull();
    // An empty-string agent counts as no agent too (truthy guard).
    expect(pickTarget([session({ id: 'shell', lastDetectedAgent: '' })], 'ws-b', 'codex')).toBeNull();
  });

  it('the single-pane fallback still fires when that pane hosts an agent (detached claude or a non-matching slug)', () => {
    // Detached claude — headless, the worker is the only delivery path.
    expect(pickTarget([session({ id: 'a', lastDetectedAgent: 'claude' })], 'ws-b', 'reviewer')?.id).toBe('a');
    // A different agent slug than the member id still gets the fallback: it is
    // a real agent pane, just not slug-matched.
    expect(pickTarget([session({ id: 'a', lastDetectedAgent: 'opencode' })], 'ws-b', 'reviewer')?.id).toBe('a');
  });
});

describe('pickTargetWithPrincipal — R2 registry direct targeting', () => {
  const PID = 'pane:ws-b/p1';

  it('directly selects the principal ptyId present in the live snapshot without the heuristic (auto-name memberId)', () => {
    // memberId "w2-1(codex)" never matches the slug heuristic — without the
    // principal path this member would never get nudged. With two same-slug
    // panes the heuristic would have returned null on ambiguity.
    const target = pickTargetWithPrincipal(
      [session({ id: 'pty-x', lastDetectedAgent: 'codex' }), session({ id: 'pty-y', lastDetectedAgent: 'codex' })],
      'ws-b',
      'w2-1(codex)',
      PID,
      (pid) => (pid === PID ? 'pty-y' : undefined),
    );
    expect(target?.id).toBe('pty-y');
  });

  it('a missing exact principal coordinate fails closed instead of waking a sibling', () => {
    const target = pickTargetWithPrincipal(
      [session({ id: 'only', lastDetectedAgent: 'codex' })],
      'ws-b',
      'w2-1(codex)',
      PID,
      () => undefined,
    );
    expect(target).toBeNull();
  });

  it('refuses a dead exact principal target or workspace mismatch rather than waking a sibling', () => {
    const dead = pickTargetWithPrincipal(
      [session({ id: 'other', lastDetectedAgent: 'codex' })],
      'ws-b',
      'codex',
      PID,
      () => 'pty-gone',
    );
    expect(dead).toBeNull();

    const wsMismatch = pickTargetWithPrincipal(
      [session({ id: 'pty-z', workspaceId: 'ws-OTHER', lastDetectedAgent: 'codex' })],
      'ws-b',
      'codex',
      PID,
      () => 'pty-z',
    );
    expect(wsMismatch).toBeNull(); // ws-b has no eligible session
  });

  it('null when the principal is an ATTACHED claude pane — the renderer owns it, no re-routing', () => {
    const target = pickTargetWithPrincipal(
      [
        session({ id: 'pty-c', lastDetectedAgent: 'claude', attached: true }),
        session({ id: 'pty-d', lastDetectedAgent: undefined }),
      ],
      'ws-b',
      'w2-1(claude)',
      PID,
      () => 'pty-c',
    );
    expect(target).toBeNull();
  });

  it('behaves identically to the existing pickTarget when principalId/lookup fn are absent', () => {
    const sessions = [session({ id: 'b', lastDetectedAgent: 'codex' })];
    expect(pickTargetWithPrincipal(sessions, 'ws-b', 'codex', undefined, undefined)?.id).toBe('b');
  });

  it('an agent-less exact principal target fails closed instead of waking a sibling', () => {
    // Codex micro-pass on the shell-nudge fix: a registry row's ptyId can
    // outlive the agent (agent exits, pane keeps its shell, row stays live
    // until the next upsert/purge). The direct-hit branch must carry the
    // same agent-required discipline as the fallback.
    const PID3 = 'pane:ws-b/pY';
    // Direct hit points at a session with NO detected agent; the only other
    // pane is also agent-less → null overall.
    expect(
      pickTargetWithPrincipal(
        [session({ id: 'was-agent-now-shell', lastDetectedAgent: undefined })],
        'ws-b',
        'w2-1(codex)',
        PID3,
        () => 'was-agent-now-shell',
      ),
    ).toBeNull();
    // Even a slug-matching sibling must not receive a nudge addressed to the
    // principal whose exact pane has fallen back to a shell.
    expect(
      pickTargetWithPrincipal(
        [
          session({ id: 'was-agent-now-shell', lastDetectedAgent: undefined }),
          session({ id: 'real-agent', lastDetectedAgent: 'codex' }),
        ],
        'ws-b',
        'codex',
        PID3,
        () => 'was-agent-now-shell',
      ),
    ).toBeNull();
  });

  it('the legacy heuristic fallback carries the same agent-required discipline (no shell nudge)', () => {
    const PID2 = 'pane:ws-b/pX';
    // No principal resolver (legacy wiring); the only pane is an agent-less
    // shell → null (never auto-submit into a bare shell).
    expect(
      pickTargetWithPrincipal(
        [session({ id: 'shell', lastDetectedAgent: undefined })],
        'ws-b',
        'w2-1(codex)',
        PID2,
        undefined,
      ),
    ).toBeNull();
    // …but a lone AGENT pane still gets the fallback nudge.
    expect(
      pickTargetWithPrincipal(
        [session({ id: 'agent', lastDetectedAgent: 'codex' })],
        'ws-b',
        'w2-1(codex)',
        PID2,
        undefined,
      )?.id,
    ).toBe('agent');
  });
});

describe('recordExternalNudge (2a-2 shared nudge ledger)', () => {
  it('counts a renderer paste as a spent slot — the worker backs off instead of double-pasting, then retries', () => {
    const h = makeHarness();
    h.setSessions([session({ id: 'pty-1', lastDetectedAgent: 'codex', lastActivityMs: 0 })]);
    h.setEntries([entry({ memberId: 'codex', mentionUnread: 1 })]);
    h.setNow(1_000_000);
    // Renderer reports its paste before the worker's first sweep.
    h.worker.recordExternalNudge('ch-1', 'ws-b', 'codex');
    h.worker.tickOnce();
    // Slot 0 was consumed by the renderer; slot-1 backoff (60s) not yet elapsed.
    expect(h.writes).toHaveLength(0);
    // After the backoff elapses the worker retries (unacked mention escalates).
    h.setNow(1_000_000 + MENTION_NUDGE_BACKOFF_MS[1]);
    h.worker.tickOnce();
    expect(h.writes.length).toBeGreaterThan(0);
  });

  it('external records alone can exhaust the budget → human handoff still fires', () => {
    const h = makeHarness();
    h.setSessions([session({ id: 'pty-1', lastDetectedAgent: 'codex', lastActivityMs: 0 })]);
    h.setEntries([entry({ memberId: 'codex', mentionUnread: 1 })]);
    for (let i = 0; i < MENTION_NUDGE_CAP; i++) h.worker.recordExternalNudge('ch-1', 'ws-b', 'codex');
    h.worker.tickOnce();
    expect(h.writes).toHaveLength(0);
    expect(h.broadcasts.some((b) => b['type'] === 'channel.nudgeExhausted')).toBe(true);
  });
});

describe('recordExternalNudge — membership validation (unbounded-growth guard)', () => {
  it('rejects tuples that are not live membership rows; accepts and debits real ones', () => {
    const h = makeHarness();
    h.setEntries([entry({ memberId: 'codex', mentionUnread: 1 })]);
    expect(h.worker.recordExternalNudge('ch-bogus', 'ws-b', 'codex')).toBe(false);
    expect(h.worker.recordExternalNudge('ch-1', 'ws-b', 'forged-member')).toBe(false);
    expect(h.worker.recordExternalNudge('ch-1', 'ws-b', 'codex')).toBe(true);
    // Only the accepted record spent a slot: the next sweep is in backoff
    // (rejected keys must not have created tracker entries of their own).
    h.setSessions([session({})]);
    h.setNow(1_000_000);
    h.worker.tickOnce();
    expect(h.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The nudge says WHAT you are being woken for, and reports whether it landed.
// ---------------------------------------------------------------------------
// Every nudge used to read identically ("2 unread — run: wmux channel read …"),
// so an agent mid-task had to spend a turn on the read just to learn whether it
// mattered. And the push half was write-only: a nudge into a pane that died
// mid-race was logged and dropped while the message it announced stayed
// 'pending' — a receipt for a delivery nobody made.
describe('ChannelWakeWorker — body preview + inject outcome', () => {
  it('carries the first line of the body after the existing hint', () => {
    const h = makeHarness();
    h.setEntries([entry({ oldestUnreadBody: 'deploy is red on main\nstack trace follows' })]);
    h.setSessions([session({})]);
    h.worker.tickOnce();

    const text = h.writes[0]!.data;
    // The hint is unchanged and still comes first.
    expect(text).toContain('run: wmux channel read ch-1 --since 3');
    expect(text).toContain('deploy is red on main');
    // Only the FIRST line — a multi-line body must never turn into several
    // submits in the target's composer.
    expect(text).not.toContain('stack trace');
    expect(text).not.toContain('\n');
  });

  it('renders the body it is given for a mention', () => {
    const h = makeHarness();
    // ChannelService picks WHICH body to hand over; this pins that the worker
    // renders it unmodified apart from the safety pass.
    h.setEntries([entry({ mentionUnread: 1, oldestUnreadBody: '@codex can you take this?' })]);
    h.setSessions([session({})]);
    h.worker.tickOnce();

    expect(h.writes[0]!.data).toContain('@codex can you take this?');
    expect(h.writes[0]!.data).toContain('(1 mention you)');
  });

  it('falls back to the hint alone when no body is supplied', () => {
    const h = makeHarness();
    h.setEntries([entry({})]);
    h.setSessions([session({})]);
    h.worker.tickOnce();
    // No dangling separator.
    expect(h.writes[0]!.data.endsWith('--since 3')).toBe(true);
  });

  // The body is another workspace's text, TYPED into a live pane and committed
  // with an Enter. `lastDetectedAgent` can be stale — the agent exits and the
  // shell stays — and a shell would RUN it.
  describe('the body is an injection surface', () => {
    const HOSTILE = 'ship it $(rm -rf ~) `id` "quoted" \'also\' \\escaped';

    it('drops shell metacharacters from the preview', () => {
      const h = makeHarness();
      h.setEntries([entry({ oldestUnreadBody: HOSTILE })]);
      h.setSessions([session({ lastDetectedAgent: 'codex' })]);
      h.worker.tickOnce();

      const text = h.writes[0]!.data;
      expect(text).toContain('ship it');
      for (const ch of ['$', '`', '\\', '"', "'"]) {
        expect(text).not.toContain(ch);
      }
    });

    it('omits the body entirely when the pane is a bare shell', () => {
      const h = makeHarness();
      h.setEntries([entry({ oldestUnreadBody: 'deploy is red on main' })]);
      // A pane with no detected agent is exactly the case where the text would
      // be run rather than composed.
      h.setSessions([
        session({ id: 'pty-1', lastDetectedAgent: 'codex' }),
        session({ id: 'pty-2', lastDetectedAgent: undefined }),
      ]);
      // Force the single-eligible-agent path onto the shell by removing the
      // agent pane: an agent-less pane is never targeted at all...
      h.setSessions([session({ lastDetectedAgent: 'zsh' })]);
      h.worker.tickOnce();

      expect(h.writes).toHaveLength(1);
      expect(h.writes[0]!.data).not.toContain('deploy is red on main');
      expect(h.writes[0]!.data).toContain('run: wmux channel read');
    });

    it('caps the FINAL assembled line, not the pieces', () => {
      const h = makeHarness();
      h.setEntries([entry({ oldestUnreadBody: 'x'.repeat(500) })]);
      h.setSessions([session({})]);
      h.worker.tickOnce();

      // Concatenation is exactly where a bounded hint and a bounded preview
      // stop being bounded.
      expect(h.writes[0]!.data.length).toBeLessThanOrEqual(220);
    });

    it('mayCarryBody names agent TUIs only', () => {
      expect(mayCarryBody('claude')).toBe(true);
      expect(mayCarryBody('codex')).toBe(true);
      expect(mayCarryBody('zsh')).toBe(false);
      expect(mayCarryBody('')).toBe(false);
      expect(mayCarryBody(undefined)).toBe(false);
    });
  });

  it('reports success only after the Enter lands, never on the text write alone', () => {
    const h = makeHarness();
    h.setEntries([entry({})]);
    h.setSessions([session({})]);
    h.worker.tickOnce();

    // Text is out but the nudge is still sitting uncommitted — not a delivery.
    expect(h.outcomes).toEqual([]);
    flushEnter();
    expect(h.outcomes).toEqual([
      {
        workspaceId: 'ws-b',
        channelId: 'ch-1',
        memberId: 'codex',
        sessionId: 'pty-1',
        fromSeqExclusive: 2,
        toSeqInclusive: 4,
        ok: true,
      },
    ]);
  });

  it('reports failure when the pane dies before the text write', () => {
    const h = makeHarness();
    h.setEntries([entry({})]);
    h.setSessions([session({})]);
    h.setWriteError(new Error('write EPIPE'));
    h.worker.tickOnce();

    expect(h.outcomes).toEqual([
      {
        workspaceId: 'ws-b',
        channelId: 'ch-1',
        memberId: 'codex',
        sessionId: 'pty-1',
        fromSeqExclusive: 2,
        toSeqInclusive: 4,
        ok: false,
      },
    ]);
  });

  it('reports failure when the pane dies between the text and the Enter', () => {
    const h = makeHarness();
    h.setEntries([entry({})]);
    h.setSessions([session({})]);
    h.worker.tickOnce();
    // The hint landed; the pane dies before the commit.
    h.setWriteError(new Error('write EPIPE'));
    flushEnter();

    expect(h.outcomes).toEqual([
      {
        workspaceId: 'ws-b',
        channelId: 'ch-1',
        memberId: 'codex',
        sessionId: 'pty-1',
        fromSeqExclusive: 2,
        toSeqInclusive: 4,
        ok: false,
      },
    ]);
  });

  it('bodyPreview strips control characters and caps the length', () => {
    expect(bodyPreview('abc')).toBe('a b c');
    expect(bodyPreview(undefined)).toBe('');
    expect(bodyPreview('   ')).toBe('');
    // Only the first line — the rest would submit as separate lines.
    expect(bodyPreview('first\r\nsecond')).toBe('first');
    const long = 'x'.repeat(BODY_PREVIEW_MAX_LEN + 50);
    const out = bodyPreview(long);
    expect(out.length).toBe(BODY_PREVIEW_MAX_LEN);
    expect(out.endsWith('…')).toBe(true);
  });
});
