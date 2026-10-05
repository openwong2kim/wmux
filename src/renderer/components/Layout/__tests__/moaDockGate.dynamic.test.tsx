// @vitest-environment jsdom
//
// The right panel exists only while Moa is on: with Moa off nothing is drawn
// (the persisted open flag is left alone), the first time Moa is turned on the
// panel opens once by itself, and each Moa flip is one layout change, so each
// pane resizes its PTY once.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFitScheduler } from '../../../utils/layoutTransitionGate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HINT = 'wmux.moa.enabledHint';
const AUTO = 'wmux.moa.panelAutoOpened';
const moa = (enabled: boolean) => ({ config: { enabled }, hq: { workspaceId: null } }) as never;

let host: HTMLDivElement;
let root: Root;

/** The gate module is read fresh per test: its boot hint is read at import. */
async function gate() {
  vi.resetModules();
  const mod = await import('../moaDockGate');
  const { useStore: store } = await import('../../../stores');
  function Harness() {
    mod.useMoaDockGate();
    const open = store(mod.selectDockOpen);
    return open ? <aside data-dock /> : null;
  }
  act(() => root.render(<Harness />));
  return { mod, store };
}
const dockShown = () => host.querySelector('[data-dock]') !== null;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('moaDockGate', () => {
  it('Moa off: no panel, and the persisted open flag is not flipped', async () => {
    const { store } = await gate();
    act(() => store.setState({ moa: moa(false), channelDockVisible: true }));
    expect(dockShown()).toBe(false);
    expect(store.getState().channelDockVisible).toBe(true);
    // Turned on: the panel is back as it was left.
    act(() => store.setState({ moa: moa(true) }));
    expect(dockShown()).toBe(true);
  });

  it('first turn-on opens the panel once; later turn-ons leave it as the operator left it', async () => {
    const { store } = await gate();
    act(() => store.setState({ moa: moa(false), channelDockVisible: false, activeDeckTab: 'channels' }));
    act(() => store.setState({ moa: moa(true) }));
    expect(store.getState().channelDockVisible).toBe(true);
    expect(store.getState().activeDeckTab).toBe('commander');
    expect(localStorage.getItem(AUTO)).toBe('1');
    expect(dockShown()).toBe(true);
    // Closed, Moa off and on again: stays closed.
    act(() => store.setState({ channelDockVisible: false }));
    act(() => store.setState({ moa: moa(false) }));
    act(() => store.setState({ moa: moa(true) }));
    expect(store.getState().channelDockVisible).toBe(false);
  });

  it('a boot that finds Moa already on does not auto-open', async () => {
    const { store } = await gate();
    act(() => store.setState({ moa: null, channelDockVisible: false }));
    act(() => store.setState({ moa: moa(true) }));
    expect(store.getState().channelDockVisible).toBe(false);
    expect(localStorage.getItem(AUTO)).toBeNull();
  });

  it('before main answers, the last answer seen decides (no full-width boot then refit)', async () => {
    localStorage.setItem(HINT, '1');
    const on = await gate();
    act(() => on.store.setState({ moa: null, channelDockVisible: true }));
    expect(dockShown()).toBe(true);
    act(() => root.render(null));
    localStorage.setItem(HINT, '0');
    const off = await gate();
    act(() => off.store.setState({ moa: null, channelDockVisible: true }));
    expect(dockShown()).toBe(false);
  });

  it('each Moa flip refits each pane once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    const { store } = await gate();
    act(() => store.setState({ moa: moa(true), channelDockVisible: true }));
    const ptyResize = vi.fn();
    // A pane: the sheet's width minus the dock's, cols from it, deduped like
    // useTerminal's lastSentCols; the observer ticks a few times per layout.
    const panes = ['a', 'b'].map((id) => {
      let width = 0;
      let sent = 0;
      const scheduler = createFitScheduler({
        debounceMs: 100,
        fitNextFrame: () => requestAnimationFrame(() => {
          const cols = Math.floor(width / 8);
          if (cols !== sent) { sent = cols; ptyResize(id, cols); }
        }),
      });
      return { layout() { width = dockShown() ? 1120 : 1440; for (let i = 0; i < 3; i++) scheduler.onResize(); } };
    });
    const settle = () => { for (const p of panes) p.layout(); vi.advanceTimersByTime(200); };
    settle();
    ptyResize.mockClear();
    act(() => store.setState({ moa: moa(false) }));
    settle();
    expect(ptyResize).toHaveBeenCalledTimes(2);
    act(() => store.setState({ moa: moa(true) }));
    settle();
    expect(ptyResize).toHaveBeenCalledTimes(4);
    expect(ptyResize).toHaveBeenLastCalledWith('b', 140);
  });
});
