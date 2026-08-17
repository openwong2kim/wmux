import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../stores';
import { selectActiveWorkspace } from '../../stores/selectors/workspaceProjections';
import { useT } from '../../hooks/useT';
import { parsePorcelain, type GitStatusCode } from '../../../shared/gitStatus';
import { findActiveLeaf } from '../../utils/focusedSurface';
import { injectText, quotePathsForPrompt } from './inject';
import { placePopover } from './placePopover';

interface Entry { name: string; path: string; isDirectory: boolean; isSymlink: boolean; }

// All four tokens exist in globals.css across all themes — no substitution needed.
const BADGE_COLOR: Record<GitStatusCode, string> = {
  M: 'var(--accent-yellow)',
  A: 'var(--accent-blue)',
  U: 'var(--accent-green)',
  D: 'var(--accent-red)',
  R: 'var(--accent-blue)',
};

interface FileExplorerPopoverProps {
  /** Pane surface cwd. Falls back to the active workspace cwd. */
  cwd?: string;
  ptyId: string;
  onClose: () => void;
}

export default function FileExplorerPopover({ cwd: cwdProp, ptyId, onClose }: FileExplorerPopoverProps) {
  const t = useT();

  // A1: 활성 ws OBJECT만 구독한다. 셀렉터는 새 객체를 만들지 않고 immer가
  // 관리하는 ws 참조를 그대로 돌려주므로 Object.is 스냅샷 검사를 통과한다(무한
  // 루프 없음). 배경 ws의 metadata/surface churn에는 리렌더되지 않는다.
  const ws = useStore(selectActiveWorkspace);
  let cwd: string | undefined = cwdProp;
  if (!cwd) cwd = ws?.metadata?.cwd;
  if (ws && !cwd) {
    const leaf = findActiveLeaf(ws);
    cwd = leaf?.surfaces.find((surf) => surf.id === leaf.activeSurfaceId)?.cwd || undefined;
  }

  const [entries, setEntries] = useState<Entry[]>([]);
  const [statusByRel, setStatusByRel] = useState<Record<string, GitStatusCode>>({});

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!cwd) {
      // Clear stale listing/badges when the cwd becomes unavailable.
      setEntries([]);
      setStatusByRel({});
      return;
    }
    let cancelled = false;

    const fsApi = window.electronAPI.fs;
    if (fsApi) {
      void fsApi.readDir(cwd)
        .then((list) => { if (!cancelled) setEntries(list as Entry[]); })
        .catch(() => { if (!cancelled) setEntries([]); });
    }

    void window.electronAPI.git.status(cwd)
      .then((out) => {
        if (cancelled) return;
        const map: Record<string, GitStatusCode> = {};
        for (const { path, code } of parsePorcelain(out)) {
          map[path.replace(/\\/g, '/')] = code;
        }
        setStatusByRel(map);
      })
      .catch(() => { if (!cancelled) setStatusByRel({}); });

    return () => { cancelled = true; };
  }, [cwd]);

  // Match git-status entries by their exact (forward-slashed) relative path, or
  // a directory whose subtree contains a change. No basename fallback: a bare
  // filename match could badge the wrong same-named file from another directory.
  const badgeFor = useCallback((name: string): GitStatusCode | undefined => {
    if (statusByRel[name]) return statusByRel[name];
    for (const rel of Object.keys(statusByRel)) {
      if (rel === name || rel.startsWith(name + '/')) return statusByRel[rel];
    }
    return undefined;
  }, [statusByRel]);

  const insertPath = (path: string) => {
    if (ptyId) void injectText(ptyId, quotePathsForPrompt([path]), false);
    onClose();
  };

  const anchor = document.querySelector('[data-pane-action="attach"]')?.getBoundingClientRect() ?? null;
  const pos = placePopover(anchor, { width: 320, height: 320 });

  return createPortal(
    <div
      className="fixed w-80 max-h-80 overflow-y-auto rounded-[7px] border border-[var(--accent-blue)] bg-[var(--bg-mantle)] shadow-xl p-1 font-mono text-xs"
      style={{ top: pos.top, left: pos.left, zIndex: 'var(--z-popover-top)' }}
      data-testid="file-explorer"
    >
      {!cwd && (
        <p className="text-[var(--text-muted)] px-2 py-2">{t('toolbar.noWorkingDir')}</p>
      )}
      {entries.map((e) => {
        const badge = e.isDirectory ? undefined : badgeFor(e.name);
        return (
          <button
            key={e.path}
            className="flex items-center w-full text-left px-2 py-0.5 rounded hover:bg-[var(--bg-surface)] text-[var(--text-sub)] hover:text-[var(--text-main)] disabled:opacity-60"
            onClick={() => { if (!e.isDirectory) insertPath(e.path); }}
            disabled={e.isDirectory}
            title={e.path}
          >
            <span className="mr-1.5">{e.isDirectory ? '📁' : '📄'}</span>
            <span className="truncate flex-1">{e.name}</span>
            {badge && (
              <span className="ml-2 font-bold" style={{ color: BADGE_COLOR[badge] }}>{badge}</span>
            )}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
