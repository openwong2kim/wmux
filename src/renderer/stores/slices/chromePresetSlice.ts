import type { StateCreator } from 'zustand';
import type { ChromePreset } from '../../../shared/chromePresets';
import { CHROME_PRESET_VALUES } from '../../../shared/chromePresets';
import type { StoreState } from '../index';

export interface ChromePresetSlice {
  /** Apply a visibility recipe once. No preset or derived custom state persists. */
  applyChromePreset: (preset: ChromePreset) => void;
}

export const createChromePresetSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  ChromePresetSlice
> = (set) => ({
  applyChromePreset: (preset) => set((state) => {
    const values = CHROME_PRESET_VALUES[preset];

    state.agentToolbarEnabled = values.agentToolbarEnabled;
    state.paneActionsVisible = values.paneActionsVisible;
    state.sidebarVisible = values.sidebarVisible;
    state.channelsTabVisible = values.channelsTabVisible;
    state.channelDockVisible = values.channelDockVisible;

    // Match setChannelsTabVisible(false): a hidden tab cannot remain the
    // active route and unexpectedly reappear when the dock opens later.
    if (!values.channelsTabVisible && state.activeDeckTab === 'channels') {
      state.activeDeckTab = 'commander';
    }
  }),
});
