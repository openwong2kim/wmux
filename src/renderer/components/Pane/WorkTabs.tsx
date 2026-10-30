import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Surface } from '../../../shared/types';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { HIT_TARGET_24 } from '../hitArea';
import { IconLock } from '../icons';
import { isPrivateBrowserSurface } from '../../../shared/privateBrowser';
import { useStore } from '../../stores';
import { RENAME_ACTIVE_TAB_EVENT } from '../../utils/commandActions';
import { BrowserAgentTabMark } from '../Browser/BrowserAgentControls';

/**
 * The work area's tab strip (DESIGN.md "Pane: terminals and work area"): the
 * browser, editor and diff tabs of a pane that also holds terminals. It sits on
 * the pane header's line, to the right of the terminal tabs, split at the same
 * place the body is, and uses the pane strip's tab grammar.
 */
export function workTabTitle(
  surface: Pick<Surface, 'title' | 'surfaceType' | 'editorFilePath' | 'previewFilePath'>,
  browserLabel: string,
): string {
  if (surface.title) return surface.title;
  const filePath = surface.surfaceType === 'editor' ? surface.editorFilePath
    : surface.surfaceType === 'preview' ? surface.previewFilePath : undefined;
  if (filePath) return filePath.split(/[\\/]/).pop() || filePath;
  return browserLabel;
}

/** A pane with its terminal column drawn on the left; the column drops away
 *  while the work area fills the pane. */
function IconWorkExpand({ expanded }: { expanded: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.8" y="2.6" width="10.4" height="8.8" rx="1" />
      {!expanded && <line x1="5.4" y1="2.6" x2="5.4" y2="11.4" />}
    </svg>
  );
}

export default function WorkTabs({
  surfaces,
  shownId,
  paneActive,
  focused,
  expanded,
  readOnly,
  tailGap,
  style,
  onSelect,
  onClose,
  onToggleExpanded,
  workspaceId,
  paneId,
}: {
  surfaces: ReadonlyArray<Surface>;
  /** The work tab drawn in the work area (focused or last shown). */
  shownId: string | undefined;
  paneActive: boolean;
  /** The pane's focus is on a work tab: the accent bar moves here. */
  focused: boolean;
  expanded: boolean;
  readOnly: boolean;
  /** Room left at the right end for the corner zoom control (no cluster). */
  tailGap: number;
  style?: CSSProperties;
  onSelect: (surfaceId: string) => void;
  onClose: (surfaceId: string) => void;
  onToggleExpanded: () => void;
  workspaceId: string;
  paneId: string;
}) {
  const t = useT();
  const updateSurfaceTitle = useStore((s) => s.updateSurfaceTitle);
  const resetSurfaceTitle = useStore((s) => s.resetSurfaceTitle);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const cancelRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const startRename = (s: Surface) => {
    if (readOnly) return;
    setEditName(s.title || '');
    setEditingId(s.id);
  };
  const commitRename = (surfaceId: string) => {
    if (cancelRef.current) {
      cancelRef.current = false;
      setEditingId(null);
      return;
    }
    const trimmed = editName.trim();
    if (trimmed) updateSurfaceTitle(surfaceId, trimmed);
    else resetSurfaceTitle(surfaceId);
    setEditingId(null);
  };
  useEffect(() => {
    if (editingId) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingId]);
  // The renameTab action renames the focused tab of the focused pane; while
  // that focus is on a work tab, this strip answers (the terminal strip stands
  // down, see SurfaceTabs' tabAccent).
  useEffect(() => {
    if (readOnly || !focused) return;
    const onRenameActiveTab = (): void => {
      const st = useStore.getState();
      const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId);
      if (!ws || ws.id !== workspaceId || ws.activePaneId !== paneId) return;
      const target = surfaces.find((s) => s.id === shownId);
      if (target) {
        setEditName(target.title || '');
        setEditingId(target.id);
      }
    };
    document.addEventListener(RENAME_ACTIVE_TAB_EVENT, onRenameActiveTab);
    return () => document.removeEventListener(RENAME_ACTIVE_TAB_EVENT, onRenameActiveTab);
  }, [readOnly, focused, workspaceId, paneId, surfaces, shownId]);
  const expandLabel = expanded ? t('pane.showTerminal') : t('pane.expandWork');
  return (
    <div
      data-work-tabs
      data-pane-focused={paneActive && focused ? 'true' : undefined}
      className="wmux-pane-header flex items-center h-10 min-w-0"
      style={{
        ...style,
        boxShadow: `inset 0 -1px 0 ${paneActive ? 'var(--line-strong)' : 'var(--stroke)'}`,
        paddingRight: tailGap,
      }}
    >
      {/* Tabs shrink (titles truncate) before the list overflows; past that it
          scrolls without a bar, which would otherwise take 6px of the 40px
          line and lift the tabs off the strip's bottom edge. */}
      <div className="wmux-surface-tablist flex items-center gap-1 px-1 flex-1 min-w-0 overflow-x-auto h-full [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist">
        {surfaces.map((s) => {
          const title = workTabTitle(s, s.surfaceType === 'board' ? t('company.board') : t('browser.title'));
          const active = s.id === shownId;
          return (
            <div
              key={s.id}
              role="tab"
              aria-selected={active}
              data-active={active ? 'true' : undefined}
              data-work-tab-id={s.id}
              className={`wmux-surface-tab group flex items-center gap-2 pl-3 pr-3 min-w-[72px] cursor-pointer text-[13px] transition-colors ${
                active
                  ? 'text-[var(--text-main)]'
                  : 'text-[color-mix(in_srgb,var(--text-main)_50%,transparent)] hover:text-[var(--text-main)] hover:bg-[var(--hover-fill)]'
              }`}
              title={s.surfaceType === 'browser' ? (s.browserUrl || title) : (s.editorFilePath || s.previewFilePath || title)}
              onClick={() => onSelect(s.id)}
              onDoubleClick={readOnly ? undefined : () => startRename(s)}
            >
              {s.surfaceType === 'browser' && <BrowserAgentTabMark surfaceId={s.id} />}
              {isPrivateBrowserSurface(s) && (
                <span className="shrink-0" role="img" aria-label={t('browser.privateTab')}>
                  <IconLock size={12} />
                </span>
              )}
              {editingId === s.id ? (
                <input
                  ref={inputRef}
                  data-work-tab-rename
                  className="ui-mini-input text-[var(--text-main)] text-xs font-mono px-1 py-0 border border-[var(--text-muted)] max-w-[120px]"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={() => commitRename(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(s.id);
                    if (e.key === 'Escape') {
                      cancelRef.current = true;
                      setEditingId(null);
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="truncate min-w-0 max-w-[120px]">{title}</span>
              )}
              {!readOnly && (
                <button
                  data-work-tab-close
                  className={`${HIT_TARGET_24} ${FOCUS_RING} ui-icon-btn ui-icon-btn-danger -mr-1.5 leading-none`}
                  onClick={(e) => { e.stopPropagation(); onClose(s.id); }}
                  title={t('surface.closeTabNamed', { name: title })}
                  aria-label={t('surface.closeTabNamed', { name: title })}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>
      {!readOnly && (
        <button
          data-work-expand
          className={`ui-icon-btn ${FOCUS_RING} w-6 h-6 shrink-0 mr-1 flex items-center justify-center ${expanded ? 'ui-icon-btn-active' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggleExpanded(); }}
          title={expandLabel}
          aria-label={expandLabel}
          aria-pressed={expanded}
        >
          <IconWorkExpand expanded={expanded} />
        </button>
      )}
    </div>
  );
}
