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
// 7px one. What it CAN prove is the contract, and the contract is where the
// first cut of this work went wrong: a symmetric `-m-1.5` on every control made
// each box 12px wider than the space it reserved, so it reached over its
// neighbour and — the later sibling winning the pointer — the workspace row's
// destructive close button owned the right 4px of the copy button beside it.
//
// So the scan discovers adopters by grepping the whole renderer for the recipe
// names rather than reading a list someone has to remember to update, and then
// holds them to the rules in hitArea.ts:
//   1. no adopter re-introduces a sub-24 fixed size;
//   2. no adopter carries a vertical or negative-left margin of its own — that
//      belongs to the recipe, and a `mt-0.5` fighting a `-my-1.5` resolves on
//      whichever Tailwind emits last;
//   3. the clustered recipe is only used inside a cluster, whose gap is exactly
//      what the members' side refunds give back, so their boxes tile.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  HIT_TARGET_24,
  HIT_TARGET_24_ROW,
  HIT_TARGET_24_CLUSTER,
  HIT_TARGET_24_IN_CLUSTER,
  CLUSTER_SIDE_REFUND_PX,
  CLUSTER_GAP_PX,
} from '../hitArea';

const RENDERER = join(__dirname, '..', '..');
const COMPONENTS = join(__dirname, '..');

/** Every control the audit measured under 24px that this lane raised. */
const REQUIRED: { file: string; markers: string[] }[] = [
  { file: 'Pane/SurfaceTabs.tsx', markers: ['data-surface-tab-close'] },
  { file: 'Sidebar/Sidebar.tsx', markers: ['data-sidebar-collapse'] },
  {
    file: 'Sidebar/WorkspaceItem.tsx',
    markers: [
      'data-workspace-action="explorer"',
      'data-workspace-action="copy-info"',
      'data-workspace-action="close"',
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

/** Every .tsx under src/renderer — the adopter search space. */
function rendererSources(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.tsx')) out.push(p);
    }
  })(RENDERER);
  return out;
}

/** The opening `<...>` tag containing `at`, brace-aware so a `>` inside a
 *  `{…}` expression does not end it early. */
function tagAround(source: string, at: number, name: string): string {
  const open = source.lastIndexOf(`<${name}`, at);
  expect(open, `no <${name} before offset ${at}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unterminated <${name}> tag`);
}

function buttonTagFor(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
  return tagAround(source, at, 'button');
}

/** Every JSX tag in the renderer that adopts one of the 24px recipes. */
function adopterTags(): { file: string; recipe: string; tag: string }[] {
  const out: { file: string; recipe: string; tag: string }[] = [];
  for (const path of rendererSources()) {
    const source = readFileSync(path, 'utf8');
    for (const m of source.matchAll(/HIT_TARGET_24(?:_ROW|_CLUSTER|_IN_CLUSTER)?\b/g)) {
      const at = m.index ?? 0;
      // Skip the import statement and the module that defines them.
      if (path.endsWith('hitArea.ts')) continue;
      const lineStart = source.lastIndexOf('\n', at) + 1;
      if (/^\s*import\b/.test(source.slice(lineStart, at))) continue;
      const open = source.lastIndexOf('<', at);
      if (open === -1) continue;
      const nameMatch = /^<([A-Za-z][\w.]*)/.exec(source.slice(open));
      if (!nameMatch) continue;
      out.push({
        file: path.slice(RENDERER.length + 1),
        recipe: m[0],
        tag: tagAround(source, at, nameMatch[1]),
      });
    }
  }
  return out;
}

