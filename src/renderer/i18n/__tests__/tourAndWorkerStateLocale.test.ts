import { describe, expect, it } from 'vitest';
import { en } from '../locales/en';
import { ko } from '../locales/ko';
import { pl } from '../locales/pl';
import { zh } from '../locales/zh';

// The verified-complete locales (en, ko, zh, pl; see plLocaleCoverage) own
// the onboarding tour's buttons and the Bots worker states instead of falling
// back to English. Mac E2E round 5 found the Korean tour showing English
// Skip/Next/Step: ko had none of these keys. The other locales are the
// accepted English-fallback gap and are not checked here.

const KEYS = [
  'onboarding.step',
  'onboarding.skip',
  'onboarding.back',
  'onboarding.done',
  'onboarding.next',
  'botsPage.worker.inReview',
  'botsPage.worker.inReviewPaused',
  'botsPage.worker.canResume',
] as const;

const VERIFIED: Record<string, Record<string, string>> = { ko, pl, zh };

function placeholdersOf(value: string): string[] {
  return [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
}

describe('tour buttons and worker states in the verified locales', () => {
  for (const [locale, table] of Object.entries(VERIFIED)) {
    it(`${locale} has its own string for each, with English's placeholders`, () => {
      for (const key of KEYS) {
        const source = (en as Record<string, string>)[key];
        expect(source, `en has "${key}"`).toBeTruthy();
        expect(Object.prototype.hasOwnProperty.call(table, key), `${locale} falls back for "${key}"`).toBe(true);
        expect(table[key]).toBeTruthy();
        expect(placeholdersOf(table[key]), `${locale} "${key}" placeholders`).toEqual(placeholdersOf(source));
      }
    });
  }
});
