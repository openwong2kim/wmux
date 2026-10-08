import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Popover from '../ui/Popover';
import { IconMoreHorizontal } from '../icons';
import { FOCUS_RING } from '../focusRing';

export interface RemoteRowMenuItem {
  id: string;
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/**
 * A row's ⋯ menu on the Remote page. The button is named after the row
 * ("DESK: more actions"); ↑↓ move, Enter picks, Escape or Tab closes and
 * hands focus back to the button, an outside click closes.
 */
export default function RemoteRowMenu({ label, items }: { label: string; items: RemoteRowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
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
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
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
        onClick={() => (open ? close(false) : setOpen(true))}
        data-remote-menu
      >
        <IconMoreHorizontal size={16} />
      </button>
      {open && (
        <Popover ref={menuRef} role="menu" aria-label={label} className="wmux-remote-menu-pop" onKeyDown={onKeyDown}>
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
        </Popover>
      )}
    </span>
  );
}
