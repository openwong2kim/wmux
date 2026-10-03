// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cssColorToHex, overlayColors } from '../titlebarOverlay';

describe('cssColorToHex', () => {
  it('reads the forms getComputedStyle returns', () => {
    expect(cssColorToHex('#121015')).toBe('#121015');
    expect(cssColorToHex('#ABC')).toBe('#aabbcc');
    expect(cssColorToHex('rgb(18, 16, 21)')).toBe('#121015');
    // A frame colour defined with color-mix computes to color(srgb …).
    expect(cssColorToHex('color(srgb 0.0705882 0.0627451 0.0823529)')).toBe('#121015');
  });

  it('gives nothing for a transparent or unknown paint', () => {
    expect(cssColorToHex('rgba(0, 0, 0, 0)')).toBeNull();
    expect(cssColorToHex('color(srgb 0 0 0 / 0)')).toBeNull();
    expect(cssColorToHex('var(--x)')).toBeNull();
    expect(cssColorToHex('')).toBeNull();
  });

  it('gives nothing for a translucent paint, so callers fall back', () => {
    expect(cssColorToHex('rgba(18, 16, 21, 0.85)')).toBeNull();
    expect(cssColorToHex('rgb(18 16 21 / 50%)')).toBeNull();
    expect(cssColorToHex('color(srgb 0.07 0.06 0.08 / 0.85)')).toBeNull();
    expect(cssColorToHex('#121015d9')).toBeNull();
    expect(cssColorToHex('#1218')).toBeNull();
  });

  it('reads a fully opaque paint that spells its alpha out', () => {
    expect(cssColorToHex('rgba(18, 16, 21, 1)')).toBe('#121015');
    expect(cssColorToHex('rgb(18 16 21 / 100%)')).toBe('#121015');
    expect(cssColorToHex('color(srgb 0.0705882 0.0627451 0.0823529 / 1)')).toBe('#121015');
    expect(cssColorToHex('#121015FF')).toBe('#121015');
    expect(cssColorToHex('#abcf')).toBe('#aabbcc');
  });
});

describe('overlayColors', () => {
  type Styles = { frameBg?: string; bgBase?: string; textSub?: string };

  /** Drive getComputedStyle per element: jsdom does not compute custom properties. */
  function stubStyles({ frameBg = '', bgBase = '', textSub = '' }: Styles, withFrame: boolean): void {
    document.body.innerHTML = withFrame ? '<div class="wmux-app-root"></div>' : '';
    vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((el: Element) => {
      const isRoot = el === document.documentElement;
      return {
        backgroundColor: isRoot ? '' : frameBg,
        getPropertyValue: (name: string) => {
          if (!isRoot) return '';
          if (name === '--bg-base') return bgBase;
          if (name === '--text-sub') return textSub;
          return '';
        },
      } as unknown as CSSStyleDeclaration;
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('takes the colour the frame paints', () => {
    stubStyles({ frameBg: 'rgb(18, 16, 21)', bgBase: '#1A171D', textSub: '#C2BDC9' }, true);
    expect(overlayColors()).toEqual({ color: '#121015', symbolColor: '#c2bdc9' });
  });

  it('falls back to --bg-base when there is no frame', () => {
    stubStyles({ bgBase: ' #1A171D', textSub: '#C2BDC9' }, false);
    expect(overlayColors()).toEqual({ color: '#1a171d', symbolColor: '#c2bdc9' });
  });

  it('falls back to --bg-base when the frame paints a translucent colour (window glass)', () => {
    stubStyles({ frameBg: 'color(srgb 0.07 0.06 0.08 / 0.85)', bgBase: '#1A171D', textSub: '#C2BDC9' }, true);
    expect(overlayColors()).toEqual({ color: '#1a171d', symbolColor: '#c2bdc9' });
  });

  it('gives nothing when the symbol colour is unreadable', () => {
    stubStyles({ frameBg: 'rgb(18, 16, 21)', bgBase: '#1A171D', textSub: 'var(--missing)' }, true);
    expect(overlayColors()).toBeNull();
  });
});
