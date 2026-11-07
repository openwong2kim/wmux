// "Move to group" in a workspace row's context menu (#3069): each group (the
// current one checked), New group… and Remove from group. Hover or click
// opens it, like the row menu's Color tag and Snooze; the keyboard enters it
// with Enter / Space / → and leaves with Escape / ←. Display-only: filing a
// workspace changes where its row is listed, nothing else.
import { useCallback, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useRowStore } from '../../stores/rowStore';
import { useT } from '../../hooks/useT';
import { IconCheck, IconChevron } from '../icons';
import { keepSubmenuInWindow } from '../../utils/keepSubmenuInWindow';

const ITEM = 'w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]';
const ITEM_STYLE = { color: 'var(--text-main)' } as const;

export default function WorkspaceGroupSubmenu({ workspaceId, groupId, opensLeft, onDone }: {
  workspaceId: string;
  /** The row's current group id, if any. */
  groupId: string | undefined;
  /** Open toward the left (the menu sits near the window's right edge). */
  opensLeft: boolean;
  /** Close the whole row menu (after a choice). */
  onDone: () => void;
}) {
  const t = useT();
  const groups = useRowStore((s) => s.workspaceGroups);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const focusFirst = useRef(false);
  // Stable so the fit runs once per mount (see keepSubmenuInWindow).
  const submenuRef = useCallback((el: HTMLDivElement | null) => {
    const release = keepSubmenuInWindow(el);
    if (el && focusFirst.current) {
      focusFirst.current = false;
      el.querySelector<HTMLButtonElement>('[data-workspace-group-option]')?.focus();
    }
    return release;
  }, []);
  // A groupId whose group is gone files the row nowhere; it reads as none.
  const current = groups.some((g) => g.id === groupId) ? groupId : undefined;

  const choose = (target: string | undefined) => {
    onDone();
    useStore.getState().moveWorkspaceToGroup(workspaceId, target);
  };
  const create = () => {
    onDone();
    const st = useStore.getState();
    // Made with a placeholder name, then named in place on its header.
    const id = st.createWorkspaceGroup(t('sidebar.groups.defaultName'), workspaceId);
    if (id) st.setWorkspaceGroupRenaming(id);
    else st.pushToast({ level: 'info', message: t('sidebar.groups.limit') });
  };

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
    >
      <button
        ref={triggerRef}
        className={ITEM}
        style={ITEM_STYLE}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            // First Escape folds the submenu; the next one closes the menu.
            e.stopPropagation();
            setOpen(false);
            return;
          }
          if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          focusFirst.current = true;
          setOpen(true);
        }}
        data-workspace-action="move-to-group"
      >
        <span>{t('sidebar.groups.moveTo')}</span>
        <span className="text-[var(--text-muted)] ml-auto"><IconChevron /></span>
      </button>
      {open && (
        <div
          ref={submenuRef}
          role="menu"
          aria-label={t('sidebar.groups.moveTo')}
          className={`absolute top-0 ${opensLeft ? 'right-full mr-0.5' : 'left-full ml-0.5'} min-w-[160px] max-w-[240px] py-1 rounded-xl shadow-xl sidebar-popover-enter`}
          style={{ background: 'var(--bg-surface)', border: '1px solid color-mix(in srgb, var(--bg-overlay) 70%, transparent)' }}
          onKeyDown={(e) => {
            const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-workspace-group-option]')];
            const at = items.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              items[(at + step + items.length) % items.length]?.focus();
            } else if (e.key === 'Escape' || e.key === 'ArrowLeft') {
              // Close only the submenu: stop the event before the document
              // listener that dismisses the whole menu.
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
        >
          {groups.map((group) => (
            <button
              key={group.id}
              role="menuitemradio"
              aria-checked={current === group.id}
              className={ITEM}
              style={ITEM_STYLE}
              onClick={() => choose(group.id)}
              data-workspace-group-option={group.id}
            >
              <span className="w-3.5 flex-none inline-flex justify-center" aria-hidden="true">
                {current === group.id && <IconCheck size={12} />}
              </span>
              <span className="min-w-0 truncate">{group.name}</span>
            </button>
          ))}
          <button role="menuitem" className={ITEM} style={ITEM_STYLE} onClick={create} data-workspace-group-option="new">
            <span className="w-3.5 flex-none" aria-hidden="true" />
            <span>{t('sidebar.groups.new')}</span>
          </button>
          {current && (
            <button role="menuitem" className={ITEM} style={ITEM_STYLE} onClick={() => choose(undefined)} data-workspace-group-option="none">
              <span className="w-3.5 flex-none" aria-hidden="true" />
              <span>{t('sidebar.groups.removeFrom')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
