import type { MediaClipId } from '../../assets/media';
import type { AppRoute } from '../../stores/slices/uiSlice';

export interface OnboardingStep {
  id: string;
  titleKey: string;
  descriptionKey: string;
  targetSelector: string;
  /** Preferred tooltip placement relative to the highlighted element */
  placement: 'top' | 'bottom' | 'left' | 'right';
  /** Short looping clip (assets/media) that shows exactly what the step's
   *  copy describes. Steps without such a clip show text only. */
  media?: MediaClipId;
  /** Spotlighted instead when `targetSelector` matches nothing (e.g. the agent
   *  toolbar is switched off), so the step is not silently skipped. */
  fallbackSelector?: string;
  /** The target lives on the hover-revealed agent toolbar: hold the bar up
   *  while this step is on screen. */
  revealsAgentToolbar?: boolean;
  /** The rail page the target lives on. The tour brings that page up before
   *  the step (it starts on Fleet, where the Workspaces page sits covered and
   *  inert underneath). */
  page?: AppRoute;
}

/** On screen: not inside a covered (inert) or hidden part of the app. */
export function isTargetVisible(el: Element): boolean {
  return !el.closest('[inert], [hidden]');
}

/**
 * The selector a step spotlights right now, or null when nothing matches. A
 * mounted target counts only when it is visible, except for a step with a
 * `page`: the tour brings that page up first, and the page's `inert` is only
 * lifted in the same commit, after this check has run.
 */
export function resolveStepTarget(step: OnboardingStep): string | null {
  for (const selector of [step.targetSelector, step.fallbackSelector]) {
    if (!selector) continue;
    const el = document.querySelector(selector);
    if (el && (step.page !== undefined || isTargetVisible(el))) return selector;
  }
  return null;
}

/**
 * Onboarding tutorial steps.
 *
 * Each step highlights a specific UI element using `data-onboarding-target`
 * attributes added to existing components. The `targetSelector` is a CSS
 * selector that matches the element to spotlight.
 */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: 'fleet',
    titleKey: 'onboarding.step1.title',
    descriptionKey: 'onboarding.step1.description',
    targetSelector: '[data-sidebar-nav="fleet"]',
    placement: 'right',
    // No clip: the recording showed a Fleet layout that has since changed.
  },
  {
    id: 'fan-out',
    titleKey: 'onboarding.step2.title',
    descriptionKey: 'onboarding.step2.description',
    targetSelector: '[data-onboarding-target="fanout"]',
    fallbackSelector: '[data-onboarding-target="pane-area"]',
    revealsAgentToolbar: true,
    page: 'workspaces',
    placement: 'top',
    media: 'worktrees',
  },
  {
    id: 'open-browser',
    titleKey: 'onboarding.step3.title',
    descriptionKey: 'onboarding.step3.description',
    targetSelector: '[data-onboarding-target="status-bar"]',
    page: 'workspaces',
    placement: 'top',
  },
  {
    id: 'command-palette',
    titleKey: 'onboarding.step4.title',
    descriptionKey: 'onboarding.step4.description',
    targetSelector: '[data-onboarding-target="settings-button"]',
    placement: 'top',
  },
  {
    id: 'notification-panel',
    titleKey: 'onboarding.step5.title',
    descriptionKey: 'onboarding.step5.description',
    targetSelector: '[data-onboarding-target="notification-bell"]',
    placement: 'top',
  },
];
