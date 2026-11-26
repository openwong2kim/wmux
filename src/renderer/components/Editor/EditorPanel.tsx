import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useT } from '../../hooks/useT';
import { renderBrainMarkdownWhole } from '../shared/BrainMarkdown';
import { setEditorDirty, keepEditorScratch, takeEditorScratch } from './dirtyEditors';
import { useStore } from '../../stores';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import Dialog, { DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';

interface EditorPanelProps {
  filePath: string;
  isActive: boolean;
  surfaceId: string;
  /** 1-based line to scroll to (a terminal `path:line` link). */
  line?: number;
  /** Bumped when a link re-targets this open tab, so the same line is shown again. */
  lineSeq?: number;
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

/** Files the View mode draws as markdown instead of raw text. */
export function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(p);
}

/** Shorten a path for display (show last 2-3 segments) */
function shortenPath(p: string): string {
  const sep = p.includes('/') ? '/' : '\\';
  const parts = p.split(sep).filter(Boolean);
  if (parts.length <= 3) return p;
  return '...' + sep + parts.slice(-2).join(sep);
}

export default function EditorPanel({ filePath, isActive, surfaceId, line, lineSeq }: EditorPanelProps) {
  const t = useT();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // The Edit-mode scratch copy. It lives in memory for the tab's lifetime and
  // survives Edit -> View -> Edit; nothing writes it to disk (see below).
  const [editContent, setEditContent] = useState('');
  // Reload asked while the scratch copy differs from the file.
  const [confirmReload, setConfirmReload] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The marked line (1-based) from a `path:line` link. It stays until the user
  // clicks the text, edits, or leaves the tab.
  const [markedLine, setMarkedLine] = useState<number | null>(null);
  // A line request shows markdown as its source (the rendered view has no
  // line-to-block map); stays until the user picks View again or the file changes.
  const [forceSource, setForceSource] = useState(false);

  const isMarkdown = isMarkdownPath(filePath);
  // null when the file is not markdown or is too long for the renderer's
  // block budget: View then shows the raw text rather than a cut document.
  // Scratch edits are never saved, so closing the tab with a changed buffer
  // loses them: tell the close-tab confirm, in View mode as much as in Edit.
  const dirty = content !== null && editContent !== content;
  // View shows the scratch copy, so what was typed is what is read.
  const viewText = content === null ? null : editContent;
  const markdownView = useMemo(
    () => (isMarkdown && !forceSource && !editing && viewText !== null
      ? renderBrainMarkdownWhole(viewText, { links: true, githubHtml: true, richCode: true })
      : null),
    [isMarkdown, forceSource, editing, viewText],
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  // Unmounting while the tab is still open (a split, a move, a stash, a
  // workspace switch) parks the scratch text for the remount; a closed tab
  // drops it. Until the file read lands, a parked copy has not been taken
  // back yet, so an unmount then leaves it parked.
  const scratchRef = useRef<string | null>(null);
  const restoredRef = useRef(false);
  scratchRef.current = dirty ? editContent : null;
  // A parked copy keeps its dirty flag until the read takes it back.
  useEffect(() => {
    if (restoredRef.current) setEditorDirty(surfaceId, dirty);
  }, [surfaceId, dirty]);
  useEffect(() => () => {
    const open = useStore.getState().workspaces.some((w) =>
      getWorkspaceLeafPanes(w).some((leaf) => leaf.surfaces.some((s) => s.id === surfaceId)));
    if (open && !restoredRef.current) return;
    const text = open ? scratchRef.current : null;
    keepEditorScratch(surfaceId, text);
    setEditorDirty(surfaceId, text !== null);
  }, [surfaceId]);
  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  // Load file content
  useEffect(() => {
    // A read that lands after unmount or a file change must not take the
    // parked scratch.
    let live = true;
    setLoading(true);
    setError(null);
    readFileContent(filePath).then((result) => {
      if (!live) return;
      if (result === null) {
        setError(t('editor.unableToRead'));
        setContent(null);
      } else {
        const kept = takeEditorScratch(surfaceId);
        restoredRef.current = true;
        // Hold it for an unmount that comes before this render commits.
        scratchRef.current = kept !== undefined && kept !== result ? kept : null;
        setContent(result);
        setEditContent(kept ?? result);
      }
      setLoading(false);
    });
    setForceSource(false);
    setMarkedLine(null);
    return () => { live = false; };
  }, [filePath]);

  // A (re-)target arrives: mark the line and, for markdown, show the source.
  useEffect(() => {
    if (line === undefined) return;
    setMarkedLine(line);
    setForceSource(true);
  }, [line, lineSeq]);

  // Leaving the tab drops the mark.
  useEffect(() => {
    if (!isActive) setMarkedLine(null);
  }, [isActive]);

  // Centre the marked line using its real position, not a proportional guess.
  useEffect(() => {
    if (markedLine === null || !isActive || loading || error || editing || markdownView || content === null) return;
    const body = bodyRef.current;
    const row = body?.querySelector<HTMLElement>('[data-editor-line-marked]');
    if (!body || !row) return;
    const delta = row.getBoundingClientRect().top - body.getBoundingClientRect().top;
    body.scrollTop = Math.max(0, body.scrollTop + delta - (body.clientHeight - row.offsetHeight) / 2);
  }, [markedLine, lineSeq, isActive, loading, error, editing, markdownView, content]);

  // Rows for the raw view, built only while a line is marked. Each row keeps
  // its trailing newline so the pre's text content is the file unchanged.
  const rawRows = useMemo(() => {
    if (markedLine === null || viewText === null) return null;
    const rows = viewText.split('\n');
    const target = Math.min(Math.max(markedLine, 1), rows.length);
    return { rows, target };
  }, [markedLine, viewText]);

  const handleToggleEdit = useCallback(() => {
    if (editing) {
      // Switch back to view mode
      setEditing(false);
    } else {
      // Switch to edit mode
      // Keep the scratch copy as it was left: re-entering Edit must not reset it.
      setMarkedLine(null);
      setEditing(true);
      // Focus textarea after render
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [editing]);

  const reloadNow = useCallback(() => {
    setConfirmReload(false);
    setLoading(true);
    setError(null);
    readFileContent(filePath).then((result) => {
      if (result === null) {
        setError(t('editor.unableToRead'));
        setContent(null);
      } else {
        setContent(result);
        setEditContent(result);
      }
      setLoading(false);
    });
  }, [filePath]);

  // Reloading replaces the scratch copy with the file: ask first when that
  // would drop edits.
  const handleReload = useCallback(() => {
    if (dirty) setConfirmReload(true);
    else reloadNow();
  }, [dirty, reloadNow]);

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
        {(editing || dirty) && (
          <span
            data-testid="editor-scratch-chip"
            className="px-1.5 py-0.5 text-[10px] text-[var(--text-sub)] whitespace-nowrap"
            style={{ background: 'var(--selection)', borderRadius: 'var(--chip-radius)' }}
            title={t('editor.scratchTitle')}
          >
            {dirty ? t('editor.scratchUnsaved') : t('editor.scratch')}
          </span>
        )}
        <button
          className="px-2 py-0.5 rounded-[5px] text-[10px] transition-colors border bg-[color-mix(in_srgb,var(--bg-surface)_72%,transparent)] border-[color-mix(in_srgb,var(--text-main)_10%,transparent)] text-[var(--text-sub)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--text-main)_6%,transparent)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-main)] hover:border-[color-mix(in_srgb,var(--text-main)_16%,transparent)] hover:shadow-[0_1px_3px_rgba(0,0,0,0.25)]"
          onClick={handleReload}
          title={t('editor.reloadTitle')}
        >
          {t('editor.reload')}
        </button>
        {/* View | Edit — a single segmented control (one track, active segment
            raised). Replaces the paired toggle button per the gpui recipe. */}
        <div
          role="tablist"
          aria-label={t('editor.modeLabel')}
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
              else setForceSource(false);
            }}
            title={t('editor.switchToView')}
          >
            {t('editor.view')}
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
            title={t('editor.switchToEdit')}
          >
            {t('editor.edit')}
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
      {/* A drag-select ends in a click too: keep the mark then, since redrawing
          the rows would drop the selection the drag just made. */}
      <div
        ref={bodyRef}
        className="flex-1 overflow-auto"
        onClick={() => {
          const sel = window.getSelection();
          const dragged = sel !== null && !sel.isCollapsed && bodyRef.current?.contains(sel.anchorNode) === true;
          if (!dragged) setMarkedLine(null);
        }}
      >
        {loading && (
          <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
            {t('editor.loading')}
          </div>
        )}
        {!loading && error && (
          <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
            {error}
          </div>
        )}
        {!loading && !error && !editing && (
          markdownView ? (
            <div
              data-testid="editor-markdown"
              className="mx-auto max-w-[48rem] p-4 text-[var(--text-main)] text-[13px] leading-relaxed select-text"
            >
              {markdownView}
            </div>
          ) : (
            <pre className="p-3 text-[var(--text-main)] text-xs font-mono whitespace-pre-wrap break-words leading-relaxed select-text">
              {rawRows
                ? rawRows.rows.map((row, i) => {
                    const n = i + 1;
                    const marked = n === rawRows.target;
                    const text = i < rawRows.rows.length - 1 ? row + '\n' : row;
                    // The mark is a 2px accent left bar plus the neutral
                    // selection fill (DESIGN.md: colour carries state, no wash).
                    return (
                      <span
                        key={n}
                        data-editor-line={n}
                        data-editor-line-marked={marked ? '' : undefined}
                        className="block"
                        style={marked
                          ? { background: 'var(--selection)', boxShadow: 'var(--select-ring)' }
                          : undefined}
                      >
                        {text}
                      </span>
                    );
                  })
                : viewText}
            </pre>
          )
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
      {confirmReload && (
        <Dialog onClose={() => setConfirmReload(false)} width={360} closeOnBackdrop data-testid="editor-reload-confirm">
          <DialogHeader title={t('editor.reloadDiscardTitle')} description={t('editor.reloadDiscardBody')} />
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={() => setConfirmReload(false)} data-editor-keep-editing>
              {t('editor.keepEditing')}
            </Button>
            <Button variant="danger" size="sm" onClick={reloadNow} data-editor-discard>
              {t('editor.discardAndReload')}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}
