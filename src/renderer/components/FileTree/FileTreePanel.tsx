import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useStore } from '../../stores';

interface FileTreePanelProps {
  position: 'left' | 'right';
  workspaceId?: string;
}

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  children?: TreeNode[];
  isExpanded?: boolean;
  isLoading?: boolean;
}

async function readDir(dirPath: string): Promise<TreeNode[]> {
  try {
    const api = (window as any).electronAPI?.fs;
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

async function readFile(filePath: string): Promise<string | null> {
  try {
    const api = (window as any).electronAPI?.fs;
    if (!api?.readFile) return null;
    return await api.readFile(filePath);
  } catch {
    return null;
  }
}

/** Simple markdown to React elements renderer (no external deps) */
function renderMarkdown(source: string): React.ReactNode[] {
  const lines = source.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre
          key={elements.length}
          className="bg-[var(--bg-base)] text-[var(--text-sub)] rounded px-2 py-1.5 my-1 overflow-x-auto text-[11px] leading-relaxed font-mono"
        >
          {codeLines.join('\n')}
        </pre>,
      );
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const sizes = ['text-sm font-bold', 'text-xs font-bold', 'text-xs font-semibold'];
      elements.push(
        <div key={elements.length} className={`${sizes[level - 1]} text-[var(--text-main)] mt-2 mb-0.5`}>
          {applyInlineFormatting(text)}
        </div>,
      );
      i++;
      continue;
    }

    // List item
    const listMatch = line.match(/^(\s*)([-*])\s+(.+)/);
    if (listMatch) {
      const indent = Math.floor(listMatch[1].length / 2);
      elements.push(
        <div
          key={elements.length}
          className="flex text-[var(--text-sub)] leading-relaxed"
          style={{ paddingLeft: `${indent * 12 + 4}px` }}
        >
          <span className="mr-1.5 shrink-0">&#x2022;</span>
          <span>{applyInlineFormatting(listMatch[3])}</span>
        </div>,
      );
      i++;
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      elements.push(<div key={elements.length} className="h-1.5" />);
      i++;
      continue;
    }

    // Normal paragraph
    elements.push(
      <div key={elements.length} className="text-[var(--text-sub)] leading-relaxed">
        {applyInlineFormatting(line)}
      </div>,
    );
    i++;
  }

  return elements;
}

/** Apply inline formatting: bold, italic, code, links */
function applyInlineFormatting(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Pattern order matters: bold before italic
  const regex = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const m = match[0];
    if (m.startsWith('`')) {
      // Inline code
      parts.push(
        <code
          key={`c${match.index}`}
          className="bg-[var(--bg-base)] text-[var(--accent)] px-1 rounded text-[10px] font-mono"
        >
          {m.slice(1, -1)}
        </code>,
      );
    } else if (m.startsWith('**')) {
      // Bold
      parts.push(
        <strong key={`b${match.index}`} className="font-bold text-[var(--text-main)]">
          {m.slice(2, -2)}
        </strong>,
      );
    } else if (m.startsWith('*')) {
      // Italic
      parts.push(
        <em key={`i${match.index}`} className="italic">
          {m.slice(1, -1)}
        </em>,
      );
    } else if (m.startsWith('[')) {
      // Link
      const linkMatch = m.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        parts.push(
          <span key={`l${match.index}`} className="text-[var(--accent)] underline cursor-pointer" title={linkMatch[2]}>
            {linkMatch[1]}
          </span>,
        );
      }
    }

    lastIndex = match.index + m.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

function TreeItem({
  node,
  depth,
  onFileClick,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  onFileClick: (path: string) => void;
  onToggle: (node: TreeNode) => void;
}) {
  const icon = node.isDirectory
    ? node.isExpanded
      ? '\u{1F4C2}'
      : '\u{1F4C1}'
    : '\u{1F4C4}';

  const handleClick = () => {
    if (node.isDirectory) {
      onToggle(node);
    } else {
      onFileClick(node.path);
    }
  };

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', node.path);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <>
      <button
        className="flex items-center w-full text-left px-2 py-0.5 hover:bg-[var(--bg-surface)] text-[var(--text-sub)] hover:text-[var(--text-main)] transition-colors truncate"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={handleClick}
        title={node.path}
        draggable={!node.isDirectory}
        onDragStart={handleDragStart}
      >
        <span className="mr-1 shrink-0 text-[11px]">{icon}</span>
        <span className="truncate">{node.name}</span>
        {node.isSymlink && <span className="ml-1 text-[var(--text-muted)] text-[9px]">&rarr;</span>}
      </button>
      {node.isDirectory && node.isExpanded && (
        <>
          {node.isLoading ? (
            <div
              className="text-[var(--text-muted)] text-[10px] py-0.5"
              style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
            >
              ...
            </div>
          ) : (
            node.children?.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                onFileClick={onFileClick}
                onToggle={onToggle}
              />
            ))
          )}
        </>
      )}
    </>
  );
}

