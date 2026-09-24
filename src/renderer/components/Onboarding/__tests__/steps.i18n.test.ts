import { describe, it, expect } from 'vitest';
import { ONBOARDING_STEPS } from '../steps';
import { en } from '../../../i18n/locales/en';
import { MEDIA_CLIPS } from '../../../assets/media';

/**
 * Regression for #452: OnboardingOverlay rendered raw i18n keys
 * ("onboarding.step1.title") because ONBOARDING_STEPS referenced keys that
 * were never added to any locale — and t() falls back to returning the key.
 *
 * The `en` locale is the source of truth for the key set (TranslationKey =
 * keyof typeof en); every other locale is Partial<> and falls back to `en`.
 * So asserting coverage against `en` guarantees no step can surface a raw
 * placeholder again.
 */
describe('ONBOARDING_STEPS i18n coverage (#452)', () => {
  it('defines every step title/description key in the en locale', () => {
    const missing: string[] = [];
    for (const step of ONBOARDING_STEPS) {
      if (!(step.titleKey in en)) missing.push(step.titleKey);
      if (!(step.descriptionKey in en)) missing.push(step.descriptionKey);
    }
    expect(missing).toEqual([]);
  });
});

describe('ONBOARDING_STEPS media', () => {
  it('only references clips that exist, each with a poster for reduced motion', () => {
    for (const step of ONBOARDING_STEPS) {
      if (!step.media) continue;
      const clip = MEDIA_CLIPS[step.media];
      expect(clip, step.id).toBeDefined();
      expect(clip.src).toMatch(/\.webm/);
      expect(clip.poster).toMatch(/\.webp/);
    }
  });
});
