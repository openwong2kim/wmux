import { useState, useCallback, useEffect, useRef } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { selectActiveWorkspace } from '../../stores/selectors/workspaceProjections';
import { selectRemoteScopeName } from '../Git/thisComputerOnly';
import { findLeaf } from '../../../shared/paneUtils';
import type { Pane, Surface, Workspace } from '../../../shared/types';
import { IconChevron, IconFile, IconFolder, IconRefresh, IconSearch, IconX } from '../icons';
import { FOCUS_RING } from '../focusRing';
import { insertPathsIntoPty } from '../AgentToolbar/inject';
import { tokenAttrs } from '../../themes';
import FileTreeResizeHandle from './FileTreeResizeHandle';
import { filterTree, FILTER_SCAN_LIMIT, type FilterResult } from './fileTreeFilter';
import { isPreviewablePath } from '../../../shared/filePreview';

interface FileTreePanelProps {
  /** The window edge the column sits on: the one opposite the sidebar. */
  position: 'left' | 'right';
}

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  children?: TreeNode[];
  isExpanded?: boolean;
  isLoading?: boolean;
  /** Set in a filtered tree on an entry whose own name matched. */
  matched?: boolean;
}

async function readDir(dirPath: string): Promise<TreeNode[]> {
  try {
    const api = window.electronAPI?.fs;
    if (!api?.readDir) return [];
    const entries: { name: string; path: string; isDirectory: boolean; isSymlink: boolean }[] =
      await api.readDir(dirPath);
    return entries
      .map((e) => ({
        name: e.name,
        path: e.path,
        isDirectory: e.isDirectory,
        isSymlink: e.isSymlink,
      }))
      .sort((a, b) => {
        // directories first, then alphabetical
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    return [];
  }
}

function separatorOf(p: string): string {
  return p.includes('/') ? '/' : '\\';
}

function basename(p: string): string {
  const sep = separatorOf(p);
  return p.split(sep).filter(Boolean).pop() ?? p;
}

function dirname(p: string): string {
  const sep = separatorOf(p);
  const i = p.lastIndexOf(sep);
  return i > 0 ? p.slice(0, i) : p;
}

/** `target` relative to `base`, or `target` itself when it is not under it. */
export function relativeTo(base: string, target: string): string {
  const sep = separatorOf(target);
  const prefix = base.endsWith(sep) ? base : base + sep;
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
}

/**
 * The surface of a pane the tree follows: the active one when it is a local
 * terminal, otherwise (an editor, browser or diff tab, which has no cwd or
 * PTY) the pane's first local terminal, so opening a file does not move the
 * tree away from the pane's folder.
 */
function anchorSurface(pane: Pane | null): Surface | undefined {
  if (!pane || pane.type !== 'leaf') return undefined;
  const active = pane.surfaces?.find((s) => s.id === pane.activeSurfaceId);
  if (active?.ptyId) return active;
  return pane.surfaces?.find((s) => s.ptyId) ?? active;
}

function surfaceCwd(pane: Pane | null): string | undefined {
  return anchorSurface(pane)?.cwd || undefined;
}

function firstLeafCwd(pane: Pane): string | undefined {
  if (pane.type === 'leaf') return surfaceCwd(pane);
  for (const child of pane.children) {
    const found = firstLeafCwd(child);
    if (found) return found;
  }
  return undefined;
}

/**
 * The folder the tree starts from: the focused pane's working directory, so
 * the tree follows the pane you are working in. Then the workspace's own
 * folder, then any pane's.
 */
export function fileTreeCwd(ws: Workspace | null | undefined): string | undefined {
  if (!ws) return undefined;
  return surfaceCwd(findLeaf(ws.rootPane, ws.activePaneId)) || ws.metadata?.cwd || firstLeafCwd(ws.rootPane);
}

function activePtyId(ws: Workspace | null | undefined): string | undefined {
  if (!ws) return undefined;
  return anchorSurface(findLeaf(ws.rootPane, ws.activePaneId))?.ptyId || undefined;
}

/**
 * Whether `target` is `base` itself or a path below it. Separators are unified
 * and drive paths compared case-insensitively, since on Windows git reports
 * `C:/repo` for a pane whose cwd reads `c:\repo\sub`.
 */
export function isAtOrUnder(base: string | undefined, target: string): boolean {
  if (!base) return false;
  const norm = (p: string) => {
    const unified = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[a-z]:/i.test(unified) ? unified.toLowerCase() : unified;
  };
  const b = norm(base);
  const t = norm(target);
  return t === b || t.startsWith(b + '/');
}

/** The OS's own word for its file manager (same vocabulary as the sidebar's menu). */
function fileManagerKey(): 'workspace.finder' | 'workspace.fileExplorer' | 'workspace.fileManager' {
  const platform = window.electronAPI?.platform;
  if (platform === 'darwin') return 'workspace.finder';
  if (platform === 'win32') return 'workspace.fileExplorer';
  return 'workspace.fileManager';
}

const INDENT = 12;

/** The name with the query's first occurrence emphasised. */
function NameWithMatch({ name, query }: { name: string; query: string }) {
  const i = query ? name.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
  if (i < 0) return <>{name}</>;
  return (
    <>
      {name.slice(0, i)}
      <mark className="wmux-filetree-match">{name.slice(i, i + query.length)}</mark>
      {name.slice(i + query.length)}
    </>
  );
}

function TreeItem({
  node,
  depth,
  query,
  selectedPath,
  onFileClick,
  onToggle,
  onContextMenu,
}: {
  node: TreeNode;
  depth: number;
  query: string;
  selectedPath: string | null;
  onFileClick: (node: TreeNode) => void;
  onToggle: (node: TreeNode) => void;
  onContextMenu: (node: TreeNode, e: React.MouseEvent) => void;
}) {
  const setTerminalTextDropDragActive = useStore((s) => s.setTerminalTextDropDragActive);

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', node.path);
    e.dataTransfer.effectAllowed = 'copy';
    setTerminalTextDropDragActive(true);
  };

  const selected = selectedPath === node.path;

  return (
    <>
      <button
        type="button"
        role="treeitem"
        className={`wmux-filetree-row ${FOCUS_RING}`}
        style={{ paddingLeft: `${depth * INDENT + 6}px` }}
        onClick={() => (node.isDirectory ? onToggle(node) : onFileClick(node))}
        onContextMenu={(e) => onContextMenu(node, e)}
        title={node.path}
        draggable
        onDragStart={handleDragStart}
        onDragEnd={() => setTerminalTextDropDragActive(false)}
        aria-expanded={node.isDirectory ? !!node.isExpanded : undefined}
        aria-selected={selected}
        data-file-tree-row={node.isDirectory ? 'dir' : 'file'}
      >
        <span
          className="wmux-filetree-chevron"
          style={{ transform: node.isExpanded ? 'rotate(90deg)' : undefined, visibility: node.isDirectory ? undefined : 'hidden' }}
        >
          <IconChevron size={12} />
        </span>
        <span className="wmux-filetree-icon">
          {node.isDirectory ? <IconFolder size={14} /> : <IconFile size={14} />}
        </span>
        <span className="truncate">{node.matched ? <NameWithMatch name={node.name} query={query} /> : node.name}</span>
        {node.isSymlink && <span className="wmux-filetree-meta">&rarr;</span>}
      </button>
      {node.isDirectory && node.isExpanded && (
        node.isLoading ? (
          <div className="wmux-filetree-meta py-0.5" style={{ paddingLeft: `${(depth + 1) * INDENT + 24}px` }}>
            …
          </div>
        ) : (
          node.children?.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              query={query}
              selectedPath={selectedPath}
              onFileClick={onFileClick}
              onToggle={onToggle}
              onContextMenu={onContextMenu}
            />
          ))
        )
      )}
    </>
  );
}

