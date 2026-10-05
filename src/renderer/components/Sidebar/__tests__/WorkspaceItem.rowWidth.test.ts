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

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const itemSource = read('src/renderer/components/Sidebar/WorkspaceItem.tsx');
const rosterSource = read('src/renderer/components/Sidebar/WorkspaceAgentRoster.tsx');
const taskGroupSource = read('src/renderer/components/Sidebar/SidebarTaskGroup.tsx');
const sidebarSource = read('src/renderer/components/Sidebar/Sidebar.tsx');
const uiCss = read('src/renderer/styles/ui.css');

/** Tailwind spacing: one unit = 4px. */
const tw = (units: string) => Number(units) * 4;
function match(re: RegExp, source: string): RegExpExecArray {
  const m = re.exec(source);
  expect(m, `${re} not found`).not.toBeNull();
  return m as RegExpExecArray;
}

function clusterRegion(): string {
  const start = itemSource.indexOf('data-workspace-actions');
  expect(start, 'hover action cluster not found').toBeGreaterThan(0);
  return itemSource.slice(start, itemSource.indexOf('</div>', start));
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
  const pad = match(/clusterSlot: 'group-hover:max-w-none [^']*group-hover:pl-(\d+(?:\.\d+)?)/, itemSource)[1];
  return clusterWidth() + tw(pad) + lineGapPx;
}

