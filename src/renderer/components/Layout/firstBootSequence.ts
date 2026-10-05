/**
 * #1164 — pure gating for the first-boot surfaces, extracted from AppLayout
 * (no jsdom fixture there) so the sequencing is unit-testable.
 *
 * One prompt at a time. A fresh launch used to stack the welcome dialog, a
 * "New: …" feature toast, the auto-update question, the spotlight tour and
 * the keyboard cheat sheet, each fired by its own trigger. Stacking made the
 * lower one pointer-dead under the upper one's backdrop, and most of them are
 * not something a new user needs yet. Now every self-opening surface goes
 * through this queue: the next one starts only when nothing else is on
 * screen, and the caller latches the start (mount → own modal layer → "a
 * dialog is open" must not unmount it again).
 */

export type FirstBootSurface = 'autoUpdatePrompt' | 'featureNotice' | 'onboarding' | 'cheatSheet';

export interface FirstBootQueueState {
  /** firstRun.check has answered, failed or is unavailable. */
  firstRunSettled: boolean;
  /** session.load() has resolved or failed. */
  sessionSettled: boolean;
  /** Launch-time checks that may open their own dialog (the hooks install
   *  ask) have answered, so nothing queued opens in the same moment. */
  launchChecksSettled: boolean;
  /** The first-run wizard (either mode) is mounted. */
  wizardOpen: boolean;
  /**
   * The first-run marker was absent on this boot: a fresh install. The wizard
   * carries the auto-update row, and announcements of what changed are for
   * upgraders only.
   */
  wizardRanThisBoot: boolean;
  /** Some modal layer (a Dialog, the tour card) or the Settings panel is open. */
  otherSurfaceOpen: boolean;
  /** A queued surface is already on screen (latched by the caller). */
  surfaceShowing: boolean;

  /** An upgrade from a build that never stored the auto-update choice. */
  autoUpdatePromptPending: boolean;
  /** A one-time "New: …" announcement has not been shown on this profile. */
  featureNoticePending: boolean;

  firstRunCompleted: boolean;
  onboardingCompleted: boolean;
  /** The user is on the Fleet page — the tour starts on the first visit there. */
  onFleetPage: boolean;

  /** "Show keyboard shortcuts once" has not been used up (or was re-armed in Settings). */
  cheatSheetPending: boolean;
}

/**
 * The surface that may open now, or null. Order: the legacy auto-update
 * question (upgraders whose choice was never stored), the one-time feature
 * announcement (upgraders), the spotlight tour (first Fleet visit), and the
 * keyboard cheat sheet (once, after the tour).
 */
export function nextFirstBootSurface(s: FirstBootQueueState): FirstBootSurface | null {
  if (!s.firstRunSettled || !s.sessionSettled || !s.launchChecksSettled) return null;
  if (s.wizardOpen || s.surfaceShowing || s.otherSurfaceOpen) return null;
  // A fresh install answered the update question in the wizard and has no
  // previous version to announce changes against.
  if (!s.wizardRanThisBoot && s.autoUpdatePromptPending) return 'autoUpdatePrompt';
  if (!s.wizardRanThisBoot && s.featureNoticePending) return 'featureNotice';
  if (!s.firstRunCompleted || !s.onboardingCompleted) {
    if (s.firstRunCompleted && s.onFleetPage) return 'onboarding';
    // The cheat sheet comes after the tour, so a user who never opens Fleet
    // is never shown either.
    return null;
  }
  if (s.cheatSheetPending) return 'cheatSheet';
  return null;
}

export type HooksLaunchCheck = 'wait' | 'check' | 'skip';

export interface HooksLaunchCheckGate {
  /** firstRun.check has answered, failed or is unavailable. Fed from local
   *  state set only by that probe — never the store's firstRunCompleted,
   *  which session load can set first. A failed probe counts as settled. */
  firstRunSettled: boolean;
  /** The first-run wizard was mounted on this boot. It carries its own
   *  "Claude Code hooks · Install hooks" row, so a launch-time hooks modal
   *  would ask the same question twice — once on top of the wizard. */
  firstRunWizardRanThisBoot: boolean;
}

/**
 * The launch-time hooks install check. It used to run on mount, before the
 * wizard probe resolved, so a fresh profile opened the hooks modal on top of
 * the Welcome dialog that already offers the same install. On the boot the
 * wizard runs, the wizard is the offer; later boots (and a mode raise, which
 * does not go through this gate) still ask.
 */
export function hooksLaunchCheck(gate: HooksLaunchCheckGate): HooksLaunchCheck {
  if (gate.firstRunWizardRanThisBoot) return 'skip';
  return gate.firstRunSettled ? 'check' : 'wait';
}
