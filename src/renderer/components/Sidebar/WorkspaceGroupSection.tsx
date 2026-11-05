// A user-defined workspace group in the sidebar (#3069): a collapsible header
// with the group's name and count, then its rows. Display-only — the rows are
// the list's own WorkspaceItem rows, unchanged.
//
// The header is the Sidebar's settled-group header, as the Bots page's folders
// use it (DESIGN.md › Bots › Folders): a 12px/500 button in 70% --text-main, a
// disclosure chevron (right, turned 90° down while open), the name and the
// count — no fill or rule, no uppercase or tracking, no count drawn at zero,
// hover --hover-fill. Right-click or Shift+F10 / the Menu key opens Rename,
// Collapse / Expand and Delete group; double-click renames in place.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconChevron } from '../icons';
import Popover from '../ui/Popover';
import { InlineConfirm } from '../Bots/InlineConfirm';
import { keepMenuInWindow } from '../../utils/keepSubmenuInWindow';
import { normalizeWorkspaceGroupName, WORKSPACE_GROUP_NAME_MAX, type WorkspaceGroup } from '../../../shared/workspaceGroups';

const MENU_ITEM = `ui-section-row w-full text-left text-[13px] ${FOCUS_RING}`;

/** One-line name field: Enter commits, Escape cancels, leaving the field
 *  commits. An empty or unchanged name cancels. */
function GroupNameInput({ initial, label, onCommit, onCancel }: {
  initial: string;
  label: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = normalizeWorkspaceGroupName(ref.current?.value);
    if (commit && name && name !== initial) onCommit(name);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      type="text"
      data-workspace-group-input
      aria-label={label}
      placeholder={label}
      defaultValue={initial}
      maxLength={WORKSPACE_GROUP_NAME_MAX}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // The sidebar's own keys (row arrows, Ctrl+F) must not see typing.
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      }}
      onBlur={() => finish(true)}
      className={`wmux-ws-group-input ${FOCUS_RING}`}
    />
  );
}

/** The header's menu, at a point and kept inside the window; it closes on an
 *  outside press and on Escape. */
function GroupMenu({ x, y, label, onClose, children }: {
  x: number;
  y: number;
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    return keepMenuInWindow(el, x, y);
  }, [x, y]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <Popover
      ref={ref}
      role="menu"
      aria-label={label}
      data-workspace-group-menu
      className="fixed z-[var(--z-popover-top)] w-max min-w-[180px] max-w-[260px]"
      style={{ left: x, top: y }}
    >
      {children}
    </Popover>
  );
}

export default function WorkspaceGroupSection({ group, count, children }: {
  group: WorkspaceGroup;
  /** Top-level rows listed under the group (nested tasks ride with their owner). */
  count: number;
  children: React.ReactNode;
}) {
  const t = useT();
  const listId = useId();
  const renaming = useStore((s) => s.workspaceGroupRenamingId === group.id);
  // The header's menu; `confirmDelete` swaps its items for the delete confirm.
  const [menu, setMenu] = useState<{ x: number; y: number; confirmDelete: boolean } | null>(null);
  const headRef = useRef<HTMLButtonElement>(null);
  const open = !group.collapsed;

  const store = useStore.getState;
  const toggle = () => store().setWorkspaceGroupCollapsed(group.id, open);
  const closeMenu = () => setMenu(null);
  const startRename = () => { setMenu(null); store().setWorkspaceGroupRenaming(group.id); };
  const endRename = () => {
    store().setWorkspaceGroupRenaming(null);
    requestAnimationFrame(() => headRef.current?.focus());
  };
  const remove = () => { setMenu(null); store().deleteWorkspaceGroup(group.id); };

  const chevron = (
    <span aria-hidden="true" className="wmux-ws-group-chevron" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
      <IconChevron size={12} />
    </span>
  );

  return (
    <div className="wmux-ws-group" data-workspace-group={group.id}>
      {renaming ? (
        <div className="wmux-ws-group-head">
          {chevron}
          <GroupNameInput
            initial={group.name}
            label={t('workspaceGroup.name')}
            onCommit={(name) => { store().renameWorkspaceGroup(group.id, name); endRename(); }}
            onCancel={endRename}
          />
        </div>
      ) : (
        <button
          ref={headRef}
          type="button"
          data-workspace-group-head={group.id}
          aria-expanded={open}
          aria-controls={listId}
          aria-label={count > 0 ? `${group.name}, ${count}` : group.name}
          title={group.name}
          onClick={toggle}
          onDoubleClick={(e) => { e.preventDefault(); startRename(); }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ x: e.clientX, y: e.clientY, confirmDelete: false });
          }}
          onKeyDown={(e) => {
            if (!((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu')) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left + 24, y: r.bottom - 4, confirmDelete: false });
          }}
          className={`wmux-ws-group-head ${FOCUS_RING}`}
        >
          {chevron}
          <span className="min-w-0 flex-1 truncate text-left">{group.name}</span>
          {count > 0 && <span aria-hidden="true" className="tabular-nums wmux-ws-group-count">{count}</span>}
        </button>
      )}
      <div id={listId} role="group" aria-label={group.name} className="mt-0.5 space-y-0.5" hidden={!open}>
        {open && children}
      </div>
      {menu && (
        <GroupMenu x={menu.x} y={menu.y} label={t('workspaceGroup.menu')} onClose={closeMenu}>
          {menu.confirmDelete ? (
            <div className="px-2 py-1.5 max-w-[240px]">
              <InlineConfirm
                text={t('workspaceGroup.deleteConfirm', { count })}
                confirmLabel={t('workspaceGroup.delete')}
                cancelLabel={t('common.cancel')}
                busy={false}
                onConfirm={remove}
                onCancel={closeMenu}
                testId="workspace-group-delete"
              />
            </div>
          ) : (
            <>
              <button type="button" role="menuitem" autoFocus data-workspace-group-action="rename" className={MENU_ITEM} onClick={startRename}>
                {t('workspaceGroup.rename')}
              </button>
              <button type="button" role="menuitem" data-workspace-group-action="toggle" className={MENU_ITEM} onClick={() => { setMenu(null); toggle(); }}>
                {open ? t('workspaceGroup.collapse') : t('workspaceGroup.expand')}
              </button>
              <button
                type="button"
                role="menuitem"
                data-workspace-group-action="delete"
                className={MENU_ITEM}
                // An empty group goes at once; one holding rows says first
                // where they go (back to the list, still open).
                onClick={() => (count > 0 ? setMenu({ ...menu, confirmDelete: true }) : remove())}
              >
                {t('workspaceGroup.delete')}
              </button>
            </>
          )}
        </GroupMenu>
      )}
    </div>
  );
}
