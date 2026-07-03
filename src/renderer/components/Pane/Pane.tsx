import { useCallback, useEffect, useState, useMemo } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import type { PaneLeaf, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { useIpc } from '../../hooks/useIpc';
import TerminalComponent from '../Terminal/Terminal';
import BrowserPanel from '../Browser/BrowserPanel';
import EditorPanel from '../Editor/EditorPanel';
import SurfaceTabs from './SurfaceTabs';
import { ErrorBoundary } from '../ErrorBoundary';
import { resolveStartupCwd, withDefaultShell, withWorkspaceProfile } from '../../utils/ptyCreateOptions';
import { permissionFlagFor, resumeGrammarFor } from '../../../shared/agentResume';
import { tokenAttrs } from '../../themes';
import PaneDecorations from '../../plugins/PaneDecorations';

interface PaneProps {
  pane: PaneLeaf;
  // The workspace this leaf pane belongs to. Required so SurfaceTabs can
  // build a drag-export payload that names the correct workspace even in
  // multiview, where useStore(activeWorkspaceId) would pick the focused
  // tile and mis-attribute drags from sibling tiles (codex P1).
  workspace: Workspace;
  isActive: boolean;
  isWorkspaceVisible?: boolean;
}

/**
 * Ring state produced by the T8 notification listener policy and stored in
 * paneSlice's `paneNotificationRing[paneId]`. `flash` is a one-shot 500ms
 * transition (newly arrived); `glow` is the steady "still unseen" indicator.
 */
export type PaneRingState = 'flash' | 'glow' | null | undefined;

/**
 * Pure className composer for the pane container. Extracted so the wiring
 * is testable without mounting the full Pane (Terminal / SurfaceTabs pull
 * in xterm.js, electronAPI mocks, etc).
 *
 * Toggle model (OPTION C — see T11 brief):
 *   - `notificationRingEnabled` gates the LEGACY unread-count pulse (callers
 *     fold this into `hasUnread` before passing it in).
 *   - `paneRingEnabled` gates the NEW state-machine flash/glow visual. When
 *     it's false the flash/glow classes are dropped regardless of `ringState`.
 */
export function composePaneClassName(opts: {
  hasUnread: boolean;
  ringState: PaneRingState;
  paneRingEnabled: boolean;
  flashing: boolean;
  /** B8: pane's active surface has a completed/awaiting agent and the pane is
   *  not focused — blink the border for attention. Takes precedence over the
   *  generic notification ring (the completion blink IS the signal for that
   *  pane, so showing both the blue glow and the green blink would be noisy). */
  completeBlink?: boolean;
}): string {
  const { hasUnread, ringState, paneRingEnabled, flashing, completeBlink } = opts;
  const classes = ['flex', 'flex-col', 'h-full', 'w-full', 'relative', 'box-border'];
  if (hasUnread) classes.push('notification-ring');
  if (completeBlink) {
    classes.push('pane-complete-blink');
  } else {
    if (paneRingEnabled && ringState === 'flash') classes.push('pane-ring-flash');
    if (paneRingEnabled && ringState === 'glow') classes.push('pane-ring-glow');
  }
  if (flashing) classes.push('pane-flash');
  return classes.join(' ');
}

/**
 * Choose which terminal and which browser surface is SHOWN on each side of the
 * terminal+browser split (`SplitSurfaceView` hasBoth). Both sides are laid out
 * side by side and must stay visible, but a pane has a single `activeSurfaceId`,
 * so visibility (what renders on each side) must be decoupled from focus (which
 * side `activeSurfaceId` points at). Each side shows its active surface when the
 * active surface is on that side, otherwise its first surface — so neither side
 * ever blanks when the other is focused. (Bug: each surface gated `display` on
 * `surface.id === activeSurfaceId`, so focusing one side display:none'd the other.)
 *
 * Pure so it is unit-testable without mounting the split (which pulls in xterm).
 */
export function pickSplitShownSurfaces(
  terminals: ReadonlyArray<{ id: string }>,
  browsers: ReadonlyArray<{ id: string }>,
  activeSurfaceId: string,
): { shownTerminalId: string | undefined; shownBrowserId: string | undefined } {
  return {
    shownTerminalId: terminals.find((s) => s.id === activeSurfaceId)?.id ?? terminals[0]?.id,
    shownBrowserId: browsers.find((s) => s.id === activeSurfaceId)?.id ?? browsers[0]?.id,
  };
}

export default function PaneComponent({ pane, workspace, isActive, isWorkspaceVisible = true }: PaneProps) {
  const t = useT();
  const [flashing, setFlashing] = useState(false);
  const setActivePane = useStore((s) => s.setActivePane);
  const setActiveSurface = useStore((s) => s.setActiveSurface);
  const addSurface = useStore((s) => s.addSurface);
  const closeSurface = useStore((s) => s.closeSurface);
  const updateSurfacePtyId = useStore((s) => s.updateSurfacePtyId);
  const markRead = useStore((s) => s.markRead);
  const setPaneNotificationRing = useStore((s) => s.setPaneNotificationRing);

  // count만 가져와 불필요한 배열 참조 안정성 문제 방지
  const unreadCount = useStore((s) =>
    s.notifications.filter(
      (n) => !n.read && pane.surfaces.some((surf) => surf.id === n.surfaceId),
    ).length,
  );
  const notificationRingEnabled = useStore((s) => s.notificationRingEnabled);
  const hasUnread = !isActive && unreadCount > 0 && notificationRingEnabled;

  // ─── T11: state-machine ring (driven by T8 listener policy) ──────────────
  // T3 (paneNotificationRing) and T5 (paneRingEnabled) are merged — read
  // directly from the typed store. `paneRingEnabled` defaults true in uiSlice
  // so the new visual is on by default until the user disables it.
  const ringState = useStore((s) => s.paneNotificationRing[pane.id]);
  const paneRingEnabled = useStore((s) => s.paneRingEnabled);

  // ─── B8: completed-terminal blink ────────────────────────────────────────
  // The pane's active surface ptyId drives the border blink. When that
  // surface's agent reaches a "needs attention" status (complete / waiting /
  // awaiting_input) AND this pane is not focused, the border blinks green.
  // Visiting the pane clears the status (the effect below), so the blink is a
  // one-shot "you haven't looked yet" cue rather than a permanent decoration.
  const activeSurfacePtyId = pane.surfaces.find((s) => s.id === pane.activeSurfaceId)?.ptyId;
  const setSurfaceAgentStatus = useStore((s) => s.setSurfaceAgentStatus);
  const activeSurfaceStatus = useStore((s) =>
    activeSurfacePtyId ? s.surfaceAgentStatus[activeSurfacePtyId] : undefined,
  );
  const completeBlink = !isActive && !!activeSurfaceStatus;

  // Clear the attention status once the user is actually on the pane (covers
  // both "navigated to a blinking pane" and "agent finished while I was
  // watching"). Keyboard nav sets isActive without firing handleClick, so the
  // clear must live here rather than only in the click handler.
  useEffect(() => {
    if (isActive && activeSurfacePtyId && activeSurfaceStatus) {
      setSurfaceAgentStatus(activeSurfacePtyId, null);
    }
  }, [isActive, activeSurfacePtyId, activeSurfaceStatus, setSurfaceAgentStatus]);

  // Ctrl+Shift+H: flash the active pane
  useEffect(() => {
    if (!isActive) return;
    const handler = () => {
      setFlashing(true);
      setTimeout(() => setFlashing(false), 500);
    };
    document.addEventListener('wmux:flash-pane', handler);
    return () => document.removeEventListener('wmux:flash-pane', handler);
  }, [isActive]);

  const handleClick = useCallback(() => {
    setActivePane(pane.id);
    // 최신 state에서 직접 읽어 stale closure 방지
    const { notifications } = useStore.getState();
    const surfaceIds = new Set(pane.surfaces.map((s) => s.id));
    let markedAny = false;
    for (const n of notifications) {
      if (!n.read && n.surfaceId !== undefined && surfaceIds.has(n.surfaceId)) {
        markRead(n.id);
        markedAny = true;
      }
    }
    // Clear the visual ring only when we actually marked something read.
    // A plain pane-focus click with no unread notifications shouldn't wipe a
    // fresh 'flash' from a notification that arrived 50ms ago and hasn't
    // been "seen" yet — the listener-driven flash→glow timeline owns that.
    if (markedAny) {
      setPaneNotificationRing(pane.id, null);
    }
  }, [pane.id, pane.surfaces, setActivePane, markRead, setPaneNotificationRing]);

  const defaultShell = useStore((s) => s.defaultShell);
  const { invoke: ipcInvoke } = useIpc();
  const handleAddSurface = useCallback(async () => {
    // Use the owning workspace id from the prop, NOT global activeWorkspaceId
    // — multiview can leave this Pane mounted while a different tile holds
    // focus, and the global value would tag the new PTY with the wrong
    // workspace. Codex P1 fix 2026-05-24.
    //
    // Read the profile FRESH from the store rather than closing over
    // `workspace.profile`: this callback is memoized on workspace.id, so after
    // the user saves a profile the stale closure would spawn the "+" terminal
    // with the OLD profile, violating the "applies to new panes" contract.
    // Mirrors Terminal.tsx's create path, which also reads the live profile.
    const profile = useStore.getState().workspaces.find((w) => w.id === workspace.id)?.profile;
    // Issue #175: new tabs honor profile.startupCwd > global startupDirectory.
    const cwd = resolveStartupCwd({ splitInheritsCwd: false, profile, startupDirectory: useStore.getState().startupDirectory });
    const result = await ipcInvoke<{ id: string }>(() =>
      window.electronAPI.pty.create(withWorkspaceProfile(withDefaultShell({ workspaceId: workspace.id, cwd }, defaultShell), profile))
    );
    if (result.ok) {
      addSurface(pane.id, result.data.id, 'Terminal', '');
    }
    // On failure, useIpc already surfaced a toast. No-op here.
  }, [pane.id, addSurface, workspace.id, defaultShell, ipcInvoke]);

  const closePane = useStore((s) => s.closePane);

  // Issue #182: zoomed badge. Without a visual cue, a zoomed pane reads as
  // "all my other panes vanished" — mirror tmux's status-line Z marker.
  const isZoomed = useStore((s) => s.zoomedPaneId === pane.id);

  // X8 supervision badge. Resolve the pane's active-surface ptyId → supervision
  // slice. `⟳` when armed (auto-restarting); `⟳!` in a warning colour when the
  // runaway guard tripped and stopped it. Absent for unsupervised panes. As
  // light as the ZOOM badge — no extra component.
  const supervision = useStore((s) =>
    activeSurfacePtyId ? s.supervisionByPtyId[activeSurfacePtyId] : undefined,
  );

  // X6 ②/③ resume pill. A pane recovered-this-boot that was running an agent
  // gets a resume offer. Clickable only once the pane is interactive (first PTY
  // data — EI6) so the paste can't land before the recovered pipe is writable.
  // X6 ③: the pill TYPES the command (no Enter) and assembles progressively —
  // click 1 restores the permission mode (Claude only), an optional click 2
  // appends the EXACT-session resume; the user presses Enter to run. With no
  // binding it falls back to the agent's cwd-relative form (Claude `--continue`,
  // Codex `resume --last`).
  const resumeHint = useStore((s) =>
    activeSurfacePtyId ? s.resumeHintByPtyId[activeSurfacePtyId] : undefined,
  );
  const resumeBinding = useStore((s) =>
    activeSurfacePtyId ? s.resumeBindingByPtyId[activeSurfacePtyId] : undefined,
  );
  const resumePtyReady = useStore((s) =>
    activeSurfacePtyId ? !!s.ptyReadyByPtyId[activeSurfacePtyId] : false,
  );
  // Progressive-assembly stage: 0 = nothing typed; 1 = base command (permission
  // flag) typed, awaiting an optional second click to append the session resume.
  const [resumeStage, setResumeStage] = useState(0);
  // Never carry a stale stage across panes or a re-offer.
  useEffect(() => {
    setResumeStage(0);
  }, [activeSurfacePtyId, resumeHint]);

  const handleCloseSurface = useCallback((surfaceId: string) => {
    const surface = pane.surfaces.find((s) => s.id === surfaceId);
    if (surface?.ptyId) {
      window.electronAPI.pty.dispose(surface.ptyId);
    }
    closeSurface(pane.id, surfaceId);

    // 마지막 Surface가 닫히면 Pane도 자동 제거
    if (pane.surfaces.length <= 1) {
      closePane(pane.id);
    }
  }, [pane.id, pane.surfaces, closeSurface, closePane]);

  return (
    <div
      className={composePaneClassName({ hasUnread, ringState, paneRingEnabled, flashing, completeBlink })}
      style={{
        border: `1px solid ${isActive ? 'var(--accent-cursor)' : 'var(--bg-surface)'}`,
      }}
      onClick={handleClick}
      data-onboarding-target="pane-area"
      data-wmux-pane-root
      {...tokenAttrs('accent', 'border')}
      data-derived="accentCursor"
    >
      <ErrorBoundary name="pane">
      {/* Plugin badges (B-1 ui.pane-decoration) — host-rendered data only */}
      <PaneDecorations paneId={pane.id} />
      {isZoomed && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().togglePaneZoom(pane.id);
          }}
          title={t('settings.prefix.toggleZoom')}
          aria-label={t('settings.prefix.toggleZoom')}
          style={{
            position: 'absolute',
            top: 4,
            right: 6,
            zIndex: 20,
            padding: '0 5px',
            height: 16,
            fontSize: 12,
            lineHeight: '16px',
            fontFamily: 'ui-monospace, monospace',
            color: 'var(--text-main)',
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--bg-surface0, rgba(255,255,255,0.12))',
            borderRadius: 3,
            cursor: 'pointer',
          }}
        >
          ⤡
        </button>
      )}
      {/* Issue #182 discoverability: an un-zoomed pane exposes a quiet maximize
          button (hover-revealed via .wmux-pane-maximize-btn in globals.css) so
          the zoom feature isn't keyboard-only. Clicking it zooms the pane; once
          zoomed, the always-visible ZOOM badge above takes over as the toggle. */}
      {!isZoomed && (
        <button
          className="wmux-pane-maximize-btn"
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().togglePaneZoom(pane.id);
          }}
          title={t('settings.prefix.toggleZoom')}
          aria-label={t('settings.prefix.toggleZoom')}
          style={{
            position: 'absolute',
            top: 4,
            // Sit left of the supervision badge when present (it owns right:6 on
            // an un-zoomed pane); otherwise take the corner.
            right: supervision ? 32 : 6,
            zIndex: 20,
            padding: '0 5px',
            height: 16,
            fontSize: 12,
            lineHeight: '16px',
            fontFamily: 'ui-monospace, monospace',
            color: 'var(--text-main)',
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--bg-surface0, rgba(255,255,255,0.12))',
            borderRadius: 3,
            cursor: 'pointer',
          }}
        >
          ⤢
        </button>
      )}
      {supervision && (
        <span
          title={
            supervision.status === 'stopped'
              ? t('supervision.stoppedTooltip')
              : t('supervision.armedTooltip', { count: supervision.restartCount })
          }
          aria-label={
            supervision.status === 'stopped'
              ? t('supervision.stoppedTooltip')
              : t('supervision.armedTooltip', { count: supervision.restartCount })
          }
          style={{
            position: 'absolute',
            top: 4,
            // Sit to the left of the ZOOM badge when both are present.
            right: isZoomed ? 54 : 6,
            zIndex: 20,
            padding: '1px 6px',
            fontSize: 10,
            fontFamily: 'ui-monospace, monospace',
            fontWeight: 700,
            letterSpacing: '0.04em',
            color: supervision.status === 'stopped' ? 'var(--bg-main)' : 'var(--text-muted)',
            backgroundColor:
              supervision.status === 'stopped' ? 'var(--accent-red)' : 'var(--bg-overlay)',
            border: 'none',
            borderRadius: 3,
            opacity: 0.85,
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          {supervision.status === 'stopped' ? '⟳!' : '⟳'}
        </span>
      )}
      {resumeHint && resumePtyReady && !supervision && activeSurfacePtyId && (() => {
        const ptyId = activeSurfacePtyId;
        const launcher = resumeHint; // slug doubles as the launcher stem ('claude'/'codex')
        const agentName = launcher.charAt(0).toUpperCase() + launcher.slice(1);
        // Resume grammar for this agent (Claude flag form / Codex subcommand
        // form). The pill is only offered for resumable agents, so this is
        // present in practice; guarded below regardless.
        const grammar = resumeGrammarFor(launcher);
        // cwd-match guard (F7): `--resume <id>` is cwd-scoped, so only offer the
        // exact-session resume when the binding's origin cwd still matches the
        // pane's LIVE cwd. The daemon checks this at recovery, but the shell can
        // `cd` afterwards (OSC 7 updates surface.cwd) — re-validate here so a
        // post-recovery cd drops to the cwd-relative `--continue` (plan line 220).
        const normCwd = (p: string | undefined) => {
          // Lowercase ONLY a leading Windows drive letter — drive letters are
          // case-insensitive, but POSIX paths are fully case-sensitive, so a blanket
          // toLowerCase() would treat `/Foo` and `/foo` as equal and wrongly allow
          // `--resume` (CodeRabbit). Mirrors the daemon's normalizeCwd.
          let out = (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
          if (/^[A-Za-z]:\//.test(out)) out = out[0].toLowerCase() + out.slice(1);
          return out;
        };
        const paneCwd = pane.surfaces.find((s) => s.id === pane.activeSurfaceId)?.cwd;
        const cwdMatches = !!(resumeBinding && paneCwd && normCwd(resumeBinding.cwd) === normCwd(paneCwd));
        // The binding must be for THIS launcher's agent. The pill's slug
        // (resumeHint) and the binding are surfaced independently, and the daemon
        // only fills lastDetectedAgent when empty — so a stale hint for one agent
        // could pair with a binding for another, typing `codex --resume <claude-id>`
        // (codex P2). Gate the exact-session path on an agent match too.
        const agentMatches = resumeBinding?.agent === launcher;
        const exactOk = cwdMatches && agentMatches;
        const sessionId = exactOk ? resumeBinding?.sessionId : undefined;
        const permFlag = exactOk ? permissionFlagFor(resumeBinding?.permissionMode) : '';

        // Paste WITHOUT a trailing \r. The user presses Enter to run — so bypass
        // is re-granted only by an explicit keystroke, never automatically (D6).
        const type = (text: string) => window.electronAPI.pty.write(ptyId, text);
        const typeAndClear = (text: string) => {
          type(text);
          useStore.getState().clearResumeHint(ptyId);
        };

        const onPrimary = (e: React.MouseEvent) => {
          e.stopPropagation();
          if (!grammar) return; // not resumable — pill shouldn't have shown (defensive)
          if (!sessionId) {
            // No binding (hook absent / purged / cwd mismatch) → cwd-relative
            // fallback (Claude `--continue`, Codex `resume --last`); no auto-submit.
            typeAndClear(`${launcher} ${grammar.fallback}`);
            return;
          }
          if (resumeStage === 0 && permFlag) {
            // Click 1: permission-restore only (Claude). Stop + Enter = a fresh
            // session in the restored mode; click again to also resume the exact
            // session. Both flags MUST land on ONE line (F6) — hence no submit
            // between clicks. Codex has no permFlag, so it never enters this stage.
            type(`${launcher} ${permFlag}`);
            setResumeStage(1);
            return;
          }
          if (resumeStage === 0) {
            // Default mode (no permission flag) → one click types the full
            // id-resume; no pointless permission-only stop.
            typeAndClear(`${launcher} ${grammar.withId(sessionId)}`);
          } else {
            // Click 2: append the exact-session resume to the already-typed base.
            typeAndClear(` ${grammar.withId(sessionId)}`);
          }
        };

        const primaryLabel = resumeStage === 1
          ? `+ ${t('resume.addSession')}`
          : `▶ ${t('resume.label', { agent: agentName })}`;
        const primaryTooltip = resumeStage === 1 ? t('resume.addSessionTooltip') : t('resume.tooltip');

        return (
          <span
            style={{
              position: 'absolute',
              top: 4,
              left: 6,
              zIndex: 20,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 10,
              fontFamily: 'ui-monospace, monospace',
              fontWeight: 700,
              letterSpacing: '0.04em',
              color: 'var(--bg-main)',
              backgroundColor: 'var(--accent-cursor)',
              borderRadius: 3,
              opacity: 0.9,
              overflow: 'hidden',
            }}
          >
            <button
              onClick={onPrimary}
              title={primaryTooltip}
              aria-label={primaryTooltip}
              style={{
                padding: '1px 6px',
                font: 'inherit',
                color: 'inherit',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {primaryLabel}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                useStore.getState().clearResumeHint(ptyId);
              }}
              title={t('resume.dismiss')}
              aria-label={t('resume.dismiss')}
              style={{
                padding: '1px 5px 1px 0',
                font: 'inherit',
                color: 'inherit',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                opacity: 0.8,
              }}
            >
              ×
            </button>
          </span>
        );
      })()}
      <SurfaceTabs
        surfaces={pane.surfaces}
        activeSurfaceId={pane.activeSurfaceId}
        workspace={workspace}
        paneId={pane.id}
        onSelect={(surfaceId) => setActiveSurface(pane.id, surfaceId)}
        onClose={handleCloseSurface}
        onAdd={handleAddSurface}
      />

      <SplitSurfaceView
        pane={pane}
        workspaceId={workspace.id}
        activeSurfaceId={pane.activeSurfaceId}
        isWorkspaceVisible={isWorkspaceVisible}
        onCloseSurface={handleCloseSurface}
        onPtyCreated={(surfaceId, ptyId) => updateSurfacePtyId(pane.id, surfaceId, ptyId)}
        emptyMessage={t('pane.empty')}
      />
      </ErrorBoundary>
    </div>
  );
}

/** Renders surfaces with a resizable split when both terminals and browsers coexist */
function SplitSurfaceView({
  pane,
  workspaceId,
  activeSurfaceId,
  isWorkspaceVisible,
  onCloseSurface,
  onPtyCreated,
  emptyMessage,
}: {
  pane: PaneLeaf;
  /** Owning workspace id — threaded through to TerminalComponent so PTY
   *  create uses the correct WMUX_WORKSPACE_ID env (Codex P1 2026-05-24). */
  workspaceId: string;
  activeSurfaceId: string;
  isWorkspaceVisible: boolean;
  onCloseSurface: (id: string) => void;
  onPtyCreated: (surfaceId: string, ptyId: string) => void;
  emptyMessage: string;
}) {
  const terminals = useMemo(
    () => pane.surfaces.filter((s) => !s.surfaceType || s.surfaceType === 'terminal'),
    [pane.surfaces],
  );
  const browsers = useMemo(
    () => pane.surfaces.filter((s) => s.surfaceType === 'browser'),
    [pane.surfaces],
  );

  const hasBoth = terminals.length > 0 && browsers.length > 0;

  if (pane.surfaces.length === 0) {
    return (
      <div className="flex-1 relative overflow-hidden flex items-center justify-center text-[var(--text-muted)] text-sm" {...tokenAttrs('textMuted', 'text')}>
        {emptyMessage}
      </div>
    );
  }

  // Only terminals or only browsers — no split needed
  if (!hasBoth) {
    return (
      <div className="flex-1 relative overflow-hidden">
        {pane.surfaces.map((surface) =>
          surface.surfaceType === 'editor' ? (
            <EditorPanel
              key={surface.id}
              filePath={surface.editorFilePath || ''}
              isActive={surface.id === activeSurfaceId}
              surfaceId={surface.id}
            />
          ) : surface.surfaceType === 'browser' ? (
            <BrowserPanel
              key={`${surface.id}:${surface.browserPartition || 'persist:wmux-default'}`}
              surfaceId={surface.id}
              initialUrl={surface.browserUrl || 'https://google.com'}
              partition={surface.browserPartition || 'persist:wmux-default'}
              isActive={surface.id === activeSurfaceId}
              onClose={() => onCloseSurface(surface.id)}
            />
          ) : (
            <TerminalComponent
              key={surface.id}
              ptyId={surface.ptyId || undefined}
              cwd={surface.cwd || undefined}
              isActive={surface.id === activeSurfaceId}
              isWorkspaceVisible={isWorkspaceVisible}
              onPtyCreated={(ptyId) => onPtyCreated(surface.id, ptyId)}
              scrollbackFile={surface.scrollbackFile}
              workspaceId={workspaceId}
              surfaceId={surface.id}
            />
          ),
        )}
      </div>
    );
  }

  // Both terminals and browsers exist — resizable split. Both sides stay
  // visible at once; visibility is decoupled from the pane's single
  // activeSurfaceId (which now only drives focus), else focusing one side
  // display:none'd the other (blank-pane bug).
  const { shownTerminalId, shownBrowserId } = pickSplitShownSurfaces(terminals, browsers, activeSurfaceId);
  return (
    <div className="flex-1 relative overflow-hidden">
      <Group orientation="horizontal" className="h-full w-full" resizeTargetMinimumSize={{ coarse: 37, fine: 16 }}>
        {/* Terminal panel */}
        <Panel defaultSize={50} minSize={20}>
          <div className="h-full w-full relative overflow-hidden">
            {terminals.map((surface) => (
              <TerminalComponent
                key={surface.id}
                ptyId={surface.ptyId || undefined}
                cwd={surface.cwd || undefined}
                isActive={surface.id === activeSurfaceId}
                visible={surface.id === shownTerminalId}
                isWorkspaceVisible={isWorkspaceVisible}
                onPtyCreated={(ptyId) => onPtyCreated(surface.id, ptyId)}
                scrollbackFile={surface.scrollbackFile}
                workspaceId={workspaceId}
                surfaceId={surface.id}
              />
            ))}
          </div>
        </Panel>

        <Separator className="w-1.5 bg-[var(--bg-surface)] hover:bg-[var(--accent-blue)] transition-colors cursor-col-resize" />

        {/* Browser panel */}
        <Panel defaultSize={50} minSize={20}>
          <div className="h-full w-full relative overflow-hidden">
            {browsers.map((surface) => (
              <BrowserPanel
                key={`${surface.id}:${surface.browserPartition || 'persist:wmux-default'}`}
                surfaceId={surface.id}
                initialUrl={surface.browserUrl || 'https://google.com'}
                partition={surface.browserPartition || 'persist:wmux-default'}
                isActive={surface.id === activeSurfaceId}
                visible={surface.id === shownBrowserId}
                onClose={() => onCloseSurface(surface.id)}
              />
            ))}
          </div>
        </Panel>
      </Group>
    </div>
  );
}
