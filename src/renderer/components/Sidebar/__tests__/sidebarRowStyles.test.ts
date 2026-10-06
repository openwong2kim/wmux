/**
 * Selection wins over needs you (sidebar critique, 2026-10-05): the needs fill
 * sits one step below the selection, a selected needs-you row keeps a visible
 * ring over the dash, hover still answers, nested task rows draw no box, and
 * keyboard focus is the app's ring. jsdom computes no styles, so the rules are
 * read from ui.css.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/ui.css'), 'utf8');
const rule = (selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} not found`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
};

describe('needs you vs selection', () => {
  // Owner decision 2026-10-07: a 1px solid attention hairline, not a dash.
  it('fills a needs-you row one step below the selection, with the hairline', () => {
    const needs = rule('.wmux-sidebar .sidebar-row.sidebar-row-needs');
    expect(needs).toContain('background: var(--selection-subtle)');
    expect(needs).toContain('border-style: solid');
    expect(needs).toContain('border-color: var(--attention-hairline, var(--attention))');
  });
  it('lifts a needs-you row on hover', () => {
    expect(rule('.wmux-sidebar .sidebar-row.sidebar-row-needs:hover')).toContain('background: var(--selection-hover)');
  });
  it('keeps the selection fill and adds an accent ring when the selected row needs you', () => {
    const selected = rule('.wmux-sidebar .sidebar-row-active.sidebar-row-needs:hover');
    expect(selected).toContain('background: var(--selection)');
    expect(selected).toContain('box-shadow: 0 0 0 1px var(--accent)');
  });
  it('draws no box on a nested task row that needs you', () => {
    const task = rule('.wmux-sidebar .sidebar-row-task.sidebar-row-needs:hover');
    expect(task).toContain('border-color: transparent');
    expect(task).toContain('background: transparent');
  });
  it('keeps the selection fill on an active nested task that needs you', () => {
    const rule2 = rule('.wmux-sidebar .sidebar-row-task.sidebar-row-active.sidebar-row-needs:hover');
    expect(rule2).toContain('background: var(--selection)');
    // It comes after (and is more specific than) the flat-task rule it overrides.
    expect(css.indexOf('.sidebar-row-task.sidebar-row-active.sidebar-row-needs'))
      .toBeGreaterThan(css.indexOf('.wmux-sidebar .sidebar-row-task.sidebar-row-needs:hover {'));
  });
  it('rings keyboard focus in the accent, inside the row', () => {
    expect(rule('.wmux-sidebar [data-sidebar-row]:focus-visible')).toContain('outline: 2px solid var(--accent)');
  });
});
