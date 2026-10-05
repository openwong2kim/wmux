/**
 * A workspace row keeps its text when its hover actions show.
 *
 * The new look (#1733) floated the three hover actions over the row's right
 * edge and faded the text column under them. The overlay covered the roster
 * chip, the fade took the git line with it, and because the fade rule was a
 * descendant selector, hovering an owner card faded every nested task row's
 * text as well — the sidebar read as "fleet: ba", "wtas…", "moa: fi".
 *
 * jsdom does no layout, so — in the house style of paneClusterWidth.test.ts —
 * the geometry is derived from the classes the markup actually carries, and
 * the arithmetic has to move with the JSX.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLUSTER_GAP_PX, CLUSTER_SIDE_REFUND_PX } from '../../hitArea';
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH } from '../../../utils/sidebarLayout';

const itemSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/components/Sidebar/WorkspaceItem.tsx'),
  'utf8',
);
const uiCss = readFileSync(resolve(process.cwd(), 'src/renderer/styles/ui.css'), 'utf8');
const sidebarSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/components/Sidebar/Sidebar.tsx'),
  'utf8',
);

/** Tailwind spacing: one unit = 4px. */
const tw = (units: string) => Number(units) * 4;

function clusterRegion(): string {
  const start = itemSource.indexOf('data-workspace-actions');
  expect(start, 'hover action cluster not found').toBeGreaterThan(0);
  const end = itemSource.indexOf('</div>', start);
  return itemSource.slice(start, end);
}

/** The revealed cluster's own width, from its markup. */
function clusterWidth(): number {
  const buttons = (clusterRegion().match(/data-workspace-action="/g) ?? []).length;
  expect(buttons).toBe(3);
  // N x 24px boxes and (N-1) gaps, less both side refunds of every member.
  return buttons * 24 + (buttons - 1) * CLUSTER_GAP_PX - buttons * 2 * CLUSTER_SIDE_REFUND_PX;
}

/** What the revealed slot takes out of a line: cluster + `pl-0.5` + the line's gap. */
function slotWidth(lineGapPx: number): number {
  const slotPad = /hover\.clusterSlot\}[^`]*focus-within:pl-(\d+(?:\.\d+)?)/.exec(itemSource)?.[1] ?? 'NaN';
  return clusterWidth() + tw(slotPad) + lineGapPx;
}

const nameLineGap = () => tw(/<div className="flex items-center gap-(\d+)">\s*\{\/\* The name truncates/.exec(itemSource)?.[1] ?? 'NaN');
const gitLineGap = () => tw(/<div className="flex items-center gap-(\d+) mt-1 [^"]*" data-git-signal-line>/.exec(itemSource)?.[1] ?? 'NaN');

/** Fixed width beside the text column of a top-level row. */
function rowChromeWidth(): number {
  const rowMargin = 2 * tw(/className="relative mx-(\d+) sidebar-row-enter"/.exec(itemSource)?.[1] ?? 'NaN');
  const padX = Number(/\.wmux-sidebar \.sidebar-row \{ border-radius: 10px; padding: \d+px (\d+)px; \}/.exec(uiCss)?.[1] ?? NaN);
  const border = Number(/\.wmux-sidebar \.sidebar-row \{\s*border: (\d+)px solid transparent;/.exec(uiCss)?.[1] ?? NaN);
  const lineGap = tw(/hover\.group\} flex min-w-0 items-start gap-(\d+)/.exec(itemSource)?.[1] ?? 'NaN');
  const statusBox = 10; // StatusMarkView: one 10px box for every mark
  const rosterChip = 24; // HIT_TARGET_24_ROW pays its 24px width in full
  return rowMargin + 2 * padX + 2 * border + statusBox + lineGap + rosterChip + lineGap;
}

describe('the hover actions take their own width and nothing else', () => {
  it('sit in flow — on the git line when there is one, else on the name line — never floated', () => {
    // A row with a branch: the actions end the git line and the diff counts
    // step aside for them while hovered, so the name never shrinks.
    expect(itemSource).toContain("const actionsOnGitLine = !!metadata?.gitBranch;");
    expect(itemSource).toContain("actions={actionsOnGitLine ? actionCluster('-ml-2') : null}");
    expect(itemSource).toMatch(/actions\s*\? <span className=\{`flex flex-shrink-0 \$\{metaHiddenOnHover \?\? ''\}`\}><GitSyncBadge/);
    // A row without one: the end of the name line.
    const nameLineSlot = itemSource.indexOf("{!actionsOnGitLine && actionCluster('-ml-1')}");
    expect(nameLineSlot).toBeGreaterThan(itemSource.indexOf('wmux-row-title'));
    // The overlay and the fade that hid the text under it are gone.
    expect(uiCss).not.toMatch(/\[data-workspace-actions\]\s*\{[^}]*position:\s*absolute/);
    expect(uiCss).not.toMatch(/\[data-workspace-text\]\s*\{[^}]*mask-image/);
  });

  it('the derived slot widths match the running app', () => {
    // Measured live at 264px: cluster 60px, name-line slot 66px.
    expect(clusterWidth()).toBe(60);
    expect(slotWidth(nameLineGap())).toBe(66);
    expect(slotWidth(gitLineGap())).toBe(70);
  });

  it.each([
    ['default', SIDEBAR_DEFAULT_WIDTH],
    ['minimum', SIDEBAR_MIN_WIDTH],
  ])('at the %s width a hovered row does not overflow and keeps a readable name', (_label, width) => {
    const text = width - rowChromeWidth();
    expect(text).toBe(width === SIDEBAR_DEFAULT_WIDTH ? 176 : 132);
    // Row with a git line: the name keeps the whole text column on hover, and
    // the revealed slot still fits beside the branch icon (12px + 4px).
    expect(slotWidth(gitLineGap()) + 16).toBeLessThan(text);
    // Row without one: the name gives up exactly the slot and nothing else —
    // ~8 characters of 13px text at the minimum, ~13 at the default.
    const name = text - slotWidth(nameLineGap());
    expect(name).toBeGreaterThanOrEqual(width === SIDEBAR_DEFAULT_WIDTH ? 110 : 64);
    // Content box never wider than the row.
    expect(rowChromeWidth() + slotWidth(nameLineGap())).toBeLessThan(width);
  });

  it('a nested task row never reveals its owner\'s actions', () => {
    // `:hover` reaches every ancestor; the hover group sits on the row's own
    // line, which does not contain the expanded roster and its task rows.
    expect(itemSource).toContain('<div className={`${hover.group} flex min-w-0 items-start gap-2`}>');
    expect(itemSource).not.toMatch(/className=\{`\$\{hover\.group\} sidebar-row/);
  });

  it('the list never scrolls sideways', () => {
    expect(sidebarSource).toContain('overflow-y-auto overflow-x-hidden');
  });
});
