/**
 * Direction helpers for the sidebar hide/expand buttons.
 *
 * The arrows must follow the sidebar's physical position (issue #151): a
 * left-docked sidebar collapses toward the left edge and expands rightward into
 * the content area, while a right-docked sidebar is mirrored. Hard-coding the
 * directions left them pointing the wrong way once the sidebar moved to the
 * right.
 *
 * Single-sourced here so both Sidebar (full) and MiniSidebar (collapsed) stay
 * consistent and the direction logic is unit-testable in the node test env.
 */
export type SidebarPosition = 'left' | 'right';
export type ChevronDirection = 'left' | 'right';

/** Direction for the full sidebar's hide button — toward the docked edge. */
export function collapseDirection(position: SidebarPosition): ChevronDirection {
  return position;
}

/** Direction for the mini sidebar's expand button — inward, toward content. */
export function expandDirection(position: SidebarPosition): ChevronDirection {
  return position === 'right' ? 'left' : 'right';
}