export default function FileTreePanel({ position }: FileTreePanelProps) {
  const t = useT();
  // A1: subscribe to the active workspace OBJECT only (cwd / pane tree derive
  // from it), so background workspace churn does not re-render the tree.
  const activeWorkspace = useStore(selectActiveWorkspace);
  // PC rail: another computer on screen ('' while the roster has not named it).
  // Its folders are on that computer, so no path of it is read from this disk.
  const remoteScope = useStore(selectRemoteScopeName);
  const width = useStore((s) => s.fileTreeWidth);

  const cwd = remoteScope !== null ? undefined : fileTreeCwd(activeWorkspace);

  // Inside a git repository the tree starts at the repository's root, so a
  // pane that has cd'd into a subfolder still shows the whole project.
  const [root, setRoot] = useState<string | undefined>(cwd);
  useEffect(() => {
    if (!cwd) { setRoot(undefined); return; }
    // A cd within the current root keeps it until the repository is resolved,
    // so a move inside the same repo does not reload the tree twice.
    setRoot((prev) => (isAtOrUnder(prev, cwd) ? prev : cwd));
    const resolveRepo = window.electronAPI?.diff?.resolveRepo;
    if (!resolveRepo) { setRoot(cwd); return; }
    let cancelled = false;
    resolveRepo(cwd).then(
      (r) => { if (!cancelled) setRoot(r.ok ? r.repoPath : cwd); },
      () => { if (!cancelled) setRoot(cwd); },
    );
    return () => { cancelled = true; };
  }, [cwd]);

  const [tree, setTree] = useState<TreeNode[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const treeRef = useRef<TreeNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null);

  // Name filter. The field only exists while open; it opens from the header's
  // search button and folds away on Escape or when it loses focus empty.
  const [filterOpen, setFilterOpen] = useState(false);
  const [query, setQuery] = useState('');
  const filterQuery = query.trim();
  const [filtered, setFiltered] = useState<FilterResult | null>(null);
  const filteredRef = useRef<FilterResult | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    filteredRef.current = null;
    setFiltered(null);
    if (!root || !filterQuery) return;
    let cancelled = false;
    // Debounced: every keystroke would otherwise start a walk of the tree.
    const timer = setTimeout(() => {
      void filterTree(root, filterQuery, readDir, () => cancelled).then((result) => {
        if (cancelled || !result) return;
        filteredRef.current = result;
        setFiltered(result);
      });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [root, filterQuery, refreshKey]);

  const closeFilter = useCallback(() => {
    setQuery('');
    setFilterOpen(false);
  }, []);

  // Track the previous root to tell a directory change from a refresh.
  const prevRootRef = useRef<string | undefined>(undefined);

  // Load the root directory, keeping expanded folders on a same-dir refresh.
  useEffect(() => {
    if (!root) {
      setTree([]);
      treeRef.current = [];
      prevRootRef.current = undefined;
      return;
    }

    const rootChanged = prevRootRef.current !== root;
    prevRootRef.current = root;

    // A new root: the old tree belongs to a different directory.
    if (rootChanged) {
      treeRef.current = [];
      setTree([]);
      setSelectedPath(null);
    }

    let cancelled = false;

    const mergeNodes = (oldNodes: TreeNode[], newNodes: TreeNode[]): TreeNode[] => {
      const oldMap = new Map(oldNodes.map((n) => [n.name, n]));
      return newNodes.map((n) => {
        const old = oldMap.get(n.name);
        if (old && old.isDirectory && n.isDirectory && old.isExpanded && old.children) {
          return { ...n, isExpanded: true, children: old.children };
        }
        return n;
      });
    };

    const loadTree = () => {
      readDir(root).then((nodes) => {
        if (cancelled) return;
        const merged = treeRef.current.length > 0 ? mergeNodes(treeRef.current, nodes) : nodes;
        treeRef.current = merged;
        setTree([...merged]);
      });
    };

    loadTree();
    const interval = setInterval(loadTree, 10_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [root, refreshKey]);

  // Watch the root for real-time changes via main's fs.watch.
  useEffect(() => {
    if (!root) return;
    const api = window.electronAPI?.fs;
    if (!api?.watch) return;

    api.watch(root);
    const unsub = api.onChanged?.((changedDir: string) => {
      // Compare normalized paths (main sends path.resolve'd paths)
      const normalizedRoot = root.replace(/\\/g, '/').toLowerCase();
      const normalizedChanged = changedDir.replace(/\\/g, '/').toLowerCase();
      if (normalizedChanged === normalizedRoot) {
        setRefreshKey((k) => k + 1);
      }
    });

    return () => {
      api.unwatch?.(root);
      unsub?.();
    };
  }, [root]);

  // Nodes are mutated in place (plain or filtered tree); a fresh top-level
  // array re-renders whichever is on screen.
  const rerender = () => {
    setTree([...treeRef.current]);
    const f = filteredRef.current;
    if (f) setFiltered({ ...f, nodes: [...f.nodes] });
  };

  const toggleNode = useCallback(async (target: TreeNode) => {
    setSelectedPath(target.path);
    if (target.isExpanded) {
      target.isExpanded = false;
      target.children = undefined;
      rerender();
      return;
    }

    // Expand: children load lazily.
    target.isExpanded = true;
    target.isLoading = true;
    rerender();

    const children = await readDir(target.path);
    target.children = children;
    target.isLoading = false;
    rerender();
  }, []);

  const addEditorSurface = useStore((s) => s.addEditorSurface);
  const addPreviewSurface = useStore((s) => s.addPreviewSurface);

  const openFile = useCallback(
    (node: TreeNode) => {
      setSelectedPath(node.path);
      if (!activeWorkspace) return;
      // Images and PDFs open in a preview tab (#2150); everything else as text.
      if (isPreviewablePath(node.path)) addPreviewSurface(activeWorkspace.activePaneId, node.path);
      else addEditorSurface(activeWorkspace.activePaneId, node.path);
    },
    [activeWorkspace, addEditorSurface, addPreviewSurface],
  );

  // Main returns canonical paths (realpath), so the base for relative paths
  // is the parent of the listed entries, not the root string as given.
  const base = tree[0] ? dirname(tree[0].path) : root;

  const openMenu = useCallback((node: TreeNode, e: React.MouseEvent) => {
    e.preventDefault();
    setSelectedPath(node.path);
    setMenu({ node, x: e.clientX, y: e.clientY });
  }, []);

  // Close the menu on any outside click or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const runMenu = (action: () => void) => {
    setMenu(null);
    action();
  };

  const ptyId = activePtyId(activeWorkspace);
  const header = root ? basename(root) : remoteScope ? remoteScope : t('filetree.noCwd');

  return (
    <div
      className="wmux-filetree relative flex flex-col h-full shrink-0"
      style={{ width, maxWidth: '100%' }}
      id="wmux-file-tree"
      data-file-tree
      data-file-tree-position={position}
      {...tokenAttrs('bgBase', 'bg')}
    >
      <FileTreeResizeHandle position={position} />
      <div className="wmux-filetree-header" {...tokenAttrs('bgMantle', 'bg')}>
        <span className="truncate flex-1" title={root ?? t('filetree.noDirectory')} data-file-tree-root {...tokenAttrs('textMain', 'text')}>
          {header}
        </span>
        <button
          type="button"
          className={`wmux-filetree-action ${FOCUS_RING}`}
          // Keep focus in the field: a blur on an empty field would fold it
          // away first, and this click would then open it again.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (filterOpen) { closeFilter(); return; }
            setFilterOpen(true);
          }}
          title={t('filetree.filter')}
          aria-label={t('filetree.filter')}
          aria-pressed={filterOpen}
          disabled={!root}
          data-file-tree-filter-toggle
          {...tokenAttrs('textMuted', 'text')}
        >
          <IconSearch size={14} />
        </button>
        <button
          type="button"
          className={`wmux-filetree-action ${FOCUS_RING}`}
          onClick={() => setRefreshKey((k) => k + 1)}
          title={t('filetree.refresh')}
          aria-label={t('filetree.refresh')}
          disabled={!root}
        >
          <IconRefresh size={14} />
        </button>
        {/* The column's own way out: the agent bar's Files button is not on
            screen while the bar is off or a remote workspace is shown. */}
        <button
          type="button"
          className={`wmux-filetree-action ${FOCUS_RING}`}
          onClick={() => useStore.getState().setFileTreeVisible(false)}
          title={t('filetree.toggleHide')}
          aria-label={t('filetree.toggleHide')}
          data-file-tree-close
        >
          <IconX size={14} />
        </button>
      </div>

      {filterOpen && root && (
        <div className="wmux-filetree-filter">
          <input
            ref={filterInputRef}
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); closeFilter(); }
            }}
            onBlur={() => { if (!query.trim()) setFilterOpen(false); }}
            placeholder={t('filetree.filterPlaceholder')}
            aria-label={t('filetree.filter')}
            className="ui-input h-8 text-[13px] flex-1 min-w-0"
            spellCheck={false}
            data-file-tree-filter
          />
          {query && (
            <button
              type="button"
              className={`wmux-filetree-action ${FOCUS_RING}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setQuery(''); filterInputRef.current?.focus(); }}
              title={t('filetree.clearFilter')}
              aria-label={t('filetree.clearFilter')}
            >
              <IconX size={12} />
            </button>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden py-1" role="tree" aria-label={header}>
        {filterQuery && root && filtered === null && (
          <div className="wmux-filetree-meta px-3 py-2" data-file-tree-searching>{t('filetree.searching')}</div>
        )}
        {filterQuery && filtered !== null && filtered.matchCount === 0 && (
          <div className="wmux-filetree-meta px-3 py-2" data-file-tree-no-match>{t('filetree.noMatches')}</div>
        )}
        {!filterQuery && tree.length === 0 && root && (
          <div className="wmux-filetree-meta px-3 py-2">{t('filetree.empty')}</div>
        )}
        {!root && (
          <div className="wmux-filetree-meta px-3 py-2" {...(remoteScope !== null ? { 'data-filetree-remote': '' } : {})}>
            {remoteScope ? t('pcRail.filesNotShown', { name: remoteScope }) : t('filetree.noCwdDetected')}
          </div>
        )}
        {(filterQuery ? (filtered?.nodes ?? []) : tree).map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            query={filterQuery}
            selectedPath={selectedPath}
            onFileClick={openFile}
            onToggle={toggleNode}
            onContextMenu={openMenu}
          />
        ))}
        {filterQuery && filtered?.truncated && (
          <div className="wmux-filetree-meta px-3 py-2" data-file-tree-truncated>
            {t('filetree.filterTruncated', { count: FILTER_SCAN_LIMIT.toLocaleString() })}
          </div>
        )}
      </div>

      {menu && (
        <div
          role="menu"
          className="wmux-filetree-menu fixed z-[var(--z-popover-top)] w-max flex flex-col py-1"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          data-file-tree-menu
        >
          {!menu.node.isDirectory && (
            <button type="button" role="menuitem" onClick={() => runMenu(() => openFile(menu.node))} data-file-tree-action="open">
              {t('filetree.menu.open')}
            </button>
          )}
          {ptyId && (
            <button
              type="button"
              role="menuitem"
              onClick={() => runMenu(() => { void insertPathsIntoPty(ptyId, [menu.node.path]); })}
              data-file-tree-action="insert"
            >
              {t('filetree.menu.insertPath')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => runMenu(() => { void window.clipboardAPI?.writeText(menu.node.path).catch(() => undefined); })}
            data-file-tree-action="copy-path"
          >
            {t('filetree.menu.copyPath')}
          </button>
          {base && (
            <button
              type="button"
              role="menuitem"
              onClick={() => runMenu(() => { void window.clipboardAPI?.writeText(relativeTo(base, menu.node.path)).catch(() => undefined); })}
              data-file-tree-action="copy-relative"
            >
              {t('filetree.menu.copyRelativePath')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => runMenu(() => {
              void window.electronAPI?.shell?.openPath(menu.node.isDirectory ? menu.node.path : dirname(menu.node.path));
            })}
            data-file-tree-action="reveal"
          >
            {t('workspace.openInExplorer', { app: t(fileManagerKey()) })}
          </button>
        </div>
      )}
    </div>
  );
}
