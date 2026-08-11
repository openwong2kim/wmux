/** One-shot visibility recipes. Applying one never stores a mode marker. */
export type ChromePreset = 'minimal' | 'standard';

export interface ChromePreferenceValues {
  agentToolbarEnabled: boolean;
  paneActionsVisible: boolean;
  sidebarVisible: boolean;
  channelsTabVisible: boolean;
  channelDockVisible: boolean;
}

/**
 * `standard` is also the source of truth for the shipped defaults. Keeping the
 * defaults and the restore action on the same map prevents them from drifting.
 */
export const CHROME_PRESET_VALUES = {
  minimal: {
    agentToolbarEnabled: false,
    paneActionsVisible: false,
    sidebarVisible: false,
    channelsTabVisible: false,
    channelDockVisible: false,
  },
  standard: {
    agentToolbarEnabled: true,
    paneActionsVisible: true,
    sidebarVisible: true,
    channelsTabVisible: false,
    channelDockVisible: false,
  },
} as const satisfies Record<ChromePreset, ChromePreferenceValues>;
