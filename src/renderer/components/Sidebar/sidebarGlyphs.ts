/**
 * Direction glyphs for the sidebar hide/expand buttons.
 *
 * The arrows must follow the sidebar's physical position (issue #151): a
 * left-docked sidebar collapses toward the left edge and expands rightward into
 * the content area, while a right-docked sidebar is mirrored. Hard-coding the
 * glyphs left them pointing the wrong way once the sidebar moved to the right.
 *
 * Single-sourced here so both Sidebar (full) and MiniSidebar (collapsed) stay
 * consistent and the direction logic is unit-testable in the node test env.
 */
export type SidebarPosition = 'left' | 'right';

/**
 * Glyph for the "hide/collapse" button shown in the full sidebar. Points toward
 * the screen edge the sidebar is docked to — the direction it collapses into.
 */
export function collapseGlyph(position: SidebarPosition): string {
  return position === 'right' ? '▶' : '◀';
}

/**
 * Glyph for the "expand/show" button shown in the mini sidebar. Points inward
 * toward the content area — the direction the sidebar expands into.
 */
export function expandGlyph(position: SidebarPosition): string {
  return position === 'right' ? '◀' : '▶';
}
