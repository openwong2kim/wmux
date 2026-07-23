import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { selectActiveWorkspace } from '../../stores/selectors/workspaceProjections';
import { useT } from '../../hooks/useT';
import { focusedTerminalPtyId } from '../../utils/focusedSurface';
import { injectText, quotePathsForPrompt } from './inject';
import RichInput from './RichInput';
import SnippetsMenu from './SnippetsMenu';
import FileExplorerPopover from './FileExplorerPopover';
import BroadcastPopover from './BroadcastPopover';
import FanOutDialog from './FanOutDialog';
import { IconPaperclip, IconFolder, IconStar, IconKeyboard, IconPlus, IconUsers, IconSparkles } from '../icons';

export default function AgentToolbar() {
  const t = useT();
  // A1: only need focused pty of active ws — subscribe to active ws OBJECT only (ignore background ws churn).
  const activeWorkspace = useStore(selectActiveWorkspace);
  const popover = useStore((s) => s.toolbarPopover);
  const setPopover = useStore((s) => s.setToolbarPopover);
  const newCommand = useStore((s) => s.newConversationCommand);

  const containerRef = useRef<HTMLDivElement>(null);
  const broadcastBtnRef = useRef<HTMLButtonElement>(null);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [showFanOut, setShowFanOut] = useState(false);

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

  // Quiet chrome (design-system cohesion): buttons are text-first with no box
  // until hovered/active — the toolbar reads as part of the frame, not a row
  // of widgets competing with the terminals.
  // Quiet chrome: `btn` owns layout/sizing; `idle`/`active` are the GPUI ghost
  // recipe (transparent at rest → subtle surface chip on hover; popover-open
  // reads cool accent-blue as a "selected" nav state). Classes live in ui.css.
  const btn = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[5px] border border-transparent text-[11px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const idle = 'ui-ghost';
  const active = 'ui-ghost-active';

  return (
    <div
      ref={containerRef}
      // wmux-toolbar is a CSS size container: below the width threshold the
      // label spans hide and the bar collapses to icon-only (titles keep the
      // affordances discoverable). See globals.css.
      className="wmux-toolbar relative flex items-center gap-2 h-9 px-2.5 shrink-0 border-t border-[var(--bg-surface)] bg-[var(--bg-mantle)]"
      data-testid="agent-toolbar"
    >
      <button className={`${btn} ${idle}`} disabled={disabled} onClick={handleAttach} title={t('toolbar.attach')}>
        <IconPaperclip size={13} /> <span className="wmux-toolbar-label wmux-toolbar-label-secondary whitespace-nowrap">{t('toolbar.attach')}</span>
      </button>
      <button className={`${btn} ${popover === 'explorer' ? active : idle}`} onClick={() => togglePopover('explorer')} title={t('toolbar.fileExplorer')}>
        <IconFolder size={13} /> <span className="wmux-toolbar-label wmux-toolbar-label-secondary whitespace-nowrap">{t('toolbar.fileExplorer')}</span>
      </button>
      <button className={`${btn} ${popover === 'snippets' ? active : idle}`} disabled={disabled} onClick={() => togglePopover('snippets')} title={t('toolbar.snippets')}>
        <IconStar size={13} /> <span className="wmux-toolbar-label wmux-toolbar-label-secondary whitespace-nowrap">{t('toolbar.snippets')}</span>
      </button>
      <button className={`${btn} ${popover === 'rich' ? active : idle}`} disabled={disabled} onClick={() => togglePopover('rich')} title={t('toolbar.richInput')}>
        <IconKeyboard size={13} /> <span className="wmux-toolbar-label whitespace-nowrap">{t('toolbar.richInput')}</span>
        <kbd className="wmux-toolbar-label ml-1 px-1 rounded border border-[var(--bg-overlay)] text-[9px] leading-tight opacity-60 font-sans">{window.electronAPI?.platform === 'darwin' ? '⌘G' : 'Ctrl G'}</kbd>
      </button>
      <button
        ref={broadcastBtnRef}
        className={`${btn} ${showBroadcast ? active : idle}`}
        // Opening a local popover clears the global one (explorer/snippets/rich)
        // so the two can't render on top of each other.
        onClick={() => { setPopover(null); setShowBroadcast((v) => !v); }}
        title={t('toolbar.broadcastTooltip')}
        data-testid="broadcast-button"
      >
        <IconUsers size={13} /> <span className="wmux-toolbar-label whitespace-nowrap">{t('toolbar.broadcast')}</span>
      </button>
      <div className="flex-1" />
      {disabled && <span className="text-[10px] text-[var(--text-muted)]">{t('toolbar.noTerminal')}</span>}
      {/* Multi Task (fan-out) — fleet spawn command, back on agent toolbar (DESIGN.md
          Decisions Log 2026-07-20). Sits left of New chat in the right group. Click opens
          FanOutDialog above the toolbar (bottom-full). */}
      <button
        className={`${btn} ${showFanOut ? active : idle}`}
        // Opening a local popover clears the global one (explorer/snippets/rich).
        onClick={() => { setPopover(null); setShowFanOut((v) => !v); }}
        title={t('fanout.title')}
        data-testid="fanout-button"
      >
        <IconSparkles size={13} /> <span className="wmux-toolbar-label whitespace-nowrap">{t('toolbar.fanOut')}</span>
      </button>
      <button className={`${btn} ${idle}`} disabled={disabled} onClick={handleNew} title={t('toolbar.newChat')}>
        <IconPlus size={13} /> <span className="wmux-toolbar-label whitespace-nowrap">{t('toolbar.newChat')}</span>
      </button>

      {popover === 'explorer' && <FileExplorerPopover />}
      {popover === 'snippets' && ptyId && <SnippetsMenu ptyId={ptyId} />}
      {popover === 'rich' && ptyId && <RichInput ptyId={ptyId} />}
      {showBroadcast && <BroadcastPopover onClose={() => setShowBroadcast(false)} triggerRef={broadcastBtnRef} />}
      {showFanOut && <FanOutDialog onClose={() => setShowFanOut(false)} />}
    </div>
  );
}
