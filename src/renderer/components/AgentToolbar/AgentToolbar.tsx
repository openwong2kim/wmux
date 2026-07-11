import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { selectActiveWorkspace } from '../../stores/selectors/workspaceProjections';
import { useT } from '../../hooks/useT';
import { focusedTerminalPtyId } from '../../utils/focusedSurface';
import { findLeafPanes } from '../../hooks/a2aAddressing';
import { injectText, quotePathsForPrompt } from './inject';
import RichInput from './RichInput';
import SnippetsMenu from './SnippetsMenu';
import FileExplorerPopover from './FileExplorerPopover';
import FanOutDialog from './FanOutDialog';
import { IconPaperclip, IconFolder, IconStar, IconKeyboard, IconSparkles, IconUsers } from '../icons';

export default function AgentToolbar() {
  const t = useT();
  // A1: 활성 ws의 포커스 pty만 필요 — 활성 ws OBJECT만 구독(배경 ws churn 무시).
  const activeWorkspace = useStore(selectActiveWorkspace);
  const popover = useStore((s) => s.toolbarPopover);
  const setPopover = useStore((s) => s.setToolbarPopover);
  const newCommand = useStore((s) => s.newConversationCommand);

  const containerRef = useRef<HTMLDivElement>(null);
  const [showFanOut, setShowFanOut] = useState(false);

  const ptyId = focusedTerminalPtyId(activeWorkspace);
  const disabled = !ptyId;

  // §6 broadcast-only(별개 동작 — WorkTask·worktree·채널 0). 현재 워크스페이스의
  // 모든 터미널 페인(terminal surface)에 같은 텍스트를 inject한다 — 에이전트 페인
  // 선별은 하지 않으므로(F5 라벨 정직화) 라벨도 "모든 터미널 페인"으로 표기한다.
  // C10의 격리 해제 옵션을 fan-out에 두지 않고 별도 진입으로 봉쇄한다. 최소 구현(§6 재량).
  const handleBroadcast = useCallback(async () => {
    if (!activeWorkspace) return;
    const text = window.prompt('broadcast — 현재 워크스페이스의 모든 터미널 페인에 전송');
    if (!text || text.trim().length === 0) return;
    const ptyIds: string[] = [];
    for (const leaf of findLeafPanes(activeWorkspace.rootPane)) {
      for (const s of leaf.surfaces) {
        if (s.ptyId && (s.surfaceType ?? 'terminal') === 'terminal') ptyIds.push(s.ptyId);
      }
    }
    for (const id of ptyIds) {
      await injectText(id, text, true);
    }
  }, [activeWorkspace]);

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
  const btn = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-transparent text-[11px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const idle = 'bg-transparent text-[var(--text-sub)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] hover:text-[var(--text-main)]';
  const active = 'bg-[rgba(var(--bg-surface-rgb),0.8)] text-[var(--accent-blue)]';

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
        <IconPaperclip size={13} /> <span className="wmux-toolbar-label">{t('toolbar.attach')}</span>
      </button>
      <button className={`${btn} ${popover === 'explorer' ? active : idle}`} onClick={() => togglePopover('explorer')} title={t('toolbar.fileExplorer')}>
        <IconFolder size={13} /> <span className="wmux-toolbar-label">{t('toolbar.fileExplorer')}</span>
      </button>
      <button className={`${btn} ${popover === 'snippets' ? active : idle}`} disabled={disabled} onClick={() => togglePopover('snippets')} title={t('toolbar.snippets')}>
        <IconStar size={13} /> <span className="wmux-toolbar-label">{t('toolbar.snippets')}</span>
      </button>
      <button className={`${btn} ${popover === 'rich' ? active : idle}`} disabled={disabled} onClick={() => togglePopover('rich')} title={t('toolbar.richInput')}>
        <IconKeyboard size={13} /> <span className="wmux-toolbar-label">{t('toolbar.richInput')}</span>
        <kbd className="wmux-toolbar-label ml-1 px-1 rounded border border-[var(--bg-overlay)] text-[9px] leading-tight opacity-60 font-sans">{window.electronAPI?.platform === 'darwin' ? '⌘G' : 'Ctrl G'}</kbd>
      </button>
      <button
        className={`${btn} ${showFanOut ? active : idle}`}
        onClick={() => setShowFanOut((v) => !v)}
        title="Fan-out — 프롬프트 1개 → N 격리 태스크"
        data-testid="fanout-button"
      >
        <IconSparkles size={13} /> <span className="wmux-toolbar-label">Fan-out</span>
      </button>
      <button
        className={`${btn} ${idle}`}
        onClick={handleBroadcast}
        title="Broadcast — 현재 워크스페이스의 모든 터미널 페인에 같은 텍스트(격리 없음)"
        data-testid="broadcast-button"
      >
        <IconUsers size={13} /> <span className="wmux-toolbar-label">Broadcast</span>
      </button>
      <div className="flex-1" />
      {disabled && <span className="text-[10px] text-[var(--text-muted)]">{t('toolbar.noTerminal')}</span>}
      <button className={`${btn} ${idle}`} disabled={disabled} onClick={handleNew} title={t('toolbar.new')}>
        <IconSparkles size={13} /> <span className="wmux-toolbar-label">{t('toolbar.new')}</span>
      </button>

      {popover === 'explorer' && <FileExplorerPopover />}
      {popover === 'snippets' && ptyId && <SnippetsMenu ptyId={ptyId} />}
      {popover === 'rich' && ptyId && <RichInput ptyId={ptyId} />}
      {showFanOut && <FanOutDialog onClose={() => setShowFanOut(false)} />}
    </div>
  );
}
