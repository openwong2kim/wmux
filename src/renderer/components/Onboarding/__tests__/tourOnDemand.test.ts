// @vitest-environment jsdom
//
// The tour is on demand: a first launch never starts it (firstBootSequence
// has no tour surface), and Settings › Setup and reset › Restart Tutorial
// starts it at any time, also for a profile that already finished it.

import { describe, it, expect, afterEach } from 'vitest';
import { useStore } from '../../../stores';
import { nextFirstBootSurface } from '../../Layout/firstBootSequence';

afterEach(() => {
  useStore.setState({ onboardingActive: false });
});

describe('the onboarding tour on demand', () => {
  it('a fresh install whose wizard closed gets no tour by itself', () => {
    const surface = nextFirstBootSurface({
      firstRunSettled: true,
      sessionSettled: true,
      launchChecksSettled: true,
      wizardOpen: false,
      wizardRanThisBoot: true,
      otherSurfaceOpen: false,
      surfaceShowing: false,
      autoUpdatePromptPending: false,
      featureNoticePending: false,
    });
    expect(surface).toBeNull();
    expect(useStore.getState().onboardingActive).toBe(false);
  });

  it('starts when asked, even after it was completed, and ends completed', () => {
    useStore.setState({ onboardingCompleted: true, onboardingActive: false });
    useStore.getState().startOnboarding();
    expect(useStore.getState().onboardingActive).toBe(true);
    useStore.getState().completeOnboarding();
    expect(useStore.getState().onboardingActive).toBe(false);
    expect(useStore.getState().onboardingCompleted).toBe(true);
  });
});
