import { useCallback, useEffect, useLayoutEffect, useState, useMemo, useRef } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import type { PaneLeaf, Workspace } from '../../../shared/types';
import { maybeDelegateExternalBrowser } from '../../utils/browserPaneActions';
import { PRIVATE_BROWSER_PARTITION } from '../../../shared/privateBrowser';
import { createTerminalSurface } from '../../utils/createTerminalSurface';
import { destroyRemoteSessions, destroySurfaceRemoteSession } from '../../utils/remoteSessionTeardown';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { MAX_PANES_PER_WORKSPACE } from '../../stores/slices/paneSlice';
import { useIpc } from '../../hooks/useIpc';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import TerminalComponent from '../Terminal/Terminal';
import { ChatV2Overlay, useChatSurfaceView } from '../ChatV2/ChatSurface';
import { forgetChatV2Pane, usePaneChatV2Binding } from '../ChatV2/useChatV2';
import BrowserPanel from '../Browser/BrowserPanel';
import EditorPanel from '../Editor/EditorPanel';
import DiffPanel from '../Diff/DiffPanel';
import RemotePaneSurface from '../Remote/RemotePaneSurface';
import AddRemotePaneModal from '../Remote/AddRemotePaneModal';
import SurfacePlaceholder from './SurfacePlaceholder';
import SurfaceTabs, {
  paneClusterWidth,
  paneActionsMode,
  paneHeaderExtraChromeWidth,
  PANE_ACTIONS_MIN_PANE_WIDTH,
  USAGE_LIMIT_CHIP_FULL_WIDTH,
  isTerminalSurfaceType,
  showsEnforcedModelBadge,
  type PaneActionsMode,
} from './SurfaceTabs';
import { PANE_CORNER_GUTTER } from './paneChrome';
import { useElementWidth } from '../../hooks/useElementWidth';
import { ErrorBoundary } from '../ErrorBoundary';
import { type ResumeBinding, agentSupportsPermissionFlag, defaultResumeSkipPermissions, normalizeResumeCwd, permissionFlagFor, resumeGrammarFor, resumePermissionFlag } from '../../../shared/agentResume';
import { applyRoleBinding, type RoleBinding } from '../../../shared/orchestratorRole';
import { CHATV2_PROVIDER_SESSION_ID } from '../../../shared/chatv2/ipc';
import { ResumeInfoChipGate } from './ResumeInfoChip';
import { tokenAttrs } from '../../themes';
import PaneDecorations from '../../plugins/PaneDecorations';
import { isRemoteMirrorVisible } from '../../stores/slices/remoteWorkspacesSlice';

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
  // `isolate` gives the pane root its own stacking context (#957). Without it
  // a pane is `relative` with no z-index, so every z value inside one competes
  // document-wide: the pane decorations painting over modals (#946) was that
  // leak surfacing, and lowering them below `--z-overlay` closed the case
  // rather than the hole. Contained, the scale inside a pane is purely local
  // and no future pane-internal element can express the collision at all.
  //
  // Safe only because nothing inside a pane needs to escape it any more. The
  // agent toolbar's popovers used to and were the stated blocker, but the bar
  // moved out to the workspace column on 2026-08-18 (DESIGN.md) and now sits
  // in ToolbarHost's own `absolute z-20` context; the terminal context menu
  // was the last one, and it portals to document.body as of this change.
  const classes = ['flex', 'flex-col', 'h-full', 'w-full', 'relative', 'isolate', 'box-border'];
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
    (s) =>
      s.surfaceType === 'diff' || s.surfaceType === 'editor' || s.surfaceType === 'remote-terminal'
      || s.surfaceType === 'placeholder',
  );
}

/**
 * #1140 — where a freshly minted remote session (from AddRemotePaneModal)
 * gets attached, given which flow opened the modal.
 *
 * `null` direction is the #1100 tab flow: always the pane whose ⋮ menu opened
 * the modal, unchanged. A direction is the new split flow: `splitResult` is
 * whatever `splitPane()` already returned by the time this runs (the caller
 * must call it BEFORE this, in the same synchronous tick as the eventual
 * addRemoteSurface call — see handleRemoteCreated's own comment for why that
 * ordering matters against EmptyLeafFunnel). `splitPane` returns `false` when
 * blocked at the per-workspace pane cap; this surfaces that as `null` — attach
 * nowhere — rather than silently falling back to the original pane, which
 * would put a second surface where the user asked for a new one instead.
 */
export function resolveRemoteAttachPaneId(
  direction: 'horizontal' | 'vertical' | null,
  currentPaneId: string,
  splitResult: string | false,
): string | null {
  if (direction === null) return currentPaneId;
  return splitResult || null;
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
  /** The permission-restore flag(s) for this launch, or '' when none apply.
   *  Ignored without `sessionId` (#1916). */
  permFlag: string;
  /** Toggle-ON path: type the whole `--dangerously-skip-permissions` line at
   *  once (no progressive stage). Ignored without `sessionId` (#1916): the
   *  session picker never carries a skip flag. */
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
  // With the skip toggle offered (Claude) and OFF, the user's explicit choice
  // wins over the role's skipPermissions: the role's skip flag is withheld (and
  // dropped from the role's args, #1681) so the restored mode is what runs. forceSkip is exactly `canSkip && toggle`.
  // #1916: without an exact session the line does not name a conversation
  // wmux can vouch for (#1946: it opens the session picker). It never carries a
  // permission flag: not the toggle's, and none of the role's (skip flag or a
  // permission choice in its args), for any agent.
  const toggledOff = !sessionId || (!forceSkip && agentSupportsPermissionFlag(launcher));
  const rewrite = (cmd: string): { text: string; rewritten: boolean } => {
    const r = applyRoleBinding(cmd, roleBinding, {
      suppressSkipPermissions: toggledOff,
      suppressPermissionChoices: !sessionId,
    });
    return { text: r.command, rewritten: r.changed };
  };
  if (!sessionId) {
    // No exact binding → the agent's own session picker (Claude `--resume`,
    // Codex `resume`), with no permission flag (#1916). Never the cwd-relative
    // `--continue` / `resume --last`: several recovered panes can share a
    // folder, and each would reopen the same newest conversation (#1946).
    const { text, rewritten } = rewrite(`${launcher} ${grammar.picker}`);
    return { text, clearHint: true, advanceStage: false, rewritten };
  }
  if (resumeStage === 1) {
    // Click 2: append the exact-session resume to the already-typed base. NOT
    // launcher-prefixed, so it is never independently rewritten (the model is
    // already on the base line typed in stage 0). Checked before forceSkip: a
    // whole line appended to the typed base would be malformed.
    return { text: ` ${grammar.withId(sessionId)}`, clearHint: true, advanceStage: false, rewritten: false };
  }
  if (forceSkip) {
    // Toggle ON: the WHOLE line at once so both flags land together (F6).
    const { text, rewritten } = rewrite(`${launcher}${permFlag ? ` ${permFlag}` : ''} ${grammar.withId(sessionId)}`);
    return { text, clearHint: true, advanceStage: false, rewritten };
  }
  if (resumeStage === 0 && permFlag) {
    // Click 1: permission-restore base ONLY — but with the model already
    // injected, so click 2's bare resume arg appends onto a line carrying --model.
    const { text, rewritten } = rewrite(`${launcher} ${permFlag}`);
    return { text, clearHint: false, advanceStage: true, rewritten };
  }
  // Default mode (no permission flag) → one click types the full id-resume.
  const { text, rewritten } = rewrite(`${launcher} ${grammar.withId(sessionId)}`);
  return { text, clearHint: true, advanceStage: false, rewritten };
}

