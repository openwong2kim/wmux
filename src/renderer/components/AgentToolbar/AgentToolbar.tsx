import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { selectActiveWorkspace } from '../../stores/selectors/workspaceProjections';
import { useT } from '../../hooks/useT';
import { focusedTerminalPtyId } from '../../utils/focusedSurface';
import { attachFilesToPty, injectText } from './inject';
import RichInput from './RichInput';
import SnippetsMenu from './SnippetsMenu';
import FileExplorerPopover from './FileExplorerPopover';
import BroadcastPopover from './BroadcastPopover';
import SessionSchedulesPopover from './SessionSchedulesPopover';
import { IconPaperclip, IconFolder, IconStar, IconKeyboard, IconPlus, IconUsers, IconSparkles, IconLock, IconClock } from '../icons';

/** Bar height — also the travel distance of the reveal transform. */
export const AGENT_TOOLBAR_HEIGHT = 36;

/** Marks a surface that BELONGS to the toolbar even though it renders through
 *  a portal. The outside-click test consults it, so a portalled popover is not
 *  mistaken for a click elsewhere and torn down before it can act. */
export const TOOLBAR_OWNED_ATTR = 'data-toolbar-owned';

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
  /** Focus reached a control — reveal so it is visible while focused. */
  onFocusEnter: () => void;
}

