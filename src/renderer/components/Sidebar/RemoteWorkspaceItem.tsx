import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import type { AttachedRemoteWorkspace } from '../../stores/slices/remoteWorkspacesSlice';

interface RemoteWorkspaceItemProps {
  workspace: AttachedRemoteWorkspace;
  isActive: boolean;
  onSelect: (key: string) => void;
  onDetach: (key: string) => void;
}

/**
 * Sidebar row for one attached remote workspace. Selected state mirrors
 * WorkspaceItem's. The context menu has a single item, "Detach" — never
 * "Close": detaching a mirror does not destroy anything on the remote host,
 * so the wording must not read as destructive.
 */
export default function RemoteWorkspaceItem({ workspace, isActive, onSelect, onDetach }: RemoteWorkspaceItemProps) {
  const t = useT();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

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

  return (
    <div className="relative mx-2">
      <div
        role="button"
        tabIndex={0}
        aria-pressed={isActive}
        className={`group sidebar-row px-3 py-1 cursor-pointer rounded-md select-none ${
          isActive
            ? 'sidebar-row-active text-[var(--text-main)]'
            : 'text-[var(--text-subtle)] hover:bg-[rgba(var(--bg-surface-rgb),0.5)] hover:text-[var(--text-sub)]'
        }`}
        onClick={() => onSelect(workspace.key)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(workspace.key);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <div
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: isActive && !workspace.stale ? 'var(--accent)' : 'var(--text-muted)' }}
          />
          <div className="flex-1 min-w-0">
            <div className="text-caption font-mono truncate">
              {workspace.name || workspace.workspaceId.slice(0, 8)}
            </div>
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
          className="fixed z-[var(--z-popover-top)] min-w-[140px] p-[5px]"
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
            className="w-full flex items-center px-2.5 py-1.5 text-xs text-left rounded-[5px] transition-colors hover:bg-[color-mix(in_srgb,var(--accent-blue)_14%,transparent)]"
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
