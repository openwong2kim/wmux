import { useState, useEffect, useCallback, useRef } from 'react';

interface EditorPanelProps {
  filePath: string;
  isActive: boolean;
  surfaceId: string;
}

async function readFileContent(filePath: string): Promise<string | null> {
  try {
    const api = (window as any).electronAPI?.fs;
    if (!api?.readFile) return null;
    return await api.readFile(filePath);
  } catch {
    return null;
  }
}

/** Shorten a path for display (show last 2-3 segments) */
function shortenPath(p: string): string {
  const sep = p.includes('/') ? '/' : '\\';
  const parts = p.split(sep).filter(Boolean);
  if (parts.length <= 3) return p;
  return '...' + sep + parts.slice(-2).join(sep);
}

export default function EditorPanel({ filePath, isActive, surfaceId }: EditorPanelProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  // Load file content
  useEffect(() => {
    setLoading(true);
    setError(null);
    readFileContent(filePath).then((result) => {
      if (result === null) {
        setError('Unable to read file');
        setContent(null);
      } else {
        setContent(result);
        setEditContent(result);
      }
      setLoading(false);
    });
  }, [filePath]);

  const handleToggleEdit = useCallback(() => {
    if (editing) {
      // Switch back to view mode
      setEditing(false);
    } else {
      // Switch to edit mode
      setEditContent(content || '');
      setEditing(true);
      // Focus textarea after render
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [editing, content]);

  const handleReload = useCallback(() => {
    setLoading(true);
    setError(null);
    readFileContent(filePath).then((result) => {
      if (result === null) {
        setError('Unable to read file');
        setContent(null);
      } else {
        setContent(result);
        setEditContent(result);
      }
      setLoading(false);
    });
  }, [filePath]);

  return (
    <div
      className="absolute inset-0 flex flex-col bg-[var(--bg-base)]"
      style={{ display: isActive ? 'flex' : 'none' }}
      data-surface-id={surfaceId}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-surface)] border-b border-[var(--bg-mantle)] shrink-0 text-xs">
        <span className="text-[var(--text-main)] font-semibold truncate" title={filePath}>
          {fileName}
        </span>
        <span className="text-[var(--text-muted)] truncate text-[10px]" title={filePath}>
          {shortenPath(filePath)}
        </span>
        <div className="flex-1" />
        <button
          className="px-2 py-0.5 rounded text-[10px] bg-[var(--bg-base)] text-[var(--text-sub)] hover:text-[var(--text-main)] transition-colors border border-[var(--bg-mantle)]"
          onClick={handleReload}
          title="Reload file"
        >
          Reload
        </button>
        <button
          className={`px-2 py-0.5 rounded text-[10px] transition-colors border border-[var(--bg-mantle)] ${
            editing
              ? 'bg-[var(--accent-blue)] text-white'
              : 'bg-[var(--bg-base)] text-[var(--text-sub)] hover:text-[var(--text-main)]'
          }`}
          onClick={handleToggleEdit}
          title={editing ? 'Switch to view mode' : 'Switch to edit mode'}
        >
          {editing ? 'View' : 'Edit'}
        </button>
        {editing && (
          <button
            className="px-2 py-0.5 rounded text-[10px] bg-[var(--bg-base)] text-[var(--text-muted)] border border-[var(--bg-mantle)] cursor-not-allowed opacity-50"
            disabled
            title="Save not available yet (writeFile API required)"
          >
            Save
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
            Loading...
          </div>
        )}
        {!loading && error && (
          <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
            {error}
          </div>
        )}
        {!loading && !error && !editing && (
          <pre className="p-3 text-[var(--text-main)] text-xs font-mono whitespace-pre-wrap break-words leading-relaxed select-text">
            {content}
          </pre>
        )}
        {!loading && !error && editing && (
          <textarea
            ref={textareaRef}
            className="w-full h-full p-3 bg-[var(--bg-base)] text-[var(--text-main)] text-xs font-mono whitespace-pre leading-relaxed resize-none outline-none border-none"
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}
