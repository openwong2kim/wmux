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
  launchChecksSettled: true,
  wizardOpen: false,
  wizardRanThisBoot: false,
  otherSurfaceOpen: false,
  surfaceShowing: false,
  autoUpdatePromptPending: false,
  featureNoticePending: false,
};

describe('nextFirstBootSurface — ordering', () => {
  it('upgrader with everything pending: update question → New toast, one at a time, then nothing', () => {
    let s: FirstBootQueueState = { ...idle, autoUpdatePromptPending: true, featureNoticePending: true };
    expect(nextFirstBootSurface(s)).toBe('autoUpdatePrompt');
    // While it is on screen (its own modal layer counts too), nothing else starts.
    expect(nextFirstBootSurface({ ...s, surfaceShowing: true, otherSurfaceOpen: true })).toBeNull();
    s = { ...s, autoUpdatePromptPending: false };
    expect(nextFirstBootSurface(s)).toBe('featureNotice');
    s = { ...s, featureNoticePending: false, surfaceShowing: true };
    expect(nextFirstBootSurface(s)).toBeNull();
    // After the toast: no tour, no cheat sheet.
    expect(nextFirstBootSurface({ ...s, surfaceShowing: false })).toBeNull();
  });

  it('a tour or cheat sheet the user opened holds the queue back', () => {
    const s = { ...idle, featureNoticePending: true };
    expect(nextFirstBootSurface({ ...s, surfaceShowing: true })).toBeNull();
    expect(nextFirstBootSurface(s)).toBe('featureNotice');
  });

  it('waits for the probes and the launch-time hooks check to settle', () => {
    const s = { ...idle, featureNoticePending: true };
    expect(nextFirstBootSurface({ ...s, firstRunSettled: false })).toBeNull();
    expect(nextFirstBootSurface({ ...s, sessionSettled: false })).toBeNull();
    // The hooks ask opens after an async probe: the toast must not land with it.
    expect(nextFirstBootSurface({ ...s, launchChecksSettled: false })).toBeNull();
    expect(nextFirstBootSurface(s)).toBe('featureNotice');
  });

  it('never opens over the wizard, a dialog or the Settings panel', () => {
    const s = { ...idle, autoUpdatePromptPending: true };
    expect(nextFirstBootSurface({ ...s, wizardOpen: true })).toBeNull();
    expect(nextFirstBootSurface({ ...s, otherSurfaceOpen: true })).toBeNull();
    // The next one waits; once the dialog closes it starts.
    expect(nextFirstBootSurface(s)).toBe('autoUpdatePrompt');
  });
});

describe('nextFirstBootSurface — fresh install', () => {
  const fresh: FirstBootQueueState = { ...idle, wizardRanThisBoot: true };

  it('opens nothing after the wizard: no toast, no update modal, no tour, no cheat sheet', () => {
    const s = { ...fresh, featureNoticePending: true, autoUpdatePromptPending: true };
    expect(nextFirstBootSurface({ ...s, wizardOpen: true })).toBeNull();
    expect(nextFirstBootSurface(s)).toBeNull();
    expect(nextFirstBootSurface(fresh)).toBeNull();
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
