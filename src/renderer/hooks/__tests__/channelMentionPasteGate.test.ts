import { describe, it, expect } from 'vitest';
import {
  isMentionPasteBusy,
  createPasteGateState,
  notePtyOutput,
  prunePasteGateState,
  UNKNOWN_STATUS_GRACE_MS,
  OUTPUT_QUIET_MS,
  MAX_UNKNOWN_HOLD_MS,
  RUNNING_STALE_MS,
  KNOWN_STABLE_MS,
} from '../channelMentionPasteGate';

describe('isMentionPasteBusy', () => {
  it('busy for running / awaiting_input (paste would corrupt the turn)', () => {
    const s = createPasteGateState();
    expect(isMentionPasteBusy('running', 'p', 0, s)).toBe(true);
    expect(isMentionPasteBusy('awaiting_input', 'p', 0, s)).toBe(true);
  });

  // Message-latency epic (2026-07-10): a mid-turn-safe agent (claude) queues
  // input while running, so a running turn is NOT a hold — deliver immediately.
  it('mid-turn-safe agent (claude): running is NOT busy — immediate deliver', () => {
    const s = createPasteGateState();
    const d = [UNKNOWN_STATUS_GRACE_MS, OUTPUT_QUIET_MS, MAX_UNKNOWN_HOLD_MS, RUNNING_STALE_MS, KNOWN_STABLE_MS] as const;
    expect(isMentionPasteBusy('running', 'p', 0, s, ...d, 'claude')).toBe(false);
    // awaiting_input still holds even for a mid-turn-safe agent (a live prompt).
    expect(isMentionPasteBusy('awaiting_input', 'p', 0, s, ...d, 'claude')).toBe(true);
  });

  it('non-listed agent (codex/unknown): running still holds', () => {
    const s = createPasteGateState();
    const d = [UNKNOWN_STATUS_GRACE_MS, OUTPUT_QUIET_MS, MAX_UNKNOWN_HOLD_MS, RUNNING_STALE_MS, KNOWN_STABLE_MS] as const;
    expect(isMentionPasteBusy('running', 'p', 0, s, ...d, 'codex')).toBe(true);
    // No slug at all = classic behavior (unchanged default).
    expect(isMentionPasteBusy('running', 'q', 0, s)).toBe(true);
  });

  it('not busy for waiting / complete / idle / any other known status', () => {
    const s = createPasteGateState();
    expect(isMentionPasteBusy('waiting', 'p', 0, s)).toBe(false);
    expect(isMentionPasteBusy('complete', 'p', 0, s)).toBe(false);
    expect(isMentionPasteBusy('idle', 'p', 0, s)).toBe(false);
  });

  // The 2026-07-05 bug: an idle-since-attach agent's status stays undefined, and
  // the old gate held the mention forever. Grace-then-deliver is the fix.
  it('holds unknown status during the grace window, then delivers', () => {
    const s = createPasteGateState();
    // First observation at t=0 arms the grace clock and holds.
    expect(isMentionPasteBusy(undefined, 'p', 0, s)).toBe(true);
    // Still within the window → still held.
    expect(isMentionPasteBusy(undefined, 'p', UNKNOWN_STATUS_GRACE_MS - 1, s)).toBe(true);
    // At/after the window → deliver (agent is quiet = idle).
    expect(isMentionPasteBusy(undefined, 'p', UNKNOWN_STATUS_GRACE_MS, s)).toBe(false);
    expect(isMentionPasteBusy(undefined, 'p', UNKNOWN_STATUS_GRACE_MS + 5000, s)).toBe(false);
  });

  it('grace clock is per-pty (one pane resolving does not release another)', () => {
    const s = createPasteGateState();
    isMentionPasteBusy(undefined, 'a', 0, s);
    isMentionPasteBusy(undefined, 'b', 1000, s);
    // 'a' passed its window; 'b' has not.
    expect(isMentionPasteBusy(undefined, 'a', UNKNOWN_STATUS_GRACE_MS, s)).toBe(false);
    expect(isMentionPasteBusy(undefined, 'b', UNKNOWN_STATUS_GRACE_MS, s)).toBe(true);
  });

  it('a running agent within grace stays held (transient post-attach window)', () => {
    const s = createPasteGateState();
    // Unknown at attach → held.
    expect(isMentionPasteBusy(undefined, 'p', 0, s)).toBe(true);
    // 'running' broadcast lands before the grace elapses → still busy. The unknown
    // clock is NOT cleared on this sub-KNOWN_STABLE_MS blip (flap guard): a 1-tick
    // known sample must not re-arm the unknown window / hold ceiling, so
    // firstUnknownAt is retained until the status proves stable.
    expect(isMentionPasteBusy('running', 'p', 1000, s)).toBe(true);
    expect(s.firstUnknownAt.has('p')).toBe(true);
  });

  // The flap fix (task 2c-②): a known status only clears the unknown clock after
  // it has held for KNOWN_STABLE_MS. Replaces the old "brief resolve clears the
  // clock immediately" test, which encoded the pre-fix behavior.
  it('clears the unknown clock only after a STABLE known status (>= KNOWN_STABLE_MS)', () => {
    const s = createPasteGateState();
    isMentionPasteBusy(undefined, 'p', 0, s); // arm the unknown clock at 0
    // A brief known blip does NOT clear the clock (flap guard).
    isMentionPasteBusy('waiting', 'p', 500, s); // known streak starts at 500
    expect(s.firstUnknownAt.has('p')).toBe(true); // still armed
    // Once the known status has persisted KNOWN_STABLE_MS it is a real resolution.
    isMentionPasteBusy('waiting', 'p', 500 + KNOWN_STABLE_MS, s); // stable → clears
    expect(s.firstUnknownAt.has('p')).toBe(false);
    // Unknown again re-arms fresh; grace is measured from the re-arm, not t=0.
    const t = 500 + KNOWN_STABLE_MS + 1000;
    expect(isMentionPasteBusy(undefined, 'p', t, s)).toBe(true);
    expect(isMentionPasteBusy(undefined, 'p', t + UNKNOWN_STATUS_GRACE_MS - 1, s)).toBe(true);
    expect(isMentionPasteBusy(undefined, 'p', t + UNKNOWN_STATUS_GRACE_MS, s)).toBe(false);
  });

  it('a transient known blip does NOT reset the unknown-hold ceiling (flap fix)', () => {
    const s = createPasteGateState();
    // Arm the unknown clock at t=0.
    isMentionPasteBusy(undefined, 'p', 0, s);
    // Deep into the hold, one stray 'running' sample lands (a detector blip).
    isMentionPasteBusy('running', 'p', MAX_UNKNOWN_HOLD_MS - 5000, s);
    // The blip did NOT clear the clock (streak < KNOWN_STABLE_MS) …
    expect(s.firstUnknownAt.has('p')).toBe(true);
    // … so the ceiling is still measured from t=0 and fires on schedule. Under the
    // old clear-on-known behavior the blip would have re-armed the clock and
    // pushed delivery a full MAX_UNKNOWN_HOLD later — a silent extra hold.
    expect(isMentionPasteBusy(undefined, 'p', MAX_UNKNOWN_HOLD_MS, s)).toBe(false);
  });

  it('honors a custom grace window', () => {
    const s = createPasteGateState();
    expect(isMentionPasteBusy(undefined, 'p', 0, s, 100)).toBe(true);
    expect(isMentionPasteBusy(undefined, 'p', 100, s, 100)).toBe(false);
  });

  // The 2026-07-05 mid-turn paste race (Codex+Claude CRITICAL): grace alone is
  // leaky. A slow/thinking background agent stays at unknown status past the
  // grace (its bursts miss ActivityMonitor's threshold) but keeps emitting; the
  // output-quiet gate must hold it. A truly idle agent's output is stale, so it
  // still delivers.
  it('unknown past grace with NO output history delivers (idle case)', () => {
    const s = createPasteGateState();
    expect(isMentionPasteBusy(undefined, 'p', 0, s)).toBe(true); // arm grace
    // Grace elapsed, lastOutputAt never stamped → both gates clear → deliver.
    expect(isMentionPasteBusy(undefined, 'p', UNKNOWN_STATUS_GRACE_MS, s)).toBe(false);
  });

  it('unknown past grace but RECENTLY output stays busy (race fix)', () => {
    const s = createPasteGateState();
    expect(isMentionPasteBusy(undefined, 'p', 0, s)).toBe(true); // arm grace at 0
    // Agent emits at t=grace (a slow think tick).
    notePtyOutput(s, 'p', UNKNOWN_STATUS_GRACE_MS);
    // Grace elapsed, but last output is only 500ms ago (< quiet) → HELD.
    expect(
      isMentionPasteBusy(undefined, 'p', UNKNOWN_STATUS_GRACE_MS + 500, s),
    ).toBe(true);
    // Boundary: exactly quietMs since last output → no longer < quiet → deliver.
    expect(
      isMentionPasteBusy(undefined, 'p', UNKNOWN_STATUS_GRACE_MS + OUTPUT_QUIET_MS, s),
    ).toBe(false);
  });

  it('unknown past grace with STALE output delivers (quiet bar cleared)', () => {
    const s = createPasteGateState();
    expect(isMentionPasteBusy(undefined, 'p', 0, s)).toBe(true); // arm grace
    notePtyOutput(s, 'p', 100); // a lone early cursor query
    // Grace elapsed AND last output is far older than quietMs → deliver.
    expect(
      isMentionPasteBusy(undefined, 'p', UNKNOWN_STATUS_GRACE_MS + OUTPUT_QUIET_MS + 1, s),
    ).toBe(false);
  });

  it('honors a custom quiet window', () => {
    const s = createPasteGateState();
    isMentionPasteBusy(undefined, 'p', 0, s, 100); // arm grace (custom 100ms)
    notePtyOutput(s, 'p', 100);
    // grace(100) elapsed at t=150; last output 50ms ago, quiet=80 → still held.
    expect(isMentionPasteBusy(undefined, 'p', 150, s, 100, 80)).toBe(true);
    // t=200: last output 100ms ago ≥ quiet(80) → deliver.
    expect(isMentionPasteBusy(undefined, 'p', 200, s, 100, 80)).toBe(false);
  });

  it('notePtyOutput ignores an empty pty id', () => {
    const s = createPasteGateState();
    notePtyOutput(s, '', 100);
    expect(s.lastOutputAt.has('')).toBe(false);
    expect(s.lastOutputAt.size).toBe(0);
  });

  it('delivers past the hard ceiling even while output stays recent (never-deliver guard)', () => {
    const s = createPasteGateState();
    // Arm the grace clock at t=0.
    isMentionPasteBusy(undefined, 'p', 0, s);
    // A pathological pane keeps emitting sub-quiet output: stamp output near the
    // ceiling so the quiet gate alone (recent output) would hold it busy.
    notePtyOutput(s, 'p', MAX_UNKNOWN_HOLD_MS - 1000);
    // Just before the ceiling, recent output still holds it busy.
    expect(isMentionPasteBusy(undefined, 'p', MAX_UNKNOWN_HOLD_MS - 500, s)).toBe(true);
    // At the ceiling, deliver regardless of still-recent output (fail-safe).
    expect(isMentionPasteBusy(undefined, 'p', MAX_UNKNOWN_HOLD_MS, s)).toBe(false);
  });

  it('honors a custom max-hold ceiling', () => {
    const s = createPasteGateState();
    isMentionPasteBusy(undefined, 'p', 0, s);
    notePtyOutput(s, 'p', 900);
    // Custom ceiling 1000ms: recent output at t=900 would normally hold, but the
    // ceiling forces delivery at t=1000 (grace 500, quiet 2000, maxHold 1000).
    expect(isMentionPasteBusy(undefined, 'p', 999, s, 500, 2000, 1000)).toBe(true);
    expect(isMentionPasteBusy(undefined, 'p', 1000, s, 500, 2000, 1000)).toBe(false);
  });

  it('prunePasteGateState drops dead ptys from both maps, keeps live ones', () => {
    const s = createPasteGateState();
    // Arm grace clocks for two ptys.
    isMentionPasteBusy(undefined, 'live', 0, s);
    isMentionPasteBusy(undefined, 'dead', 0, s);
    // Stamp output for both.
    notePtyOutput(s, 'live', 10);
    notePtyOutput(s, 'dead', 10);
    expect(s.firstUnknownAt.has('dead')).toBe(true);
    expect(s.lastOutputAt.has('dead')).toBe(true);

    prunePasteGateState(s, new Set(['live']));

    // Dead pty gone from BOTH maps; live pty untouched.
    expect(s.firstUnknownAt.has('dead')).toBe(false);
    expect(s.lastOutputAt.has('dead')).toBe(false);
    expect(s.firstUnknownAt.has('live')).toBe(true);
    expect(s.lastOutputAt.has('live')).toBe(true);
  });

  // ── Stale-running guard (task 2c-①, RCA 2026-07-05): a hung 'running' agent
  // that emits nothing must not pin the mention forever; a thinking agent that
  // keeps repainting its status line must stay held (regression guard 941a639).

  it('a hung running agent (output-quiet for RUNNING_STALE_MS) delivers as stale', () => {
    const s = createPasteGateState();
    // First 'running' sight with no prior output anchors the observation start at 0.
    expect(isMentionPasteBusy('running', 'p', 0, s)).toBe(true);
    expect(s.lastOutputAt.get('p')).toBe(0); // anchored
    // Still 'running' but quiet for < RUNNING_STALE_MS → held.
    expect(isMentionPasteBusy('running', 'p', RUNNING_STALE_MS - 1, s)).toBe(true);
    // Quiet for >= RUNNING_STALE_MS → treat as hung, deliver.
    expect(isMentionPasteBusy('running', 'p', RUNNING_STALE_MS, s)).toBe(false);
  });

  it('a thinking running agent that keeps emitting stays held past RUNNING_STALE_MS (regression: 941a639)', () => {
    const s = createPasteGateState();
    // First 'running' sight anchors the observation start at 0.
    expect(isMentionPasteBusy('running', 'p', 0, s)).toBe(true);
    // The agent repaints its status line ~1s; each real (non-CPR) chunk refreshes
    // the anchor. Advance well past RUNNING_STALE_MS in 1s steps.
    let t = 0;
    while (t < RUNNING_STALE_MS + 10_000) {
      t += 1000;
      notePtyOutput(s, 'p', t); // real output refreshes lastOutputAt
      // Total elapsed since attach exceeds RUNNING_STALE_MS, but the anchor is
      // never older than 1s → NOT stale → still held. A frozen anchor would have
      // delivered mid-turn (the 941a639 bug).
      expect(isMentionPasteBusy('running', 'p', t, s)).toBe(true);
    }
    // The anchor really is fresh (last refresh == last t), not the t=0 seed.
    expect(s.lastOutputAt.get('p')).toBe(t);
  });

  it('honors a custom running-stale window', () => {
    const s = createPasteGateState();
    // grace/quiet/maxHold left default (undefined); staleMs = 1000.
    isMentionPasteBusy('running', 'p', 0, s, undefined, undefined, undefined, 1000);
    expect(s.lastOutputAt.get('p')).toBe(0); // anchored on first sight
    expect(isMentionPasteBusy('running', 'p', 999, s, undefined, undefined, undefined, 1000)).toBe(true);
    expect(isMentionPasteBusy('running', 'p', 1000, s, undefined, undefined, undefined, 1000)).toBe(false);
  });

  it('notePtyOutput skips DSR/CPR-only chunks (idle cursor answers are not activity)', () => {
    const s = createPasteGateState();
    // A lone cursor-position report / device-status query → NOT activity → no stamp.
    notePtyOutput(s, 'p', 100, '\x1b[24;80R');
    expect(s.lastOutputAt.has('p')).toBe(false);
    notePtyOutput(s, 'p', 100, '\x1b[6n');
    expect(s.lastOutputAt.has('p')).toBe(false);
    // Several concatenated cursor sequences → still only chatter → no stamp.
    notePtyOutput(s, 'p', 100, '\x1b[6n\x1b[24;80R');
    expect(s.lastOutputAt.has('p')).toBe(false);
    // Real output (even with a trailing CPR) IS activity → stamp.
    notePtyOutput(s, 'p', 200, '\x1b[24;80Rhello');
    expect(s.lastOutputAt.get('p')).toBe(200);
    // Omitting data preserves the original always-stamp behavior.
    notePtyOutput(s, 'p', 300);
    expect(s.lastOutputAt.get('p')).toBe(300);
  });

  it('prunePasteGateState drops dead ptys from the stableKnownSince map too', () => {
    const s = createPasteGateState();
    // Populate all three maps for both ptys.
    isMentionPasteBusy(undefined, 'live', 0, s);
    isMentionPasteBusy(undefined, 'dead', 0, s);
    notePtyOutput(s, 'live', 10);
    notePtyOutput(s, 'dead', 10);
    isMentionPasteBusy('running', 'live', 20, s); // stamps stableKnownSince
    isMentionPasteBusy('running', 'dead', 20, s);
    expect(s.stableKnownSince.has('dead')).toBe(true);

    prunePasteGateState(s, new Set(['live']));

    // Dead pty gone from ALL three maps; live pty retained in stableKnownSince.
    expect(s.firstUnknownAt.has('dead')).toBe(false);
    expect(s.lastOutputAt.has('dead')).toBe(false);
    expect(s.stableKnownSince.has('dead')).toBe(false);
    expect(s.stableKnownSince.has('live')).toBe(true);
  });
});

describe('notePtyOutput — remainder judging (adversarial review F11b)', () => {
  it('an empty chunk is not activity', () => {
    const st = createPasteGateState();
    notePtyOutput(st, 'p', 1_000, '');
    expect(st.lastOutputAt.has('p')).toBe(false);
  });

  it('CPR echo mixed with real bytes still counts as activity', () => {
    const st = createPasteGateState();
    notePtyOutput(st, 'p', 1_000, '\x1b[24;80Rhello');
    expect(st.lastOutputAt.get('p')).toBe(1_000);
  });

  it('multiple CPR sequences with nothing else are not activity', () => {
    const st = createPasteGateState();
    notePtyOutput(st, 'p', 1_000, '\x1b[24;80R\x1b[6n\x1b[1;1R');
    expect(st.lastOutputAt.has('p')).toBe(false);
  });
});
