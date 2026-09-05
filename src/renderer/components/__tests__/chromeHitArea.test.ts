// Chrome pointer targets — the 24px floor (WCAG 2.2 SC 2.5.8).
//
// A 2026-09 audit of the packaged app at 1280x800 found 66 interactive elements
// under 24px in one dimension. The ones this lane owns live in four surfaces:
// the pane tab strip, the workspace sidebar, the titlebar status strip, and the
// deck toggle.
//
// This is a SOURCE scan, not a layout measurement, and deliberately so: the
// renderer tests run under jsdom, which resolves no stylesheet and reports
// every getBoundingClientRect() as 0x0 — it cannot tell a 24px button from a
// 7px one. What it CAN prove is the contract: every control the audit flagged
// declares the shared hit-area recipe, and no chrome button re-introduces a
// sub-24 fixed size. When the recipe changes, it changes in one file.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HIT_TARGET_24, HIT_TARGET_24_TIGHT } from '../hitArea';

const COMPONENTS = join(__dirname, '..');

/** Every control the audit measured under 24px that this lane owns. */
const REQUIRED: { file: string; markers: string[] }[] = [
  { file: 'Pane/SurfaceTabs.tsx', markers: ['data-surface-tab-close'] },
  { file: 'Sidebar/Sidebar.tsx', markers: ['data-sidebar-collapse'] },
  {
    file: 'Sidebar/WorkspaceItem.tsx',
    markers: [
      'data-workspace-action="explorer"',
      'data-workspace-action="copy-info"',
      'data-workspace-action="close"',
      'data-workspace-action="project-badge"',
    ],
  },
  { file: 'Sidebar/WorkspaceAgentRoster.tsx', markers: ['data-workspace-agent-roster'] },
  { file: 'Deck/DeckToggle.tsx', markers: ['data-deck-toggle'] },
  { file: 'StatusBar/StatusBar.tsx', markers: ['data-statusbar-settings'] },
];

/**
 * Deliberately exempt from the size floor: the workspace colour-tag swatches.
 * There the swatch IS the target — at the grid's 20px pitch a 24px box would
 * overlap its neighbours, so the pointer would land on a colour the user can
 * see it is not over. They live in a context-menu popover (not the chrome rows
 * the audit measured) inside a 164px grid whose width is a documented
 * constraint, and WCAG 2.2 SC 2.5.8's spacing allowance is what they trade on.
 */
const SIZE_EXEMPT = /workspaceColorLabelKey|workspace\.colorNone/;

const read = (file: string): string => readFileSync(join(COMPONENTS, file), 'utf8');

/**
 * The opening `<button …>` tag that carries `marker`. Walks forward from the
 * nearest `<button` before the marker to the first top-level `>` so a `>` inside
 * a `{…}` expression (an arrow function, a comparison) does not end the tag
 * early.
 */
function buttonTagFor(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const open = source.lastIndexOf('<button', at);
  expect(open, `no <button before ${marker}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unterminated <button> tag for ${marker}`);
}

describe('chrome hit areas — the 24px pointer floor', () => {
  it('declares a 24px recipe on every control the audit measured under it', () => {
    const missing: string[] = [];
    for (const { file, markers } of REQUIRED) {
      const source = read(file);
      for (const marker of markers) {
        const tag = buttonTagFor(source, marker);
        if (!/HIT_TARGET_24(_TIGHT)?\b/.test(tag)) missing.push(`${file} ${marker}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('never re-introduces a sub-24 fixed size on a scanned chrome button', () => {
    const offenders: string[] = [];
    for (const { file } of REQUIRED) {
      const source = read(file);
      for (const m of source.matchAll(/<button\b/g)) {
        let depth = 0;
        let tag = '';
        const start = m.index ?? 0;
        for (let i = start; i < source.length; i++) {
          const c = source[i];
          if (c === '{') depth++;
          else if (c === '}') depth--;
          if (c === '>' && depth === 0) {
            tag = source.slice(start, i + 1);
            break;
          }
        }
        // `w-5 h-5` / `w-4 h-4` / `w-3 h-3` are 20 / 16 / 12px squares.
        if (SIZE_EXEMPT.test(tag)) continue;
        if (/\bw-[1-5]\s+h-[1-5]\b/.test(tag)) offenders.push(`${file}: ${tag.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps both recipes at a real 24px box', () => {
    for (const recipe of [HIT_TARGET_24, HIT_TARGET_24_TIGHT]) {
      expect(recipe).toContain('min-w-[24px]');
      expect(recipe).toContain('min-h-[24px]');
    }
    // The tight variant refunds the growth so a dense row keeps its footprint.
    expect(HIT_TARGET_24_TIGHT).toContain('-m-1.5');
    expect(HIT_TARGET_24).not.toContain('-m-1.5');
  });

  it('leaves no margin utility on a tight control that would fight the -m', () => {
    // `-m-1.5` and `mt-0.5` have the same specificity: whichever Tailwind emits
    // last wins, which is not something a call site should be betting on.
    const clashes: string[] = [];
    for (const { file, markers } of REQUIRED) {
      const source = read(file);
      for (const marker of markers) {
        const tag = buttonTagFor(source, marker);
        if (!tag.includes('HIT_TARGET_24_TIGHT')) continue;
        if (/\s-?m[trblxy]?-[0-9]/.test(tag.replace('-m-1.5', ''))) {
          clashes.push(`${file} ${marker}`);
        }
      }
    }
    expect(clashes).toEqual([]);
  });
});
