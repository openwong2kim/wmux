import type { MediaClipId } from '../../assets/media';

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
    id: 'split-pane',
    titleKey: 'onboarding.step1.title',
    descriptionKey: 'onboarding.step1.description',
    targetSelector: '[data-onboarding-target="pane-area"]',
    placement: 'bottom',
    media: 'split',
  },
  {
    id: 'add-workspace',
    titleKey: 'onboarding.step2.title',
    descriptionKey: 'onboarding.step2.description',
    targetSelector: '[data-onboarding-target="add-workspace"]',
    placement: 'right',
    media: 'workspaces',
  },
  {
    id: 'open-browser',
    titleKey: 'onboarding.step3.title',
    descriptionKey: 'onboarding.step3.description',
    targetSelector: '[data-onboarding-target="status-bar"]',
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
