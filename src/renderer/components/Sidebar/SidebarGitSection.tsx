// ─── Sidebar Git section (2026-10-03) ────────────────────────────────────────
//
// The tools panel's Git tab, moved to the foot of the sidebar: a header band
// ("Git · <repo>", refresh, collapse) over the active repo's body (GitTab).
// The workspace list keeps the rest of the column: the section is never taller
// than 45% of the sidebar and scrolls inside itself. Its top edge drags to
// resize; the height and the collapsed state are remembered per user.
//
// Collapsed, the body is not mounted, so nothing reads git or polls the PR
// host — the same "only while visible" rule the tab had. The folded header
// then sums up the active workspace from the git status main already pushes
// (branch · +A −R · PR #n and its CI dot), so it costs nothing to keep.
//
// Later sections (issues, PR filters) hang off this header and body.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import type { StoreState } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconChevron, IconRefresh } from '../icons';
import { GitTab } from '../Git/GitTab';
import { SIDEBAR_GIT_DEFAULT_HEIGHT, SIDEBAR_GIT_MAX_SHARE, SIDEBAR_GIT_MIN_HEIGHT, clampSidebarGitHeight } from '../../utils/sidebarLayout';

const KEY_STEP = 16;

/** Pure: the height a drag lands on. Dragging the top edge up (negative dy) grows it. */
export function gitHeightForDrag(startHeight: number, deltaY: number, available?: number): number {
  return clampSidebarGitHeight(startHeight - deltaY, available);
}

export interface GitHeaderSummary {
  branch: string;
  added: number;
  removed: number;
  pr: number | null;
  checks: 'pending' | 'passing' | 'failing' | null;
}

/** The folded header's line, from the active workspace's pushed metadata; null outside a repo. */
export function selectGitHeaderSummary(s: StoreState): GitHeaderSummary | null {
  const m = s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.metadata;
  if (!m?.gitBranch) return null;
  return {
    branch: m.gitBranch,
    added: m.gitSync?.added ?? 0,
    removed: m.gitSync?.removed ?? 0,
    pr: m.pr?.number ?? null,
    checks: m.pr?.checks ?? null,
  };
}

const CHECKS_COLOR = {
  passing: 'var(--accent-green)',
  pending: 'var(--accent-yellow)',
  failing: 'var(--accent-red)',
} as const;

export default function SidebarGitSection() {
  const t = useT();
  const collapsed = useStore((s) => s.sidebarGitCollapsed);
  const height = useStore((s) => s.sidebarGitHeight);
  const setCollapsed = useStore((s) => s.setSidebarGitCollapsed);
  const setHeight = useStore((s) => s.setSidebarGitHeight);
  const [repo, setRepo] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const summary = useStore(useShallow((s) => (collapsed ? selectGitHeaderSummary(s) : null)));
  const sectionRef = useRef<HTMLElement>(null);
  // The sidebar's height, for the separator's value range (the 45% share).
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const parent = sectionRef.current?.parentElement;
    if (!parent) return;
    setRoom(parent.getBoundingClientRect().height);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setRoom(parent.getBoundingClientRect().height));
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);
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
  const maxHeight = room > 0 ? Math.max(SIDEBAR_GIT_MIN_HEIGHT, Math.floor(room * SIDEBAR_GIT_MAX_SHARE)) : Math.max(height, SIDEBAR_GIT_MIN_HEIGHT);
  const shownHeight = Math.min(dragHeight ?? height, maxHeight);

  return (
    <section
      ref={sectionRef}
      className="wmux-git-section"
      data-sidebar-git
      data-collapsed={collapsed ? 'true' : undefined}
      aria-label={title}
      // The stored height is a ceiling, not a size: a section with one line
      // to show (no repo) stays one line. CSS also caps it at 45% of the sidebar.
      style={collapsed ? undefined : ({ '--git-h': `${dragHeight ?? height}px` } as React.CSSProperties)}
    >
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('sidebar.git.resize')}
          title={t('sidebar.git.resize')}
          aria-valuemin={SIDEBAR_GIT_MIN_HEIGHT}
          aria-valuemax={maxHeight}
          aria-valuenow={Math.round(shownHeight)}
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
        <span className="wmux-git-title" data-sidebar-git-title>
          <span className="shrink-0">{title}</span>
          {!collapsed && repo && (
            <>
              <span className="wmux-git-repo shrink-0">{' · '}</span>
              <span className="wmux-git-repo truncate">{repo}</span>
            </>
          )}
          {collapsed && summary && (
            // The branch gives way first, so the changes and the PR stay readable.
            <span className="wmux-git-repo wmux-git-summary" data-sidebar-git-summary>
              <span className="shrink-0">{' · '}</span>
              <span className="wmux-git-summary-branch truncate">{summary.branch}</span>
              <span className="shrink-0">
                {(summary.added > 0 || summary.removed > 0) && (
                  <>
                    {' · '}
                    {summary.added > 0 && <span style={{ color: 'var(--accent-green)' }}>+{summary.added}</span>}
                    {summary.added > 0 && summary.removed > 0 && ' '}
                    {summary.removed > 0 && <span style={{ color: 'var(--accent-red)' }}>−{summary.removed}</span>}
                  </>
                )}
                {summary.pr !== null && (
                  <>
                    {' · '}PR #{summary.pr}
                    {summary.checks && (
                      <span
                        className="wmux-git-ci-dot"
                        data-ci={summary.checks}
                        style={{ background: CHECKS_COLOR[summary.checks] }}
                        title={t(`workspace.prChecks.${summary.checks}`)}
                        role="img"
                        aria-label={t(`workspace.prChecks.${summary.checks}`)}
                      />
                    )}
                  </>
                )}
              </span>
            </span>
          )}
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
          onClick={() => {
            // The body reports the repo again when it remounts; a name kept
            // from before the fold could belong to another repo by then.
            if (!collapsed) setRepo(null);
            setCollapsed(!collapsed);
          }}
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
