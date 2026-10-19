import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RECONNECTED_NOTICE_MS,
  dismissPaneLinkNotice,
  getPaneLinkNotice,
  noteDaemonConnected,
  noteDaemonDisconnected,
  noteDaemonGaveUp,
  noteDaemonReconnecting,
  notePaneReattached,
  notePaneUserInput,
  notePaneWriteDropped,
  resetDaemonLinkNoticeForTests,
  setDaemonLinkSurfaceResolver,
} from '../daemonLinkNotice';

const PANES = [{ surfaceId: 'sA', ptyId: 'a' }, { surfaceId: 'sB', ptyId: 'b' }];
const none = () => null;

describe('daemon link notice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDaemonLinkNoticeForTests();
  });
  afterEach(() => {
    resetDaemonLinkNoticeForTests();
    vi.useRealTimers();
  });

  it('tells every attached pane at once and flags input only where main dropped it', () => {
    noteDaemonDisconnected(PANES);
    noteDaemonReconnecting(2);
    // Typing alone flags nothing: only main knows the write was dropped.
    notePaneUserInput('a');
    notePaneWriteDropped('b');
    notePaneWriteDropped('later-local-pane');

    expect(getPaneLinkNotice('sA')).toEqual({ state: 'reconnecting', attempt: 2, inputLost: false });
    expect(getPaneLinkNotice('sB')).toEqual({ state: 'reconnecting', attempt: 2, inputLost: true });

    // daemon:connected alone is not "reconnected": the pane's pipe is not back
    // yet, so input sent now is still lost.
    noteDaemonConnected();
    notePaneWriteDropped('a');
    expect(getPaneLinkNotice('sA')).toEqual({ state: 'reconnecting', attempt: 2, inputLost: true });

    notePaneReattached('b', none);
    vi.advanceTimersByTime(RECONNECTED_NOTICE_MS);
    // Input lost → stays until the user types there again.
    expect(getPaneLinkNotice('sB')).toEqual({ state: 'reconnected', attempt: 2, inputLost: true });
    notePaneUserInput('b');
    expect(getPaneLinkNotice('sB')).toBeNull();
  });

  it('follows a pane rebound to a new session and clears it when nothing was lost', () => {
    noteDaemonDisconnected(PANES);
    noteDaemonConnected();
    notePaneReattached('a-new', () => 'sA');
    expect(getPaneLinkNotice('sA')?.state).toBe('reconnected');
    vi.advanceTimersByTime(RECONNECTED_NOTICE_MS);
    expect(getPaneLinkNotice('sA')).toBeNull();
    expect(getPaneLinkNotice('sB')?.state).toBe('reconnecting');
  });

  it('keeps a reconnected notice when a drop is reported after the reattach', () => {
    noteDaemonDisconnected(PANES);
    noteDaemonConnected();
    notePaneReattached('a', none);
    // The drop of a write sent just before the replay arrives late.
    notePaneWriteDropped('a');
    vi.advanceTimersByTime(RECONNECTED_NOTICE_MS * 2);
    expect(getPaneLinkNotice('sA')).toEqual({ state: 'reconnected', attempt: 0, inputLost: true });
  });

  it('counts a drop that came before daemon:disconnected, until the pane reattaches', () => {
    // Graceful shutdown: the session pipes close before the control link.
    notePaneWriteDropped('a');
    notePaneWriteDropped('b');
    notePaneReattached('b', none); // b's pipe came back before the drop
    noteDaemonDisconnected(PANES);
    expect(getPaneLinkNotice('sA')?.inputLost).toBe(true);
    expect(getPaneLinkNotice('sB')?.inputLost).toBe(false);
    // Consumed by that drop: the next one starts clean.
    noteDaemonConnected();
    notePaneReattached('a', none);
    notePaneUserInput('a');
    noteDaemonDisconnected(PANES);
    expect(getPaneLinkNotice('sA')?.inputLost).toBe(false);
  });

  it('flags input sent to a rebound session before its replay finished', () => {
    noteDaemonDisconnected(PANES);
    noteDaemonConnected();
    setDaemonLinkSurfaceResolver((ptyId) => (ptyId === 'a-new' ? 'sA' : ptyId === 'local' ? 'sLocal' : null));
    // Reconcile rebound sA to a-new; its pipe has not replayed yet.
    notePaneWriteDropped('a-new');
    // A pane opened during the gap has no notice and stays unflagged.
    notePaneWriteDropped('local');
    expect(getPaneLinkNotice('sA')).toEqual({ state: 'reconnecting', attempt: 0, inputLost: true });
    expect(getPaneLinkNotice('sLocal')).toBeNull();
    notePaneReattached('a-new', none);
    vi.advanceTimersByTime(RECONNECTED_NOTICE_MS);
    expect(getPaneLinkNotice('sA')).toEqual({ state: 'reconnected', attempt: 0, inputLost: true });
  });

  it('stays after the respawn budget runs out, until dismissed', () => {
    noteDaemonDisconnected(PANES);
    noteDaemonGaveUp();
    vi.advanceTimersByTime(RECONNECTED_NOTICE_MS * 10);
    notePaneWriteDropped('a');
    // Typing into a pane that is still cut off does not clear it.
    notePaneUserInput('a');
    expect(getPaneLinkNotice('sA')).toEqual({ state: 'gave-up', attempt: 0, inputLost: true });
    dismissPaneLinkNotice('sA');
    expect(getPaneLinkNotice('sA')).toBeNull();
  });

  it('ignores events that follow no drop', () => {
    noteDaemonConnected();
    noteDaemonReconnecting(1);
    noteDaemonGaveUp();
    notePaneReattached('a', () => 'sA');
    expect(getPaneLinkNotice('sA')).toBeNull();
  });
});
