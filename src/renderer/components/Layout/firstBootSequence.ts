/**
 * #1164 — pure gating for the first-boot overlays, extracted from AppLayout
 * (no jsdom fixture there) so the sequencing is unit-testable.
 *
 * One first-boot surface at a time: wizard → auto-update consent → spotlight.
 * Stacking them made the lower one pointer-dead under the upper one's
 * full-screen backdrop.
 */

export interface AutoUpdatePromptGate {
  /** The consent question is still unanswered. */
  pending: boolean;
  /** The first-run wizard is mounted (either mode). */
  wizardOpen: boolean;
  /**
   * The wizard probe has settled: the marker already existed, the wizard was
   * closed (completed / Skip / Escape / ×), or the probe failed. Until then a
   * fresh boot does not yet know the wizard is coming — session.load() usually
   * resolves first, and rendering the prompt then would flash it for a frame
   * before the wizard mounts over it.
   */
  firstRunSettled: boolean;
}

export function shouldShowAutoUpdatePrompt(gate: AutoUpdatePromptGate): boolean {
  return gate.pending && !gate.wizardOpen && gate.firstRunSettled;
}

export interface OnboardingStartGate {
  sessionLoaded: boolean;
  /** Pending consent blocks the spotlight even while hidden behind the wizard. */
  autoUpdatePromptPending: boolean;
  firstRunCompleted: boolean;
  onboardingCompleted: boolean;
  workspaceCount: number;
}

export function shouldStartOnboarding(gate: OnboardingStartGate): boolean {
  if (!gate.sessionLoaded) return false;
  if (gate.autoUpdatePromptPending) return false;
  return gate.firstRunCompleted && !gate.onboardingCompleted && gate.workspaceCount === 1;
}
