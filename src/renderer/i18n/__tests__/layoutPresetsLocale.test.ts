import { describe, expect, it } from 'vitest';
import { LAYOUT_PRESETS } from '../../../shared/layoutPresets';
import { en } from '../locales/en';

const enStrings = en as unknown as Record<string, string>;

/**
 * Pins the dynamic-key contract the sidebar + menu relies on:
 * PresetPicker renders `t(\`preset.${preset.id}.name\`)`. If a preset is
 * ever added without keys, t()'s last fallback returns the key itself —
 * the menu would show "preset.foo.name" verbatim, in every locale
 * including English. This test fails first so that mistake never ships.
 */
describe('layout presets locale contract', () => {
  it('every LAYOUT_PRESETS id has preset.<id>.name/.description in en', () => {
    for (const preset of LAYOUT_PRESETS) {
      const nameKey = `preset.${preset.id}.name`;
      const descKey = `preset.${preset.id}.description`;
      expect(
        Object.prototype.hasOwnProperty.call(en, nameKey),
        `en missing "${nameKey}" — the + menu would render the raw key`,
      ).toBe(true);
      expect(
        Object.prototype.hasOwnProperty.call(en, descKey),
        `en missing "${descKey}"`,
      ).toBe(true);
      expect(enStrings[nameKey]).not.toBe(nameKey);
      expect(enStrings[descKey]).not.toBe(descKey);
    }
  });
});
