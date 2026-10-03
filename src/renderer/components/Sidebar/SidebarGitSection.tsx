// ─── Sidebar Git section (2026-10-03) ────────────────────────────────────────
//
// The tools panel's Git tab, moved to the foot of the sidebar: a header band
// ("Git · <repo>", refresh, collapse) over the active repo's body (GitTab).
// The workspace list keeps the rest of the column: the section is never taller
// than 45% of the sidebar and scrolls inside itself. Its top edge drags to
// resize; the height and the collapsed state are remembered per user.
//
// Collapsed, the body is not mounted, so nothing reads git or polls the PR
// host — the same "only while visible" rule the tab had.
//
// Later sections (issues, PR filters) hang off this header and body.

import { useCallback, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconChevron, IconRefresh } from '../icons';
import { GitTab } from '../Git/GitTab';
import { SIDEBAR_GIT_DEFAULT_HEIGHT, clampSidebarGitHeight } from '../../utils/sidebarLayout';

const KEY_STEP = 16;

/** Pure: the height a drag lands on. Dragging the top edge up (negative dy) grows it. */
export function gitHeightForDrag(startHeight: number, deltaY: number, available?: number): number {
  return clampSidebarGitHeight(startHeight - deltaY, available);
}

export default function SidebarGitSection() {
  const t = useT();
  const collapsed = useStore((s) => s.sidebarGitCollapsed);
  const height = useStore((s) => s.sidebarGitHeight);
  const setCollapsed = useStore((s) => s.setSidebarGitCollapsed);
  const setHeight = useStore((s) => s.setSidebarGitHeight);
  const [repo, setRepo] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);
  const drag = useRef<{ startY: number; startHeight: number; available: number } | null>(null);
  // A live drag is fine here: the sidebar's own split moves no terminal.
  const [dragHeight, setDragHeight] = useState<number | null>(null);

  const available = () => sectionRef.current?.parentElement?.getBoundingClientRect().height ?? 0;

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const shown = sectionRef.current?.getBoundingClientRect().height || height;
    drag.current = { startY: e.clientY, startHeight: shown, available: available() };
  }, [height]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setDragHeight(gitHeightForDrag(d.startHeight, e.clientY - d.startY, d.available));
  }, []);

  const abort = useCallback(() => {
    drag.current = null;
    setDragHeight(null);
  }, []);

  const finish = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragHeight(null);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setHeight(gitHeightForDrag(d.startHeight, e.clientY - d.startY, d.available));
  }, [setHeight]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const shown = sectionRef.current?.getBoundingClientRect().height || height;
    const room = available();
    if (e.key === 'ArrowUp') setHeight(clampSidebarGitHeight(shown + KEY_STEP, room));
    else if (e.key === 'ArrowDown') setHeight(clampSidebarGitHeight(shown - KEY_STEP, room));
    else if (e.key === 'Enter') setHeight(SIDEBAR_GIT_DEFAULT_HEIGHT);
    else return;
    e.preventDefault();
  }, [height, setHeight]);

  const title = t('deck.tabGit') || 'Git';
  const toggleLabel = collapsed ? t('sidebar.git.expand') : t('sidebar.git.collapse');

  return (
    <section
      ref={sectionRef}
      className="wmux-git-section"
      data-sidebar-git
      data-collapsed={collapsed ? 'true' : undefined}
      aria-label={title}
      // Capped at 45% of the sidebar in CSS, whatever the stored height says.
      style={collapsed ? undefined : { height: dragHeight ?? height }}
    >
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('sidebar.git.resize')}
          title={t('sidebar.git.resize')}
          tabIndex={0}
          className={`wmux-git-resize ${FOCUS_RING}`}
          data-sidebar-git-resize
          data-dragging={dragHeight !== null ? 'true' : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={abort}
          onLostPointerCapture={abort}
          onDoubleClick={() => setHeight(SIDEBAR_GIT_DEFAULT_HEIGHT)}
          onKeyDown={onKeyDown}
        />
      )}
      <div className="wmux-sidebar-section wmux-git-header">
        <span className="truncate" data-sidebar-git-title>
          {title}{repo && <span className="wmux-git-repo"> · {repo}</span>}
        </span>
        {!collapsed && (
          <button
            type="button"
            className={`ui-icon-btn ml-auto h-7 w-7 ${FOCUS_RING}`}
            onClick={() => setRefreshKey((k) => k + 1)}
            title={t('git.refresh')}
            aria-label={t('git.refresh')}
            data-sidebar-git-refresh
          ><IconRefresh size={14} /></button>
        )}
        <button
          type="button"
          className={`ui-icon-btn ${collapsed ? 'ml-auto ' : ''}h-7 w-7 wmux-git-collapse ${FOCUS_RING}`}
          onClick={() => setCollapsed(!collapsed)}
          title={toggleLabel}
          aria-label={toggleLabel}
          aria-expanded={!collapsed}
          data-sidebar-git-toggle
        ><IconChevron size={14} /></button>
      </div>
      {!collapsed && <GitTab refreshKey={refreshKey} onRepo={setRepo} />}
    </section>
  );
}
