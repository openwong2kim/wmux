import { useState, useEffect, useCallback, useRef } from 'react';
import type { SessionLocation } from '../../../shared/sessionLocation';

interface EditorPanelProps {
  filePath: string;
  isActive: boolean;
  surfaceId: string;
  location?: SessionLocation;
}

async function readFileContent(filePath: string, location?: SessionLocation): Promise<string | null> {
  try {
    const api = (window as any).electronAPI?.fs;
    if (!api?.readFile || !location) return null;
    return await api.readFile(filePath, location);
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

export default function EditorPanel({ filePath, isActive, surfaceId, location }: EditorPanelProps) {
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
    readFileContent(filePath, location).then((result) => {
      if (result === null) {
        setError('Unable to read file');
        setContent(null);
      } else {
        setContent(result);
        setEditContent(result);
      }
      setLoading(false);
    });
  }, [filePath, location]);

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
          className="px-2 py-0.5 rounded-[5px] text-[10px] transition-colors border bg-[color-mix(in_srgb,var(--bg-surface)_72%,transparent)] border-[color-mix(in_srgb,var(--text-main)_10%,transparent)] text-[var(--text-sub)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--text-main)_6%,transparent)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-main)] hover:border-[color-mix(in_srgb,var(--text-main)_16%,transparent)] hover:shadow-[0_1px_3px_rgba(0,0,0,0.25)]"
          onClick={handleReload}
          title="Reload file"
        >
          Reload
        </button>
        {/* View | Edit — a single segmented control (one track, active segment
            raised). Replaces the paired toggle button per the gpui recipe. */}
        <div
          role="tablist"
          aria-label="Editor mode"
          className="inline-flex items-center gap-0.5 p-0.5 rounded-[7px]"
          style={{
            background: 'var(--bg-mantle)',
            border: '1px solid color-mix(in srgb, var(--text-main) 8%, transparent)',
          }}
        >
          <button
            role="tab"
            aria-selected={!editing}
            className="px-2 py-0.5 rounded-[5px] text-[10px] transition-colors"
            style={
              !editing
                ? {
                    background: 'var(--bg-surface)',
                    color: 'var(--text-main)',
                    boxShadow:
                      'inset 0 1px 0 color-mix(in srgb, var(--text-main) 8%, transparent), 0 1px 2px rgba(0, 0, 0, 0.3)',
                  }
                : { color: 'var(--text-sub)' }
            }
            onClick={() => {
              if (editing) setEditing(false);
            }}
            title="Switch to view mode"
          >
            View
          </button>
          <button
            role="tab"
            aria-selected={editing}
            className="px-2 py-0.5 rounded-[5px] text-[10px] transition-colors"
            style={
              editing
                ? {
                    background: 'var(--bg-surface)',
                    color: 'var(--text-main)',
                    boxShadow:
                      'inset 0 1px 0 color-mix(in srgb, var(--text-main) 8%, transparent), 0 1px 2px rgba(0, 0, 0, 0.3)',
                  }
                : { color: 'var(--text-sub)' }
            }
            onClick={() => {
              if (!editing) handleToggleEdit();
            }}
            title="Switch to edit mode"
          >
            Edit
          </button>
        </div>
        {/* No Save button: the panel is a read-only viewer with a local-only
            edit/scratch mode (changes are not persisted). A disabled "Save not
            available yet" button read as unfinished; removed (NN5-T5-ALT).
            Finishing persistence would require relaxing the CLAUDE.md-only
            FS_WRITE_FILE allowlist (a renderer write-power expansion) — out of
            scope for the read-only viewer the README documents. */}
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