/**
 * #1916 — the recovery pill's skip-permissions toggle and permission flag.
 *
 * `--dangerously-skip-permissions` needs an exact session. Without one the pill
 * opens the session picker (`claude --resume`, #1946), where the user may pick
 * any conversation in the folder, so the toggle is not offered (`canSkip`
 * false) and no permission flag is typed.
 * On an exact resume the toggle starts at the session's recorded mode (on only
 * for `bypassPermissions`) until the user sets it (`skipOverride`); OFF
 * restores the recorded mode without bypass.
 */
export function resolveRecoveryPillPermissions(args: {
  launcher: string;
  /** The exact-session id when the cwd+agent gates passed, else undefined. */
  sessionId: string | undefined;
  recordedMode: ResumeBinding['permissionMode'];
  /** The user's explicit toggle choice, or undefined for the default. */
  skipOverride: boolean | undefined;
}): { canSkip: boolean; skipChecked: boolean; forceSkip: boolean; permFlag: string } {
  const exact = !!args.sessionId;
  const canSkip = exact && agentSupportsPermissionFlag(args.launcher);
  const skipChecked = args.skipOverride ?? defaultResumeSkipPermissions(args.recordedMode, exact);
  const forceSkip = canSkip && skipChecked;
  const permFlag = resumePermissionFlag({
    agent: args.launcher,
    exact,
    recordedMode: args.recordedMode,
    skipPermissions: forceSkip,
  });
  return { canSkip, skipChecked, forceSkip, permFlag };
}

/**
 * Ptys the automatic resume must no longer touch this run: already resumed
 * automatically, or the user started the Resume pill (whose staged first click
 * leaves the hint up while it waits for the second).
 */
const autoResumedPtys = new Set<string>();

/** Record that the Resume pill typed into `ptyId`; automatic resume then stays out. */
export function markResumePillUsed(ptyId: string): void {
  autoResumedPtys.add(ptyId);
}

/** Take the one automatic resume `ptyId` gets; false if it ran or the pill was used. */
export function claimAutoResume(ptyId: string): boolean {
  if (autoResumedPtys.has(ptyId)) return false;
  autoResumedPtys.add(ptyId);
  return true;
}

/**
 * The line to run when a recovered Claude pane is resumed on app start, or null
 * when it should be left alone. Same assembly as the Resume pill, with the
 * permission mode that session had restored. Only the EXACT conversation is
 * resumed automatically, when the saved binding still matches the pane's cwd.
 * Without one this returns null and the pill stays up, offering the session
 * picker (#1946): `claude --continue` would reopen the same newest conversation
 * in every recovered pane sharing the folder, and opening a picker in each pane
 * on start is not a resume. `--dangerously-skip-permissions` is never added
 * here: that is the pill toggle's explicit choice, not something to grant on
 * every start.
 */
export function planAutoResume(args: {
  /** The user's opt-in setting (`claudeResumeOnStart`); off means the pill only. */
  enabled: boolean;
  agent: string | undefined;
  binding: { agent?: string; cwd: string; sessionId?: string; permissionMode?: Parameters<typeof permissionFlagFor>[0] } | undefined;
  paneCwds: ReadonlyArray<string | undefined>;
  roleBinding: RoleBinding | undefined;
}): string | null {
  if (!args.enabled || args.agent !== 'claude') return null;
  const { binding } = args;
  // Validate the session id before typing it: only a well-formed Claude session
  // id is ever put on the line; anything else leaves the pane to the pill.
  const sessionId = binding?.sessionId && CHATV2_PROVIDER_SESSION_ID.test(binding.sessionId)
    ? binding.sessionId
    : undefined;
  const exact = !!binding && !!sessionId && binding.agent === 'claude' &&
    args.paneCwds.some((c) => !!c && normalizeResumeCwd(binding.cwd) === normalizeResumeCwd(c));
  if (!binding || !sessionId || !exact) return null; // #1946: the pill offers the picker
  const plan = planRecoveryPillType({
    launcher: 'claude',
    sessionId,
    // A saved bypassPermissions mode restores as the default mode here: only
    // the pill's explicit toggle may type --dangerously-skip-permissions.
    permFlag: binding.permissionMode !== 'bypassPermissions'
      ? permissionFlagFor(binding.permissionMode)
      : '',
    forceSkip: false,
    // Both flags land on one line: the staged click flow does not apply here.
    resumeStage: 0,
    roleBinding: args.roleBinding,
  });
  if (!plan) return null;
  // With a permission flag and an exact id the plan types only the base line
  // first; build the whole line instead.
  if (plan.advanceStage) {
    const grammar = resumeGrammarFor('claude');
    if (!grammar || !sessionId) return null;
    return `${plan.text} ${grammar.withId(sessionId)}`;
  }
  return plan.text;
}

