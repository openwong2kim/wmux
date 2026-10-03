// @vitest-environment jsdom
// Settings sits at the titlebar's right end: it swaps the sheet to the
// Settings page and carries the selection fill while that page is up.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../../stores';
import SettingsButton from '../SettingsButton';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({ appRoute: 'fleet', fleetViewVisible: true, settingsPanelVisible: false });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('titlebar Settings button', () => {
  it('opens the Settings page and shows it as selected', () => {
    act(() => root.render(<SettingsButton />));
    const button = container.querySelector<HTMLButtonElement>('[data-titlebar-settings]');
    expect(button?.getAttribute('aria-label')).toBe('Settings');
    expect(button?.getAttribute('title')).toBe('Settings');
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    act(() => button?.click());
    expect(useStore.getState().appRoute).toBe('settings');
    expect(useStore.getState().settingsPanelVisible).toBe(true);
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    // The onboarding tour's Settings step finds it here now.
    expect(button?.dataset.onboardingTarget).toBe('settings-button');
  });
});