describe('chrome hit areas — the 24px pointer floor', () => {
  it('declares a 24px recipe on every control the audit measured under it', () => {
    const missing: string[] = [];
    for (const { file, markers } of REQUIRED) {
      const source = read(file);
      for (const marker of markers) {
        const tag = buttonTagFor(source, marker);
        if (!/HIT_TARGET_24\b|HIT_TARGET_24_(ROW|IN_CLUSTER)\b/.test(tag)) {
          missing.push(`${file} ${marker}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('never re-introduces a sub-24 fixed size on a scanned chrome button', () => {
    const offenders: string[] = [];
    for (const { file } of REQUIRED) {
      const source = read(file);
      for (const m of source.matchAll(/<button\b/g)) {
        const tag = tagAround(source, m.index ?? 0, 'button');
        if (SIZE_EXEMPT.test(tag)) continue;
        // `w-5 h-5` / `w-4 h-4` / `w-3 h-3` are 20 / 16 / 12px squares.
        if (/\bw-[1-5]\s+h-[1-5]\b/.test(tag)) offenders.push(`${file}: ${tag.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every recipe at a real 24px box', () => {
    for (const recipe of [
      HIT_TARGET_24,
      HIT_TARGET_24_ROW,
      HIT_TARGET_24_IN_CLUSTER,
    ]) {
      expect(recipe).toContain('min-w-[24px]');
      expect(recipe).toContain('min-h-[24px]');
    }
  });

  it('refunds width in exactly one recipe, and only against a matching gap', () => {
    // The whole point of the review round: a horizontal refund makes the box
    // wider than the space it reserves. Only the clustered member may do it,
    // and only because its cluster hands the width straight back.
    expect(HIT_TARGET_24).not.toMatch(/-m[xlr]?-/);
    expect(HIT_TARGET_24_ROW).not.toMatch(/-m[xlr]-/);
    expect(HIT_TARGET_24_ROW).toContain('-my-1.5');
    expect(HIT_TARGET_24_IN_CLUSTER).toContain('-mx-1.5');
    expect(HIT_TARGET_24_CLUSTER).toContain('gap-3');
    // gap-3 = 12px, -mx-1.5 = 6px a side. Two neighbours give back 12px between
    // them, so consecutive boxes meet edge to edge and never overlap.
    expect(CLUSTER_GAP_PX).toBe(CLUSTER_SIDE_REFUND_PX * 2);
    expect(HIT_TARGET_24_CLUSTER).toContain(`gap-${CLUSTER_GAP_PX / 4}`);
    expect(HIT_TARGET_24_IN_CLUSTER).toContain(`-mx-${CLUSTER_SIDE_REFUND_PX / 4}`);
  });

  it('centres the taller box on the text of an items-start row', () => {
    // A 24px box pinned to the top of an items-start row floats its glyph above
    // the caption line it belongs to. Both row recipes carry the alignment so a
    // call site cannot forget it (and cannot reach for `mt-*` to fake it).
    expect(HIT_TARGET_24_ROW).toContain('self-center');
    expect(HIT_TARGET_24_CLUSTER).toContain('self-center');
    expect(HIT_TARGET_24_CLUSTER).toContain('items-center');
  });

  it('lets no adopter anywhere in the renderer carry its own vertical or left margin', () => {
    // Discovered by grep, not by a list: an adopter added in another file next
    // month is held to the same rule.
    const tags = adopterTags();
    expect(tags.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const { file, recipe, tag } of tags) {
      // Strip the recipe references themselves — their margins are the recipe's.
      const own = tag.replace(/HIT_TARGET_24(?:_ROW|_CLUSTER|_IN_CLUSTER)?/g, '');
      // Banned: any vertical margin, any negative left margin, any all-sides or
      // horizontal shorthand. Allowed: `-mr-*` (the tab close refunds into its
      // own cell padding, where nothing interactive lives) and plain positive
      // side margins.
      const bad = own.match(/(?<![\w-])-?m(?:[tby]|[xy]|)-\d|(?<![\w-])-ml-\d|(?<![\w-])-mx-\d/g);
      if (bad) offenders.push(`${file} (${recipe}): ${bad.join(' ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('uses the clustered recipe only inside a cluster', () => {
    const orphans: string[] = [];
    for (const path of rendererSources()) {
      const source = readFileSync(path, 'utf8');
      if (!/HIT_TARGET_24_IN_CLUSTER/.test(source.replace(/^\s*import.*$/gm, ''))) continue;
      if (!source.includes('HIT_TARGET_24_CLUSTER')) {
        orphans.push(path.slice(RENDERER.length + 1));
      }
    }
    expect(orphans).toEqual([]);
  });
});
