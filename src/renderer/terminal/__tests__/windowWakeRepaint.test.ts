import { describe, it, expect, vi } from 'vitest';
import {
  createWindowWakeRepaint,
  WAKE_SECOND_PASS_MS,
  type WindowWakeRepaintDeps,
} from '../windowWakeRepaint';

type Listener = () => void;

function makeFakeWindow() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener: (type: string, cb: EventListener) => {
      const set = listeners.get(type) ?? new Set<Listener>();
      set.add(cb as Listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, cb: EventListener) => {
      listeners.get(type)?.delete(cb as Listener);
    },
    fire: (type: 'blur' | 'focus') => {
      for (const cb of [...(listeners.get(type) ?? [])]) cb();
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

/** Manual frame + timer queues so a test drives the two passes independently. */
function setup(overrides: Partial<WindowWakeRepaintDeps> = {}) {
  const win = makeFakeWindow();
  let focused = true;
  const frames: Array<{ id: number; cb: () => void; cancelled: boolean }> = [];
  const timers: Array<{ id: number; cb: () => void; ms: number; cancelled: boolean }> = [];
  let nextId = 1;
  const logs: string[] = [];

  const coordinator = createWindowWakeRepaint();
  const teardown = coordinator.init({
    enabled: true,
    windowRef: win,
    hasFocus: () => focused,
    requestFrame: (cb) => { const id = nextId++; frames.push({ id, cb, cancelled: false }); return id; },
    cancelFrame: (id) => { const f = frames.find((x) => x.id === id); if (f) f.cancelled = true; },
    setTimeoutFn: (cb, ms) => { const id = nextId++; timers.push({ id, cb, ms, cancelled: false }); return id; },
    clearTimeoutFn: (id) => { const t = timers.find((x) => x.id === id); if (t) t.cancelled = true; },
    log: (m) => logs.push(m),
    ...overrides,
  });

  return {
    win,
    coordinator,
    teardown,
    logs,
    timers,
    setFocused: (v: boolean) => { focused = v; },
    /** Run every frame callback queued and not cancelled. */
    runFrames: () => {
      for (const f of frames.filter((x) => !x.cancelled && x.cb)) { const cb = f.cb; f.cancelled = true; cb(); }
    },
    runTimers: () => {
      for (const t of timers.filter((x) => !x.cancelled && x.cb)) { const cb = t.cb; t.cancelled = true; cb(); }
    },
    pendingFrames: () => frames.filter((f) => !f.cancelled).length,
    pendingTimers: () => timers.filter((t) => !t.cancelled).length,
  };
}

function pane(visible = true) {
  const calls: number[] = [];
  let n = 0;
  return {
    entry: { isVisible: () => visible, repaint: () => { calls.push(++n); } },
    count: () => calls.length,
    setVisible: (v: boolean) => { visible = v; },
  };
}

describe('windowWakeRepaint', () => {
  it('repaints every visible pane twice (frame pass, then delayed pass) on blur→focus', () => {
    const s = setup();
    const a = pane();
    const b = pane();
    s.coordinator.register(a.entry);
    s.coordinator.register(b.entry);

    s.setFocused(false);
    s.win.fire('blur');
    s.setFocused(true);
    s.win.fire('focus');

    s.runFrames();
    expect([a.count(), b.count()]).toEqual([1, 1]);
    s.runTimers();
    // Both panes, not just the one that would own the focused textarea — that
    // single-pane gap is the split-layout half of #879.
    expect([a.count(), b.count()]).toEqual([2, 2]);
    expect(s.logs).toHaveLength(2);
    expect(s.logs[0]).toContain('repainted 2 visible pane(s)');
  });

  it('the delayed pass is armed at WAKE_SECOND_PASS_MS', () => {
    const s = setup();
    s.coordinator.register(pane().entry);
    s.setFocused(false);
    s.win.fire('blur');
    s.setFocused(true);
    s.win.fire('focus');
    expect(s.timers.at(-1)?.ms).toBe(WAKE_SECOND_PASS_MS);
  });

  it('a focus with no preceding blur does nothing (in-app focus churn)', () => {
    const s = setup();
    const p = pane();
    s.coordinator.register(p.entry);

    s.win.fire('focus');
    s.runFrames();
    s.runTimers();

    expect(p.count()).toBe(0);
    expect(s.logs).toEqual([]);
  });

  it('a pane that mounted while the window was already blurred still wakes', () => {
    // hasFocus() is false at init, so the coordinator starts in the "away"
    // state instead of waiting for a blur it structurally cannot observe: the
    // blur happened before anything here was listening.
    let focused = false;
    const s = setup({ hasFocus: () => focused });
    const p = pane();
    s.coordinator.register(p.entry);

    focused = true;
    s.win.fire('focus');
    s.runFrames();

    expect(p.count()).toBe(1);
  });

  it('skips panes in a hidden workspace/tab', () => {
    const s = setup();
    const hidden = pane(false);
    const shown = pane(true);
    s.coordinator.register(hidden.entry);
    s.coordinator.register(shown.entry);

    s.setFocused(false);
    s.win.fire('blur');
    s.setFocused(true);
    s.win.fire('focus');
    s.runFrames();
    s.runTimers();

    expect(hidden.count()).toBe(0);
    expect(shown.count()).toBe(2);
    expect(s.logs[0]).toContain('repainted 1 visible pane(s)');
  });

  it('a blur mid-cycle cancels the pending passes instead of stacking them', () => {
    const s = setup();
    const p = pane();
    s.coordinator.register(p.entry);

    s.setFocused(false);
    s.win.fire('blur');
    s.setFocused(true);
    s.win.fire('focus');   // arms pass 1 + pass 2
    s.setFocused(false);
    s.win.fire('blur');    // user tabbed away again before either ran
    expect(s.pendingFrames()).toBe(0);
    expect(s.pendingTimers()).toBe(0);

    s.setFocused(true);
    s.win.fire('focus');
    s.runFrames();
    s.runTimers();
    // Exactly one cycle's worth of work, not two.
    expect(p.count()).toBe(2);
  });

  it('a pass that runs while the window is away again repaints nothing', () => {
    const s = setup();
    const p = pane();
    s.coordinator.register(p.entry);

    s.setFocused(false);
    s.win.fire('blur');
    s.setFocused(true);
    s.win.fire('focus');
    // Focus lost without a blur event reaching us (OS-level race): the pass
    // re-checks at execution time.
    s.setFocused(false);
    s.runFrames();
    s.runTimers();

    expect(p.count()).toBe(0);
  });

  it('one pane throwing does not stop the others', () => {
    const s = setup();
    const bad = { isVisible: () => true, repaint: () => { throw new Error('disposing'); } };
    const good = pane();
    s.coordinator.register(bad);
    s.coordinator.register(good.entry);

    s.setFocused(false);
    s.win.fire('blur');
    s.setFocused(true);
    s.win.fire('focus');
    s.runFrames();

    expect(good.count()).toBe(1);
  });

  it('unregister stops that pane; teardown detaches the listeners and cancels pending work', () => {
    const s = setup();
    const p = pane();
    const unregister = s.coordinator.register(p.entry);
    unregister();

    s.setFocused(false);
    s.win.fire('blur');
    s.setFocused(true);
    s.win.fire('focus');
    s.runFrames();
    expect(p.count()).toBe(0);

    s.coordinator.register(p.entry);
    s.setFocused(false);
    s.win.fire('blur');
    s.setFocused(true);
    s.win.fire('focus');
    s.teardown();
    expect(s.pendingFrames()).toBe(0);
    expect(s.pendingTimers()).toBe(0);
    expect(s.win.listenerCount()).toBe(0);

    s.win.fire('focus');
    s.runFrames();
    expect(p.count()).toBe(0);
  });

  it('enabled:false attaches nothing and never repaints (non-Windows builds)', () => {
    const win = makeFakeWindow();
    const coordinator = createWindowWakeRepaint();
    const p = pane();
    coordinator.register(p.entry);
    const repaintSpy = vi.spyOn(p.entry, 'repaint');

    const teardown = coordinator.init({ enabled: false, windowRef: win, hasFocus: () => false });
    expect(win.listenerCount()).toBe(0);
    win.fire('focus');
    expect(repaintSpy).not.toHaveBeenCalled();
    teardown();
  });
});