export default function FileTreePanel({ position }: FileTreePanelProps) {
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);

  // Resolve CWD: try workspace metadata first, then recursively find from panes
  let cwd = activeWorkspace?.metadata?.cwd;
  if (!cwd && activeWorkspace) {
    const findCwd = (pane: any): string | undefined => {
      if (pane.type === 'leaf') {
        const surface = pane.surfaces?.find((s: any) => s.id === pane.activeSurfaceId);
        return surface?.cwd || undefined;
      }
      if (pane.children) {
        for (const child of pane.children) {
          const found = findCwd(child);
          if (found) return found;
        }
      }
      return undefined;
    };
    cwd = findCwd(activeWorkspace.rootPane);
  }

  const [tree, setTree] = useState<TreeNode[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const treeRef = useRef<TreeNode[]>([]);

  // Markdown preview state
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Track previous cwd to detect directory changes vs refreshes
  const prevCwdRef = useRef<string | undefined>(undefined);

  // Load root directory, preserving expanded folder state on same-dir refresh
  useEffect(() => {
    if (!cwd) {
      setTree([]);
      treeRef.current = [];
      prevCwdRef.current = undefined;
      return;
    }

    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // If CWD changed, reset tree completely (old tree is from different directory)
    if (cwdChanged) {
      treeRef.current = [];
      setTree([]);
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
      readDir(cwd!).then((nodes) => {
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
  }, [cwd, refreshKey]);

  // Watch directory for real-time changes via main process fs.watch
  useEffect(() => {
    if (!cwd) return;
    const api = (window as any).electronAPI?.fs;
    if (!api?.watch) return;

    api.watch(cwd);
    const unsub = api.onChanged?.((changedDir: string) => {
      // Compare normalized paths (main sends path.resolve'd paths)
      const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase();
      const normalizedChanged = changedDir.replace(/\\/g, '/').toLowerCase();
      if (normalizedChanged === normalizedCwd) {
        setRefreshKey((k) => k + 1);
      }
    });

    return () => {
      api.unwatch?.(cwd);
      unsub?.();
    };
  }, [cwd]);

  const toggleNode = useCallback(
    async (target: TreeNode) => {
      if (target.isExpanded) {
        // collapse
        target.isExpanded = false;
        target.children = undefined;
        setTree([...treeRef.current]);
        return;
      }

      // expand - lazy load children
      target.isExpanded = true;
      target.isLoading = true;
      setTree([...treeRef.current]);

      const children = await readDir(target.path);
      target.children = children;
      target.isLoading = false;
      setTree([...treeRef.current]);
    },
    [],
  );

  const addEditorSurface = useStore((s) => s.addEditorSurface);

  const handleFileClick = useCallback(
    (filePath: string) => {
      if (!activeWorkspace) return;

      // Find active leaf pane id
      const findActivePaneId = (pane: any): string | undefined => {
        if (pane.type === 'leaf') return pane.id === activeWorkspace.activePaneId ? pane.id : undefined;
        for (const child of pane.children ?? []) {
          const found = findActivePaneId(child);
          if (found) return found;
        }
        return undefined;
      };

      const paneId = findActivePaneId(activeWorkspace.rootPane);
      if (paneId) {
        addEditorSurface(paneId, filePath);
      }
    },
    [activeWorkspace, addEditorSurface],
  );

  const closePreview = useCallback(() => {
    setPreviewFile(null);
    setPreviewContent(null);
  }, []);

  const previewFileName = useMemo(() => {
    if (!previewFile) return '';
    const sep = previewFile.includes('/') ? '/' : '\\';
    return previewFile.split(sep).pop() ?? '';
  }, [previewFile]);

  const renderedMarkdown = useMemo(() => {
    if (!previewContent) return null;
    return renderMarkdown(previewContent);
  }, [previewContent]);

  const borderClass = position === 'left' ? 'border-r' : 'border-l';

  return (
    <div
      className={`flex flex-col h-full bg-[var(--bg-mantle)] ${borderClass} border-[var(--bg-surface)] font-mono text-xs`}
      style={{ width: 240, minWidth: 240 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--bg-surface)] shrink-0">
        <span
          className="text-[var(--text-sub)] truncate flex-1 mr-2"
          title={cwd ?? 'No directory'}
        >
          {cwd ? shortenPath(cwd) : 'No CWD'}
        </span>
        <button
          className="text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors text-sm"
          onClick={() => setRefreshKey((k) => k + 1)}
          title="Refresh"
        >
          &#x21BB;
        </button>
      </div>

      {/* Tree */}
      <div className={`overflow-y-auto overflow-x-hidden py-1 ${previewFile ? 'flex-1 min-h-0' : 'flex-1'}`}>
        {tree.length === 0 && cwd && (
          <div className="px-3 py-2 text-[var(--text-muted)] text-[10px]">
            Empty or not available
          </div>
        )}
        {!cwd && (
          <div className="px-3 py-2 text-[var(--text-muted)] text-[10px]">
            No working directory detected
          </div>
        )}
        {tree.map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            onFileClick={handleFileClick}
            onToggle={toggleNode}
          />
        ))}
      </div>

      {/* Markdown Preview */}
      {previewFile && (
        <div className="flex flex-col border-t border-[var(--bg-surface)] shrink-0" style={{ height: '45%', minHeight: 120 }}>
          {/* Preview Header */}
          <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--bg-surface)] shrink-0 bg-[var(--bg-surface)]">
            <span className="text-[var(--text-main)] text-[10px] font-semibold truncate flex-1 mr-2" title={previewFile}>
              {previewFileName}
            </span>
            <button
              className="text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors text-xs leading-none px-1"
              onClick={closePreview}
              title="Close preview"
            >
              &#x2715;
            </button>
          </div>
          {/* Preview Content */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-1.5 text-[11px] leading-relaxed">
            {previewLoading && (
              <div className="text-[var(--text-muted)] text-[10px] py-2">Loading...</div>
            )}
            {!previewLoading && previewContent === null && (
              <div className="text-[var(--text-muted)] text-[10px] py-2">
                Unable to read file. File read API not available.
              </div>
            )}
            {!previewLoading && previewContent !== null && renderedMarkdown}
          </div>
        </div>
      )}
    </div>
  );
}

/** Shorten a path for display (show last 2-3 segments) */
function shortenPath(p: string): string {
  const sep = p.includes('/') ? '/' : '\\';
  const parts = p.split(sep).filter(Boolean);
  if (parts.length <= 3) return p;
  return '...' + sep + parts.slice(-2).join(sep);
}
