import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { focusedTerminalPtyId } from '../../utils/focusedSurface';
import { injectText, quotePathsForPrompt } from './inject';
import RichInput from './RichInput';
import SnippetsMenu from './SnippetsMenu';
import FileExplorerPopover from './FileExplorerPopover';

export default function AgentToolbar() {
  const t = useT();
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const popover = useStore((s) => s.toolbarPopover);
  const setPopover = useStore((s) => s.setToolbarPopover);
  const newCommand = useStore((s) => s.newConversationCommand);

  const containerRef = useRef<HTMLDivElement>(null);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const ptyId = focusedTerminalPtyId(activeWorkspace);
  const disabled = !ptyId;

  const handleAttach = useCallback(async () => {
    if (!ptyId) return;
    const paths = await window.electronAPI.dialog.pickFile();
    if (paths.length === 0) return;
    await injectText(ptyId, quotePathsForPrompt(paths), false);
  }, [ptyId]);

  const handleNew = useCallback(() => {
    if (!ptyId) return;
    void injectText(ptyId, newCommand, true);
  }, [ptyId, newCommand]);

  const togglePopover = (name: 'explorer' | 'snippets' | 'rich') =>
    setPopover(popover === name ? null : name);

  useEffect(() => {
    if (!popover) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setPopover(null); }
    };
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPopover(null);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [popover, setPopover]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
        // Don't hijack Ctrl/Cmd+G while the user is typing in the toolbar's own
        // editable fields (Rich Input textarea, Snippet inputs). Editable
        // elements OUTSIDE the toolbar (notably the focused terminal's xterm
        // textarea) must still toggle Rich Input — that's the primary entry.
        const el = e.target as HTMLElement | null;
        if (el && containerRef.current && containerRef.current.contains(el)) {
          const tag = el.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return;
        }
        const state = useStore.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (!focusedTerminalPtyId(ws)) return;
        e.preventDefault();
        const cur = useStore.getState().toolbarPopover;
        setPopover(cur === 'rich' ? null : 'rich');
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [setPopover]);

  const btn = 'px-2.5 py-1 rounded border text-[11px] font-mono transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const idle = 'bg-[var(--bg-surface)] border-[var(--bg-overlay)] text-[var(--text-sub)] hover:text-[var(--text-main)]';
  const active = 'bg-[var(--bg-overlay)] border-[var(--accent-blue)] text-[var(--accent-blue)]';

  return (
    <div
      ref={containerRef}
      className="relative flex items-center gap-2 px-2.5 py-1.5 shrink-0 border-t border-[var(--bg-surface)] bg-[var(--bg-mantle)]"
      data-testid="agent-toolbar"
    >
      <button className={`${btn} ${idle}`} disabled={disabled} onClick={handleAttach} title={t('toolbar.attach')}>
        ＋ {t('toolbar.attach')}
      </button>
      <button className={`${btn} ${popover === 'explorer' ? active : idle}`} onClick={() => togglePopover('explorer')}>
        📁 {t('toolbar.fileExplorer')}
      </button>
      <button className={`${btn} ${popover === 'snippets' ? active : idle}`} disabled={disabled} onClick={() => togglePopover('snippets')}>
        ★ {t('toolbar.snippets')}
      </button>
      <button className={`${btn} ${popover === 'rich' ? active : idle}`} disabled={disabled} onClick={() => togglePopover('rich')}>
        ⌨ {t('toolbar.richInput')} <span className="opacity-50">Ctrl G</span>
      </button>
      <div className="flex-1" />
      {disabled && <span className="text-[10px] text-[var(--text-muted)] font-mono">{t('toolbar.noTerminal')}</span>}
      <button className={`${btn} ${idle}`} disabled={disabled} onClick={handleNew} title={t('toolbar.new')}>
        ⊕ {t('toolbar.new')}
      </button>

      {popover === 'explorer' && <FileExplorerPopover />}
      {popover === 'snippets' && ptyId && <SnippetsMenu ptyId={ptyId} />}
      {popover === 'rich' && ptyId && <RichInput ptyId={ptyId} />}
    </div>
  );
}
