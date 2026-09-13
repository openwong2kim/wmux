/**
 * #1164 — first-boot overlay sequencing: wizard → auto-update consent →
 * onboarding spotlight, never stacked.
 */
import { describe, it, expect } from 'vitest';
import { shouldShowAutoUpdatePrompt, shouldShowCheatSheet, shouldStartOnboarding } from '../firstBootSequence';

describe('shouldShowCheatSheet (#1276)', () => {
  const base = {
    firstRunCompleted: true,
    sessionSettled: true,
    dismissed: false,
    forceShown: false,
    autoUpdatePromptPending: false,
    onboardingActiveOrStarting: false,
  };

  it('fresh boot: stays hidden while the consent prompt is pending after the wizard closes', () => {
    expect(shouldShowCheatSheet({ ...base, autoUpdatePromptPending: true })).toBe(false);
  });

  it('waits out the spotlight tour (running or about to start), then shows', () => {
    expect(shouldShowCheatSheet({ ...base, onboardingActiveOrStarting: true })).toBe(false);
    expect(shouldShowCheatSheet(base)).toBe(true);
  });

  it('stays behind the wizard and honours the permanent opt-out', () => {
    expect(shouldShowCheatSheet({ ...base, firstRunCompleted: false })).toBe(false);
    expect(shouldShowCheatSheet({ ...base, dismissed: true })).toBe(false);
  });

  it('holds until session.load() settles (no mount-then-unmount flicker)', () => {
    expect(shouldShowCheatSheet({ ...base, sessionSettled: false })).toBe(false);
  });

  it('returning user (marker present, tour unfinished): firstRun resolves before session load → tour starts, then the sheet shows — never hidden for good', () => {
    // Mirrors AppLayout: the start effect and the gate read the same inputs,
    // and the effect re-runs on sessionLoaded.
    const onboarding = {
      autoUpdatePromptPending: false,
      firstRunCompleted: true,
      onboardingCompleted: false,
      workspaceCount: 1,
    };
    const sheet = (sessionLoaded: boolean, onboardingActive: boolean, onboardingCompleted = false) =>
      shouldShowCheatSheet({
        ...base,
        sessionSettled: sessionLoaded,
        onboardingActiveOrStarting: onboardingActive
          || shouldStartOnboarding({ ...onboarding, onboardingCompleted, sessionLoaded }),
      });

    // 1. firstRun.check resolved, session.load still in flight: nothing yet.
    expect(shouldStartOnboarding({ ...onboarding, sessionLoaded: false })).toBe(false);
    expect(sheet(false, false)).toBe(false);
    // 2. session lands (workspaceCount 1→1): the effect's sessionLoaded dep changed, so it starts the tour.
    expect(shouldStartOnboarding({ ...onboarding, sessionLoaded: true })).toBe(true);
    expect(sheet(true, false)).toBe(false);
    // 3. tour running.
    expect(sheet(true, true)).toBe(false);
    // 4. tour skipped/completed → the sheet shows.
    expect(sheet(true, false, true)).toBe(true);
  });

  it('a failed session.load() settles the gate — the sheet still shows', () => {
    // sessionLoaded stays false on failure, so the tour never starts; the sheet must not wait on it.
    const starting = shouldStartOnboarding({
      sessionLoaded: false,
      autoUpdatePromptPending: false,
      firstRunCompleted: true,
      onboardingCompleted: false,
      workspaceCount: 1,
    });
    expect(shouldShowCheatSheet({ ...base, sessionSettled: true, onboardingActiveOrStarting: starting })).toBe(true);
  });

  it('a user-initiated `?` open is never gated by the first-boot sequence', () => {
    expect(shouldShowCheatSheet({
      ...base,
      dismissed: true,
      forceShown: true,
      autoUpdatePromptPending: true,
      onboardingActiveOrStarting: true,
    })).toBe(true);
  });
});

describe('shouldShowAutoUpdatePrompt', () => {
  it('fresh boot: holds the prompt while the wizard probe is unresolved and while the wizard is open', () => {
    // session.load() → null resolves before firstRun.check(): no flash.
    expect(shouldShowAutoUpdatePrompt({ pending: true, wizardOpen: false, firstRunSettled: false })).toBe(false);
    expect(shouldShowAutoUpdatePrompt({ pending: true, wizardOpen: true, firstRunSettled: false })).toBe(false);
  });

  it('fresh boot: releases the still-pending prompt once the wizard closes (Escape / Skip / complete)', () => {
    // handleWizardClose clears the wizard and settles firstRunCompleted in one pass.
    expect(shouldShowAutoUpdatePrompt({ pending: true, wizardOpen: false, firstRunSettled: true })).toBe(true);
  });

  it('upgrade install (marker exists, no wizard) still shows the prompt', () => {
    expect(shouldShowAutoUpdatePrompt({ pending: true, wizardOpen: false, firstRunSettled: true })).toBe(true);
  });

  it('a reopened wizard hides a pending prompt, and nothing shows once answered', () => {
    expect(shouldShowAutoUpdatePrompt({ pending: true, wizardOpen: true, firstRunSettled: true })).toBe(false);
    expect(shouldShowAutoUpdatePrompt({ pending: false, wizardOpen: false, firstRunSettled: true })).toBe(false);
  });
});

describe('shouldStartOnboarding', () => {
  const base = {
    sessionLoaded: true,
    autoUpdatePromptPending: false,
    firstRunCompleted: true,
    onboardingCompleted: false,
    workspaceCount: 1,
  };

  it('starts after the wizard and the consent are both done', () => {
    expect(shouldStartOnboarding(base)).toBe(true);
  });

  it('waits out a pending consent prompt', () => {
    expect(shouldStartOnboarding({ ...base, autoUpdatePromptPending: true })).toBe(false);
  });

  it('stays behind the wizard and the session load', () => {
    expect(shouldStartOnboarding({ ...base, firstRunCompleted: false })).toBe(false);
    expect(shouldStartOnboarding({ ...base, sessionLoaded: false })).toBe(false);
  });

  it('does not restart for completed onboarding or multi-workspace users', () => {
    expect(shouldStartOnboarding({ ...base, onboardingCompleted: true })).toBe(false);
    expect(shouldStartOnboarding({ ...base, workspaceCount: 2 })).toBe(false);
  });
});
