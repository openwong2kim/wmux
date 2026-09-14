import { describe, expect, it } from 'vitest';
import { ADVERTISED_SHORTCUTS } from '../../../shared/keymap';
import { en } from '../locales/en';
import { ko } from '../locales/ko';
import { zh } from '../locales/zh';

/**
 * SettingsPanel renders one row per ADVERTISED_SHORTCUTS entry as
 * `t(entry.descriptionKey)`. A row whose key has no string falls through t()'s
 * last fallback and the Settings list shows "settings.sc.richInput" verbatim —
 * in English too. #1280 added the Ctrl+G row (Rich Input) precisely so the
 * binding can be switched OFF from that list, so the row has to be legible.
 *
 * English is the gate for the whole list: it is the fallback every locale
 * lands on, so a key missing there is visible in every language. pl has its
 * own full-coverage lock (plLocaleCoverage.test.ts); ko/zh are maintained but
 * not complete (#997), and the other 20 locales are the accepted stalled gap —
 * all of them fall back to English at runtime. The new key is checked in
 * ko/zh explicitly rather than by sweeping a list they do not fully cover.
 */
const enStrings = en as unknown as Record<string, string>;

describe('advertised shortcut labels', () => {
  it('every advertised row has an English string', () => {
    for (const entry of ADVERTISED_SHORTCUTS) {
      // ADVERTISED_SHORTCUTS is filtered to non-null descriptionKeys, but the
      // declared type keeps the nullable union.
      const value = enStrings[entry.descriptionKey as string];
      expect(value, `en missing "${entry.descriptionKey}" for ${entry.combo}`)
        .toBeTruthy();
      expect(value).not.toBe(entry.descriptionKey);
    }
  });

  it('Ctrl+G (Rich Input) is one of those rows', () => {
    const row = ADVERTISED_SHORTCUTS.find((e) => e.combo === 'Ctrl+G');
    expect(row?.descriptionKey).toBe('settings.sc.richInput');
    expect(enStrings['settings.sc.richInput']).toBe('Toggle Rich Input');
    // Added to the maintained locales in the same pass.
    for (const [name, strings] of [
      ['ko', ko as unknown as Record<string, string>],
      ['zh', zh as unknown as Record<string, string>],
    ] as const) {
      expect(strings['settings.sc.richInput'], `${name} missing the label`).toBeTruthy();
    }
  });
});
