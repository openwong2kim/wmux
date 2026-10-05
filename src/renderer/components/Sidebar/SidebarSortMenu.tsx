import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import type { SidebarSortMode } from '../../utils/sidebarLayout';
import Popover from '../ui/Popover';
import { IconCheck, IconSort } from '../icons';
import { FOCUS_RING } from '../focusRing';

const MODES: { value: SidebarSortMode; labelKey: 'settings.sidebarSortAttention' | 'settings.sidebarSortManual' | 'settings.sidebarSortRecent' }[] = [
  { value: 'attention', labelKey: 'settings.sidebarSortAttention' },
  { value: 'manual', labelKey: 'settings.sidebarSortManual' },
  { value: 'recent', labelKey: 'settings.sidebarSortRecent' },
];

/**
 * The sidebar header's order control: the same three orders as Settings ›
 * Appearance › Sidebar, one press away. The button names the current order;
 * its menu is three radio items. ↑↓ move, Enter or Space picks, Escape closes
 * and hands focus back to the button.
 */
export default function SidebarSortMenu() {
  const t = useT();
  const mode = useStore((s) => s.sidebarSortMode);
  const setMode = useStore((s) => s.setSidebarSortMode);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = MODES.find((m) => m.value === mode) ?? MODES[0];
  const name = t('sidebar.sortOrder', { order: t(current.labelKey) });

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) requestAnimationFrame(() => buttonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      // Both close the menu and hand focus back to its button, so focus never
      // drops to the page; the next Tab goes on from there.
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`ui-icon-btn h-7 w-7 ${FOCUS_RING}`}
        onClick={() => (open ? close(false) : setOpen(true))}
        title={name}
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={open}
        data-sidebar-sort-toggle
      >
        <IconSort size={15} />
      </button>
      {open && (
        <Popover ref={menuRef} role="menu" className="wmux-ws-sort" aria-label={t('settings.sidebarSort')} onKeyDown={onMenuKeyDown} data-sidebar-sort-menu>
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="menuitemradio"
              aria-checked={m.value === mode}
              tabIndex={m.value === mode ? 0 : -1}
              className="wmux-ws-filter-option"
              onClick={() => { setMode(m.value); close(true); }}
              data-sort-option={m.value}
            >
              <span className="wmux-ws-sort-check" aria-hidden="true">{m.value === mode && <IconCheck size={11} />}</span>
              {t(m.labelKey)}
            </button>
          ))}
        </Popover>
      )}
    </>
  );
}
