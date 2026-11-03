// The Bots list's folders (DESIGN.md › Bots › Folders): a folder's section
// header, its inline name field and the context menus that file a bot or
// manage a folder. The data and the calls live in BotsPage.tsx.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { FOCUS_RING } from '../focusRing';
import { IconChevron } from '../icons';
import Popover from '../ui/Popover';
import { keepMenuInWindow } from '../../utils/keepSubmenuInWindow';
import { BOT_FOLDER_LIMITS, normalizeFolderName, type BotFolder } from '../../../shared/botFolder';
import type { useT } from '../../hooks/useT';

type T = ReturnType<typeof useT>;

const FOLDER_MENU_ITEM = `ui-section-row w-full text-left text-[13px] ${FOCUS_RING}`;

/** Shift+F10 / the Menu key on a row or header: cancels the key's default and
 *  returns where its context menu opens (under the element); null for any other
 *  key. */
export function menuKeyPoint(e: React.KeyboardEvent<HTMLElement>): { x: number; y: number } | null {
  if (!((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu')) return null;
  e.preventDefault();
  const r = e.currentTarget.getBoundingClientRect();
  return { x: r.left + 24, y: r.bottom - 4 };
}

/** A one-line name field: Enter commits, Escape cancels, leaving the field
 *  commits (like renaming a workspace in the Sidebar). A name that is empty or
 *  unchanged cancels. */
export function FolderNameInput({ initial, label, testId, onCommit, onCancel }: {
  initial: string;
  label: string;
  testId: string;
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
    const name = normalizeFolderName(ref.current?.value);
    if (commit && name && name !== initial) onCommit(name);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      type="text"
      data-bots-folder-input={testId}
      data-testid={testId}
      aria-label={label}
      placeholder={label}
      defaultValue={initial}
      maxLength={BOT_FOLDER_LIMITS.NAME_MAX}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      }}
      onBlur={() => finish(true)}
      className={`wmux-bots-folder-input ${FOCUS_RING}`}
    />
  );
}

/** The orange count of what needs the owner (a row's, or a folder's). */
export function NeedsBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span data-bots-needs={count} aria-hidden="true" className="wmux-bots-badge">{count > 99 ? '99+' : count}</span>;
}

/** Unread messages: a neutral count, shown only when nothing there needs the
 *  owner (the orange count wins). */
export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span data-bots-unread={count} aria-hidden="true" className="wmux-bots-unread">{count > 99 ? '99+' : count}</span>;
}

/** A folder's section header: a disclosure button (chevron right, turned down
 *  while open), the name and the count of its bots (none drawn at zero).
 *  Right-click or Shift+F10 opens the folder's menu. */
export function FolderHeader({ folder, count, open, listId, renaming, renameLabel, dropActive = false, needsYou = 0, unread = 0, markText = '', onToggle, onMenu, onRename, onCancelRename }: {
  folder: BotFolder;
  count: number;
  open: boolean;
  listId: string;
  renaming: boolean;
  renameLabel: string;
  /** A dragged bot is over this folder. */
  dropActive?: boolean;
  /** The strongest mark of the folder's rows, open or collapsed: the orange
   *  count if any needs the owner, else the neutral unread count. */
  needsYou?: number;
  unread?: number;
  /** That mark worded for the accessible name (empty: none). */
  markText?: string;
  onToggle: () => void;
  onMenu: (x: number, y: number) => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
}) {
  const chevron = (
    <span aria-hidden="true" className="wmux-bots-folder-chevron" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
      <IconChevron size={12} />
    </span>
  );
  if (renaming) {
    return (
      <div className="wmux-bots-folder-head" data-bots-folder-head={folder.id}>
        {chevron}
        <FolderNameInput initial={folder.name} label={renameLabel} testId="bots-folder-rename" onCommit={onRename} onCancel={onCancelRename} />
      </div>
    );
  }
  return (
    <div
      className="wmux-bots-folder-head-wrap"
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onMenu(e.clientX, e.clientY); }}
    >
      <button
        type="button"
        data-bots-folder-head={folder.id}
        aria-expanded={open}
        aria-controls={listId}
        // The badges are aria-hidden, so the mark is worded here; a name from
        // content alone would drop it.
        aria-label={markText ? [folder.name, count > 0 ? String(count) : '', markText].filter(Boolean).join(', ') : undefined}
        onClick={onToggle}
        onKeyDown={(e) => {
          const at = menuKeyPoint(e);
          if (at) onMenu(at.x, at.y);
        }}
        className={`wmux-bots-folder-head ${dropActive ? 'is-drop' : ''} ${FOCUS_RING}`}
      >
        {chevron}
        <span className="min-w-0 flex-1 truncate text-left">{folder.name}</span>
        {count > 0 && <span className="tabular-nums wmux-bots-folder-count">{count}</span>}
        <NeedsBadge count={needsYou} />
        {needsYou <= 0 && <UnreadBadge count={unread} />}
      </button>
    </div>
  );
}

/** A fixed menu at a point, kept inside the window; it closes on an outside
 *  press and on Escape. */
function BotsContextMenu({ x, y, label, onClose, children }: {
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
      data-bots-menu
      className="fixed z-[var(--z-popover-top)] w-max min-w-[180px] max-w-[260px]"
      style={{ left: x, top: y }}
    >
      {children}
    </Popover>
  );
}

/** A bot row's menu: Move to folder (each folder, New folder…) and Remove
 *  from folder. It acts on one bot, or on every checked bot: `currentId` is
 *  the folder they all share (else null) and `canRemove` says any is filed. */
export function BotFolderMenu({ t, x, y, folders, currentId, canRemove, onMove, onNew, onClose }: {
  t: T;
  x: number;
  y: number;
  folders: readonly BotFolder[];
  currentId: string | null;
  canRemove: boolean;
  onMove: (folderId: string | null) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  return (
    <BotsContextMenu x={x} y={y} label={t('botsPage.folders.move')} onClose={onClose}>
      <p className="wmux-bots-menu-label" aria-hidden="true">{t('botsPage.folders.move')}</p>
      {folders.map((f, i) => (
        <button
          key={f.id}
          type="button"
          role="menuitemradio"
          aria-checked={f.id === currentId}
          autoFocus={i === 0}
          data-bots-move-to={f.id}
          className={FOLDER_MENU_ITEM}
          onClick={() => onMove(f.id)}
        >
          <span className="block truncate">{f.name}</span>
        </button>
      ))}
      <button type="button" role="menuitem" autoFocus={folders.length === 0} data-bots-move-new className={FOLDER_MENU_ITEM} onClick={onNew}>
        {t('botsPage.folders.newEllipsis')}
      </button>
      {canRemove && (
        <button type="button" role="menuitem" data-bots-move-out className={FOLDER_MENU_ITEM} onClick={() => onMove(null)}>
          {t('botsPage.folders.remove')}
        </button>
      )}
    </BotsContextMenu>
  );
}

/** A folder header's menu: Rename and Delete. */
export function FolderActionsMenu({ t, x, y, onRename, onDelete, onClose }: {
  t: T;
  x: number;
  y: number;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <BotsContextMenu x={x} y={y} label={t('botsPage.folders.menu')} onClose={onClose}>
      <button type="button" role="menuitem" autoFocus data-bots-folder-rename className={FOLDER_MENU_ITEM} onClick={onRename}>
        {t('botsPage.folders.rename')}
      </button>
      <button type="button" role="menuitem" data-bots-folder-delete className={FOLDER_MENU_ITEM} onClick={onDelete}>
        {t('botsPage.folders.delete')}
      </button>
    </BotsContextMenu>
  );
}
