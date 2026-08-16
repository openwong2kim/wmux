import { useEffect, useRef } from 'react';
import { useT } from '../../hooks/useT';

interface SurfaceAddMenuProps {
  /** Keyboard shortcut shown next to "New terminal", already OS-mapped. */
  terminalShortcut: string;
  /** Viewport rect of the `+` button, used to place the fixed panel under it. */
  anchor: { left: number; bottom: number };
  onAddTerminal: () => void;
  onAddBrowser: () => void;
  onClose: () => void;
}

/**
 * "Add a surface to this pane" menu, opened from the `+` after the last tab.
 *
 * Deliberately a menu and not a one-click `+`. One pane = one terminal is
 * still the shape we recommend: a second terminal in the same pane is a real
 * capability (Ctrl+T has always done it) but not the default answer to "I
 * want another terminal" — splitting is. A bare `+` sitting against the tabs
 * would read as the intended way to add terminals and quietly invert that.
 * A menu keeps the capability one gesture away without advertising it as the
 * default, and it gives the browser surface a home next to the terminal one
 * instead of a separate button in the action cluster.
 *
 * Dismissal mirrors Terminal/ContextMenu.tsx (mousedown outside + Escape) so
 * pane chrome has one menu behaviour rather than two.
 */
export default function SurfaceAddMenu({
  terminalShortcut,
  anchor,
  onAddTerminal,
  onAddBrowser,
  onClose,
}: SurfaceAddMenuProps) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Stop the pane's own Escape handling from also firing: closing this
        // menu is the whole intent of the keypress.
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  // Clamp into the viewport, same as ContextMenu: the `+` of a right-hand pane
  // sits near the window edge, and a fixed panel does not reflow on its own.
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth) el.style.left = `${Math.max(4, window.innerWidth - r.width - 4)}px`;
    if (r.bottom > window.innerHeight) el.style.top = `${Math.max(4, window.innerHeight - r.height - 4)}px`;
  }, [anchor.left, anchor.bottom]);

  const run = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('pane.addSurface')}
      data-testid="surface-add-menu"
      // `fixed`, positioned from the trigger — not `absolute` inside the strip.
      // The tab list scrolls horizontally (`overflow: auto`), and an ancestor
      // with a non-visible overflow CLIPS an absolutely-positioned descendant:
      // the panel had a valid box, z-index 9999 and `visibility: visible`, and
      // was still invisible in the running app. jsdom has no layout, so the
      // unit tests could not have caught it. Same escape ContextMenu uses.
      className="fixed z-[var(--z-popover-top)] min-w-[176px] p-[5px]"
      style={{
        left: anchor.left,
        top: anchor.bottom + 2,
        background: 'var(--bg-surface)',
        border: '1px solid color-mix(in srgb, var(--text-main) 9%, transparent)',
        borderRadius: 8,
        boxShadow:
          '0 12px 32px rgba(0, 0, 0, 0.45), inset 0 1px 0 color-mix(in srgb, var(--text-main) 5%, transparent)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <MenuItem
        label={t('pane.newTerminal')}
        shortcut={terminalShortcut}
        dataAction="new-terminal"
        onClick={() => run(onAddTerminal)}
      />
      <MenuItem
        label={t('pane.newBrowser')}
        dataAction="new-browser"
        onClick={() => run(onAddBrowser)}
      />
    </div>
  );
}

function MenuItem({
  label,
  shortcut,
  dataAction,
  onClick,
}: {
  label: string;
  shortcut?: string;
  dataAction: string;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      className="w-full flex items-center justify-between gap-4 px-2.5 py-1.5 text-xs text-left rounded-[5px] transition-colors hover:bg-[color-mix(in_srgb,var(--accent-blue)_14%,transparent)]"
      style={{ color: 'var(--text-main)' }}
      data-pane-action={dataAction}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <span>{label}</span>
      {shortcut && (
        <span
          className="ml-4 text-[10px] font-mono tabular-nums"
          style={{ color: 'var(--text-subtle)' }}
        >
          {shortcut}
        </span>
      )}
    </button>
  );
}
