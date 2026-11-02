// Accessibility-first observation: when an agent names no mode, getAppState
// reads the tree alone and adds a screenshot only when the tree is too thin to
// act on (canvas apps, games, web content that exposes nothing). Both helpers
// render the same tree text (docs/computer-use-design.md, Observation), so the
// decision is made here, once, for both OSes.

import type { AppState } from '../../shared/computer/protocol';

/**
 * Fewer named controls than this, outside the window's own chrome (menu bar,
 * title bar, and on macOS the window buttons), and the tree is thin.
 */
export const THIN_TREE_MIN_CONTROLS = 5;

/**
 * Humanised roles an agent can act on, from both helpers' interactive sets
 * (native/computer-use-windows Tree.cs, native/computer-use-macos Tree.swift).
 */
const CONTROL_ROLES: ReadonlySet<string> = new Set([
  // Shared
  'button', 'check box', 'radio button', 'combo box', 'slider', 'menu item',
  // Windows (UIA)
  'edit', 'hyperlink', 'list item', 'spinner', 'split button', 'tab item', 'tree item', 'data item',
  'document', 'header item', 'calendar',
  // macOS (AX roles and the subroles that rename them)
  'text field', 'text area', 'search field', 'secure text field', 'pop up button', 'menu button',
  'link', 'disclosure triangle', 'incrementor', 'color well', 'segmented control', 'row', 'cell',
  'date field', 'time field', 'stepper', 'switch', 'toggle button', 'tab',
]);

/** App chrome present whatever the window shows: their subtrees are not counted. */
const CHROME_ROLES: ReadonlySet<string> = new Set(['menu bar', 'title bar']);

/**
 * Longest first, so `menu bar item` is not read as `menu bar`, `pop up button`
 * not as `button` and macOS's `tab group` container not as a named `tab`.
 */
const KNOWN_ROLES = [...CONTROL_ROLES, ...CHROME_ROLES, 'menu bar item', 'tab group'].sort((a, b) => b.length - a.length);

const ELEMENT_LINE = /^(\t*)\d+ (.*)$/;

/**
 * Named controls in a rendered tree, skipping the menu bar and title bar. A
 * control is named when its line carries a name or a value after the role; a
 * bare `button` or `button, State: disabled` tells the agent nothing.
 *
 * `skipWindowButtons`: macOS has no title bar element, so the close, minimise,
 * zoom and full-screen buttons sit right under the window, named in the
 * system language. Buttons that are direct children of the window are not
 * counted there; Windows already drops them with the title bar.
 */
export function countNamedControls(tree: string, opts: { skipWindowButtons?: boolean } = {}): number {
  let count = 0;
  let chromeDepth = -1;
  for (const line of tree.split('\n')) {
    const match = ELEMENT_LINE.exec(line);
    if (!match) continue;
    const depth = match[1].length;
    if (chromeDepth >= 0) {
      if (depth > chromeDepth) continue;
      chromeDepth = -1;
    }
    const rest = match[2];
    const role = KNOWN_ROLES.find((r) => rest === r || rest.startsWith(`${r} `) || rest.startsWith(`${r},`));
    if (!role) continue;
    if (CHROME_ROLES.has(role)) {
      chromeDepth = depth;
      continue;
    }
    if (!CONTROL_ROLES.has(role)) continue;
    if (opts.skipWindowButtons && role === 'button' && depth === 1) continue;
    const after = rest.slice(role.length);
    if (after.startsWith(' ') && after.trim().length > 0) count++;
    else if (after.startsWith(', Value:')) count++;
  }
  return count;
}

/**
 * Why a default observation should add a screenshot, or undefined when the
 * tree is enough. A walk cut short by the node, depth or time cap is never
 * called thin: its count says nothing about the window, and walking it again
 * for the screenshot would double the time it already ran out of.
 */
export function thinTreeReason(state: AppState, opts: { skipWindowButtons?: boolean } = {}): string | undefined {
  if (state.truncated) return undefined;
  const controls = state.tree ? countNamedControls(state.tree, opts) : 0;
  if (controls >= THIN_TREE_MIN_CONTROLS) return undefined;
  return `the accessibility tree has only ${controls} named control${controls === 1 ? '' : 's'}`;
}
