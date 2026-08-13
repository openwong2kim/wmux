import { describe, it, expect } from 'vitest';
import {
  createWindowDisplayedReporter,
  isWindowDisplayed,
  type DisplayableWindow,
} from '../windowDisplayed';

type WinEvent = 'minimize' | 'restore' | 'hide' | 'show';
type PowerEvent = 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume';

function fakeWindow(state: {
  visible?: boolean;
  minimized?: boolean;
  destroyed?: boolean;
  contentsDestroyed?: boolean;
} = {}) {
  const listeners = new Map<WinEvent, Set<() => void>>();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const win = {
    visible: state.visible ?? true,
    minimized: state.minimized ?? false,
    destroyed: state.destroyed ?? false,
    contentsDestroyed: state.contentsDestroyed ?? false,
    sent,
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    isMinimized: () => win.minimized,
    on(event: WinEvent, listener: () => void) {
      const set = listeners.get(event) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(event, set);
      return win;
    },
    webContents: {
      isDestroyed: () => win.contentsDestroyed,
      send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); },
    },
    fire(event: WinEvent) { for (const l of [...(listeners.get(event) ?? [])]) l(); },
    /** Values pushed so far, in order. */
    values: () => sent.map((s) => (s.payload as { displayed: boolean }).displayed),
  };
  return win;
}

function fakePower() {
  const listeners = new Map<PowerEvent, Set<() => void>>();
  return {
    on(event: PowerEvent, listener: () => void) {
      const set = listeners.get(event) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(event, set);
      return this;
    },
    fire(event: PowerEvent) { for (const l of [...(listeners.get(event) ?? [])]) l(); },
  };
}

describe('isWindowDisplayed', () => {
  it('true only when the window is visible and not minimized', () => {
    expect(isWindowDisplayed(fakeWindow() as unknown as DisplayableWindow)).toBe(true);
    expect(isWindowDisplayed(fakeWindow({ minimized: true }) as unknown as DisplayableWindow)).toBe(false);
    expect(isWindowDisplayed(fakeWindow({ visible: false }) as unknown as DisplayableWindow)).toBe(false);
    expect(isWindowDisplayed(fakeWindow({ visible: false, minimized: true }) as unknown as DisplayableWindow)).toBe(false);
  });

  it('checks destruction FIRST — isVisible() on a destroyed window throws in Electron', () => {
    const win = fakeWindow({ destroyed: true });
    win.isVisible = () => { throw new Error('Object has been destroyed'); };
    win.isMinimized = () => { throw new Error('Object has been destroyed'); };
    expect(isWindowDisplayed(win as unknown as DisplayableWindow)).toBe(false);
  });
});

describe('windowDisplayedReporter', () => {
  it('pushes on minimize and restore', () => {
    const win = fakeWindow();
    const r = createWindowDisplayedReporter('ch');
    r.attach(win as unknown as DisplayableWindow);

    win.minimized = true;
    win.fire('minimize');
    win.minimized = false;
    win.fire('restore');

    expect(win.values()).toEqual([false, true]);
    expect(win.sent[0].channel).toBe('ch');
  });

  it('pushes on hide and show (tray)', () => {
    const win = fakeWindow();
    const r = createWindowDisplayedReporter('ch');
    r.attach(win as unknown as DisplayableWindow);

    win.visible = false;
    win.fire('hide');
    win.visible = true;
    win.fire('show');

    expect(win.values()).toEqual([false, true]);
  });

  it('does not push when the answer did not change', () => {
    // A `show` on an already-shown window is routine; waking every pane's
    // report effect for it is not free.
    const win = fakeWindow();
    const r = createWindowDisplayedReporter('ch');
    r.attach(win as unknown as DisplayableWindow);

    win.fire('show');
    win.fire('restore');
    expect(win.values()).toEqual([]);

    win.minimized = true;
    win.fire('minimize');
    win.fire('minimize');
    expect(win.values()).toEqual([false]);
  });

  it('treats a locked screen as not displayed, even though the window is untouched', () => {
    // Locking does not hide or minimize the window — the whole reason this
    // term exists separately.
    const win = fakeWindow();
    const power = fakePower();
    const r = createWindowDisplayedReporter('ch');
    r.attach(win as unknown as DisplayableWindow, { powerMonitor: power });

    power.fire('lock-screen');
    expect(win.values()).toEqual([false]);
    expect(r.current()).toBe(false);

    power.fire('unlock-screen');
    expect(win.values()).toEqual([false, true]);
    expect(r.current()).toBe(true);
  });

  it('suspend/resume behaves the same, and resume re-reads the window instead of assuming', () => {
    const win = fakeWindow();
    const power = fakePower();
    const r = createWindowDisplayedReporter('ch');
    r.attach(win as unknown as DisplayableWindow, { powerMonitor: power });

    win.minimized = true;
    win.fire('minimize');
    power.fire('suspend');
    // Already false — no duplicate push.
    expect(win.values()).toEqual([false]);

    // Machine is back but the window is still minimized: still not displayed.
    power.fire('resume');
    expect(win.values()).toEqual([false]);
    expect(r.current()).toBe(false);

    win.minimized = false;
    win.fire('restore');
    expect(win.values()).toEqual([false, true]);
  });

  it('never sends to a destroyed window or destroyed webContents', () => {
    const win = fakeWindow();
    const r = createWindowDisplayedReporter('ch');
    r.attach(win as unknown as DisplayableWindow);

    win.contentsDestroyed = true;
    win.minimized = true;
    win.fire('minimize');
    expect(win.sent).toEqual([]);

    win.contentsDestroyed = false;
    win.destroyed = true;
    win.minimized = false;
    win.fire('restore');
    expect(win.sent).toEqual([]);
  });

  it('current() answers the pull, and falls back to the safe default with no window', () => {
    const r = createWindowDisplayedReporter('ch');
    expect(r.current()).toBe(true); // nothing attached yet

    const win = fakeWindow({ minimized: true });
    const detach = r.attach(win as unknown as DisplayableWindow);
    expect(r.current()).toBe(false);

    detach();
    expect(r.current()).toBe(true);
  });

  it('a destroyed window reads as not displayed through current()', () => {
    const win = fakeWindow();
    const r = createWindowDisplayedReporter('ch');
    r.attach(win as unknown as DisplayableWindow);
    win.destroyed = true;
    expect(r.current()).toBe(false);
  });
});