export default function PaneComponent({ pane, workspace, isActive, isWorkspaceVisible = true, isZoomHidden = false }: PaneProps) {
  const t = useT();
  const { invoke: ipcInvoke } = useIpc();
  const [flashing, setFlashing] = useState(false);
  const setActivePane = useStore((s) => s.setActivePane);
  const setActiveSurface = useStore((s) => s.setActiveSurface);
  const addBrowserSurface = useStore((s) => s.addBrowserSurface);
  const addRemoteSurface = useStore((s) => s.addRemoteSurface);
  const [addRemoteModalOpen, setAddRemoteModalOpen] = useState(false);
  // #1140: the SAME modal (pick a host, mint a session) serves both the
  // existing "New remote pane" tab flow and the new split-into-a-pane flow.
  // null → tab (add to THIS pane, unchanged #1100 behavior); a direction →
  // split first, then attach the minted session to the freshly created pane.
  // A ref, not state: read synchronously inside handleRemoteCreated, which
  // fires from the modal's async onCreated — no render needs to observe it.
  const remoteSplitDirectionRef = useRef<'horizontal' | 'vertical' | null>(null);
  const splitPane = useStore((s) => s.splitPane);
  const clearSplitCwdSeed = useStore((s) => s.clearSplitCwdSeed);
  const pushToast = useStore((s) => s.pushToast);
  const closeSurface = useStore((s) => s.closeSurface);
  const updateSurfacePtyId = useStore((s) => s.updateSurfacePtyId);
  const addSurface = useStore((s) => s.addSurface);
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
  // #949: user-tunable glow dim. Fed to CSS as a custom property so the
  // .pane-ring-glow rule stays the single owner of the visual; 1 turns the
  // shadowing off while keeping the border-color glow as the unread cue.
  const paneGlowOpacity = useStore((s) => s.paneGlowOpacity);

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
  const activePendingQuestion = useStore((s) =>
    activeSurfacePtyId ? s.surfacePendingQuestion[activeSurfacePtyId] : undefined,
  );
  const markSurfaceQuestionSeen = useStore((s) => s.markSurfaceQuestionSeen);
  // A turn that died on a usage limit is waited out, not flagged: no blink
  // while the hold stands (shared/usageLimit).
  const activeUsageWaiting = useStore((s) => !!activeSurfacePtyId && s.usageLimitWaiting[activeSurfacePtyId] === true);
  const completeBlink = !isActive && !!activeSurfaceStatus && !(activeUsageWaiting && activeSurfaceStatus === 'error');

  // Clear the attention status once the user is actually on the pane (covers
  // both "navigated to a blinking pane" and "agent finished while I was
  // watching"). Keyboard nav sets isActive without firing handleClick, so the
  // clear must live here rather than only in the click handler.
  useEffect(() => {
    if (isActive && activeSurfacePtyId && activeSurfaceStatus) {
      setSurfaceAgentStatus(activeSurfacePtyId, null);
    }
  }, [isActive, activeSurfacePtyId, activeSurfaceStatus, setSurfaceAgentStatus]);

  // #1176 — focusing a BLOCKED pane marks its question as seen. The question
  // itself survives (the agent is still blocked — looking does not answer it);
  // only the roster's animated glow drops, separating triaged from untriaged
  // blocked agents. Same placement as the attention clear above so keyboard
  // nav marks it seen too. Not while a REMOTE workspace is selected: that view
  // hides the local area (WorkspaceCenter, display:none) without touching
  // activeWorkspaceId, so this pane still reports isActive while nobody can
  // see it — a question arriving then must stay unseen.
  const remoteSelected = useStore(isRemoteMirrorVisible);
  useEffect(() => {
    if (isActive && !remoteSelected && activeSurfacePtyId && activePendingQuestion) {
      markSurfaceQuestionSeen(activeSurfacePtyId);
    }
  }, [isActive, remoteSelected, activeSurfacePtyId, activePendingQuestion, markSurfaceQuestionSeen]);

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

  // #645 — is a pane drag currently hovering THIS pane, and where?
  //
  // Returns a STRING, not an object. A selector that builds `{ kind }` returns
  // a fresh reference on every store read, so zustand's Object.is comparison
  // always reports a change and the pane re-renders forever ("Maximum update
  // depth exceeded"). A primitive compares by value and settles.
  const dropIndicator = useStore((s) =>
    s.paneDropTarget?.paneId === pane.id ? (s.paneDropTarget.edge ?? 'swap') : null,
  );

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
  const handleAddTerminal = useCallback(() => {
    const state = useStore.getState();
    void createTerminalSurface({
      workspaceId: workspace.id,
      paneId: pane.id,
      paneGate: state.paneGate,
      workspaces: state.workspaces,
      startupDirectory: state.startupDirectory,
      defaultShell: state.defaultShell,
      ipcInvoke,
      ptyCreate: window.electronAPI.pty.create,
      addSurface,
    });
  }, [addSurface, ipcInvoke, pane.id, workspace.id]);

  const handleAddBrowser = useCallback(() => {
    // #517 external backend: send the open to the OS browser instead of
    // mounting an embedded webview pane. No url here → the default homepage.
    if (maybeDelegateExternalBrowser(undefined)) return;
    addBrowserSurface(pane.id, undefined, undefined, workspace.id);
  }, [addBrowserSurface, pane.id, workspace.id]);

  // Never delegated to the external backend: the OS browser cannot honour
  // "private", so a private tab always opens in the app's own webview.
  const handleAddPrivateBrowser = useCallback(() => {
    addBrowserSurface(pane.id, undefined, PRIVATE_BROWSER_PARTITION, workspace.id);
  }, [addBrowserSurface, pane.id, workspace.id]);

  const handleAddRemote = useCallback(() => {
    remoteSplitDirectionRef.current = null;
    setAddRemoteModalOpen(true);
  }, []);

  // #1140: same modal, but split first — a fresh pane, not another tab on
  // this one. Mirrors handleSplitHorizontal/handleSplitVertical's direction
  // semantics (Ctrl+D right, Ctrl+Shift+D down).
  //
  // Cap pre-check BEFORE the modal opens: the modal mints a real session on
  // the host before onCreated fires, so opening it at the pane cap would
  // spend a host round-trip on a split that is already known to refuse —
  // same split-before-mint ordering splitBrowserPane settled on
  // (browserPane.ts). Duplicates splitPane's own toast because splitPane
  // cannot be asked "would you refuse?" without actually splitting.
  const remoteSplitBlockedAtCap = useCallback((): boolean => {
    if (getWorkspaceLeafPanes(workspace).length < MAX_PANES_PER_WORKSPACE) return false;
    const stashed = (workspace.stashedPanes ?? []).length;
    pushToast({
      message: stashed > 0
        ? t('pane.maxLeavesReachedWithStash', { count: MAX_PANES_PER_WORKSPACE, stashed })
        : t('pane.maxLeavesReached', { count: MAX_PANES_PER_WORKSPACE }),
      level: 'warn',
    });
    return true;
  }, [workspace, pushToast, t]);
  const handleSplitRemoteHorizontal = useCallback(() => {
    if (remoteSplitBlockedAtCap()) return;
    remoteSplitDirectionRef.current = 'horizontal';
    setAddRemoteModalOpen(true);
  }, [remoteSplitBlockedAtCap]);
  const handleSplitRemoteVertical = useCallback(() => {
    if (remoteSplitBlockedAtCap()) return;
    remoteSplitDirectionRef.current = 'vertical';
    setAddRemoteModalOpen(true);
  }, [remoteSplitBlockedAtCap]);

  const handleRemoteCreated = useCallback((hostId: string, sessionId: string, remoteWorkspaceId: string) => {
    const direction = remoteSplitDirectionRef.current;
    remoteSplitDirectionRef.current = null;
    // splitPane (when direction is set) creates an EMPTY leaf; EmptyLeafFunnel
    // would otherwise race to spawn a local PTY into it. It runs here, and
    // addRemoteSurface right after (via resolveRemoteAttachPaneId below), in
    // the same synchronous tick (no await between them) — the leaf already
    // carries a surface by the time React commits and the funnel's effect
    // can observe it. The null-direction branch never calls splitPane at all,
    // so `pane.id` there is just a truthy placeholder resolveRemoteAttachPaneId
    // ignores in favor of currentPaneId.
    const splitResult: string | false = direction === null ? pane.id : splitPane(pane.id, direction, workspace.id);
    const targetPaneId = resolveRemoteAttachPaneId(direction, pane.id, splitResult);
    if (targetPaneId) {
      // owned: true — AddRemotePaneModal MINTED this session (and the one-shot
      // `remote-pane-*` workspace row derived from it), so this tab is what has
      // to destroy it on close (#1129). Nothing else on the host ever will.
      // #1329 — the LAST argument is the workspace the session lives in ON THE
      // HOST (not `workspace.id`, this desk's local one). It is what
      // useRemoteAttachmentsLifecycle polls `/api/workspaces` for, and without
      // it the pane's agent is invisible to the sidebar roster and pane_list.
      addRemoteSurface(targetPaneId, hostId, sessionId, undefined, undefined, workspace.id, true, remoteWorkspaceId);
      // splitPane seeded an inherited cwd for the fresh leaf so a terminal
      // funnel could start a shell there; a remote leaf never goes through
      // that funnel, so the seed would sit until the pane closes — and replay
      // a stale cwd if the leaf ever empties out. Same guard splitBrowserPane
      // applies (browserPane.ts).
      if (direction !== null) clearSplitCwdSeed(targetPaneId);
    } else {
      // splitPane refused after the mint — the cap was reached while the
      // modal sat open, or this pane vanished under it. With no surface to
      // carry the remoteOwned record, nothing would ever reap the session
      // (#1129's exact orphan) — destroy it now rather than strand a live
      // shell on the host.
      destroyRemoteSessions([{ hostId, sessionId }]);
    }
  }, [addRemoteSurface, clearSplitCwdSeed, pane.id, splitPane, workspace.id]);

  const closePane = useStore((s) => s.closePane);

  // Issue #182: zoomed badge. Without a visual cue, a zoomed pane reads as
  // "all my other panes vanished" — mirror tmux's status-line Z marker.
  const isZoomed = useStore((s) => s.zoomedPaneId === pane.id);

  // When the pane action cluster is shown (SurfaceTabs), zoom/maximize lives as
  // the cluster's fifth button. The absolute corner maximize/restore controls
  // below are then redundant AND overlap the cluster, so they render only when
  // the cluster is absent. Subscribe the same way SurfaceTabs does.
  const paneActionsSetting = useStore((s) => s.paneActionsVisible);
  const chatViewEnabled = useStore((s) => s.chatViewEnabled);
  // Browser mirror (wmux web /app): no split/stash/zoom cluster or corner zoom.
  const readOnly = useStore((s) => s.readOnly);
  // #977 follow-up — width-based collapse. The cluster is fixed-width and
  // shrink-0, so on a narrow pane every pixel it takes comes out of the tab
  // strip, which is flex-1 min-w-0 and therefore collapses to NOTHING: at
  // ~200px the header was 100% buttons and 0% identity, with the last button
  // clipped. Below 222px the five buttons become one ⋮ that opens them as a
  // vertical menu — and the ⋮ persists to ANY width (the strip scrolls, and
  // the menu holds the ways out of a pane that narrow: zoom, stash). 'none'
  // is the Settings toggle's mode, never a width verdict.
  // D2 — this pane's enforced role→model binding (if its role is bound). Threaded
  // into the resume chip so a reconstructed resume command re-asserts the model
  // flag (a naive resume rebuilds from the agent stem alone and would drop it).
  const paneRoleName = useStore((s) => s.paneRole[pane.id]);
  const paneRoleBinding = useStore((s) =>
    paneRoleName ? s.orchestratorRoleBindings[paneRoleName] : undefined,
  );
  const [paneRootRef, paneWidth] = useElementWidth<HTMLDivElement>();
  // What the header carries BESIDES the cluster counts against the same width,
  // so the collapse threshold has to know about it (see
  // paneHeaderExtraChromeWidth). Both of these gate on the ACTIVE surface being
  // a terminal, which is the same condition SurfaceTabs draws them under.
  const activeSurfaceType = pane.surfaces.find((s) => s.id === pane.activeSurfaceId)?.surfaceType;
  const hasUsageLimit = useStore((s) => !!activeSurfacePtyId && !!s.usageLimits[activeSurfacePtyId]);
  const headerExtraChrome = paneHeaderExtraChromeWidth({
    chatToggle: chatViewEnabled && isTerminalSurfaceType(activeSurfaceType),
    enforcedModelBadge: showsEnforcedModelBadge({
      binding: paneRoleBinding,
      surfaceType: activeSurfaceType,
    }),
    usageLimitChip: hasUsageLimit,
  });
  const actionsMode: PaneActionsMode = paneActionsSetting && !readOnly
    ? paneActionsMode(paneWidth, headerExtraChrome)
    : 'none';
  // The full usage-limit chip needs room beyond the compact floor counted above.
  const usageLimitCompact = hasUsageLimit && paneWidth != null && paneWidth > 0
    && paneWidth < PANE_ACTIONS_MIN_PANE_WIDTH + headerExtraChrome + USAGE_LIMIT_CHIP_FULL_WIDTH;

  // X8 supervision. Resolve the pane's active-surface ptyId → supervision
  // slice. The ⟳ badge itself is drawn by SurfaceTabs (it belongs to the header
  // strip's layout); what is left here is the resume pill's gate — a supervised
  // pane restarts itself, so it is never offered a manual resume.
  const supervision = useStore((s) =>
    activeSurfacePtyId ? s.supervisionByPtyId[activeSurfacePtyId] : undefined,
  );

  // X6 ②/③ resume pill. A pane recovered-this-boot that was running an agent
  // gets a resume offer. Clickable only once the pane is interactive (first PTY
  // data — EI6) so the paste can't land before the recovered pipe is writable.
  // X6 ③: the pill TYPES the command (no Enter) and assembles progressively —
  // click 1 restores the permission mode (Claude only), an optional click 2
  // appends the EXACT-session resume; the user presses Enter to run. With no
  // exact binding it opens the agent's session picker (Claude `--resume`, Codex
  // `resume`) rather than the newest conversation in the folder (#1946).
  const resumeHint = useStore((s) =>
    activeSurfacePtyId ? s.resumeHintByPtyId[activeSurfacePtyId] : undefined,
  );
  const resumeBinding = useStore((s) =>
    activeSurfacePtyId ? s.resumeBindingByPtyId[activeSurfacePtyId] : undefined,
  );
  const resumePtyReady = useStore((s) =>
    activeSurfacePtyId ? !!s.ptyReadyByPtyId[activeSurfacePtyId] : false,
  );
  // A chat-v2 conversation that still owns this pane (not handed off) must not
  // be offered for resume in the anchor shell: that would put a second writer
  // on the same conversation. Asked only for panes that offer a resume.
  const chatV2Binding = usePaneChatV2Binding(activeSurfacePtyId || undefined, !!resumeBinding || !!resumeHint);
  const chatV2OwnsPane = !!chatV2Binding && chatV2Binding.status !== 'handed-off';
  // Resume Claude Code panes automatically on app start, when the user opted
  // in (`claudeResumeOnStart`, off by default; off keeps the pill). The setting
  // is read when the pane becomes ready, not subscribed to: turning it on must
  // not type into panes already showing the pill. A pane recovered this
  // boot that was running Claude gets its resume line typed and submitted once
  // its shell is interactive, instead of waiting for the pill's click + Enter.
  const autoResumeCwds = [
    pane.surfaces.find((s) => s.id === pane.activeSurfaceId)?.cwd,
    workspace.metadata?.cwd,
  ];
  useEffect(() => {
    const ptyId = activeSurfacePtyId;
    if (!ptyId || !resumePtyReady || supervision || chatV2OwnsPane) return;
    if (autoResumedPtys.has(ptyId)) return;
    const line = planAutoResume({
      enabled: useStore.getState().claudeResumeOnStart,
      agent: resumeHint,
      binding: resumeBinding,
      paneCwds: autoResumeCwds,
      roleBinding: paneRoleBinding,
    });
    if (!line) return;
    // A beat after the first output, so the prompt is up and reading input.
    const timer = setTimeout(() => {
      if (!useStore.getState().claudeResumeOnStart) return; // turned off meanwhile
      if (useStore.getState().resumeHintByPtyId[ptyId] !== 'claude') return; // typed into / dismissed meanwhile
      if (!claimAutoResume(ptyId)) return; // resumed already, or the pill was clicked meanwhile
      window.electronAPI.pty.write(ptyId, `${line}\r`);
      useStore.getState().clearResumeHint(ptyId);
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSurfacePtyId, resumePtyReady, resumeHint, resumeBinding, supervision, chatV2OwnsPane]);
  // The persistent resume chip's "is this pane's agent busy?" gate — and the
  // store-wide `agentClockMs` decay-clock subscription it needs — lives in the
  // <ResumeInfoChipGate> leaf below, NOT here: Pane mounts that leaf only when a
  // resume binding is present, so a clock tick (bumped ~every 2 s by
  // useAgentActivityClock while any agent is active) re-renders just the tiny
  // gate, never the whole Pane body across every mounted pane.
  // Progressive-assembly stage: 0 = nothing typed; 1 = base command (permission
  // flag) typed, awaiting an optional second click to append the session resume.
  const [resumeStage, setResumeStage] = useState(0);
  // --dangerously-skip-permissions toggle for the recovery pill. Claude-only;
  // mirrors the persistent chip's toggle. #1916: this holds only the user's
  // explicit choice. Until they make one, the toggle follows the binding:
  // on only for an exact resume of a session recorded in bypassPermissions
  // mode (defaultResumeSkipPermissions), computed at render because the
  // binding can land after the hint.
  const [resumeSkipOverride, setResumeSkipOverride] = useState<boolean | undefined>(undefined);
  // Never carry a stale stage/toggle across panes or a re-offer.
  useEffect(() => {
    setResumeStage(0);
    setResumeSkipOverride(undefined);
  }, [activeSurfacePtyId, resumeHint]);

  const handleCloseSurface = useCallback((surfaceId: string) => {
    const surface = pane.surfaces.find((s) => s.id === surfaceId);
    if (surface?.ptyId) {
      window.electronAPI.pty.dispose(surface.ptyId);
    }
    // #1129 — a remote-terminal tab carries no ptyId, so the dispose above is
    // structurally blind to it. Closing the tab must also end the session
    // this desktop minted on the host (and with it the one-shot workspace row
    // derived from it); a tab merely viewing somebody else's session is left
    // alone by destroySurfaceRemoteSession itself.
    destroySurfaceRemoteSession(surface);
    closeSurface(pane.id, surfaceId);

    // 마지막 Surface가 닫히면 Pane도 자동 제거
    if (pane.surfaces.length <= 1) {
      closePane(pane.id);
    }
  }, [pane.id, pane.surfaces, closeSurface, closePane]);

  // The tab strip's X asks first, like the close-tab shortcut. A browser
  // panel closing itself (window.close) goes straight to handleCloseSurface.
  const handleCloseSurfaceFromTab = useCallback((surfaceId: string) => {
    useStore.getState().requestCloseTab({ workspaceId: workspace.id, paneId: pane.id, surfaceId });
  }, [workspace.id, pane.id]);

  return (
    <div
      ref={paneRootRef}
      className={composePaneClassName({ hasUnread, ringState, paneRingEnabled, flashing, completeBlink })}
      style={{
        // #949: dim level for the unread glow — consumed by .pane-ring-glow's
        // `opacity: var(--pane-glow-opacity, 0.6)`. Set unconditionally so a
        // glow that arrives without a re-render still reads the current value.
        ['--pane-glow-opacity' as string]: String(paneGlowOpacity),
        // Design-system cohesion: panes keep a QUIET hairline in both states —
        // focus is signaled by the amber underline on the tab strip (mock's
        // .pane.focused .pane-head treatment), not a loud full border box.
        // Longhand (not the `border` shorthand) so this can coexist with the
        // per-side borderTopWidth override below without React's "mixing
        // shorthand and non-shorthand" dev warning firing on re-render.
        borderStyle: 'solid',
        borderColor: isActive ? 'var(--bg-overlay)' : 'var(--border-soft)',
        // No TOP border: it sat redundantly under the 40px titlebar's own bottom
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
      {...{
        // #645 — hit-test anchors for the pane drag. collectDropRects reads
        // both: the id to address the pane, the workspace to keep a drag
        // inside the tile it started in under multiview.
        'data-pane-root': pane.id,
        'data-pane-workspace': workspace.id,
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
      {actionsMode === 'none' && isZoomed && !readOnly && (
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
            right: PANE_CORNER_GUTTER,
            zIndex: 20,
            padding: '0 5px',
            height: 16,
            fontSize: 12,
            lineHeight: '16px',
            fontFamily: 'ui-monospace, monospace',
            color: 'var(--text-main)',
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid color-mix(in srgb, var(--text-main) 12%, transparent)',
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
      {actionsMode === 'none' && !isZoomed && !readOnly && (
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
            // The corner is unconditional now: the supervision badge that used
            // to own right:6 is laid out in the header strip (SurfaceTabs).
            right: PANE_CORNER_GUTTER,
            zIndex: 20,
            padding: '0 5px',
            height: 16,
            fontSize: 12,
            lineHeight: '16px',
            fontFamily: 'ui-monospace, monospace',
            color: 'var(--text-main)',
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid color-mix(in srgb, var(--text-main) 12%, transparent)',
            borderRadius: 3,
            cursor: 'pointer',
          }}
        >
          ⤢
        </button>
      )}
      {/* Persistent per-pane resume affordance — shown whenever this agent pane
          carries a captured conversation binding but is NOT in the reboot-
          recovery pill flow above (the pill takes precedence right after a
          reboot). Reveals the conversation UUID and types the exact resume
          command into this pane on 복구. */}
      {resumeBinding && !resumeHint && activeSurfacePtyId && !chatV2OwnsPane && (
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
      {/* #645 — drop indicator. Drawn by the pane being hovered, not by the
          one being dragged, so it lands in the right coordinate space with no
          overlay layer. Steel accent (navigation), a thin edge line, no wash —
          DESIGN.md's two-accent grammar reserves amber for alive/attention. */}
      {dropIndicator && (
        <div
          data-pane-drop-indicator={dropIndicator}
          style={{
            position: 'absolute',
            zIndex: 30,
            pointerEvents: 'none',
            transition: 'all 120ms ease-out',
            ...(dropIndicator === 'swap'
              ? {
                  // A swap has no edge, so outline the whole pane instead.
                  inset: 0,
                  border: '2px solid var(--accent-blue)',
                }
              : dropIndicator === 'left' || dropIndicator === 'right'
                ? { backgroundColor: 'var(--accent-blue)', top: 0, bottom: 0, width: 2, [dropIndicator]: 0 }
                : { backgroundColor: 'var(--accent-blue)', left: 0, right: 0, height: 2, [dropIndicator]: 0 }),
          }}
        />
      )}

      <SurfaceTabs
        surfaces={pane.surfaces}
        activeSurfaceId={pane.activeSurfaceId}
        workspace={workspace}
        paneId={pane.id}
        paneActive={isActive}
        actionsMode={actionsMode}
        usageLimitCompact={usageLimitCompact}
        onSelect={(surfaceId) => setActiveSurface(pane.id, surfaceId)}
        onClose={handleCloseSurfaceFromTab}
        onSplitHorizontal={handleSplitHorizontal}
        onSplitVertical={handleSplitVertical}
        onAddTerminal={handleAddTerminal}
        onAddBrowser={handleAddBrowser}
        onAddPrivateBrowser={handleAddPrivateBrowser}
        onAddRemote={handleAddRemote}
        onSplitHorizontalRemote={handleSplitRemoteHorizontal}
        onSplitVerticalRemote={handleSplitRemoteVertical}
      />
      {/* #1464 — the reboot-recovery resume pill gets its own row under the
          tab strip while the offer stands. It used to float over the pane
          top-left, covering the tab title and the first terminal row (the
          row it types the resume command into); the strip itself has no
          room for it on a narrow pane.
          The row is laid out from the moment the hint exists, NOT from
          resumePtyReady: it then takes its height before the recovered pane's
          first fit instead of shrinking the terminal (a resize, a SIGWINCH)
          once the pane is live. Only the button waits for readiness. */}
      {resumeHint && !supervision && activeSurfacePtyId && !chatV2OwnsPane && (() => {
        const ptyId = activeSurfacePtyId;
        const launcher = resumeHint; // slug doubles as the launcher stem ('claude'/'codex')
        const agentName = launcher.charAt(0).toUpperCase() + launcher.slice(1);
        // cwd-match guard (F7): `--resume <id>` is cwd-scoped, so only offer the
        // exact-session resume when the binding's origin cwd still matches the
        // pane's LIVE cwd. The daemon checks this at recovery, but the shell can
        // `cd` afterwards (OSC 7 updates surface.cwd) — re-validate here so a
        // post-recovery cd drops to the session picker (plan line 220, #1946).
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
        // wrongly downgraded a legitimate exact resume to the fallback. The
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
        // #1916: the skip toggle and the permission flag (see the helper).
        const { canSkip, skipChecked, forceSkip, permFlag } = resolveRecoveryPillPermissions({
          launcher,
          sessionId,
          recordedMode: resumeBinding?.permissionMode,
          skipOverride: resumeSkipOverride,
        });
        // #1916: the folder the typed line will run in (the shell's tracked
        // cwd), so a stale recovered cwd is visible before the click.
        const runCwd = paneCwdCandidates[0] || '';

        // Paste WITHOUT a trailing \r. The user presses Enter to run — so bypass
        // is re-granted only by an explicit keystroke, never automatically (D6).
        const type = (text: string) => window.electronAPI.pty.write(ptyId, text);
        const typeAndClear = (text: string) => {
          type(text);
          useStore.getState().clearResumeHint(ptyId);
        };

        // Assemble the exact string the next click types — with the role's
        // bound model re-asserted on the launcher-prefixed variants (mirrors the
        // chip and the input.send path). The permission-restore (click 1) /
        // exact-resume (click 2) staging and the D6 no-auto-submit contract are
        // unchanged; planRecoveryPillType only injects the model where
        // applyRoleBinding's gates allow it. Planned at render so the tooltip
        // can show the very line the click types (#1916).
        const plan = planRecoveryPillType({
          launcher,
          sessionId,
          permFlag,
          forceSkip,
          resumeStage,
          roleBinding: paneRoleBinding,
        });

        const onPrimary = (e: React.MouseEvent) => {
          e.stopPropagation();
          if (!resumePtyReady) return; // EI6: the recovered pipe is not writable yet
          if (!plan) return; // not resumable — pill shouldn't have shown (defensive)
          // The staged first click keeps the hint up; keep automatic resume
          // from appending a second line to what the pill typed.
          markResumePillUsed(ptyId);
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
        // #1946: without an exact session the click opens the agent's session
        // picker, and the label says so instead of promising a resume.
        const primaryLabel = resumeStage === 1
          ? `+ ${t('resume.addSession')}`
          : sessionId
            ? `▶ ${t('resume.label', { agent: agentName })}`
            : `▶ ${t('resume.pickLabel', { agent: agentName })}`;
        // #1916: the tooltip names the line this click types and the folder it
        // runs in; the picker line also says why it opens a picker and carries
        // no bypass (#1946).
        const primaryTooltip = [
          resumeStage === 1 ? t('resume.addSessionTooltip') : sessionId ? t('resume.tooltip') : t('resume.pickTooltip'),
          plan ? t('resume.typesLine', { command: plan.text.trim() }) : '',
          runCwd ? t('resume.runsIn', { cwd: runCwd }) : '',
          !sessionId ? t('resume.pickerNote') : '',
        ].filter(Boolean).join('\n');

        return (
          <span
            onClick={(e) => e.stopPropagation()}
            style={{
              // Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/app/shell/TitleBar.tsx), MIT License, Copyright (c) 2026 Nick
              // A 40px chrome-module row in flow, so the terminal below gives up
              // the height instead of being drawn over. On a narrow pane the
              // checkbox label ellipsizes; the button never shrinks.
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexShrink: 0,
              height: 40,
              minWidth: 0,
              padding: '0 8px',
              overflow: 'hidden',
              backgroundColor: 'var(--bg-mantle)',
              borderBottom: '1px solid var(--border-soft)',
              boxSizing: 'border-box',
              fontSize: 10,
              fontFamily: 'ui-monospace, monospace',
              fontWeight: 600,
              letterSpacing: '0.04em',
            }}
          >
            {/* --dangerously-skip-permissions toggle (Claude only). Offered only
                for an exact resume, and on by default only when that session
                was recorded in bypassPermissions mode (#1916); the primary
                button types it onto the resume line when checked. */}
            {canSkip && (
              <label
                onClick={(e) => e.stopPropagation()}
                // The flag ellipsizes on a narrow pane; keep it readable on hover.
                title="--dangerously-skip-permissions"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  cursor: 'pointer',
                  fontWeight: 400,
                  color: 'var(--text-sub)',
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-soft)',
                  borderRadius: 6,
                  padding: '0 6px',
                  height: 24,
                  boxSizing: 'border-box',
                  minWidth: 0,
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={skipChecked}
                  // Locked after the staged first click: the base line is
                  // already typed, so the toggle can no longer change it.
                  disabled={resumeStage === 1}
                  onChange={(e) => setResumeSkipOverride(e.target.checked)}
                  style={{ accentColor: 'var(--accent-cursor)', cursor: 'pointer', margin: 0, flexShrink: 0 }}
                />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>--dangerously-skip-permissions</span>
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
                borderRadius: 6,
                height: 24,
                boxSizing: 'border-box',
                flexShrink: 0,
                overflow: 'hidden',
              }}
            >
            <button
              onClick={onPrimary}
              disabled={!resumePtyReady}
              title={primaryTooltip}
              aria-label={primaryTooltip}
              style={{
                padding: '1px 6px',
                font: 'inherit',
                color: 'inherit',
                background: 'none',
                border: 'none',
                cursor: resumePtyReady ? 'pointer' : 'default',
                opacity: resumePtyReady ? 1 : 0.5,
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
            {/* #1916: the folder the typed line runs in, so a stale recovered
                cwd is visible before the click. A path, so mono, muted
                metadata with no colour (DESIGN.md); it ellipsizes at the
                START so the folder name stays visible, full path on hover. */}
            {runCwd && (
              <span
                data-resume-cwd
                title={t('resume.runsIn', { cwd: runCwd })}
                style={{
                  flex: '0 1 auto',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  direction: 'rtl',
                  textAlign: 'left',
                  fontWeight: 400,
                  letterSpacing: 0,
                  color: 'var(--text-muted)',
                }}
              >
                <bdi>{t('resume.inCwd', { cwd: runCwd })}</bdi>
              </span>
            )}
          </span>
        );
      })()}
      {addRemoteModalOpen && (
        <AddRemotePaneModal
          onClose={() => setAddRemoteModalOpen(false)}
          onCreated={handleRemoteCreated}
          // Reading the ref during render is safe here: every handler that
          // opens the modal writes the ref before setAddRemoteModalOpen(true),
          // so by the render that mounts this it already names the flow — and
          // it stays put until handleRemoteCreated/onClose unmounts us.
          title={
            remoteSplitDirectionRef.current === 'horizontal' ? t('pane.splitRightRemote')
            : remoteSplitDirectionRef.current === 'vertical' ? t('pane.splitDownRemote')
            : undefined
          }
        />
      )}

      <SplitSurfaceView
        pane={pane}
        workspaceId={workspace.id}
        activeSurfaceId={pane.activeSurfaceId}
        isWorkspaceVisible={isWorkspaceVisible}
        isZoomHidden={isZoomHidden}
        onCloseSurface={handleCloseSurface}
        onPtyCreated={(surfaceId, ptyId) => {
          // Bind first so Terminal immediately sees a non-empty externalPtyId;
          // then move any staged dead-session resume offer onto the new id.
          updateSurfacePtyId(pane.id, surfaceId, ptyId);
          useStore.getState().completeDeadPaneRecovery(surfaceId, ptyId);
        }}
        emptyMessage={t('pane.empty')}
      />
      </ErrorBoundary>
    </div>
  );
}

/**
 * A terminal surface and, in Chat view, the chat it shows. Chat v2 lays its
 * view over the anchor terminal and makes the terminal inert, so keys typed
 * into the chat never reach the shell; the terminal-projection chat stays
 * inside Terminal. Choosing a view never creates a PTY.
 */
function TerminalSurface({ surface, paneId, chatViewEnabled, isActive, visible, isWorkspaceVisible, onPtyCreated, workspaceId }: {
  surface: PaneLeaf['surfaces'][number];
  paneId: string;
  chatViewEnabled: boolean;
  isActive: boolean;
  visible?: boolean;
  isWorkspaceVisible: boolean;
  onPtyCreated: (ptyId: string) => void;
  workspaceId: string;
}) {
  const view = useChatSurfaceView(surface.ptyId || undefined, chatViewEnabled, surface.viewMode);
  const chatV2 = view === 'chatv2';
  const shown = visible ?? isActive;
  // The covered terminal still renders its own search bar (above the chat) when
  // the global find chord fires in this pane; chat v2 has its own find.
  const coveredSearch = useStore((s) => chatV2 && isActive && s.searchBarVisible
    && s.workspaces.find((w) => w.id === workspaceId)?.activePaneId === paneId);
  useLayoutEffect(() => {
    if (coveredSearch) useStore.getState().setSearchBarVisible(false);
  }, [coveredSearch]);
  // The surface closed (or its PTY was replaced): forget its chat drafts and binding.
  const ptyId = surface.ptyId;
  useEffect(() => () => { if (ptyId) forgetChatV2Pane(ptyId); }, [ptyId]);
  return (
    <>
      <div style={{ display: 'contents' }} inert={chatV2 || undefined}>
        <TerminalComponent
          chatView={view === 'projection'}
          ptyId={surface.ptyId || undefined}
          cwd={surface.cwd || undefined}
          isActive={isActive}
          visible={visible}
          isWorkspaceVisible={isWorkspaceVisible}
          onPtyCreated={onPtyCreated}
          scrollbackFile={surface.scrollbackFile}
          workspaceId={workspaceId}
          surfaceId={surface.id}
        />
      </div>
      {chatV2 && shown && isWorkspaceVisible && surface.ptyId && <ChatV2Overlay ptyId={surface.ptyId} surfaceId={surface.id} cwd={surface.cwd} />}
    </>
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
  const chatViewEnabled = useStore((s) => s.chatViewEnabled);
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
  const updateRemoteSurfaceTitle = useStore((s) => s.updateRemoteSurfaceTitle);

  const hasBoth = terminals.length > 0 && browsers.length > 0;

  if (pane.surfaces.length === 0) {
    return (
      <div className="flex-1 relative overflow-clip flex items-center justify-center text-[var(--text-muted)] text-sm" {...tokenAttrs('textMuted', 'text')}>
        {emptyMessage}
      </div>
    );
  }

  // Only terminals or only browsers — no split needed
  if (!hasBoth) {
    return (
      <div className="flex-1 relative overflow-clip">
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
          ) : surface.surfaceType === 'placeholder' ? (
            <SurfacePlaceholder
              key={surface.id}
              title={surface.title}
              isActive={surface.id === activeSurfaceId}
              surfaceId={surface.id}
            />
          ) : surface.surfaceType === 'remote-terminal' ? (
            // #1086/#1091 — a remote session mirrored as an ordinary tab in a
            // LOCAL workspace's pane, not a whole separate "attached remote
            // workspace". No local PTY, so it sits outside the `terminals`
            // group above (which is keyed on ptyId-bearing surfaces) even
            // though it visually shares the same tab strip.
            <RemotePaneSurface
              key={surface.id}
              hostId={surface.remoteHostId || ''}
              sessionId={surface.remoteSessionId || ''}
              surfaceId={surface.id}
              shell={surface.shell}
              cwd={surface.cwd}
              isActive={surface.id === activeSurfaceId}
              onTitleChange={updateRemoteSurfaceTitle}
            />
          ) : (
            <TerminalSurface
              key={surface.id}
              surface={surface}
              paneId={pane.id}
              chatViewEnabled={chatViewEnabled}
              isActive={surface.id === activeSurfaceId}
              isWorkspaceVisible={isWorkspaceVisible}
              onPtyCreated={(ptyId) => onPtyCreated(surface.id, ptyId)}
              workspaceId={workspaceId}
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
    <div className="flex-1 relative overflow-clip">
      <Group orientation="horizontal" className="h-full w-full" resizeTargetMinimumSize={{ coarse: 37, fine: 16 }}>
        {/* Terminal panel */}
        <Panel defaultSize={50} minSize={20}>
          <div className="h-full w-full relative overflow-clip">
            {terminals.map((surface) => (
              <TerminalSurface
                key={surface.id}
                surface={surface}
                paneId={pane.id}
                chatViewEnabled={chatViewEnabled}
                isActive={surface.id === activeSurfaceId}
                visible={surface.id === shownTerminalId}
                isWorkspaceVisible={isWorkspaceVisible}
                onPtyCreated={(ptyId) => onPtyCreated(surface.id, ptyId)}
                workspaceId={workspaceId}
              />
            ))}
          </div>
        </Panel>

        <Separator className="w-px bg-[var(--border-soft)] hover:bg-[var(--accent-blue)] transition-colors cursor-col-resize" />

        {/* Browser panel */}
        <Panel defaultSize={50} minSize={20}>
          <div className="h-full w-full relative overflow-clip">
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
        ) : surface.surfaceType === 'placeholder' ? (
          <SurfacePlaceholder
            key={surface.id}
            title={surface.title}
            isActive={surface.id === activeSurfaceId}
            surfaceId={surface.id}
          />
        ) : surface.surfaceType === 'remote-terminal' ? (
          // #1086/#1091, CodeRabbit round 1 — the hasBoth split previously
          // routed remote-terminal into the editor ternary below (empty
          // filePath, nothing rendered). Same overlay contract as Diff/Editor
          // (absolute inset-0, isActive→display:none inside the component).
          <RemotePaneSurface
            key={surface.id}
            hostId={surface.remoteHostId || ''}
            sessionId={surface.remoteSessionId || ''}
            surfaceId={surface.id}
            shell={surface.shell}
            cwd={surface.cwd}
            isActive={surface.id === activeSurfaceId}
            onTitleChange={updateRemoteSurfaceTitle}
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
