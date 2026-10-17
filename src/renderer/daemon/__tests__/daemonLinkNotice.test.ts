import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RECONNECTED_NOTICE_MS,
  dismissPaneLinkNotice,
  getPaneLinkNotice,
  noteDaemonConnected,
  noteDaemonDisconnected,
  noteDaemonGaveUp,
  noteDaemonReconnecting,
  notePaneInput,
  notePaneReattached,
  resetDaemonLinkNoticeForTests,
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

  it('tells every attached pane at once and flags input only where it was typed', () => {
    noteDaemonDisconnected(PANES);
    noteDaemonReconnecting(2);
    notePaneInput('b');
    notePaneInput('later-local-pane');

    expect(getPaneLinkNotice('sA')).toEqual({ state: 'reconnecting', attempt: 2, inputLost: false });
    expect(getPaneLinkNotice('sB')).toEqual({ state: 'reconnecting', attempt: 2, inputLost: true });

    // daemon:connected alone is not "reconnected": the pane's pipe is not back
    // yet, so input sent now is still lost.
    noteDaemonConnected();
    notePaneInput('a');
    expect(getPaneLinkNotice('sA')).toEqual({ state: 'reconnecting', attempt: 2, inputLost: true });

    notePaneReattached('b', none);
    vi.advanceTimersByTime(RECONNECTED_NOTICE_MS);
    // Input lost → stays until the user types there again.
    expect(getPaneLinkNotice('sB')).toEqual({ state: 'reconnected', attempt: 2, inputLost: true });
    notePaneInput('b');
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

  it('stays after the respawn budget runs out, until dismissed', () => {
    noteDaemonDisconnected(PANES);
    noteDaemonGaveUp();
    vi.advanceTimersByTime(RECONNECTED_NOTICE_MS * 10);
    notePaneInput('a');
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
