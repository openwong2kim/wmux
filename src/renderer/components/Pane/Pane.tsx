import { useCallback, useEffect, useState, useMemo } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import type { PaneLeaf, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import TerminalComponent from '../Terminal/Terminal';
import BrowserPanel from '../Browser/BrowserPanel';
import EditorPanel from '../Editor/EditorPanel';
import DiffPanel from '../Diff/DiffPanel';
import SurfaceTabs, { PANE_ACTIONS_CLUSTER_WIDTH } from './SurfaceTabs';
import { ErrorBoundary } from '../ErrorBoundary';
import { agentSupportsPermissionFlag, permissionFlagFor, resumeGrammarFor } from '../../../shared/agentResume';
import { applyRoleBinding, bindingEnforcesModel, type RoleBinding } from '../../../shared/orchestratorRole';
import { ResumeInfoChipGate } from './ResumeInfoChip';
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
  /** This leaf is hidden because another pane in ITS tree is zoomed (#517). */
  isZoomHidden?: boolean;
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

/** D2 — only a terminal surface can launch an agent, so only a terminal surface
 *  may claim a role-enforced model. An undefined `surfaceType` is a legacy
 *  terminal (the field postdates the original Surface shape). */
export function isTerminalSurfaceType(surfaceType: string | undefined): boolean {
  return surfaceType === undefined || surfaceType === 'terminal';
}

/**
 * D2 — may this pane display a "role-enforced launch" model badge?
 *
 * Both halves are load-bearing and neither is obvious at the call site, which is
 * why this is a named predicate rather than an inline `&&`:
 *  - the binding must REALLY inject the model (bindingEnforcesModel). A
 *    model-only binding, or one naming an agent whose `--model` grammar wmux has
 *    not verified, is stored and shown in Settings but never applied — badging it
 *    would tell the operator a pane is pinned to a model while the launch goes
 *    out on the default.
 *  - the surface must be a terminal, since nothing else launches an agent.
 */
export function showsEnforcedModelBadge(opts: {
  binding: RoleBinding | undefined;
  surfaceType: string | undefined;
}): boolean {
  return bindingEnforcesModel(opts.binding) && isTerminalSurfaceType(opts.surfaceType);
}

/**
 * D2 — the `right` offset at which the enforced-model badge can sit without
 * covering the pane's top-right controls, which are all absolutely positioned
 * at `top: 4` with `zIndex: 20`:
 *   - action cluster ON  → SurfaceTabs owns the strip (PANE_ACTIONS_CLUSTER_WIDTH),
 *     with the supervision badge parked just left of it.
 *   - action cluster OFF → the zoom (`right: 6`) or maximize button takes the
 *     corner, and the supervision badge sits at 6 (un-zoomed, pushing maximize
 *     out to 32) or 54 (zoomed).
 * The badge lands past whichever of those is rightmost. Pure so the arithmetic
 * is testable without a DOM — the same reason composePaneClassName is extracted.
 */
export function enforcedModelBadgeOffset(opts: {
  paneActionsVisible: boolean;
  isZoomed: boolean;
  supervised: boolean;
}): number {
  const { paneActionsVisible, isZoomed, supervised } = opts;
  /** Rendered width of the supervision badge (10px glyph + 6px side padding). */
  const SUPERVISION_W = 28;
  /** Rendered width of a corner icon button plus its 6px gutter. */
  const CORNER_BTN_W = 26;
  if (paneActionsVisible) {
    return PANE_ACTIONS_CLUSTER_WIDTH + 6 + (supervised ? SUPERVISION_W : 0);
  }
  if (!supervised) return 6 + CORNER_BTN_W;
  // Supervised: zoom sits at 6 and supervision at 54, else supervision at 6 and
  // maximize at 32.
  return isZoomed ? 54 + SUPERVISION_W : 32 + CORNER_BTN_W + 4;
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

/**
 * F6 — non-PTY overlay surfaces (diff / editor) for the terminal+browser split.
 *
 * The `hasBoth` split path lays out terminals and browsers side by side but
 * consulted neither `diff` nor `editor` surfaces, so an active diff surface in
 * a mixed pane rendered nothing. This pure predicate isolates the overlay set
 * (diff + editor) so the routing is unit-testable without mounting the split
 * (which pulls in xterm + DiffPanel's rpc bridge). Order-preserving.
 */
export function pickOverlaySurfaces<T extends { surfaceType?: string }>(
  surfaces: ReadonlyArray<T>,
): T[] {
  return surfaces.filter(
    (s) => s.surfaceType === 'diff' || s.surfaceType === 'editor',
  );
}

/** The side effect the reboot-recovery pill performs on one primary-button
 *  click: the exact string written to the PTY, plus the two follow-ups the
 *  handler must apply (clear the hint / advance the progressive stage) and
 *  whether the role→model rewrite actually fired (for the audit log). */
export interface RecoveryPillPlan {
  /** Written verbatim to the PTY (no trailing \r — the user presses Enter). */
  text: string;
  /** typeAndClear vs type: clear the resume hint after writing. */
  clearHint: boolean;
  /** Advance to stage 1 (permission-restore base typed, awaiting the resume
   *  arg on a second click). */
  advanceStage: boolean;
  /** applyRoleBinding changed a launcher-prefixed variant — the caller logs it
   *  once, at the action (not on every render). */
  rewritten: boolean;
}

/**
 * D2 — what the reboot-recovery pill types for one primary click, with the
 * pane's role→model binding re-asserted on every launcher-prefixed variant.
 *
 * This mirrors the persistent chip's {@link buildPaneResumeCommand}: a resume
 * command reconstructed from the agent stem + resume/permission flags would
 * silently DROP a bound model, so `applyRoleBinding` re-injects it (its own gates
 * handle a non-agent stem, prose, an explicit `--model`, or an agent mismatch —
 * so the four launcher-prefixed forms can be passed through unconditionally).
 *
 * The two-stage assembly (stage 0 types a permission-restore base, stage 1
 * appends the exact-session resume) puts the model on the STAGE-0 base, because
 * the stage-2 continuation is a bare ` <resumeArg>` fragment — not launcher-
 * prefixed — which applyRoleBinding would no-op on anyway (its stem gate). So the
 * assembled line ends up `claude --model haiku --permission-mode plan --resume
 * <id>`: one valid line, model included.
 *
 * Pure + exported so the rewrite and the two-stage assembly are unit-testable
 * without a DOM (the repo's vitest runs node-env; see the sibling helpers).
 * Returns null for a non-resumable launcher (the pill should not have shown).
 */
export function planRecoveryPillType(args: {
  launcher: string;
  /** The exact-session id when the cwd+agent gates passed, else undefined. */
  sessionId: string | undefined;
  /** The permission-restore flag(s) for this launch, or '' when none apply. */
  permFlag: string;
  /** Toggle-ON path: type the whole `--dangerously-skip-permissions` line at
   *  once (no progressive stage). */
  forceSkip: boolean;
  /** Progressive-assembly stage: 0 = nothing typed yet, 1 = base typed. */
  resumeStage: number;
  /** The pane's role→model binding (re-asserted on the launch), if bound. */
  roleBinding: RoleBinding | undefined;
}): RecoveryPillPlan | null {
  const { launcher, sessionId, permFlag, forceSkip, resumeStage, roleBinding } = args;
  const grammar = resumeGrammarFor(launcher);
  if (!grammar) return null; // not resumable — pill shouldn't have shown (defensive)
  // Re-assert the bound model on a launcher-prefixed line. The stage-2
  // continuation is NOT launcher-prefixed, so it is typed verbatim (the model
  // already rode the stage-0 base) — matching input.send / buildPaneResumeCommand.
  const rewrite = (cmd: string): { text: string; rewritten: boolean } => {
    const r = applyRoleBinding(cmd, roleBinding);
    return { text: r.command, rewritten: r.changed };
  };
  const resumeArg = sessionId ? grammar.withId(sessionId) : grammar.fallback;
  if (forceSkip) {
    // Toggle ON: the WHOLE line at once so both flags land together (F6).
    const { text, rewritten } = rewrite(`${launcher}${permFlag ? ` ${permFlag}` : ''} ${resumeArg}`);
    return { text, clearHint: true, advanceStage: false, rewritten };
  }
  if (!sessionId) {
    // No binding → cwd-relative fallback (Claude `--continue`, Codex `resume --last`).
    const { text, rewritten } = rewrite(`${launcher} ${grammar.fallback}`);
    return { text, clearHint: true, advanceStage: false, rewritten };
  }
  if (resumeStage === 0 && permFlag) {
    // Click 1: permission-restore base ONLY — but with the model already
    // injected, so click 2's bare resume arg appends onto a line carrying --model.
    const { text, rewritten } = rewrite(`${launcher} ${permFlag}`);
    return { text, clearHint: false, advanceStage: true, rewritten };
  }
  if (resumeStage === 0) {
    // Default mode (no permission flag) → one click types the full id-resume.
    const { text, rewritten } = rewrite(`${launcher} ${grammar.withId(sessionId)}`);
    return { text, clearHint: true, advanceStage: false, rewritten };
  }
  // Click 2: append the exact-session resume to the already-typed base. NOT
  // launcher-prefixed, so it is never independently rewritten (the model is
  // already on the base line typed in stage 0).
  return { text: ` ${grammar.withId(sessionId)}`, clearHint: true, advanceStage: false, rewritten: false };
}

export default function PaneComponent({ pane, workspace, isActive, isWorkspaceVisible = true, isZoomHidden = false }: PaneProps) {
  const t = useT();
  const [flashing, setFlashing] = useState(false);
  const setActivePane = useStore((s) => s.setActivePane);
  const setActiveSurface = useStore((s) => s.setActiveSurface);
  const addBrowserSurface = useStore((s) => s.addBrowserSurface);
  const splitPane = useStore((s) => s.splitPane);
  const closeSurface = useStore((s) => s.closeSurface);
  const updateSurfacePtyId = useStore((s) => s.updateSurfacePtyId);
  const markRead = useStore((s) => s.markRead);
  const setPaneNotificationRing = useStore((s) => s.setPaneNotificationRing);

  // count만 가져와 불필요한 배열 참조 안정성 문제 방지.
  // O(S) via the unreadBySurfaceId index on store state (was O(P×N×S) filter).
  const unreadCount = useStore((s) =>
    pane.surfaces.reduce((acc, surf) => acc + (s.unreadBySurfaceId[surf.id] ?? 0), 0),
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

  // (handleAddSurface removed with the pane-header "new terminal" button —
  // one pane = one terminal is the concept. Ctrl+T still adds a surface via
  // the keyboard path in useKeyboard.ts → store.addSurface.)

  // Pane header actions (SurfaceTabs cluster). Split direction semantics match
  // the store + keyboard: 'horizontal' → side-by-side columns (Ctrl+D, the new
  // pane opens right); 'vertical' → stacked rows (Ctrl+Shift+D, new pane below).
  // Pass workspace.id explicitly (not global active) so multiview targets the
  // owning workspace — same reasoning as handleAddSurface above.
  const handleSplitHorizontal = useCallback(() => {
    splitPane(pane.id, 'horizontal', workspace.id);
  }, [splitPane, pane.id, workspace.id]);
  const handleSplitVertical = useCallback(() => {
    splitPane(pane.id, 'vertical', workspace.id);
  }, [splitPane, pane.id, workspace.id]);
  const handleAddBrowser = useCallback(() => {
    addBrowserSurface(pane.id, undefined, undefined, workspace.id);
  }, [addBrowserSurface, pane.id, workspace.id]);

  const closePane = useStore((s) => s.closePane);

  // Issue #182: zoomed badge. Without a visual cue, a zoomed pane reads as
  // "all my other panes vanished" — mirror tmux's status-line Z marker.
  const isZoomed = useStore((s) => s.zoomedPaneId === pane.id);

  // When the pane action cluster is shown (SurfaceTabs), zoom/maximize lives as
  // the cluster's fifth button. The absolute corner maximize/restore controls
  // below are then redundant AND overlap the cluster, so they render only when
  // the cluster is absent. Subscribe the same way SurfaceTabs does.
  const paneActionsVisible = useStore((s) => s.paneActionsVisible);

  // X8 supervision badge. Resolve the pane's active-surface ptyId → supervision
  // slice. `⟳` when armed (auto-restarting); `⟳!` in a warning colour when the
  // runaway guard tripped and stopped it. Absent for unsupervised panes. As
  // light as the ZOOM badge — no extra component.
  const supervision = useStore((s) =>
    activeSurfacePtyId ? s.supervisionByPtyId[activeSurfacePtyId] : undefined,
  );

  const enforcedModelBadgeRight = enforcedModelBadgeOffset({
    paneActionsVisible,
    isZoomed,
    supervised: !!supervision,
  });

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
  // D2 — this pane's enforced role→model binding (if its role is bound). Threaded
  // into the resume chip so a reconstructed resume command re-asserts the model
  // flag (a naive resume rebuilds from the agent stem alone and would drop it).
  const paneRoleName = useStore((s) => s.paneRole[pane.id]);
  const paneRoleBinding = useStore((s) =>
    paneRoleName ? s.orchestratorRoleBindings[paneRoleName] : undefined,
  );
  const showsEnforcedModel = showsEnforcedModelBadge({
    binding: paneRoleBinding,
    surfaceType: pane.surfaces.find((s) => s.id === pane.activeSurfaceId)?.surfaceType,
  });
  // The persistent resume chip's "is this pane's agent busy?" gate — and the
  // store-wide `agentClockMs` decay-clock subscription it needs — lives in the
  // <ResumeInfoChipGate> leaf below, NOT here: Pane mounts that leaf only when a
  // resume binding is present, so a clock tick (bumped ~every 2 s by
  // useAgentActivityClock while any agent is active) re-renders just the tiny
  // gate, never the whole Pane body across every mounted pane.
  // Progressive-assembly stage: 0 = nothing typed; 1 = base command (permission
  // flag) typed, awaiting an optional second click to append the session resume.
  const [resumeStage, setResumeStage] = useState(0);
  // --dangerously-skip-permissions toggle for the recovery pill, default ON
  // (the owner routinely resumes in bypass mode and was retyping the flag by
  // hand). Claude-only; mirrors the persistent chip's toggle.
  const [resumeSkipPermissions, setResumeSkipPermissions] = useState(true);
  // Never carry a stale stage/toggle across panes or a re-offer.
  useEffect(() => {
    setResumeStage(0);
    setResumeSkipPermissions(true);
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
        // Design-system cohesion: panes keep a QUIET hairline in both states —
        // focus is signaled by the amber underline on the tab strip (mock's
        // .pane.focused .pane-head treatment), not a loud full border box.
        // Longhand (not the `border` shorthand) so this can coexist with the
        // per-side borderTopWidth override below without React's "mixing
        // shorthand and non-shorthand" dev warning firing on re-render.
        borderStyle: 'solid',
        borderColor: isActive ? 'var(--bg-overlay)' : 'var(--border-soft)',
        // No TOP border: it sat redundantly under the 36px titlebar's own bottom
        // hairline (a double line) AND pushed the tab strip down 1px, so the
        // pane's bottom-hairline seam landed 1px below the deck tabs' — the
        // "the top line doesn't connect" report. Content now starts at the
        // column top, aligned with the deck. The attention ring keeps its other
        // three sides (its border-color override still applies).
        borderTopWidth: 0,
        borderRightWidth: 1,
        borderBottomWidth: 1,
        borderLeftWidth: 1,
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
      {!paneActionsVisible && isZoomed && (
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
      {!paneActionsVisible && !isZoomed && (
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
            // When the action cluster is shown it owns the strip's top-right, so
            // anchor the badge just left of it (cluster width + a small gap) to
            // avoid overlap — using the exported constant beside the cluster
            // rather than a hardcoded pixel guess. Cluster-off keeps the prior
            // behaviour: sit left of the ZOOM badge when both are present.
            right: paneActionsVisible
              ? PANE_ACTIONS_CLUSTER_WIDTH + 6
              : isZoomed
                ? 54
                : 6,
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
        // Candidates, not a single cwd (2026-07-21): surface.cwd goes stale
        // across `cd X; claude` one-liners (no prompt render → no OSC 7), which
        // wrongly downgraded a legitimate exact resume to `--continue`. The
        // workspace's hook-reported agent cwd (metadata.cwd) is the second
        // candidate — same rationale as buildPaneResumeCommand (ResumeInfoChip).
        const paneCwdCandidates = [
          pane.surfaces.find((s) => s.id === pane.activeSurfaceId)?.cwd,
          workspace.metadata?.cwd,
        ];
        const cwdMatches = !!resumeBinding &&
          paneCwdCandidates.some((c) => !!c && normCwd(resumeBinding.cwd) === normCwd(c));
        // The binding must be for THIS launcher's agent. The pill's slug
        // (resumeHint) and the binding are surfaced independently, and the daemon
        // only fills lastDetectedAgent when empty — so a stale hint for one agent
        // could pair with a binding for another, typing `codex --resume <claude-id>`
        // (codex P2). Gate the exact-session path on an agent match too.
        const agentMatches = resumeBinding?.agent === launcher;
        const exactOk = cwdMatches && agentMatches;
        const sessionId = exactOk ? resumeBinding?.sessionId : undefined;
        // --dangerously-skip-permissions is a launch preference, not tied to the
        // exact conversation, so the explicit toggle forces it on EITHER the exact
        // resume or the cwd-relative fallback. When the toggle is OFF, fall back
        // to restoring the captured mode (acceptEdits/plan), exact-resume only.
        const canSkip = agentSupportsPermissionFlag(launcher);
        const forceSkip = canSkip && resumeSkipPermissions;
        const permFlag = forceSkip
          ? permissionFlagFor('bypassPermissions')
          : (exactOk ? permissionFlagFor(resumeBinding?.permissionMode) : '');

        // Paste WITHOUT a trailing \r. The user presses Enter to run — so bypass
        // is re-granted only by an explicit keystroke, never automatically (D6).
        const type = (text: string) => window.electronAPI.pty.write(ptyId, text);
        const typeAndClear = (text: string) => {
          type(text);
          useStore.getState().clearResumeHint(ptyId);
        };

        const onPrimary = (e: React.MouseEvent) => {
          e.stopPropagation();
          // Assemble the exact string to type — with the role's bound model
          // re-asserted on the launcher-prefixed variants (mirrors the chip and
          // the input.send path). The permission-restore (click 1) / exact-resume
          // (click 2) staging and the D6 no-auto-submit contract are unchanged;
          // planRecoveryPillType only injects the model where applyRoleBinding's
          // gates allow it.
          const plan = planRecoveryPillType({
            launcher,
            sessionId,
            permFlag,
            forceSkip,
            resumeStage,
            roleBinding: paneRoleBinding,
          });
          if (!plan) return; // not resumable — pill shouldn't have shown (defensive)
          if (plan.rewritten) {
            // Audit trail — a role silently changed what this pill types. Logged
            // at the ACTION so it fires once per real rewrite, not every render.
            console.log('[wmux:role-binding] resume command rewritten', {
              role: paneRoleName,
              agent: launcher,
              after: plan.text,
            });
          }
          if (plan.clearHint) typeAndClear(plan.text);
          else type(plan.text);
          if (plan.advanceStage) setResumeStage(1);
        };

        // The two-stage progressive assembly only applies to the toggle-OFF
        // captured-mode path; with the toggle ON, one click types everything.
        const primaryLabel = resumeStage === 1
          ? `+ ${t('resume.addSession')}`
          : `▶ ${t('resume.label', { agent: agentName })}`;
        const primaryTooltip = resumeStage === 1 ? t('resume.addSessionTooltip') : t('resume.tooltip');

        return (
          <span
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: 4,
              left: 6,
              zIndex: 20,
              display: 'inline-flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 4,
              fontSize: 10,
              fontFamily: 'ui-monospace, monospace',
              fontWeight: 600,
              letterSpacing: '0.04em',
            }}
          >
            {/* --dangerously-skip-permissions toggle (Claude only, default on).
                A launch preference the owner used to retype by hand; the primary
                button types it onto the resume line when checked. */}
            {canSkip && (
              <label
                onClick={(e) => e.stopPropagation()}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  cursor: 'pointer',
                  fontWeight: 400,
                  color: 'var(--text-sub)',
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-soft)',
                  borderRadius: 4,
                  padding: '1px 6px',
                  boxShadow: 'var(--shadow-sm, 0 1px 3px rgba(0,0,0,0.25))',
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={resumeSkipPermissions}
                  onChange={(e) => setResumeSkipPermissions(e.target.checked)}
                  style={{ accentColor: 'var(--accent-cursor)', cursor: 'pointer', margin: 0 }}
                />
                <span>--dangerously-skip-permissions</span>
              </label>
            )}
            {/* Button pill — DESIGN.md: amber never FILLS an area — neutral surface
                pill with a thin amber edge (accent as an outline, not a wash). */}
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                color: 'var(--text-main)',
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid color-mix(in srgb, var(--accent-cursor) 55%, transparent)',
                borderRadius: 4,
                boxShadow: 'var(--shadow-sm, 0 1px 3px rgba(0,0,0,0.25))',
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
          </span>
        );
      })()}
      {/* Persistent per-pane resume affordance — shown whenever this agent pane
          carries a captured conversation binding but is NOT in the reboot-
          recovery pill flow above (the pill takes precedence right after a
          reboot). Reveals the conversation UUID and types the exact resume
          command into this pane on 복구. */}
      {resumeBinding && !resumeHint && activeSurfacePtyId && (
        <ResumeInfoChipGate
          ptyId={activeSurfacePtyId}
          binding={resumeBinding}
          roleBinding={paneRoleBinding}
          role={paneRoleName}
          paneCwds={[
            pane.surfaces.find((s) => s.id === pane.activeSurfaceId)?.cwd,
            workspace.metadata?.cwd,
          ]}
        />
      )}
      {/* D2 — muted enforced-model badge on a role-bound TERMINAL pane. Amber
          stays reserved for alive+focus (DESIGN.md), so this rides the sub
          tones. A browser/diff/editor surface never launches an agent, so the
          badge would be a lie there — hence the surface-type gate, and the
          enforceability gate beside it (see showsEnforcedModel). */}
      {showsEnforcedModel && paneRoleBinding && (
        <span
          data-pane-enforced-model
          title={t('pane.enforcedLaunch', {
            binding: [paneRoleBinding.agent, paneRoleBinding.model].filter(Boolean).join(' · '),
          })}
          style={{
            position: 'absolute',
            top: 4,
            // The pane's top-right is a stack of absolutely-positioned controls
            // (zoom/maximize, the supervision badge, or SurfaceTabs' own action
            // cluster). Anchor past whatever is present — the same approach the
            // supervision badge above uses — so this never covers a button.
            right: enforcedModelBadgeRight,
            zIndex: 20,
            padding: '0 5px',
            fontSize: 10,
            lineHeight: '16px',
            fontFamily: 'ui-monospace, monospace',
            letterSpacing: '0.02em',
            color: 'var(--text-muted)',
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-soft)',
            borderRadius: 3,
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          {paneRoleBinding.model}
        </span>
      )}
      <SurfaceTabs
        surfaces={pane.surfaces}
        activeSurfaceId={pane.activeSurfaceId}
        workspace={workspace}
        paneId={pane.id}
        paneActive={isActive}
        onSelect={(surfaceId) => setActiveSurface(pane.id, surfaceId)}
        onClose={handleCloseSurface}
        onSplitHorizontal={handleSplitHorizontal}
        onSplitVertical={handleSplitVertical}
        onAddBrowser={handleAddBrowser}
      />

      <SplitSurfaceView
        pane={pane}
        workspaceId={workspace.id}
        activeSurfaceId={pane.activeSurfaceId}
        isWorkspaceVisible={isWorkspaceVisible}
        isZoomHidden={isZoomHidden}
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
  isZoomHidden,
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
  isZoomHidden?: boolean;
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
  // F6 — terminal·browser 어디에도 속하지 않는 비PTY 서피스(diff·editor). hasBoth
  // 스플릿 경로가 terminals·browsers만 렌더해 이들이 누락됐다(diff가 안 뜸). active
  // 인 것만 split 위에 오버레이로 겹쳐 렌더한다(각 패널이 display:isActive로 자기
  // 가시성을 관리하므로 비active는 보이지 않음 — editor 기존 단독 경로는 무회귀).
  const others = useMemo(() => pickOverlaySurfaces(pane.surfaces), [pane.surfaces]);

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
              workspaceId={workspaceId}
              initialUrl={surface.browserUrl || 'https://google.com'}
              partition={surface.browserPartition || 'persist:wmux-default'}
              isActive={surface.id === activeSurfaceId}
              isWorkspaceVisible={isWorkspaceVisible}
              isZoomHidden={isZoomHidden}
              onClose={() => onCloseSurface(surface.id)}
            />
          ) : surface.surfaceType === 'diff' ? (
            // J2 — diff 서피스는 PTY 없음. F1: verifiedWorkspaceId는 태스크 owner(부모)
            // ws id(task.mission.* RPC가 owner 스코프). fan-out이 diff 서피스에 실어둔
            // diffOwnerWorkspaceId를 쓰고, 없으면(구 세션 등) 담고 있는 ws로 폴백.
            // diffRepoPath가 있으면 워크스페이스 diff(읽기 전용, 태스크 결합 없음).
            <DiffPanel
              key={surface.id}
              source={
                surface.diffRepoPath
                  ? { kind: 'workspace', repoPath: surface.diffRepoPath }
                  : { kind: 'task', taskId: surface.diffTaskId || '' }
              }
              isActive={surface.id === activeSurfaceId}
              surfaceId={surface.id}
              verifiedWorkspaceId={surface.diffOwnerWorkspaceId || workspaceId}
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
  // #517 (codex P3): when a diff/editor overlay is the ACTIVE surface it
  // covers the whole split, so the browser underneath is not actually visible
  // — report it occluded so lightweight mode can throttle it.
  const overlayActive = others.some((s) => s.id === activeSurfaceId);
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
                workspaceId={workspaceId}
                initialUrl={surface.browserUrl || 'https://google.com'}
                partition={surface.browserPartition || 'persist:wmux-default'}
                isActive={surface.id === activeSurfaceId}
                visible={surface.id === shownBrowserId}
                isWorkspaceVisible={isWorkspaceVisible}
                isZoomHidden={isZoomHidden}
                occluded={overlayActive}
                onClose={() => onCloseSurface(surface.id)}
              />
            ))}
          </div>
        </Panel>
      </Group>
      {/* F6 — active인 diff·editor 서피스를 스플릿 위에 오버레이(absolute inset-0).
          비active는 각 패널의 display:none으로 숨으므로 겹쳐도 안전. */}
      {others.map((surface) =>
        surface.surfaceType === 'diff' ? (
          <DiffPanel
            key={surface.id}
            source={
              surface.diffRepoPath
                ? { kind: 'workspace', repoPath: surface.diffRepoPath }
                : { kind: 'task', taskId: surface.diffTaskId || '' }
            }
            isActive={surface.id === activeSurfaceId}
            surfaceId={surface.id}
            verifiedWorkspaceId={surface.diffOwnerWorkspaceId || workspaceId}
          />
        ) : (
          <EditorPanel
            key={surface.id}
            filePath={surface.editorFilePath || ''}
            isActive={surface.id === activeSurfaceId}
            surfaceId={surface.id}
          />
        ),
      )}
    </div>
  );
}
