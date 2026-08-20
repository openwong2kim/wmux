import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RestingCursorGuard,
  CURSOR_HIDE,
  CURSOR_SHOW,
  RESTING_DELAY_MS,
} from '../restingCursor';

const SYNC_ON = '\x1b[?2026h';
const SYNC_OFF = '\x1b[?2026l';

describe('RestingCursorGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes chunks without a ?2026 marker through untouched, with no timer', () => {
    const inject = vi.fn();
    const guard = new RestingCursorGuard(inject);
    const chunk = 'plain output\x1b[1;1Hmore';
    expect(guard.process(chunk)).toBe(chunk);
    vi.advanceTimersByTime(RESTING_DELAY_MS * 4);
    expect(inject).not.toHaveBeenCalled();
  });

  it('appends a hide to a sync-frame chunk and shows again after the resting delay', () => {
    const inject = vi.fn();
    const guard = new RestingCursorGuard(inject);
    const chunk = `${SYNC_ON}\x1b[2;1Hstatus tick${SYNC_OFF}`;
    expect(guard.process(chunk)).toBe(chunk + CURSOR_HIDE);
    expect(inject).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RESTING_DELAY_MS);
    expect(inject).toHaveBeenCalledExactlyOnceWith(CURSOR_SHOW);
  });

  it('keeps the cursor hidden across a burst — only the last frame re-arms the show', () => {
    const inject = vi.fn();
    const guard = new RestingCursorGuard(inject);
    for (let i = 0; i < 5; i++) {
      guard.process(`${SYNC_ON}frame ${i}${SYNC_OFF}`);
      vi.advanceTimersByTime(RESTING_DELAY_MS / 2);
    }
    expect(inject).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RESTING_DELAY_MS);
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it('never re-shows a cursor the app itself hid', () => {
    const inject = vi.fn();
    const guard = new RestingCursorGuard(inject);
    guard.process(`\x1b[?25l${SYNC_ON}repaint${SYNC_OFF}`);
    vi.advanceTimersByTime(RESTING_DELAY_MS * 2);
    expect(inject).not.toHaveBeenCalled();
    // the app shows it again → resting show resumes
    guard.process(`${SYNC_ON}repaint\x1b[?25h${SYNC_OFF}`);
    vi.advanceTimersByTime(RESTING_DELAY_MS);
    expect(inject).toHaveBeenCalledExactlyOnceWith(CURSOR_SHOW);
  });

  it('tracks the LAST DECTCEM in a chunk as the app intent', () => {
    const inject = vi.fn();
    const guard = new RestingCursorGuard(inject);
    // codex-style frame: hide during repaint, show at the end
    guard.process(`${SYNC_ON}\x1b[?25lrepaint\x1b[?25h${SYNC_OFF}`);
    vi.advanceTimersByTime(RESTING_DELAY_MS);
    expect(inject).toHaveBeenCalledExactlyOnceWith(CURSOR_SHOW);
  });

  it('an injected hide is not mistaken for app intent on the next chunk', () => {
    const inject = vi.fn();
    const guard = new RestingCursorGuard(inject);
    const out = guard.process(`${SYNC_ON}a${SYNC_OFF}`);
    expect(out.endsWith(CURSOR_HIDE)).toBe(true);
    // next sync chunk carries no DECTCEM of its own — app intent is still
    // "visible" from the initial state, so rest shows the cursor
    guard.process(`${SYNC_ON}b${SYNC_OFF}`);
    vi.advanceTimersByTime(RESTING_DELAY_MS);
    expect(inject).toHaveBeenCalledExactlyOnceWith(CURSOR_SHOW);
  });

  it('dispose cancels the pending show and stops appending', () => {
    const inject = vi.fn();
    const guard = new RestingCursorGuard(inject);
    guard.process(`${SYNC_ON}a${SYNC_OFF}`);
    guard.dispose();
    vi.advanceTimersByTime(RESTING_DELAY_MS * 2);
    expect(inject).not.toHaveBeenCalled();
    const chunk = `${SYNC_ON}b${SYNC_OFF}`;
    expect(guard.process(chunk)).toBe(chunk);
  });
});
