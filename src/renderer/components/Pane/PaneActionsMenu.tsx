// ─── Pane actions, as a vertical menu ────────────────────────────────────────
//
// What the header's five-button cluster becomes when the pane is too narrow to
// hold it (and what right-clicking the header opens at any width). The cluster
// is fixed-width and shrink-0, so below ~222px every pixel it takes comes out
// of the tab strip; collapsing it to one ⋮ costs 31px instead of 142 and keeps
// the actions reachable down to ~111px.
//
// Dropping them outright — what this replaces — took the actions away exactly
// when a crowded layout needs stash and zoom most, and "add a browser tab to
// THIS pane" had no other entry point at all (the palette's Open Browser passes
// forceNew, which splits off another pane and makes the crowding worse).
//
// Portalled to document.body for the same reason Terminal/ContextMenu.tsx is
// (#957): a pane owns its stacking context and clips its overflow, so a menu
// rendered inside one is a bug waiting for whoever adds an `overflow` rule.
// Anchored placement is placePopover — already right-aligned to an anchor,
// already viewport-flipping, and the cluster it hangs from lives on the right.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { placePopover } from '../AgentToolbar/placePopover';

export interface PaneActionItem {
  /** Stable id — also the `data-pane-menu-action` hook tests select on. */
  key: string;
  label: string;
  /** Keyboard shortcut, shown right-aligned. Absent when the action has none. */
  shortcut?: string;
  icon?: React.ReactNode;
  /** Unavailable, but still focusable and still explains itself (see below). */
  disabled?: boolean;
  /** Tooltip — carries the reason when `disabled`. */
  title?: string;
  /** Renders pressed, e.g. zoom while the pane is zoomed. */
  active?: boolean;
  onSelect: () => void;
  /** Draw a divider above this item (zoom, matching the cluster's border-l). */
  separatorBefore?: boolean;
}

interface PaneActionsMenuProps {
  /** Viewport rect of whatever opened the menu: the ⋮ button, or a 0×0 rect at
   *  the pointer for a right-click on the header. */
  anchor: { top: number; left: number; right: number; bottom: number } | null;
  /** Excluded from the outside-click test so the trigger's own click toggles
   *  rather than double-toggles (mousedown would close, click would reopen). */
  triggerRef?: React.RefObject<HTMLElement | null>;
  items: PaneActionItem[];
  onClose: () => void;
}

/** Item box: px-2.5 py-1.5 around a 12px line — matches ContextMenu's MenuItem.
 *  Only an opening estimate; the real height is measured before paint. */
const ESTIMATED_ITEM_HEIGHT = 27;
const MENU_WIDTH = 216;

export default function PaneActionsMenu({ anchor, triggerRef, items, onClose }: PaneActionsMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const separators = items.filter((i) => i.separatorBefore).length;
  const [height, setHeight] = useState(
    items.length * ESTIMATED_ITEM_HEIGHT + separators * 9 + 10,
  );
  // Re-place on resize: the position is derived from the viewport, so it goes
  // stale the moment the window changes size under an open menu (a snap layout,
  // a display change) and the menu can end up clipped or off screen.
  const [, bumpOnResize] = useState(0);

  // Measure before paint and re-place with the real height, so a menu opened
  // near the bottom edge flips ABOVE its anchor on the first frame rather than
  // painting once clipped and then correcting.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const measured = el.getBoundingClientRect().height;
    setHeight((prev) => (Math.abs(prev - measured) < 1 ? prev : measured));
  }, [items.length]);

  useEffect(() => {
    const onResize = () => bumpOnResize((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // A menu that opens under the cursor but leaves focus in the terminal is a
  // menu a keyboard user cannot use. The terminal takes focus back on close.
  useEffect(() => {
    firstItemRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef?.current?.contains(target)) return;
      onClose();
    };
    // Capture on keydown: the terminal swallows keys, and Escape must close the
    // menu rather than reach the shell behind it.
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose, triggerRef]);

  const pos = placePopover(anchor, { width: MENU_WIDTH, height });

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-pane-actions-menu
      className="fixed p-[5px]"
      style={{
        top: pos.top,
        left: pos.left,
        width: MENU_WIDTH,
        zIndex: 'var(--z-popover-top)',
        background: 'var(--bg-surface)',
        border: '1px solid color-mix(in srgb, var(--text-main) 9%, transparent)',
        borderRadius: 8,
        boxShadow:
          '0 12px 32px rgba(0, 0, 0, 0.45), inset 0 1px 0 color-mix(in srgb, var(--text-main) 5%, transparent)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <div key={item.key}>
          {item.separatorBefore && (
            <div
              className="my-1 mx-2 border-t"
              style={{ borderColor: 'var(--bg-overlay)' }}
            />
          )}
          <button
            ref={i === 0 ? firstItemRef : undefined}
            role="menuitem"
            data-pane-menu-action={item.key}
            // aria-disabled, not disabled: a disabled button drops out of the
            // tab order, so a keyboard user cannot reach it to READ why it is
            // unavailable. Same call the cluster's stash button makes.
            aria-disabled={item.disabled || undefined}
            aria-pressed={item.active}
            title={item.title}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left rounded-[5px] transition-colors hover:bg-[color-mix(in_srgb,var(--accent-blue)_14%,transparent)] ${
              item.disabled ? 'opacity-40' : ''
            }`}
            style={{ color: item.active ? 'var(--accent-blue)' : 'var(--text-main)' }}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}
          >
            {item.icon && (
              <span aria-hidden="true" className="shrink-0 w-4 flex items-center justify-center">
                {item.icon}
              </span>
            )}
            <span className="flex-1 truncate">{item.label}</span>
            {item.shortcut && (
              <span
                className="ml-2 shrink-0 text-[10px] font-mono tabular-nums"
                style={{ color: 'var(--text-subtle)' }}
              >
                {item.shortcut}
              </span>
            )}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