const nameLineGap = () => tw(match(/<div className="flex items-center gap-(\d+)">\s*\{\/\* The name truncates/, itemSource)[1]);
const gitLineGap = () => tw(match(/<div className="flex items-center gap-(\d+) mt-1 [^"]*" data-git-signal-line>/, itemSource)[1]);
/** Branch icon (12px) and its `mr-1`: what a git line shows even fully truncated. */
const BRANCH_ICON = 12 + 4;
/** The fan-out provenance glyph on a task row's name line, and the line's gap. */
const PROVENANCE_GLYPH = 10 + 4;

/** Card margin (both sides) and padding + border (both sides). */
function cardInset(): { margin: number; inner: number } {
  const margin = 2 * tw(match(/className="relative mx-(\d+) sidebar-row-enter"/, itemSource)[1]);
  const padX = Number(match(/\.wmux-sidebar \.sidebar-row \{ border-radius: 10px; padding: \d+px (\d+)px; \}/, uiCss)[1]);
  const border = Number(match(/\.wmux-sidebar \.sidebar-row \{\s*border: (\d+)px solid transparent;/, uiCss)[1]);
  return { margin, inner: 2 * padX + 2 * border };
}

/** Status box, roster chip and the line's gaps beside the text column. */
function lineChrome(): number {
  const lineGap = tw(match(/hover\.group\} -mx-2\.5 -my-2 flex min-w-0 items-start gap-(\d+)/, itemSource)[1]);
  const statusBox = 10; // StatusMarkView: one 10px box for every mark
  const rosterChip = 24; // HIT_TARGET_24_ROW pays its 24px width in full
  return statusBox + lineGap + rosterChip + lineGap;
}

/** Text column of a top-level row in a sidebar `width` wide. */
function topText(width: number): number {
  const { margin, inner } = cardInset();
  return width - margin - inner - lineChrome();
}

/**
 * Text column of a task row nested under its owner's pane row: the owner's
 * card, the roster's `pl-3`, the task list's `ml-[9px]` and 1px guide line
 * less its `-mr-2`, and the task row's own `ml-1` (its `mx-2` is overridden).
 */
function nestedText(width: number): number {
  const { margin, inner } = cardInset();
  const rosterPad = tw(match(/<div className="pl-(\d+)" data-roster-list>/, rosterSource)[1]);
  const [, mr, ml, rowMl] = match(
    /className="-mr-(\d+) ml-\[(\d+)px\] mt-0\.5 space-y-0\.5 border-l [^"]*\[&>div>div\]:ml-(\d+) \[&>div>div\]:mr-0"/,
    taskGroupSource,
  );
  const row = width - margin - inner - rosterPad - Number(ml) - 1 + tw(mr) - tw(rowMl);
  return row - inner - lineChrome();
}

describe('the hover actions take their own width and nothing else', () => {
  it('sit in flow — git line, name line, or a line of their own — never floated', () => {
    // A row with a branch: the actions end the git line, and the diff counts
    // and the PR badge step aside while they show, so the name never shrinks.
    expect(itemSource).toContain('const actionsOnGitLine = !!metadata?.gitBranch;');
    expect(itemSource).toContain("actions={actionsOnGitLine ? actionCluster('-ml-2') : null}");
    expect(itemSource).toMatch(/actions\s*\? <span className=\{`flex flex-shrink-0 \$\{metaHiddenOnHover \?\? ''\}`\}><GitSyncBadge/);
    expect(itemSource).toMatch(/actions\s*\? <span className=\{`flex flex-shrink-0 \$\{metaHiddenOnHover \?\? ''\}`\}><PrBadge/);
    // A branchless nested task row: a line of its own. Top-level: the name line.
    expect(itemSource).toContain('const actionsOnOwnLine = !actionsOnGitLine && taskRow;');
    expect(itemSource).toMatch(/\{actionsOnOwnLine && \(\s*<div className="[^"]*" data-row-actions-line>\s*\{actionCluster\(''\)\}/);
    expect(itemSource).toContain("{!actionsOnGitLine && !actionsOnOwnLine && actionCluster('-ml-1')}");
    // The overlay and the fade that hid the text under it are gone.
    expect(uiCss).not.toMatch(/\[data-workspace-actions\]\s*\{[^}]*position:\s*absolute/);
    expect(uiCss).not.toMatch(/\[data-workspace-text\]\s*\{[^}]*mask-image/);
  });

  it('the derived widths match the running app', () => {
    // Measured live at 264px: cluster 60px, name-line slot 66px, git-line
    // slot 62px + its 8px gap, top-level text 176px, nested text 136px.
    expect(clusterWidth()).toBe(60);
    expect(slotWidth(nameLineGap())).toBe(66);
    expect(slotWidth(gitLineGap())).toBe(70);
    expect(topText(SIDEBAR_DEFAULT_WIDTH)).toBe(176);
    expect(nestedText(SIDEBAR_DEFAULT_WIDTH)).toBe(136);
  });

  it.each([
    ['default', SIDEBAR_DEFAULT_WIDTH],
    ['minimum', SIDEBAR_MIN_WIDTH],
  ])('at the %s width every row keeps a readable name with its actions shown', (_label, width) => {
    const top = topText(width);
    const nested = nestedText(width);
    // Rows with a branch (and a diff, and a PR): once the diff counts and the
    // PR badge step aside, the revealed slot fits beside the branch icon, and
    // the name keeps the whole column — top-level and nested alike.
    expect(slotWidth(gitLineGap()) + BRANCH_ICON).toBeLessThanOrEqual(top);
    expect(slotWidth(gitLineGap()) + BRANCH_ICON).toBeLessThanOrEqual(nested);
    expect(nested - PROVENANCE_GLYPH).toBeGreaterThanOrEqual(width === SIDEBAR_DEFAULT_WIDTH ? 122 : 78);
    // Branchless top-level row: the name gives up exactly the slot —
    // ~8 characters of 13px text at the minimum, ~13 at the default.
    expect(top - slotWidth(nameLineGap())).toBeGreaterThanOrEqual(width === SIDEBAR_DEFAULT_WIDTH ? 110 : 64);
    // Branchless nested row: the actions' own line has room for them, and
    // its name line is untouched.
    expect(slotWidth(0)).toBeLessThanOrEqual(nested);
  });

  it('the keyboard reveals the same layout the pointer does', () => {
    // Focus anywhere on the row line reveals the cluster and hides the same
    // metadata — not just the cluster's own focus-within, which left the diff
    // counts in place and overflowed the git line.
    const recipes = itemSource.slice(itemSource.indexOf('function hoverRecipes'), itemSource.indexOf('function shortenPath'));
    for (const g of ['group-focus-within/task', 'group-focus-within']) {
      expect(recipes).toContain(`${g}:hidden`);
      expect(recipes).toContain(`${g}:opacity-100`);
      expect(recipes).toContain(`${g}:max-w-none`);
      expect(recipes).toContain(`${g}:ml-auto`);
    }
    expect(itemSource).toContain('metaHiddenOnHover={hover.hideOnHover}');
  });

  it('a nested task row never reveals its owner\'s actions, and the whole card reveals its own', () => {
    // `:hover` reaches every ancestor; the hover group sits on the row's own
    // line, which does not contain the expanded roster and its task rows, and
    // stretches over the card's padding so the reveal matches the hover fill.
    expect(itemSource).toContain('<div className={`${hover.group} -mx-2.5 -my-2 flex min-w-0 items-start gap-2 px-2.5 py-2`}>');
    expect(uiCss).toMatch(/\.wmux-sidebar \.sidebar-row \{ border-radius: 10px; padding: 8px 10px; \}/);
    expect(itemSource).not.toMatch(/className=\{`\$\{hover\.group\} sidebar-row/);
  });

  it('the list never scrolls sideways', () => {
    expect(sidebarSource).toContain('overflow-y-auto overflow-x-hidden');
  });
});
