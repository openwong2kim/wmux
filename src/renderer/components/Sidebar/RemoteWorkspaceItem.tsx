import { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import type { AttachedRemoteWorkspace } from '../../stores/slices/remoteWorkspacesSlice';
import {
  WORKSPACE_COLOR_IDS,
  normalizeWorkspaceColor,
  workspaceColorHex,
  workspaceColorLabelKey,
} from '../../../shared/workspaceColors';
import { FOCUS_RING } from '../focusRing';

interface RemoteWorkspaceItemProps {
  workspace: AttachedRemoteWorkspace;
  isActive: boolean;
  onSelect: (key: string) => void;
  onDetach: (key: string) => void;
}

/**
 * Sidebar row for one attached remote workspace. Selected state mirrors
 * WorkspaceItem's. The context menu carries Detach — never "Close":
 * detaching a mirror does not destroy anything on the remote host, so the
 * wording must not read as destructive — plus the #1086 parity verbs that are
 * LOCAL by design: Rename and Color tag are aliases this desktop keeps on the
 * attachment descriptor; the remote host still owns the real name.
 */
export default function RemoteWorkspaceItem({ workspace, isActive, onSelect, onDetach }: RemoteWorkspaceItemProps) {
  const t = useT();
  const renameRemoteWorkspace = useStore((s) => s.renameRemoteWorkspace);
  const setRemoteWorkspaceColor = useStore((s) => s.setRemoteWorkspaceColor);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!menuPos) return;
    const close = () => setMenuPos(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuPos(null); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuPos]);

  const commitRename = () => {
    renameRemoteWorkspace(workspace.key, editName.trim() || null);
    setEditing(false);
  };

  const displayName = workspace.label || workspace.name || workspace.workspaceId.slice(0, 8);
  const tagHex = workspaceColorHex(normalizeWorkspaceColor(workspace.color));

  return (
    <div className="relative mx-2">
      <div
        role="button"
        tabIndex={0}
        aria-pressed={isActive}
        aria-label={`${displayName} — ${workspace.hostLabel}`}
        className={`group sidebar-row px-3 py-1 cursor-pointer rounded-md select-none ${
          isActive
            ? 'sidebar-row-active text-[var(--text-main)]'
            : 'text-[var(--text-subtle)] hover:bg-[rgba(var(--bg-surface-rgb),0.5)] hover:text-[var(--text-sub)]'
        }`}
        onClick={() => { if (!editing) onSelect(workspace.key); }}
        onKeyDown={(e) => {
          if (editing) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(workspace.key);
          }
        }}
        onDoubleClick={() => {
          setEditName(workspace.label || workspace.name || '');
          setEditing(true);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          {/* #1086 — the color tag rides the same dot grammar as local rows:
              identity, filled, one dot. Untagged rows keep the status dot. */}
          <div
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={tagHex
              ? { backgroundColor: tagHex }
              : { backgroundColor: isActive && !workspace.stale ? 'var(--accent)' : 'var(--text-muted)' }}
          />
          <div className="flex-1 min-w-0">
            {editing ? (
              <input
                ref={inputRef}
                data-remote-rename-input
                className="ui-mini-input w-full text-caption font-mono bg-transparent border border-[var(--accent-blue)] rounded px-1"
                value={editName}
                maxLength={64}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditing(false);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <div className="text-caption font-mono truncate" title={workspace.label ? `${workspace.name} (renamed locally)` : undefined}>
                {displayName}
              </div>
            )}
            {/* A stale entry is unreachable, not gone: it keeps its row (only
                the user detaches) but drops the live accent colour and says
                why on hover. */}
            <div
              className="text-[10px] font-mono truncate"
              style={{ color: workspace.stale ? 'var(--text-muted)' : 'var(--accent)' }}
              title={workspace.stale ? t('remote.disconnected') : undefined}
            >
              {workspace.hostLabel}
            </div>
          </div>
        </div>
      </div>

      {menuPos && (
        <div
          className="fixed z-[var(--z-popover-top)] min-w-[160px] p-[5px]"
          style={{
            left: menuPos.x,
            top: menuPos.y,
            background: 'var(--bg-surface)',
            border: '1px solid color-mix(in srgb, var(--text-main) 9%, transparent)',
            borderRadius: 8,
            boxShadow:
              '0 12px 32px rgba(0, 0, 0, 0.45), inset 0 1px 0 color-mix(in srgb, var(--text-main) 5%, transparent)',
          }}
          // MOUSEDOWN, not click. The dismiss listener above is on `mousedown`,
          // which fires first — so stopping only `click` let the menu unmount
          // under the pointer before the button's own click could ever land,
          // and Detach did nothing at all. React's synthetic stopPropagation
          // calls the native one, which is what keeps the document listener
          // from seeing this. (Same shape AttachRemoteModal already uses for
          // its backdrop.)
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className={`w-full flex items-center px-2.5 py-1.5 text-xs text-left rounded-[5px] transition-colors hover:bg-[color-mix(in_srgb,var(--accent-blue)_14%,transparent)] ${FOCUS_RING}`}
            style={{ color: 'var(--text-main)' }}
            onClick={() => {
              setEditName(workspace.label || workspace.name || '');
              setEditing(true);
              setMenuPos(null);
            }}
          >
            {t('workspace.rename')}
          </button>
          {/* #1086 — color tag: the same palette and grammar as WorkspaceItem,
              stored as a LOCAL alias on the attachment descriptor. */}
          <div className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            {t('workspace.colorTag')}
          </div>
          <div className="flex flex-wrap gap-1 px-2.5 pb-1.5" role="group" aria-label={t('workspace.colorTag')}>
            <button
              type="button"
              data-remote-color-none
              className={`w-4 h-4 rounded-full border transition-transform hover:scale-110 ${FOCUS_RING} ${!workspace.color ? 'border-[var(--text-main)]' : 'border-transparent'}`}
              style={{ backgroundColor: 'var(--text-muted)' }}
              title={t('workspace.colorNone')}
              aria-label={t('workspace.colorNone')}
              onClick={() => { setRemoteWorkspaceColor(workspace.key, undefined); setMenuPos(null); }}
            />
            {WORKSPACE_COLOR_IDS.map((id) => {
              const selected = normalizeWorkspaceColor(workspace.color) === id;
              return (
                <button
                  type="button"
                  key={id}
                  data-remote-color={id}
                  className={`w-4 h-4 rounded-full border transition-transform hover:scale-110 ${FOCUS_RING} ${selected ? 'border-[var(--text-main)]' : 'border-transparent'}`}
                  style={{ backgroundColor: workspaceColorHex(id) }}
                  title={t(workspaceColorLabelKey(id))}
                  aria-label={t(workspaceColorLabelKey(id))}
                  aria-pressed={selected}
                  onClick={() => { setRemoteWorkspaceColor(workspace.key, id); setMenuPos(null); }}
                />
              );
            })}
          </div>
          <button
            type="button"
            className={`w-full flex items-center px-2.5 py-1.5 text-xs text-left rounded-[5px] transition-colors hover:bg-[color-mix(in_srgb,var(--accent-blue)_14%,transparent)] ${FOCUS_RING}`}
            style={{ color: 'var(--text-main)' }}
            onClick={() => { onDetach(workspace.key); setMenuPos(null); }}
          >
            {t('remote.detach')}
          </button>
        </div>
      )}
    </div>
  );
}
