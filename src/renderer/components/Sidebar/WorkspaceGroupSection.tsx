// A user-defined workspace group in the sidebar (#3069): a collapsible header
// with the group's name and count, then its rows. Display-only — the rows are
// the list's own WorkspaceItem rows, unchanged.
//
// The header is the Sidebar's settled-group header, as the Bots page's folders
// use it (DESIGN.md › Bots › Folders), and shares their name field, menu shell
// and menu key (Bots/BotFolderUi.tsx): a 12px/500 button in 70% --text-main, a
// disclosure chevron (right, turned 90° down while open), the name and the
// count — no fill or rule, no uppercase or tracking, no count drawn at zero,
// hover --hover-fill. Right-click or Shift+F10 / the Menu key opens Rename,
// Collapse / Expand and Delete group; double-click renames in place.
import { useCallback, useId, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconChevron } from '../icons';
import { InlineConfirm } from '../Bots/InlineConfirm';
import { FOLDER_MENU_ITEM, FolderContextMenu, FolderNameInput, menuKeyPoint } from '../Bots/BotFolderUi';
import { normalizeWorkspaceGroupName, WORKSPACE_GROUP_NAME_MAX, type WorkspaceGroup } from '../../../shared/workspaceGroups';

export default function WorkspaceGroupSection({ group, count, forceOpen = false, containsActive = false, children }: {
  group: WorkspaceGroup;
  /** Top-level rows listed under the group (nested tasks ride with their owner). */
  count: number;
  /** Shown open whatever the stored state (a filter is narrowing the list). */
  forceOpen?: boolean;
  /** The open workspace is one of the group's rows. */
  containsActive?: boolean;
  children: React.ReactNode;
}) {
  const t = useT();
  const listId = useId();
  const renaming = useStore((s) => s.workspaceGroupRenamingId === group.id);
  // Every workspace filed here, drawn or not (settled, snoozed, filtered out):
  // deleting the group takes them all out of it.
  const members = useStore((s) => s.workspaces.filter((w) => w.groupId === group.id).length);
  // The header's menu; `confirmDelete` swaps its items for the delete confirm.
  const [menu, setMenu] = useState<{ x: number; y: number; confirmDelete: boolean } | null>(null);
  const headRef = useRef<HTMLButtonElement>(null);
  const open = forceOpen || !group.collapsed;
  // Folded over the open workspace: the header stands in for its selected row.
  const hidesActive = containsActive && !open;

  const closeMenu = useCallback(() => {
    setMenu(null);
    headRef.current?.focus();
  }, []);
  // Flips the stored state: while a filter holds the group open, `open` says
  // nothing about it.
  const toggle = () => useStore.getState().setWorkspaceGroupCollapsed(group.id, !group.collapsed);
  const startRename = () => {
    setMenu(null);
    useStore.getState().setWorkspaceGroupRenaming(group.id);
  };
  const endRename = () => {
    useStore.getState().setWorkspaceGroupRenaming(null);
    requestAnimationFrame(() => headRef.current?.focus());
  };
  const remove = () => {
    setMenu(null);
    useStore.getState().deleteWorkspaceGroup(group.id);
  };

  const chevron = (
    <span aria-hidden="true" className="wmux-ws-group-chevron" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
      <IconChevron size={12} />
    </span>
  );
  const label = [group.name, count > 0 ? String(count) : '', hidesActive ? t('sidebar.groups.holdsActive') : '']
    .filter(Boolean).join(', ');

  return (
    <div className="wmux-ws-group" data-workspace-group={group.id}>
      {renaming ? (
        <div className="wmux-ws-group-head">
          {chevron}
          <FolderNameInput
            initial={group.name}
            label={t('sidebar.groups.name')}
            testId="workspace-group-input"
            normalize={normalizeWorkspaceGroupName}
            maxLength={WORKSPACE_GROUP_NAME_MAX}
            className="wmux-ws-group-input"
            isolateKeys
            onCommit={(name) => { useStore.getState().renameWorkspaceGroup(group.id, name); endRename(); }}
            onCancel={endRename}
          />
        </div>
      ) : (
        <button
          ref={headRef}
          type="button"
          data-workspace-group-head={group.id}
          data-holds-active={hidesActive ? 'true' : undefined}
          aria-expanded={open}
          aria-controls={listId}
          aria-label={label}
          title={hidesActive ? `${group.name} · ${t('sidebar.groups.holdsActive')}` : group.name}
          onClick={toggle}
          onDoubleClick={(e) => { e.preventDefault(); startRename(); }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ x: e.clientX, y: e.clientY, confirmDelete: false });
          }}
          onKeyDown={(e) => {
            const at = menuKeyPoint(e);
            if (at) setMenu({ ...at, confirmDelete: false });
          }}
          className={`wmux-ws-group-head ${FOCUS_RING}`}
        >
          {chevron}
          <span className="min-w-0 flex-1 truncate text-left">{group.name}</span>
          {count > 0 && <span aria-hidden="true" className="tabular-nums wmux-ws-group-count">{count}</span>}
        </button>
      )}
      {/* Unmounted while folded, like the Snoozed / Settled groups. */}
      <div id={listId} role="group" aria-label={group.name} className="mt-0.5 space-y-0.5" hidden={!open}>
        {open && children}
      </div>
      {menu && (
        <FolderContextMenu x={menu.x} y={menu.y} label={t('sidebar.groups.menu')} onClose={closeMenu} marker="data-workspace-group-menu">
          {menu.confirmDelete ? (
            <div className="px-2 py-1.5 max-w-[240px]">
              <InlineConfirm
                text={t('sidebar.groups.deleteConfirm', { count: members })}
                confirmLabel={t('sidebar.groups.delete')}
                cancelLabel={t('common.cancel')}
                busy={false}
                onConfirm={remove}
                onCancel={closeMenu}
                testId="workspace-group-delete"
              />
            </div>
          ) : (
            <>
              <button type="button" role="menuitem" autoFocus data-workspace-group-action="rename" className={FOLDER_MENU_ITEM} onClick={startRename}>
                {t('sidebar.groups.rename')}
              </button>
              <button type="button" role="menuitem" data-workspace-group-action="toggle" className={FOLDER_MENU_ITEM} onClick={() => { closeMenu(); toggle(); }}>
                {group.collapsed ? t('sidebar.groups.expand') : t('sidebar.groups.collapse')}
              </button>
              <button
                type="button"
                role="menuitem"
                data-workspace-group-action="delete"
                className={FOLDER_MENU_ITEM}
                // An empty group goes at once; one holding rows says first
                // where they go (back to the list, still open).
                onClick={() => (members > 0 ? setMenu({ ...menu, confirmDelete: true }) : remove())}
              >
                {t('sidebar.groups.delete')}
              </button>
            </>
          )}
        </FolderContextMenu>
      )}
    </div>
  );
}
