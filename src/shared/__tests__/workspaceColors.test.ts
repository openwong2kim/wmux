import { describe, it, expect } from 'vitest';
import {
  WORKSPACE_COLOR_IDS,
  WORKSPACE_COLOR_HEX,
  normalizeWorkspaceColor,
  workspaceColorHex,
} from '../workspaceColors';

describe('workspaceColors', () => {
  it('every id has a hex and every hex is a 6-digit color', () => {
    for (const id of WORKSPACE_COLOR_IDS) {
      expect(WORKSPACE_COLOR_HEX[id]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(Object.keys(WORKSPACE_COLOR_HEX)).toHaveLength(WORKSPACE_COLOR_IDS.length);
  });

  it('normalize accepts known ids', () => {
    for (const id of WORKSPACE_COLOR_IDS) {
      expect(normalizeWorkspaceColor(id)).toBe(id);
    }
  });

  it('normalize drops anything else instead of throwing', () => {
    // A hand-edited session.json, a value from a newer build, or a prototype
    // pollution attempt must all end as "no tag" — never as a rendered value.
    for (const bad of [undefined, null, '', 'chartreuse', '#ff0000', 42, {}, [], 'toString']) {
      expect(normalizeWorkspaceColor(bad)).toBeUndefined();
    }
  });

  it('workspaceColorHex maps id → hex and unknown → undefined', () => {
    expect(workspaceColorHex('blue')).toBe(WORKSPACE_COLOR_HEX.blue);
    expect(workspaceColorHex('nope')).toBeUndefined();
    expect(workspaceColorHex(undefined)).toBeUndefined();
  });

  // The whole point of a curated (not free-form) palette is that no two tags
  // read as "the same color" at a glance. Pin that as a real check rather than
  // an eyeballed comment, so a future addition that lands too close to an
  // existing hue fails CI instead of shipping a visually-duplicate tag.
  it('every color is at least 12° apart in hue from every other', () => {
    const hue = (hex: string): number => {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max === min) return 0;
      const d = max - min;
      let h: number;
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4; break;
      }
      return h * 60;
    };
    const hues = WORKSPACE_COLOR_IDS.map((id) => [id, hue(WORKSPACE_COLOR_HEX[id])] as const);
    for (let i = 0; i < hues.length; i += 1) {
      for (let j = i + 1; j < hues.length; j += 1) {
        const [idA, hA] = hues[i];
        const [idB, hB] = hues[j];
        const diff = Math.abs(hA - hB);
        const circularDiff = Math.min(diff, 360 - diff);
        expect(circularDiff, `${idA} (${hA.toFixed(0)}°) vs ${idB} (${hB.toFixed(0)}°)`).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it('every color clears a minimum WCAG contrast ratio against both theme extremes', () => {
    const relLum = (hex: string): number => {
      const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      const r = lin(parseInt(hex.slice(1, 3), 16) / 255);
      const g = lin(parseInt(hex.slice(3, 5), 16) / 255);
      const b = lin(parseInt(hex.slice(5, 7), 16) / 255);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string): number => {
      const [l1, l2] = [relLum(a), relLum(b)].sort((x, y) => y - x);
      return (l1 + 0.05) / (l2 + 0.05);
    };
    const darkest = '#11111b';
    const lightest = '#eff1f5';
    for (const id of WORKSPACE_COLOR_IDS) {
      const hex = WORKSPACE_COLOR_HEX[id];
      // The floor is set BELOW the existing minimums (yellow: 9.27/1.79) so
      // this pins "stays in the same band the original eight established",
      // not an aspirational bar the original set itself would fail.
      expect(contrast(hex, darkest), `${id} vs dark`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex, lightest), `${id} vs light`).toBeGreaterThanOrEqual(1.7);
    }
  });
});
