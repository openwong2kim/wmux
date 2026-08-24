/**
 * Stashed rows are gathered under a divider and marked with an eye (#977,
 * owner directive after live dogfood).
 *
 * What went wrong in the real app: with six of seven panes stashed the roster
 * looked untouched — same seven rows, same red "Waiting" labels. An 8px archive
 * glyph and a "just now" trailer are not enough signal to carry "these are not
 * on your screen"; a rule with a count is. And the marker had to change anyway:
 * this app already spends the archive glyph on channel archive, which means a
 * one-way DEACTIVATION — the opposite of a stashed pane's "still running".
 *
 * A source-scan guard in the house style: the store-connected roster has no
 * render fixture here, and the hover/focus icon swap is CSS-only by design (so
 * pointer and keyboard behave identically), which no jsdom assertion can read.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SIDEBAR = resolve(process.cwd(), 'src/renderer/components/Sidebar');
const roster = readFileSync(resolve(SIDEBAR, 'WorkspaceAgentRoster.tsx'), 'utf8');
const icons = readFileSync(
  resolve(process.cwd(), 'src/renderer/components/icons.tsx'),
  'utf8',
);
const surfaceTabs = readFileSync(
  resolve(process.cwd(), 'src/renderer/components/Pane/SurfaceTabs.tsx'),
  'utf8',
);

/** The divider's own JSX, bounded at the end of its conditional so the row
 *  markup that follows cannot leak into the assertions. */
function dividerBlock(): string {
  const start = roster.indexOf('{startsStashedGroup && (');
  expect(start, 'divider conditional not found').toBeGreaterThanOrEqual(0);
  const end = roster.indexOf(')}', roster.indexOf('</span>', start));
  expect(end, 'divider conditional never closes').toBeGreaterThan(start);
  return roster.slice(start, end);
}

describe('roster — stashed group divider', () => {
  it('renders the divider once, before the FIRST stashed row', () => {
    // Computed from the previous row rather than an index compare, so it stays
    // correct if the selector ever interleaves.
    expect(roster).toMatch(
      /const startsStashedGroup = !!row\.stashed && !roster\.rows\[index - 1\]\?\.stashed;/,
    );
    expect(roster).toMatch(/\{startsStashedGroup && \(/);
  });

  it('carries the count, so the group says how much is hidden', () => {
    expect(dividerBlock()).toContain("t('roster.stashedCount', { count: roster.stashedCount })");
  });

  it('is a hairline + muted mono label, not a second disclosure', () => {
    const block = dividerBlock();
    expect(block).toMatch(/border-t border-\[var\(--border-soft\)\]/);
    expect(block).toMatch(/text-\[var\(--text-muted\)\]/);
    // One collapsible per workspace: a second one would make the user open two
    // things to see what they just stashed.
    expect(block).not.toContain('aria-expanded');
    expect(block).not.toContain('<button');
  });

  it('is hidden from assistive tech — the rows below it are already listed', () => {
    expect(dividerBlock()).toContain('aria-hidden="true"');
  });
});

describe('roster — eye marker', () => {
  it('marks stashed rows with eye-off, swapping to eye on hover AND focus', () => {
    expect(roster).toContain('<IconEyeOff size={9} />');
    expect(roster).toContain('<IconEye size={9} />');
    // Both, so a keyboard user gets the verb a pointer user gets.
    expect(roster).toMatch(/group-hover\/roster-row:hidden/);
    expect(roster).toMatch(/group-focus-visible\/roster-row:hidden/);
    expect(roster).toMatch(/group-hover\/roster-row:block/);
    expect(roster).toMatch(/group-focus-visible\/roster-row:block/);
    expect(roster).toMatch(/group\/roster-row/);
  });

  it('swaps the ICON only — the status label never moves', () => {
    // The distinction the earlier review turned on: hiding the STATUS on hover
    // takes away the row's proof of life exactly when the user is looking at it.
    // The icon slot carries no such information.
    const labelAt = roster.indexOf('{statusLabel}');
    expect(labelAt).toBeGreaterThan(0);
    // Just the element that renders it — its className and nothing else.
    const statusSpan = roster.slice(roster.lastIndexOf('<span', labelAt), labelAt);
    expect(statusSpan).not.toMatch(/group-hover/);
    expect(statusSpan).not.toMatch(/hidden/);
  });

  it('no longer uses the archive glyph anywhere in the stash UI', () => {
    // IconArchive means channel archive: read-only, one-way, deactivated. A
    // stashed pane is the opposite, and both appear in this sidebar.
    expect(roster).not.toContain('IconArchive');
    expect(surfaceTabs).not.toContain('IconArchive');
  });

  it('gives the pane header the same eye-off, so the pair means one thing', () => {
    expect(surfaceTabs).toContain('<IconEyeOff size={14} />');
  });
});

describe('icons — the eye pair exists at the shared stroke style', () => {
  it.each(['IconEye', 'IconEyeOff'])('%s is defined and uses the Icon wrapper', (name) => {
    const start = icons.indexOf(`export function ${name}(`);
    expect(start, `${name} not defined`).toBeGreaterThanOrEqual(0);
    const body = icons.slice(start, icons.indexOf('export function', start + 10));
    expect(body).toMatch(/<Icon size=\{size\}>/);
    expect(body).toMatch(/size = 14/);
  });

  it('gives eye-off a slash, or the two are indistinguishable at 9px', () => {
    const start = icons.indexOf('export function IconEyeOff(');
    const body = icons.slice(start, icons.indexOf('export function', start + 10));
    expect(body).toMatch(/<line /);
  });
});
