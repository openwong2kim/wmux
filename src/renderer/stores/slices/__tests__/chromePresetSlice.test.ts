import { afterEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  CHROME_PRESET_VALUES,
  type ChromePreferenceValues,
} from '../../../../shared/chromePresets';
import {
  createChromePresetSlice,
  type ChromePresetSlice,
} from '../chromePresetSlice';
import { useStore } from '../../index';

type TestState = ChromePreferenceValues & ChromePresetSlice & {
  activeDeckTab: 'commander' | 'channels' | 'git';
  unrelatedPreference: string;
};

function createTestStore() {
  return create<TestState>()(
    immer((...args) => ({
      ...CHROME_PRESET_VALUES.standard,
      activeDeckTab: 'commander' as const,
      unrelatedPreference: 'keep me',
      // @ts-expect-error — this focused store supplies only the fields touched
      // by createChromePresetSlice, not the complete renderer StoreState.
      ...createChromePresetSlice(...args),
    })),
  );
}

function pickChromeValues(state: ChromePreferenceValues): ChromePreferenceValues {
  return {
    agentToolbarEnabled: state.agentToolbarEnabled,
    paneActionsVisible: state.paneActionsVisible,
    sidebarVisible: state.sidebarVisible,
    channelsTabVisible: state.channelsTabVisible,
    channelDockVisible: state.channelDockVisible,
  };
}

afterEach(() => {
  useStore.setState({
    ...CHROME_PRESET_VALUES.standard,
    activeDeckTab: 'commander',
  });
});

describe('ChromePresetSlice', () => {
  it('applies Minimal in one transaction and preserves unrelated preferences', () => {
    const store = createTestStore();
    store.setState({
      channelsTabVisible: true,
      channelDockVisible: true,
      activeDeckTab: 'channels',
    });
    const subscriber = vi.fn();
    store.subscribe(subscriber);

    store.getState().applyChromePreset('minimal');

    expect(pickChromeValues(store.getState())).toEqual(CHROME_PRESET_VALUES.minimal);
    expect(store.getState().activeDeckTab).toBe('commander');
    expect(store.getState().unrelatedPreference).toBe('keep me');
    expect(subscriber).toHaveBeenCalledTimes(1);
  });

  it('restores the shipped Standard defaults without storing a mode', () => {
    const store = createTestStore();
    store.setState({
      ...CHROME_PRESET_VALUES.minimal,
      channelsTabVisible: true,
      channelDockVisible: true,
      activeDeckTab: 'channels',
    });

    store.getState().applyChromePreset('standard');

    expect(pickChromeValues(store.getState())).toEqual(CHROME_PRESET_VALUES.standard);
    expect(store.getState().activeDeckTab).toBe('commander');
    expect(store.getState()).not.toHaveProperty('chromePreset');
    expect(store.getState()).not.toHaveProperty('chromePresetMode');
  });

  it('is idempotent for both recipes', () => {
    const store = createTestStore();

    for (const preset of ['minimal', 'standard'] as const) {
      store.getState().applyChromePreset(preset);
      const once = pickChromeValues(store.getState());
      store.getState().applyChromePreset(preset);
      expect(pickChromeValues(store.getState())).toEqual(once);
    }
  });

  it('uses Standard as the real renderer store default', () => {
    expect(pickChromeValues(useStore.getInitialState())).toEqual(CHROME_PRESET_VALUES.standard);
  });

  it('matches the existing preference setters in the real renderer store', () => {
    const startingState = {
      agentToolbarEnabled: true,
      paneActionsVisible: true,
      sidebarVisible: true,
      channelsTabVisible: true,
      channelDockVisible: true,
      activeDeckTab: 'channels' as const,
    };

    useStore.setState(startingState);
    const setters = useStore.getState();
    setters.setAgentToolbarEnabled(false);
    setters.setPaneActionsVisible(false);
    setters.setSidebarVisible(false);
    setters.setChannelsTabVisible(false);
    setters.setChannelDockVisible(false);
    const expected = {
      ...pickChromeValues(useStore.getState()),
      activeDeckTab: useStore.getState().activeDeckTab,
    };

    useStore.setState(startingState);
    useStore.getState().applyChromePreset('minimal');

    expect({
      ...pickChromeValues(useStore.getState()),
      activeDeckTab: useStore.getState().activeDeckTab,
    }).toEqual(expected);
  });
});
