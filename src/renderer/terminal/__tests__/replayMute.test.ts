import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createReplayMute,
  isReplayMuted,
  beginReplayWrite,
  openReattachWindow,
  noteReplayData,
  resetReplayMute,
  REATTACH_QUIET_MS,
  REATTACH_CAP_MS,
} from '../replayMute';

/**
 * #998. The rule: while stored output is being parsed, an OSC 52 clipboard
 * write inside it must not reach the system clipboard. These pin WHEN the gate
 * is closed, which is the whole difficulty — the writes we make can hang the
 * mute on xterm's callback, while the reattach replay arrives as ordinary
 * pty:data and has to be bounded by a window instead.
 */
describe('replayMute', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts open', () => {
    expect(isReplayMuted(createReplayMute())).toBe(false);
  });

  describe('beginReplayWrite — our own replay writes', () => {
    it('mutes until the release runs (xterm write callback)', () => {
      const m = createReplayMute();
      const release = beginReplayWrite(m);
      expect(isReplayMuted(m)).toBe(true);
      release();
      expect(isReplayMuted(m)).toBe(false);
    });

    it('nests: the bridge reopens only after the LAST write settles', () => {
      const m = createReplayMute();
      const a = beginReplayWrite(m);
      const b = beginReplayWrite(m);
      a();
      expect(isReplayMuted(m)).toBe(true); // b still parsing
      b();
      expect(isReplayMuted(m)).toBe(false);
    });

    it('is idempotent — a double release cannot unmute someone else', () => {
      const m = createReplayMute();
      const a = beginReplayWrite(m);
      const b = beginReplayWrite(m);
      a();
      a();
      expect(isReplayMuted(m)).toBe(true);
      b();
      expect(isReplayMuted(m)).toBe(false);
    });

    it('ignores a release from a previous terminal generation', () => {
      // The hook outlives the terminal it hosts. A late callback from a disposed
      // terminal must not unmute the terminal that replaced it — that would be
      // the same bug wearing a different hat.
      const m = createReplayMute();
      const stale = beginReplayWrite(m);
      resetReplayMute(m);
      const fresh = beginReplayWrite(m);
      stale();
      expect(isReplayMuted(m)).toBe(true);
      fresh();
      expect(isReplayMuted(m)).toBe(false);
    });
  });

  describe('openReattachWindow — the replay that arrives as pty:data', () => {
    it('mutes immediately and closes after a quiet period', () => {
      const m = createReplayMute();
      openReattachWindow(m);
      expect(isReplayMuted(m)).toBe(true);
      vi.advanceTimersByTime(REATTACH_QUIET_MS - 1);
      expect(isReplayMuted(m)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(isReplayMuted(m)).toBe(false);
    });

    it('stays muted while the burst keeps arriving', () => {
      const m = createReplayMute();
      openReattachWindow(m);
      for (let i = 0; i < 10; i += 1) {
        vi.advanceTimersByTime(REATTACH_QUIET_MS - 50);
        noteReplayData(m);
      }
      expect(isReplayMuted(m)).toBe(true);
      vi.advanceTimersByTime(REATTACH_QUIET_MS);
      expect(isReplayMuted(m)).toBe(false);
    });

    it('a pane that never stops printing cannot hold the bridge shut', () => {
      // The hard cap is why this is safe to hang on a heuristic: worst case the
      // mute lasts REATTACH_CAP_MS, not forever.
      const m = createReplayMute();
      openReattachWindow(m);
      for (let i = 0; i < 200; i += 1) {
        vi.advanceTimersByTime(100);
        noteReplayData(m);
      }
      expect(isReplayMuted(m)).toBe(false);
      expect(200 * 100).toBeGreaterThan(REATTACH_CAP_MS);
    });

    it('opens at most one window (a doubled reattach does not double the depth)', () => {
      const m = createReplayMute();
      openReattachWindow(m);
      openReattachWindow(m);
      vi.advanceTimersByTime(REATTACH_QUIET_MS);
      expect(isReplayMuted(m)).toBe(false);
    });

    it('noteReplayData is inert when no window is open (the common case)', () => {
      const m = createReplayMute();
      noteReplayData(m);
      expect(isReplayMuted(m)).toBe(false);
      vi.advanceTimersByTime(REATTACH_CAP_MS * 2);
      expect(isReplayMuted(m)).toBe(false);
    });

    it('closes even when the replay never arrives (failed reconnect, empty ring)', () => {
      const m = createReplayMute();
      openReattachWindow(m);
      vi.advanceTimersByTime(REATTACH_QUIET_MS);
      expect(isReplayMuted(m)).toBe(false);
    });

    it('coexists with a write mute: both must clear', () => {
      const m = createReplayMute();
      openReattachWindow(m);
      const release = beginReplayWrite(m);
      vi.advanceTimersByTime(REATTACH_QUIET_MS);
      expect(isReplayMuted(m)).toBe(true); // window closed, write still parsing
      release();
      expect(isReplayMuted(m)).toBe(false);
    });
  });

  describe('resetReplayMute — teardown', () => {
    it('drops everything, so a disposed terminal cannot leave the bridge muted', () => {
      const m = createReplayMute();
      openReattachWindow(m);
      beginReplayWrite(m);
      resetReplayMute(m);
      expect(isReplayMuted(m)).toBe(false);
    });

    it('cancels the window timers (no late close touching the successor)', () => {
      const m = createReplayMute();
      openReattachWindow(m);
      resetReplayMute(m);
      const release = beginReplayWrite(m); // next terminal starts a replay
      vi.advanceTimersByTime(REATTACH_CAP_MS * 2);
      expect(isReplayMuted(m)).toBe(true); // stale timers must not have fired
      release();
      expect(isReplayMuted(m)).toBe(false);
    });
  });
});