export default function AgentToolbar({ barHandlers, revealed, onHoldChange, onFocusEnter }: AgentToolbarProps) {
  const t = useT();
  // Only the active workspace's focused pty is needed here, so subscribe to
  // the active workspace OBJECT and ignore churn in background workspaces.
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
  const [newArmed, setNewArmed] = useState(false);

  const ptyId = focusedTerminalPtyId(activeWorkspace);
  const activeAgent = useStore((s) => (ptyId ? s.surfaceAgent[ptyId] : undefined));
  const disabled = !ptyId;

  // Anything open below the bar must keep it on screen — a popover whose
  // trigger vanished under the pointer is the failure mode hover bars are
  // notorious for. `toolbarPopover` is global and the popovers themselves are
  // gated on `ptyId`, so a pane closing under an open popover left the state
  // set with nothing rendered — and the bar held open forever. Hold only for
  // popovers that can actually be on screen.
  const popoverOnScreen = popover !== null && !!ptyId;
  const hold = popoverOnScreen || showBroadcast || fanOutOpen;
  useEffect(() => { onHoldChange(hold); }, [hold, onHoldChange]);

  // Losing the focused terminal invalidates every popover here; clear the
  // global flag too so nothing else reads a popover that cannot render.
  useEffect(() => {
    if (!ptyId && popover !== null) setPopover(null);
  }, [ptyId, popover, setPopover]);

  const handleAttach = useCallback(() => {
    if (!ptyId) return;
    void attachFilesToPty(ptyId);
  }, [ptyId]);

  // Two-step, like the pane cluster's button was: the default command is
  // `/clear`, which discards the agent's conversation. A single stray click on
  // a bar that appears under the pointer must not be able to do that.
  const handleNew = useCallback(() => {
    if (!ptyId) return;
    if (!newArmed) { setNewArmed(true); return; }
    void injectText(ptyId, newCommand, true);
    setNewArmed(false);
  }, [ptyId, newCommand, newArmed]);

  useEffect(() => {
    if (!newArmed) return;
    const id = window.setTimeout(() => setNewArmed(false), 4000);
    return () => window.clearTimeout(id);
  }, [newArmed]);

  // Every open path closes the others. Fan-out already cleared these; without
  // the reverse the two dialogs could sit on top of each other.
  const togglePopover = (name: 'explorer' | 'snippets' | 'rich' | 'schedule') => {
    if (fanOutOpen) closeFanOut();
    setShowBroadcast(false);
    setPopover(popover === name ? null : name);
  };

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
    // "Outside" cannot be decided by the bar's DOM alone: FileExplorerPopover
    // portals to document.body, so a click on one of its rows is outside
    // containerRef. Closing on that mousedown unmounted the popover before its
    // own click could run — the explorer looked alive and inserted nothing.
    // Portalled children of this bar count as inside.
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!containerRef.current || !target) return;
      if (containerRef.current.contains(target)) return;
      if (target.closest?.(`[${TOOLBAR_OWNED_ATTR}]`)) return;
      setPopover(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [popover, setPopover]);

  /* ⌘G is owned by ToolbarHost (useComposeShortcut), which mounts above the
     enabled gate so the binding survives the bar being switched off. */

  // Quiet chrome (design-system cohesion): buttons are text-first with no box
  // until hovered/active — the toolbar reads as part of the frame, not a row
  // of widgets competing with the terminals.
  // `pointer-events-auto` on every control: the bar's own background stays
  // transparent to the terminal underneath (see the container style), so each
  // interactive child has to claim its own hit area.
  const btn = 'pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[5px] border border-transparent text-[11px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
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
        // The bar's own background never takes pointer events: it covers the
        // bottom ~2 rows of the terminal, and claiming them would steal the
        // clicks and drag-selection that belong to the text underneath —
        // permanently, once pinned. Only the controls opt in (`.ui-toolbar-hit`
        // below), so the gaps between them stay transparent to the terminal.
        pointerEvents: 'none',
      }}
      // `inert` (not just aria-hidden) while off-screen: aria-hidden alone left
      // eight buttons in the tab order, so Tab walked into invisible controls
      // and focus could be trapped inside an aria-hidden subtree.
      //
      // `hold` is OR-ed in because it is computed here, synchronously, while
      // `revealed` arrives from the host one render later. Without it ⌘G
      // mounted Rich Input inside a still-inert bar, where its autofocus was
      // silently dropped — focus stayed on the terminal, and Escape then went
      // to xterm instead of closing the popover.
      inert={!revealed && !hold}
      aria-hidden={!revealed && !hold}
      // Keyboard users get here by focus, not by pointer: focusing any control
      // reveals the bar so it is visible while it has focus.
      onFocusCapture={onFocusEnter}
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
        <kbd className="wmux-toolbar-label ml-1 px-1 rounded border border-[var(--bg-overlay)] text-[10px] leading-tight opacity-60 font-sans">{window.electronAPI?.platform === 'darwin' ? '⌘G' : 'Ctrl G'}</kbd>
      </button>
      <button
        className={`${btn} ${popover === 'schedule' ? active : idle}`}
        disabled={disabled}
        onClick={() => togglePopover('schedule')}
        title={t('toolbar.scheduleTooltip')}
        data-testid="session-schedule-button"
      >
        <IconClock size={13} /> <span className="wmux-toolbar-label whitespace-nowrap">{t('toolbar.schedule')}</span>
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
      {/* Multi Task (fan-out) — a fleet-spawn command, so it lives on the
          agent toolbar, in the right-hand group left of New chat. */}
      <button
        className={`${btn} ${fanOutOpen ? active : idle}`}
        onClick={handleFanOut}
        title={t('fanout.title')}
        data-testid="fanout-button"
      >
        <IconSparkles size={13} /> <span className="wmux-toolbar-label whitespace-nowrap">{t('toolbar.fanOut')}</span>
      </button>
      <button
        className={`${btn} ${newArmed ? active : idle}`}
        disabled={disabled}
        onClick={handleNew}
        title={newArmed
          ? t('toolbar.newConversationConfirm')
          : `${t('toolbar.newChat')} (${newCommand})`}
        data-testid="new-conversation"
        data-armed={newArmed ? 'true' : 'false'}
      >
        <IconPlus size={13} />
        <span className="wmux-toolbar-label whitespace-nowrap">
          {newArmed ? t('toolbar.newConversationConfirm') : t('toolbar.newChat')}
        </span>
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

      {/* These three render INSIDE the bar, which is pointer-events:none, so
          each claims its own hit area at its root (FileExplorerPopover portals
          to document.body and is therefore unaffected). */}
      {popover === 'explorer' && ptyId && (
        <FileExplorerPopover ptyId={ptyId} onClose={() => setPopover(null)} />
      )}
      {popover === 'snippets' && ptyId && <SnippetsMenu ptyId={ptyId} />}
      {popover === 'rich' && ptyId && <RichInput ptyId={ptyId} />}
      {popover === 'schedule' && ptyId && (
        <SessionSchedulesPopover
          ptyId={ptyId}
          agentSlug={activeAgent?.slug}
          agentName={activeAgent?.name}
        />
      )}
      {showBroadcast && <BroadcastPopover onClose={() => setShowBroadcast(false)} triggerRef={broadcastBtnRef} />}
    </div>
  );
}
