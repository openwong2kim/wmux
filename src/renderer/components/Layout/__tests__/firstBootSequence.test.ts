/**
 * First-boot queue: one self-opening surface at a time, in a fixed order,
 * and nothing a fresh install does not need (#1164, #1276).
 */
import { describe, it, expect } from 'vitest';
import { hooksLaunchCheck, nextFirstBootSurface } from '../firstBootSequence';
import type { FirstBootQueueState } from '../firstBootSequence';

/** A settled boot with nothing open and nothing pending. */
const idle: FirstBootQueueState = {
  firstRunSettled: true,
  sessionSettled: true,
  wizardOpen: false,
  wizardRanThisBoot: false,
  otherSurfaceOpen: false,
  surfaceShowing: false,
  autoUpdatePromptPending: false,
  featureNoticePending: false,
  firstRunCompleted: true,
  onboardingCompleted: true,
  onFleetPage: false,
  cheatSheetPending: false,
};

describe('nextFirstBootSurface — ordering', () => {
  it('upgrader with everything pending: update question → New toast → tour → cheat sheet, one at a time', () => {
    let s: FirstBootQueueState = {
      ...idle,
      autoUpdatePromptPending: true,
      featureNoticePending: true,
      onboardingCompleted: false,
      onFleetPage: true,
      cheatSheetPending: true,
    };
    expect(nextFirstBootSurface(s)).toBe('autoUpdatePrompt');
    // While it is on screen (its own modal layer counts too), nothing else starts.
    expect(nextFirstBootSurface({ ...s, surfaceShowing: true, otherSurfaceOpen: true })).toBeNull();
    s = { ...s, autoUpdatePromptPending: false };
    expect(nextFirstBootSurface(s)).toBe('featureNotice');
    s = { ...s, featureNoticePending: false };
    expect(nextFirstBootSurface(s)).toBe('onboarding');
    expect(nextFirstBootSurface({ ...s, surfaceShowing: true })).toBeNull();
    s = { ...s, onboardingCompleted: true };
    expect(nextFirstBootSurface(s)).toBe('cheatSheet');
    s = { ...s, cheatSheetPending: false };
    expect(nextFirstBootSurface(s)).toBeNull();
  });

  it('waits for both probes to settle', () => {
    const s = { ...idle, featureNoticePending: true };
    expect(nextFirstBootSurface({ ...s, firstRunSettled: false })).toBeNull();
    expect(nextFirstBootSurface({ ...s, sessionSettled: false })).toBeNull();
    expect(nextFirstBootSurface(s)).toBe('featureNotice');
  });

  it('never opens over the wizard, a dialog or the Settings panel', () => {
    const s = { ...idle, onboardingCompleted: false, onFleetPage: true };
    expect(nextFirstBootSurface({ ...s, wizardOpen: true })).toBeNull();
    expect(nextFirstBootSurface({ ...s, otherSurfaceOpen: true })).toBeNull();
    // The next one waits; once the dialog closes it starts.
    expect(nextFirstBootSurface(s)).toBe('onboarding');
  });
});

describe('nextFirstBootSurface — fresh install', () => {
  const fresh: FirstBootQueueState = {
    ...idle,
    wizardRanThisBoot: true,
    onboardingCompleted: false,
    cheatSheetPending: true,
  };

  it('hides "New: …" toasts and the separate update modal (the wizard row asked)', () => {
    const s = { ...fresh, featureNoticePending: true, autoUpdatePromptPending: true };
    expect(nextFirstBootSurface({ ...s, wizardOpen: true })).toBeNull();
    // After the wizard closes, still nothing: no toast, no modal, no tour, no sheet.
    expect(nextFirstBootSurface(s)).toBeNull();
  });

  it('starts the tour only on the first visit to the Fleet page, after the wizard', () => {
    expect(nextFirstBootSurface({ ...fresh, firstRunCompleted: false, onFleetPage: true })).toBeNull();
    expect(nextFirstBootSurface(fresh)).toBeNull();
    expect(nextFirstBootSurface({ ...fresh, onFleetPage: true })).toBe('onboarding');
  });

  it('never auto-opens the cheat sheet before the tour is done', () => {
    expect(nextFirstBootSurface({ ...fresh, onFleetPage: false })).toBeNull();
    expect(nextFirstBootSurface({ ...fresh, onboardingCompleted: true })).toBe('cheatSheet');
  });
});

describe('hooksLaunchCheck — the Welcome dialog already offers hooks', () => {
  it('waits while the wizard probe is unsettled, so a fresh boot never checks before the wizard mounts', () => {
    expect(hooksLaunchCheck({ firstRunSettled: false, firstRunWizardRanThisBoot: false })).toBe('wait');
  });

  it('skips the launch prompt on the boot the wizard ran, even after it closes', () => {
    expect(hooksLaunchCheck({ firstRunSettled: false, firstRunWizardRanThisBoot: true })).toBe('skip');
    expect(hooksLaunchCheck({ firstRunSettled: true, firstRunWizardRanThisBoot: true })).toBe('skip');
  });

  it('checks on a later boot (marker already written)', () => {
    expect(hooksLaunchCheck({ firstRunSettled: true, firstRunWizardRanThisBoot: false })).toBe('check');
  });
});
