/**
 * Tests for the custom-theme contrast safety net (PR1).
 *
 * Same constraint as the notifications/firstRun suites: vitest runs in `node`
 * without a DOM, so we drive the pure `ContrastBadge` through
 * `renderToStaticMarkup` and verify markup + ARIA wiring, and exercise the
 * `detectBasePreset` helper directly. The surface-aware contrast math itself is
 * covered in ../../../__tests__/contrastSafety.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContrastBadge, baseColorsFor, detectBasePreset } from '../SettingsPanel';
import { evaluateToken } from '../../../contrastSafety';
import { builtinToCustom } from '../../../themes';

// Identity translator that ALSO echoes the vars it received — keeps the test
// free of en.ts copy drift while still proving the right key + vars (ratio /
// surface) reach the label. Real `t()` interpolates them into the en.ts copy.
const tStub = (key: string, vars?: Record<string, string | number>): string => {
  if (!vars) return key;
  const pairs = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(' ');
  return `${key} {${pairs}}`;
};

const surfaceLabel = (bg: string): string => bg;

// Minimal color set the evaluator needs.
function colors(over: Record<string, string> = {}) {
  return {
    bgBase: '#1E1E2E', bgSurface: '#313244', bgMantle: '#181825',
    textMain: '#CDD6F4', textSub: '#BAC2DE', textMuted: '#7F849C', accent: '#89B4FA',
    ...over,
  };
}

describe('ContrastBadge — low contrast', () => {
  it('renders an amber warning with the ratio in the aria-label for a hard-to-read pair', () => {
    // bg ≈ #F8F8FA, text ≈ #F0F0F0 → ~1.1:1 (severe, < 3:1).
    const c = colors({ bgBase: '#F8F8FA', bgSurface: '#F8F8FA', bgMantle: '#F8F8FA', textMain: '#F0F0F0' });
    const report = evaluateToken('textMain', c);
    const html = renderToStaticMarkup(
      createElement(ContrastBadge, { report, t: tStub, surfaceLabel }),
    );
    // Warning state, not ok.
    expect(html).toContain('data-contrast-state="severe"');
    expect(html).not.toContain('data-contrast-state="ok"');
    // aria-label carries the severe key plus the ratio + surface vars (which
    // real t() interpolates into the en.ts copy) and the chip shows the ratio.
    expect(html).toMatch(/aria-label="settings\.contrast\.severe \{ratio=1\.\d/);
    expect(html).toContain('surface=bgBase');
    expect(html).toMatch(/>1\.\d:1</);
    // Severe failures announce assertively.
    expect(html).toContain('aria-live="assertive"');
  });

  it('uses a polite amber warning (not severe) for an AA-miss that still clears 3:1', () => {
    // Pick a pair between 3:1 and 4.5:1 — mid-gray text on white ≈ 3.5:1.
    const c = colors({ bgBase: '#FFFFFF', bgSurface: '#FFFFFF', bgMantle: '#FFFFFF', textMain: '#888888' });
    const report = evaluateToken('textMain', c);
    // Sanity: this fixture must be in the warn (not severe) band.
    expect(report.allPass).toBe(false);
    expect(report.anySevere).toBe(false);
    const html = renderToStaticMarkup(
      createElement(ContrastBadge, { report, t: tStub, surfaceLabel }),
    );
    expect(html).toContain('data-contrast-state="warn"');
    expect(html).toMatch(/aria-label="settings\.contrast\.warn/);
    expect(html).toContain('aria-live="polite"');
  });
});

describe('ContrastBadge — passing contrast', () => {
  it('renders an ok badge with no ratio for a readable pair', () => {
    const c = colors({ bgBase: '#FFFFFF', bgSurface: '#FFFFFF', bgMantle: '#FFFFFF', textMain: '#111111' });
    const report = evaluateToken('textMain', c);
    const html = renderToStaticMarkup(
      createElement(ContrastBadge, { report, t: tStub, surfaceLabel }),
    );
    expect(html).toContain('data-contrast-state="ok"');
    expect(html).toContain('aria-label="settings.contrast.ok"');
    expect(html).not.toContain('aria-live="assertive"');
  });

  it('the shipped catppuccin-mocha accent reads OK against the dark surfaces', () => {
    const report = evaluateToken('accent', builtinToCustom('catppuccin-mocha'));
    const html = renderToStaticMarkup(
      createElement(ContrastBadge, { report, t: tStub, surfaceLabel }),
    );
    expect(html).toContain('data-contrast-state="ok"');
  });
});

describe('detectBasePreset', () => {
  it('matches an unmodified built-in to its preset id', () => {
    for (const id of ['catppuccin-mocha', 'hinomaru', 'taegeuk', 'void'] as const) {
      expect(detectBasePreset(builtinToCustom(id))).toBe(id);
    }
  });

  it('still matches a copy saved before the preset\'s text was lifted for contrast', () => {
    // The old DEFAULT_CUSTOM_THEME was Catppuccin with muted #585B70.
    expect(detectBasePreset({ ...builtinToCustom('catppuccin-mocha'), textMuted: '#585B70' })).toBe('catppuccin-mocha');
    expect(detectBasePreset({ ...builtinToCustom('mono-light'), textSub: '#7E7E7E', textMuted: '#9C9C9C' })).toBe('mono-light');
    // Mixing an old value with a current one is a hand-tuned theme.
    expect(detectBasePreset({ ...builtinToCustom('mono-light'), textMuted: '#9C9C9C' })).toBeNull();
  });

  it('diffs an untouched legacy copy against the variant it matched, so no token reads as overridden', () => {
    const copy = { ...builtinToCustom('catppuccin-mocha'), textMuted: '#585B70' };
    const base = baseColorsFor(copy, 'catppuccin-mocha');
    expect(base.textMuted).toBe('#585B70');
    // Hand-tuned colours fall back to the chosen preset.
    expect(baseColorsFor({ ...copy, accent: '#123456' }, 'void')).toEqual(builtinToCustom('void'));
  });

  it('returns null for hand-tuned colors that match no built-in', () => {
    const tweaked = { ...builtinToCustom('catppuccin-mocha'), accent: '#123456' };
    expect(detectBasePreset(tweaked)).toBeNull();
  });
});
