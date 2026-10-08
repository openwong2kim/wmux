import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import Popover from '../ui/Popover';
import { IconMoreHorizontal } from '../icons';
import { FOCUS_RING } from '../focusRing';

export interface RemoteRowMenuItem {
  id: string;
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/** Menu row height and padding, to place the menu above its button when it would run off the window. */
const ROW_PX = 29;
const PAD_PX = 12;

/**
 * A row's ⋯ menu on the Remote page. The button is named after the row
 * ("DESK: more actions"); ↑↓ move, Enter picks, Escape or Tab closes and
 * hands focus back to the button (from the menu or the button alike), an
 * outside click closes. The menu is portalled to the body so the list's
 * rounded clip never cuts it off.
 */
export default function RemoteRowMenu({ label, items }: { label: string; items: RemoteRowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openMenu = () => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) {
      const height = items.length * ROW_PX + PAD_PX;
      const right = Math.max(8, window.innerWidth - r.right);
      setPlace(r.bottom + 4 + height > window.innerHeight
        ? { bottom: window.innerHeight - r.top + 4, right }
        : { top: r.bottom + 4, right });
    }
    setOpen(true);
  };
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) requestAnimationFrame(() => buttonRef.current?.focus());
  }, []);
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    };
    // Fixed to the window: a scroll or resize would leave it beside the wrong row.
    const onMove = (e: Event) => { if (!menuRef.current?.contains(e.target as Node)) close(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, close]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    all[(at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
  };
  if (items.length === 0) return null;
  return (
    <span className="wmux-remote-menu">
      <button
        ref={buttonRef}
        type="button"
        className={`ui-icon-btn wmux-remote-icon-btn ${FOCUS_RING}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(e) => {
          // The page's Escape leaves the page: an open menu goes first.
          if (!open || (e.key !== 'Escape' && e.key !== 'Tab')) return;
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); }
          close(false);
        }}
        data-remote-menu
      >
        <IconMoreHorizontal size={16} />
      </button>
      {open && createPortal(
        <Popover ref={menuRef} id={menuId} role="menu" aria-label={label} className="wmux-remote-menu-pop" style={place} onKeyDown={onKeyDown}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="wmux-ws-filter-option"
              data-remote-menu-item={item.id}
              style={item.danger ? { color: 'var(--accent-red)' } : undefined}
              onClick={() => { close(false); item.onSelect(); }}
            >
              {item.label}
            </button>
          ))}
        </Popover>,
        document.body,
      )}
    </span>
  );
}
