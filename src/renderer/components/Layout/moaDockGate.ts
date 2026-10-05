// ─── The right panel exists only while Moa is on ─────────────────────────────
//
// With Moa off the right panel held nothing Fleet does not already show, so it
// is not rendered at all and the terminals take the full width. The persisted
// `channelDockVisible` flag is left alone: it is the panel's open state for
// when Moa is on, and turning Moa back on restores it as it was.
//
// `moa` is null until main's first answer. Until then the last answer seen
// (a localStorage hint) decides, so a Moa-on boot does not draw the panes
// full width and then refit them all when the answer lands.
import { useEffect, useRef } from 'react';
import { useStore } from '../../stores';
import type { StoreState } from '../../stores';

export const MOA_ON_HINT_KEY = 'wmux.moa.enabledHint';
/** Set once the panel has opened by itself the first time Moa was turned on. */
export const MOA_PANEL_AUTO_OPENED_KEY = 'wmux.moa.panelAutoOpened';

function readFlag(key: string): boolean | null {
  try {
    const v = globalThis.localStorage?.getItem(key);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, on ? '1' : '0');
  } catch {
    // storage unavailable: both flags are conveniences only
  }
}

const bootHint = readFlag(MOA_ON_HINT_KEY);

/** Whether Moa is on, for the panel: main's answer, else the last one seen. */
export function selectMoaOn(s: Pick<StoreState, 'moa'>): boolean {
  return s.moa ? s.moa.config.enabled === true : bootHint === true;
}

/** Whether the right panel is rendered: open, and Moa on. */
export function selectDockOpen(s: Pick<StoreState, 'moa' | 'channelDockVisible'>): boolean {
  return s.channelDockVisible && selectMoaOn(s);
}

/**
 * Keeps the boot hint current and, the first time Moa is turned on (seen
 * going from off to on, never on a boot that finds it already on), opens the
 * panel on Moa's conversation once.
 */
export function useMoaDockGate(): void {
  const known = useStore((s) => (s.moa ? s.moa.config.enabled === true : null));
  const prev = useRef<boolean | null>(bootHint);
  useEffect(() => {
    if (known === null) return;
    const was = prev.current;
    prev.current = known;
    writeFlag(MOA_ON_HINT_KEY, known);
    if (known && was === false && readFlag(MOA_PANEL_AUTO_OPENED_KEY) !== true) {
      writeFlag(MOA_PANEL_AUTO_OPENED_KEY, true);
      const st = useStore.getState();
      st.setActiveDeckTab('commander');
      st.setChannelDockVisible(true);
    }
  }, [known]);
}
