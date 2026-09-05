/**
 * Badge geometry follows the type it contains.
 *
 * Snapping the renderer onto the DESIGN.md ramp raised two badges' text
 * (8 -> 10px, and a numeric fontSize 9 -> 10) inside boxes that were sized for
 * the old type. Neither has a component test that renders it, and both are
 * pure geometry, so they are pinned here as a source assertion: a 10px glyph
 * with `leading-none` needs a box taller than 12px, and a 10px glyph in a
 * fixed-height chip needs its line-box raised with it — otherwise the round
 * badge goes oval and the chip clips its own digits.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RENDERER = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(RENDERER, rel), 'utf8');

describe('badge geometry tracks the type ramp', () => {
  it('MiniSidebar unread badge box is taller than its 10px glyph', () => {
    const src = read('components/Sidebar/MiniSidebar.tsx');
    const badge = src
      .split('\n')
      .find((l) => l.includes('rounded-full') && l.includes('ring-[var(--border-soft)]'));
    expect(badge, 'unread badge className not found').toBeDefined();
    const line = badge as string;
    expect(line).toContain('text-[10px]');
    // h-3 (12px) / min-w-[12px] was sized for the old 8px glyph.
    expect(line).toContain('h-3.5');
    expect(line).toContain('min-w-[14px]');
    expect(line).not.toMatch(/\bh-3(?![.\d])/);
    expect(line).not.toContain('min-w-[12px]');
  });

  it('SettingsPanel contrast badge raises its box and line-box with the glyph', () => {
    const src = read('components/Settings/SettingsPanel.tsx');
    const style = /height: (\d+), fontSize: (\d+), lineHeight: '(\d+)px'/.exec(src);
    expect(style, 'contrast badge inline style not found').not.toBeNull();
    const [, height, fontSize, lineHeight] = (style as RegExpExecArray).map(Number);
    expect(fontSize).toBe(10);
    // The line box must clear the glyph, and the chip must clear the line box.
    expect(lineHeight).toBeGreaterThan(fontSize);
    expect(height).toBeGreaterThan(lineHeight);
  });
});
