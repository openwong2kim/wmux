// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/app/shell/Sidebar.tsx), MIT License, Copyright (c) 2026 Nick
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { remoteWorkspaceDisplayName, type AttachedRemoteWorkspace } from '../../stores/slices/remoteWorkspacesSlice';
import { remoteWorkspaceAttentionClass } from '../../stores/selectors/fleet';
import {
  WORKSPACE_COLOR_IDS,
  normalizeWorkspaceColor,
  workspaceColorHex,
  workspaceColorLabelKey,
} from '../../../shared/workspaceColors';
import { FOCUS_RING } from '../focusRing';
import { IconServer } from '../icons';

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

  const displayName = remoteWorkspaceDisplayName(workspace);
  const hostName = workspace.hostLabel || t('remote.hostFallback');
  // Needs HTTPS wins over a rejected credential: the token is not even sent.
  const rejectedText = workspace.insecureTransport
    ? t('remote.insecureHost', { host: hostName })
    : workspace.authRejected
      ? t('remote.authRejected', { host: hostName })
      : null;
  const tagHex = workspaceColorHex(normalizeWorkspaceColor(workspace.color));
  // The row sorts by this class (Sidebar), so it must also say it: a mirror
  // lifted to the top with no visible reason reads as a sorting bug.
  const needsYou = remoteWorkspaceAttentionClass(workspace) === 'needsYou';

  return (
    <div className="relative mx-2">
      <div
        role="button"
        tabIndex={0}
        aria-pressed={isActive}
        aria-label={rejectedText ? `${displayName} — ${rejectedText}` : `${displayName} — ${hostName}`}
        // Card states are painted by the .wmux-sidebar .sidebar-row rules (ui.css).
        className={`group sidebar-row px-2.5 py-2 cursor-pointer rounded-md select-none ${needsYou ? 'sidebar-row-needs' : ''} ${
          isActive ? 'sidebar-row-active' : ''
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
          // A double-click INSIDE the rename input (word select) bubbles here;
          // re-seeding the draft would discard what the user just typed.
          if (editing) return;
          setEditName(workspace.label || workspace.name || '');
          setEditing(true);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
      >
        {/* A stale mirror is dimmed (the convention for "not live"); only the
            content, so a selected stale row keeps its selection legible. */}
        <div className={`flex min-w-0 items-center gap-2 ${workspace.stale ? 'opacity-60' : ''}`} data-remote-stale={workspace.stale ? '' : undefined}>
          {/* #1086 — the color tag rides the same dot grammar as local rows:
              identity, filled, one dot. Untagged rows keep the status dot. */}
          <div
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={tagHex
              ? { backgroundColor: tagHex }
              : { backgroundColor: needsYou ? 'var(--accent-yellow)' : isActive && !workspace.stale ? 'var(--accent)' : 'var(--text-muted)' }}
          />
          <div className="flex-1 min-w-0">
            {editing ? (
              <input
                ref={inputRef}
                data-remote-rename-input
                className="ui-mini-input w-full text-caption font-mono bg-transparent border border-[var(--accent-blue)] rounded-md px-1"
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
                the user detaches) but drops to a fainter metadata tone and says
                why on hover. */}
            <div
              className="mt-0.5 flex items-center gap-1 text-[11px] font-mono min-w-0"
              style={{ color: workspace.stale || workspace.insecureTransport ? 'color-mix(in srgb, var(--text-main) 35%, transparent)' : 'color-mix(in srgb, var(--text-main) 45%, transparent)' }}
              title={rejectedText ?? (workspace.stale ? t('remote.disconnected') : undefined)}
            >
              {/* "On another machine" at a glance, now that remote rows share
                  the local list. Muted, so it spends no amber. */}
              <span className="flex-shrink-0" style={{ color: 'var(--text-muted)' }} data-remote-host-glyph><IconServer size={10} /></span>
              <span className="truncate">
                {hostName}
                {/* Not only a tooltip: a host that refused this computer will not
                    come back on its own, so the row says so where it is read. */}
                {rejectedText && ` · ${workspace.insecureTransport ? t('remote.needsHttps') : t('remote.needsPairing')}`}
              </span>
            </div>
          </div>
          {needsYou && (
            <span className={`font-sans text-[11px] font-medium text-[var(--accent-yellow)] flex-shrink-0 ${isActive ? '' : 'group-hover:hidden'}`} data-remote-needs-you>
              {t('workspace.needsYou')}
            </span>
          )}
        </div>
      </div>

      {menuPos && (
        <div
          className="fixed z-[var(--z-popover-top)] min-w-[160px] p-1"
          style={{
            left: menuPos.x,
            top: menuPos.y,
            background: 'var(--bg-surface)',
            border: '1px solid var(--line)',
            borderRadius: 12,
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
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
            className={`w-full flex items-center px-2.5 py-1.5 text-xs text-left rounded-md transition-colors hover:bg-[var(--hover-fill)] ${FOCUS_RING}`}
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
            className={`w-full flex items-center px-2.5 py-1.5 text-xs text-left rounded-md transition-colors hover:bg-[var(--hover-fill)] ${FOCUS_RING}`}
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
