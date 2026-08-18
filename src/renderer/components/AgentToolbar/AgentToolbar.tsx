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
import { IconPaperclip, IconFolder, IconStar, IconKeyboard, IconPlus, IconUsers, IconSparkles, IconLock } from '../icons';

/** Bar height — also the travel distance of the reveal transform. */
export const AGENT_TOOLBAR_HEIGHT = 36;

/**
 * The workspace-spanning agent toolbar (restored 2026-08-18, owner call).
 *
 * It overlays the pane grid instead of taking a layout row: taking layout would
 * resize every PTY on each reveal. `useHoverReveal` owns when it shows; this
 * component only renders and reports its own hover state upward through
 * `barHandlers`.
 */
interface AgentToolbarProps {
  /** From useHoverReveal — keeps the bar up while the pointer is on it. */
  barHandlers: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
  };
  revealed: boolean;
  /** Signals "a popover is open" so the host can hold the bar visible. */
  onHoldChange: (hold: boolean) => void;
}

export default function AgentToolbar({ barHandlers, revealed, onHoldChange }: AgentToolbarProps) {
  const t = useT();
  // A1: 활성 ws의 포커스 pty만 필요 — 활성 ws OBJECT만 구독(배경 ws churn 무시).
  const activeWorkspace = useStore(selectActiveWorkspace);
  const popover = useStore((s) => s.toolbarPopover);
  const setPopover = useStore((s) => s.setToolbarPopover);
  const newCommand = useStore((s) => s.newConversationCommand);
  const pinned = useStore((s) => s.agentToolbarPinned);
  const setPinned = useStore((s) => s.setAgentToolbarPinned);
  const fanOutOpen = useStore((s) => s.fanOutWorkspaceId != null);
  const openFanOut = useStore((s) => s.openFanOut);
  const closeFanOut = useStore((s) => s.closeFanOut);

  const containerRef = useRef<HTMLDivElement>(null);
  const broadcastBtnRef = useRef<HTMLButtonElement>(null);
  const [showBroadcast, setShowBroadcast] = useState(false);

  const ptyId = focusedTerminalPtyId(activeWorkspace);
  const disabled = !ptyId;

  // Anything open below the bar must keep it on screen — a popover whose
  // trigger vanished under the pointer is the failure mode hover bars are
  // notorious for.
  const hold = popover !== null || showBroadcast || fanOutOpen;
  useEffect(() => { onHoldChange(hold); }, [hold, onHoldChange]);

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

  // Fan-out opens through the store so its dialog portals out of this bar's
  // stacking context. The anchor is the button's REAL rect: placePopover
  // right-aligns against `right`, so passing a synthesised rect (the old
  // {top,left}-only shape) drove it hard against the viewport's left pad.
  const handleFanOut = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (!activeWorkspace) return;
    if (fanOutOpen) { closeFanOut(); return; }
    setPopover(null);
    setShowBroadcast(false);
    const r = event.currentTarget.getBoundingClientRect();
    openFanOut(activeWorkspace.id, { top: r.top, left: r.left, right: r.right, bottom: r.bottom });
  }, [activeWorkspace, fanOutOpen, closeFanOut, setPopover, openFanOut]);

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
  const btn = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[5px] border border-transparent text-[11px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const idle = 'ui-ghost';
  const active = 'ui-ghost-active';

  return (
    <div
      ref={containerRef}
      {...barHandlers}
      // wmux-toolbar is a CSS size container: below the width threshold the
      // label spans hide and the bar collapses to icon-only (titles keep the
      // affordances discoverable). See globals.css.
      // No overflow clipping here: the popovers open upward (`bottom-full`)
      // out of this box. html/body already clip, so the hidden bar's
      // translateY cannot produce a scrollbar.
      className="wmux-toolbar absolute inset-x-0 bottom-0 z-30 flex items-center gap-2 h-9 px-2.5 border-t border-[var(--bg-surface)] bg-[var(--bg-mantle)] transition-transform duration-150 ease-out"
      style={{
        transform: revealed ? 'translateY(0)' : `translateY(${AGENT_TOOLBAR_HEIGHT}px)`,
        // The host is pointer-events:none so the grid keeps its clicks; the bar
        // opts back in, but only once it is actually on screen.
        pointerEvents: revealed ? 'auto' : 'none',
      }}
      // Hidden from AT while off-screen; the palette commands remain the
      // keyboard route either way.
      aria-hidden={!revealed}
      data-testid="agent-toolbar"
      data-revealed={revealed ? 'true' : 'false'}
    >
      <button className={`${btn} ${idle}`} disabled={disabled} onClick={handleAttach} title={t('toolbar.attach')}>
        <IconPaperclip size={13} /> <span className="wmux-toolbar-label wmux-toolbar-label-secondary whitespace-nowrap">{t('toolbar.attach')}</span>
      </button>
      {/* Disabled without a focused terminal: the explorer's only verb is
          "insert this path into the prompt", which needs a pty to write to. */}
      <button
        className={`${btn} ${popover === 'explorer' ? active : idle}`}
        disabled={disabled}
        onClick={() => togglePopover('explorer')}
        title={t('toolbar.fileExplorer')}
        data-toolbar-action="file-explorer"
      >
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
      {/* Multi Task(fan-out) — 함대 스폰 명령이라 에이전트 툴바에 산다. 우측
          그룹에서 New chat 왼쪽. */}
      <button
        className={`${btn} ${fanOutOpen ? active : idle}`}
        onClick={handleFanOut}
        title={t('fanout.title')}
        data-testid="fanout-button"
      >
        <IconSparkles size={13} /> <span className="wmux-toolbar-label whitespace-nowrap">{t('toolbar.fanOut')}</span>
      </button>
      <button className={`${btn} ${idle}`} disabled={disabled} onClick={handleNew} title={t('toolbar.newChat')}>
        <IconPlus size={13} /> <span className="wmux-toolbar-label whitespace-nowrap">{t('toolbar.newChat')}</span>
      </button>
      {/* Pin — the escape hatch from reveal-on-approach. Pinned, this is the
          plain always-on strip; unpinned it stays out of the terminal's way. */}
      <button
        className={`${btn} ${pinned ? active : idle}`}
        onClick={() => setPinned(!pinned)}
        title={pinned ? t('toolbar.unpin') : t('toolbar.pin')}
        aria-pressed={pinned}
        data-testid="toolbar-pin"
      >
        <IconLock size={12} />
      </button>

      {popover === 'explorer' && ptyId && (
        <FileExplorerPopover ptyId={ptyId} onClose={() => setPopover(null)} />
      )}
      {popover === 'snippets' && ptyId && <SnippetsMenu ptyId={ptyId} />}
      {popover === 'rich' && ptyId && <RichInput ptyId={ptyId} />}
      {showBroadcast && <BroadcastPopover onClose={() => setShowBroadcast(false)} triggerRef={broadcastBtnRef} />}
    </div>
  );
}
