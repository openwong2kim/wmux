import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../../stores';
import { parsePorcelain, type GitStatusCode } from '../../../shared/gitStatus';
import { findActiveLeaf } from '../../utils/focusedSurface';

interface Entry { name: string; path: string; isDirectory: boolean; isSymlink: boolean; }

// All four tokens exist in globals.css across all themes — no substitution needed.
const BADGE_COLOR: Record<GitStatusCode, string> = {
  M: 'var(--accent-yellow)',
  A: 'var(--accent-blue)',
  U: 'var(--accent-green)',
  D: 'var(--accent-red)',
  R: 'var(--accent-blue)',
};

export default function FileExplorerPopover() {
  const addEditorSurface = useStore((s) => s.addEditorSurface);
  const setPopover = useStore((s) => s.setToolbarPopover);

  // Derive cwd + activePaneId reactively from the store.
  const { cwd, activePaneId } = useStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    if (!ws) return { cwd: undefined as string | undefined, activePaneId: undefined as string | undefined };
    let resolvedCwd: string | undefined = ws.metadata?.cwd;
    if (!resolvedCwd) {
      const leaf = findActiveLeaf(ws);
      const surface = leaf?.surfaces.find((surf) => surf.id === leaf.activeSurfaceId);
      resolvedCwd = surface?.cwd || undefined;
    }
    return { cwd: resolvedCwd, activePaneId: ws.activePaneId };
  });

  const [entries, setEntries] = useState<Entry[]>([]);
  const [statusByRel, setStatusByRel] = useState<Record<string, GitStatusCode>>({});

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;

    const fsApi = window.electronAPI.fs;
    if (fsApi) {
      void fsApi.readDir(cwd).then((list) => {
        if (!cancelled) setEntries(list as Entry[]);
      });
    }

    void window.electronAPI.git.status(cwd).then((out) => {
      if (cancelled) return;
      const map: Record<string, GitStatusCode> = {};
      for (const { path, code } of parsePorcelain(out)) {
        map[path.replace(/\\/g, '/')] = code;
      }
      setStatusByRel(map);
    });

    return () => { cancelled = true; };
  }, [cwd]);

  const badgeFor = useCallback((name: string): GitStatusCode | undefined => {
    if (statusByRel[name]) return statusByRel[name];
    for (const rel of Object.keys(statusByRel)) {
      const base = rel.split('/').pop();
      if (rel === name || base === name || rel.startsWith(name + '/')) return statusByRel[rel];
    }
    return undefined;
  }, [statusByRel]);

  const openFile = (path: string) => {
    if (activePaneId) addEditorSurface(activePaneId, path);
    setPopover(null);
  };

  return (
    <div
      className="absolute bottom-full left-24 mb-1 w-80 max-h-80 overflow-y-auto rounded-lg border border-[var(--accent-blue)] bg-[var(--bg-mantle)] shadow-xl z-50 p-1 font-mono text-xs"
      data-testid="file-explorer"
    >
      {!cwd && (
        <p className="text-[var(--text-muted)] px-2 py-2">No working directory.</p>
      )}
      {entries.map((e) => {
        const badge = e.isDirectory ? undefined : badgeFor(e.name);
        return (
          <button
            key={e.path}
            className="flex items-center w-full text-left px-2 py-0.5 rounded hover:bg-[var(--bg-surface)] text-[var(--text-sub)] hover:text-[var(--text-main)] disabled:opacity-60"
            onClick={() => { if (!e.isDirectory) openFile(e.path); }}
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
    </div>
  );
}
