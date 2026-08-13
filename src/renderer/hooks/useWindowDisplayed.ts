// "Is anyone looking at this window" as one renderer-wide fact (#882).
//
// Main owns the signal (main/window/windowDisplayed.ts has the measurements and
// the reasoning); this is the renderer half. Panes read it through
// `useWindowDisplayed` and fold it into the #766 viewer-visibility report.
//
// ONE bridge subscription for the whole app, not one per pane. Every pane wants
// the same global bit, and N panes each calling `ipcRenderer.on` would be N
// preload listeners and N duplicate deliveries of one event.
//
// PULL AT INIT, then push. The pull is not decoration: the window can already be
// hidden when the renderer loads (started to tray, or reloaded after a renderer
// crash), and a push-only design would leave every such renderer sitting on the
// optimistic default until the user happened to minimize and restore. Same
// shape as the fullscreen state in Titlebar.tsx.
//
// Defaults to TRUE — the same optimistic default the daemon holds
// (`viewerVisible: true`) — so a preload too old to expose the bridge behaves
// exactly as it did before this existed.

import { useSyncExternalStore } from 'react';

type Listener = () => void;

export interface WindowDisplayedStore {
  /** Current value. True until main says otherwise. */
  get(): boolean;
  subscribe(listener: Listener): () => void;
  /** Wire the bridge: pull the current value, then follow transitions.
   *  Called once from App; returns the teardown. */
  init(deps?: WindowDisplayedDeps): () => void;
}

export interface WindowDisplayedDeps {
  isDisplayed?: () => Promise<boolean>;
  onDisplayedChanged?: (cb: (displayed: boolean) => void) => () => void;
}

export function createWindowDisplayedStore(): WindowDisplayedStore {
  let displayed = true;
  const listeners = new Set<Listener>();

  const set = (value: boolean): void => {
    if (value === displayed) return;
    displayed = value;
    for (const listener of [...listeners]) listener();
  };

  return {
    get: () => displayed,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    init(deps = {}) {
      // `typeof window` guard, not a bare access: this module is imported by
      // node-environment unit tests that never load jsdom.
      const api = typeof window === 'undefined'
        ? undefined
        : (window as { electronAPI?: { window?: WindowDisplayedDeps } }).electronAPI?.window;
      const {
        // Optional-chained rather than assumed: a packaged app can be updated
        // under a running renderer, leaving a preload without these members.
        isDisplayed = api?.isDisplayed?.bind(api),
        onDisplayedChanged = api?.onDisplayedChanged?.bind(api),
      } = deps;

      let alive = true;
      // Subscribe BEFORE pulling, so a transition that lands between the two
      // is not dropped. The pull is then only allowed to fill in the initial
      // value — never to overwrite a push that has already arrived, which
      // would resurrect a stale answer from an in-flight invoke.
      let pushed = false;
      const off = onDisplayedChanged?.((value) => {
        if (!alive) return;
        pushed = true;
        set(value);
      });
      void isDisplayed?.().then((value) => {
        if (!alive || pushed) return;
        set(value === true);
      }).catch(() => {
        // Best-effort: the push path corrects the value on the next transition,
        // and the default is the safe one.
      });

      return () => {
        alive = false;
        off?.();
      };
    },
  };
}

/** App-wide singleton — `AppLayout` calls `init`, panes call the hook. */
export const windowDisplayedStore = createWindowDisplayedStore();

/** Subscribe a component to the window-displayed bit. */
export function useWindowDisplayed(): boolean {
  return useSyncExternalStore(
    windowDisplayedStore.subscribe,
    windowDisplayedStore.get,
    // Server snapshot: tests render with jsdom, never SSR, but React demands
    // the third argument when the second can differ across environments.
    windowDisplayedStore.get,
  );
}
