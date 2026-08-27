import { useEffect, useState, useRef, useCallback, lazy, Suspense } from 'react';
import type { AgentSlug } from '../../../shared/events';
import type { ResumeBinding } from '../../../shared/agentResume';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import Sidebar from '../Sidebar/Sidebar';
import MiniSidebar from '../Sidebar/MiniSidebar';
import { WorkspaceCenter } from './WorkspaceCenter';
import { EmptyLeafFunnel } from './EmptyLeafFunnel';
import { selectProjectCwdSignature } from '../../stores/selectors/appLayout';
import { shouldShowInstallError, shouldReannounceAfterError, truncateReason } from './updateNoticePolicy';
import { registerSessionSaver, saveSessionNow } from '../../utils/sessionSaveBridge';
import { resolveReconcileRebind } from '../../hooks/resolveReconcileRebind';
import { getLeafPanes, getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import NotificationPanel from '../Notification/NotificationPanel';
import FleetView from '../FleetView/FleetView';
// TASK-2: the 4 always-mounted overlays are lazy-loaded + render-gated below so
// their chunks stay out of the cold-boot critical path (SettingsPanel alone is
// ~4k lines). React.lazy without a render gate is a no-op for FCP, so each is
// gated on its own open/visible store flag inside <Suspense> + <ErrorBoundary>.
const CommandPalette = lazy(() => import('../Palette/CommandPalette'));
const WorktaskCleanupView = lazy(() => import('../WorkTask/WorktaskCleanupView'));
const SettingsPanel = lazy(() => import('../Settings/SettingsPanel'));
const InspectOverlay = lazy(() => import('../Inspect/InspectOverlay'));
import FileTreePanel from '../FileTree/FileTreePanel';
import ApprovalDialog from '../Company/ApprovalDialog';
import ExecuteApprovalDialog from '../A2a/ExecuteApprovalDialog';
import PermissionApprovalDialogContainer from '../Approval/PermissionApprovalDialogContainer';
import { initAtlasWakeRecovery } from '../../terminal/atlasWakeRecovery';
import { windowDisplayedStore } from '../../hooks/useWindowDisplayed';
import CompanyView from '../Company/CompanyView';
import MessageFeedPanel from '../Company/MessageFeedPanel';
import OnboardingOverlay from '../Onboarding/OnboardingOverlay';
import FirstRunWizard from '../FirstRunWizard';
import KeyboardCheatSheet from '../KeyboardCheatSheet';
import ToastContainer from '../Toast/ToastContainer';
import { HooksInstallPromptContainer } from '../Deck/HooksInstallPrompt';
import FloatingPane from '../Terminal/FloatingPane';
import SearchResultsPanel from '../Search/SearchResultsPanel';
import ChannelDock from '../Channels/ChannelDock';
import { ErrorBoundary } from '../ErrorBoundary';
import { useKeyboard } from '../../hooks/useKeyboard';
import { FocusManager } from './LayoutLogicMounts';
import { useAgentActivityClock } from '../../hooks/useAgentActivityClock';
import { useTerminalCopyShortcut } from '../../hooks/useTerminalCopyShortcut';
import { useNotificationListener } from '../../hooks/useNotificationListener';
import { useRpcBridge } from '../../hooks/useRpcBridge';
import { useWorkspaceMirrorPush } from '../../hooks/useWorkspaceMirrorPush';
import { useResizeGuard } from '../../hooks/useResizeGuard';
import { useApprovalInboxBridge } from '../../hooks/useApprovalInboxBridge';
import { useRemoteInboxBridge } from '../../hooks/useRemoteInboxBridge';
import { useRemoteAttachmentsLifecycle } from '../../hooks/useRemoteAttachmentsLifecycle';
import { useDeckStream } from '../../hooks/useDeckStream';
import { useChannelsEventSubscription } from '../../hooks/useChannelsEventSubscription';
import { useChannelsHydration } from '../../hooks/useChannelsHydration';
import { useMissionsPolling } from '../../hooks/useMissionsPolling';
import { useColdParkSweep } from '../../hooks/useColdParkSweep';
import { usePaneDecorationChannel } from '../../plugins/usePaneDecorationChannel';
import { useIpc } from '../../hooks/useIpc';
import type { SessionData, PaneLeaf, Pane, StashedPane, Surface, Workspace } from '../../../shared/types';
import { FIRST_RUN_REOPEN_EVENT } from '../../../shared/firstRun';
import { isFileDrag } from '../../../shared/dragDrop';
import { terminalRegistry } from '../../hooks/useTerminal';
import { resolvePtyIdsToClear } from '../../hooks/reconcileWithReQuery';
import { runWithProgressTimeout } from '../../hooks/reconcileProgressTimeout';
import { createLateReconcileOnConnect } from '../../hooks/lateReconcileOnConnect';
import ProjectConfigDialog from '../Project/ProjectConfigDialog';
import { probeProjectConfig, maybeAutoApplyProjectLayout, workspaceProbeCwd } from '../../utils/projectConfigProbe';
import { serializeTerminalBuffer } from '../../utils/scrollbackDump';
import { pastePtyChunked } from '../../utils/clipboardChunk';
import { isDaemonModeActive, setDaemonModeActive } from '../../daemon/daemonMode';
import { planAgentCandidateSeed, asAgentSlug, markSeedAttempted } from '../../channels/agentCandidateSeed';
import { RECONCILE_TIMEOUT_MS } from '../../../shared/timeouts';
import ComposeHost from '../AgentToolbar/ComposeHost';
import ToolbarHost, { AGENT_TOOLBAR_HEIGHT } from '../AgentToolbar/ToolbarHost';
import Titlebar from '../Titlebar/Titlebar';
import {
  createDeadPaneRecovery,
  type DeadPaneSessionSnapshot,
} from '../../../shared/ptyRecovery';

interface ReconcilePtySession extends DeadPaneSessionSnapshot {
  id: string;
  state?: string;
  surfaceId?: string;
  createdAt?: string;
}

/**
 * Fix 0 — startup reconcile timeout.
 *
 * startup state machine:
 *
 *   mount
 *     │
 *     ▼
 *   [pending] ──► session.load()
 *     │
 *     ▼
 *   loadSession(saved)  ── saved=null? ──► [ready]
 *     │ (ptyId preserved)                    ▲
 *     ▼                                      │
 *   daemon.whenReady()                       │
 *     │                                      │
 *     ▼                                      │
 *   gen = ++startupGenRef                    │
 *   abortCtl = new AbortController           │
 *   await runWithProgressTimeout(            │
 *     report => reconcilePtys(signal, report),│
 *     RECONCILE_TIMEOUT_MS (stall window)    │
 *   )                                        │
 *     │                                      │
 *     ├── success ──────────────────────────┤
 *     │                                      │
 *     ├── timeout/throw ──► abortCtl.abort() │
 *     │                     if (gen === startupGenRef.current)
 *     │                       clearAllPtyState()
 *     │                     ────────────────┤
 *     │                                      │
 *     └── (always) finally: setPaneGate('ready') ───┘
 *
 * Generation token prevents late-arriving reconcile from mutating store
 * after a fresher startup ran. AbortController propagates cancellation
 * into reconcilePtys so its `signal.aborted` checks early-return.
 *
 * RCA A2 — RECONCILE_TIMEOUT_MS now lives in shared/timeouts.ts and is
 * derived as DAEMON_RPC_TIMEOUT_MS + 5s (= 15s). It is a rolling no-progress
 * watchdog, re-armed after each reconcile IPC stage. A fixed total timeout is
 * unsafe now that one pass can serially list, promote, and re-list sessions:
 * two individually valid slow RPCs could otherwise exceed 15s and make the
 * startup catch wipe every live session via clearAllPtyState().
 */

/** Collect all terminal surfaces from a pane tree */
function collectTerminalSurfaces(pane: Pane): Surface[] {
  if (pane.type === 'leaf') {
    return pane.surfaces.filter((s) => !s.surfaceType || s.surfaceType === 'terminal');
  }
  const result: Surface[] = [];
  for (const child of pane.children) {
    result.push(...collectTerminalSurfaces(child));
  }
  return result;
}

/** Dump all terminal scrollback buffers via IPC (fire-and-forget).
 *  Also sets scrollbackFile on each surface in the session data. */
/** Dump all terminal scrollback buffers via IPC (fire-and-forget).
 *  Returns a map of surfaceId → true for surfaces that were dumped.
 *  SessionData objects from Zustand may be frozen, so we return the map
 *  instead of mutating surfaces directly. */
/** Sync version — fire-and-forget for beforeunload (cannot await). */
function dumpScrollbackBuffersSync(): Map<string, boolean> {
  // Phase A — A6. In daemon mode the daemon RingBuffer is the single source
  // of truth for scrollback. Skip the helper entirely so the corresponding
  // scrollback:dump IPC is never invoked and the rotation chain cannot
  // self-destruct while daemon is healthy. The returned empty map flows
  // through cloneWithScrollback so no `scrollbackFile` field is stamped
  // onto session data, preventing a future restore from picking up a stale
  // entry from a session that ran in local mode.
  if (isDaemonModeActive()) {
    return new Map();
  }
  const dumped = new Map<string, boolean>();
  const state = useStore.getState();
  for (const ws of state.workspaces) {
    // rootPane only, deliberately (#977): a stashed pane's terminal is
    // unmounted, so it has no entry in terminalRegistry to serialize — and
    // stashing requires a daemon connection, which means this whole function
    // has already returned above. There is nothing to dump for them.
    const surfaces = collectTerminalSurfaces(ws.rootPane);
    for (const surface of surfaces) {
      if (!surface.ptyId) continue;
      const terminal = terminalRegistry.get(surface.ptyId);
      if (!terminal) continue;
      const content = serializeTerminalBuffer(terminal);
      if (!content) continue;
      dumped.set(surface.id, true);
      window.electronAPI.scrollback.dump(surface.id, content).catch(() => {});
    }
  }
  return dumped;
}

/** Deep-clone pane tree, setting scrollbackFile on dumped surfaces.
 *
 * Phase A — A6 follow-up (codex review P2, session 019e2af8). When daemon
 * mode is active and dumped is empty, the previous logic preserved every
 * surface's existing `scrollbackFile` field. A session saved in local
 * mode therefore carried its stale `.txt` reference forward; if the
 * renderer ever reloaded before daemon readiness (or after a failed A7
 * migration), it would try to restore from the stale `.txt` despite the
 * IPC-level gate. Clear the field outright in daemon mode so session
 * data round-trips with the gates' intent.
 */
function cloneWithScrollback(pane: Pane, dumped: Map<string, boolean>): Pane {
  const daemonMode = isDaemonModeActive();
  if (pane.type === 'leaf') {
    // P2 (checklist G): drop `metadata` from the persisted snapshot. Pane labels
    // live in MetadataStore (metadata.json) as the single source of truth; the
    // `...pane` spread would otherwise round-trip a stale `label` into
    // session.json, a second persist path that drifts from the store. `ordinal`
    // (a sibling field) is intentionally preserved — it IS layout state and must
    // persist here so pane numbers survive restart.
    const leafRest = { ...pane };
    delete leafRest.metadata;
    return {
      ...leafRest,
      surfaces: pane.surfaces.map((s) => ({
        ...s,
        scrollbackFile: dumped.has(s.id) ? s.id : (daemonMode ? undefined : s.scrollbackFile),
      })),
    };
  }
  return {
    ...pane,
    children: pane.children.map((c) => cloneWithScrollback(c, dumped)),
  };
}

/**
 * Serialize a workspace's stashed panes (#977).
 *
 * The `...ws` spread would carry `stashedPanes` through untouched, which is
 * exactly the wrong thing: they'd skip the scrollback sanitization every
 * visible pane goes through, so a stale `scrollbackFile` could round-trip into
 * a daemon-mode session. They are put through the SAME cloneWithScrollback the
 * tree gets. (There is nothing to dump for them — a stashed pane's terminal is
 * unmounted, so it isn't in terminalRegistry, and stashing requires a daemon
 * connection, so the ring already holds its scrollback.)
 *
 * On failure the entry is NOT dropped. A dropped entry is a permanently lost
 * pane plus an orphaned daemon session — strictly worse than a failed save,
 * which leaves the previous file intact. So: minimally-sanitized fallback
 * first, and if even that throws, let it propagate and abort the whole save.
 */
function cloneStashedPanes(
  ws: Workspace,
  dumped: Map<string, boolean>,
): StashedPane[] | undefined {
  const stashed = ws.stashedPanes;
  if (!stashed || stashed.length === 0) return undefined;
  return stashed.map((entry) => {
    try {
      return { ...entry, pane: cloneWithScrollback(entry.pane, dumped) as PaneLeaf };
    } catch (err) {
      console.warn(
        `[wmux:stash] serialize failed for stashed pane=${entry?.pane?.id ?? '?'} — `
        + `falling back to a minimal entry: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Everything derived is dropped; identity, surfaces and their ptyIds are
      // what the pane needs to come back alive.
      const pane = entry.pane;
      return {
        pane: {
          id: pane.id,
          type: 'leaf',
          activeSurfaceId: pane.activeSurfaceId,
          ordinal: pane.ordinal,
          // `metadata` rides along here and NOT in cloneWithScrollback, which
          // strips it on purpose (MetadataStore owns pane labels). This path is
          // the opposite case: the normal serializer just failed, so anything
          // dropped here is dropped for good.
          ...(pane.metadata ? { metadata: pane.metadata } : {}),
          surfaces: pane.surfaces.map((s) => ({
            id: s.id,
            ptyId: s.ptyId,
            title: s.title,
            shell: s.shell,
            cwd: s.cwd,
            surfaceType: s.surfaceType,
            browserUrl: s.browserUrl,
            // A browser tab that loses its partition comes back logged out —
            // browser surfaces ARE stashable, so the salvage path must carry
            // it (review). scrollbackFile likewise: the last dump on record
            // makes this a degraded restore instead of an empty one.
            browserPartition: s.browserPartition,
            scrollbackFile: s.scrollbackFile,
            // Without this a user's manual tab rename comes back as a shell
            // title on the next OSC 0 — a small loss, but a silent one.
            titleLocked: s.titleLocked,
          })),
        },
        ...(entry.origin ? { origin: entry.origin } : {}),
        stashedAt: entry.stashedAt,
      };
    }
  });
}

/** Build a consistent SessionData snapshot for save operations */
function buildSessionData(dumped: Map<string, boolean>): SessionData {
  const state = useStore.getState();
  const companySafe = state.company ? { ...state.company, skipPermissions: undefined } : null;
  return {
    workspaces: state.workspaces.map((ws) => ({
      ...ws,
      rootPane: cloneWithScrollback(ws.rootPane, dumped),
      stashedPanes: cloneStashedPanes(ws, dumped),
    })),
    activeWorkspaceId: state.activeWorkspaceId,
    // P2: persist the global workspace-ordinal high-water so wsOrdinals are
    // never recycled across restarts (loadSession reads it back + backfills).
    nextWorkspaceOrdinal: state.nextWorkspaceOrdinal,
    sidebarVisible: state.sidebarVisible,
    channelDockVisible: state.channelDockVisible,
    sidebarMode: state.sidebarMode,
    company: companySafe,
    memberCosts: state.memberCosts,
    sessionStartTime: state.sessionStartTime ?? undefined,
    // User preferences
    theme: state.theme,
    locale: state.locale,
    terminalFontSize: state.terminalFontSize,
    uiScale: state.uiScale,
    terminalFontFamily: state.terminalFontFamily,
    terminalCursorStyle: state.terminalCursorStyle,
    defaultShell: state.defaultShell,
    deckBrainModel: state.deckBrainModel || undefined,
    orchestratorRoleBindings:
      Object.keys(state.orchestratorRoleBindings).length > 0 ? state.orchestratorRoleBindings : undefined,
    // Persisted explicitly (not `|| undefined`): an explicit false survives
    // serialization, so a future default flip can't resurrect full power for
    // a user who deliberately turned it off (CodeRabbit, PR #474).
    deckBrainFullPower: state.deckBrainFullPower,
    deckBrainVendor: state.deckBrainVendor,
    // Must persist, or the one-shot terminal-brain upgrade re-runs on every
    // load and overrides a user who picks the SDK brain back.
    deckBrainVendorMigrated: state.deckBrainVendorMigrated,
    channelsTabVisible: state.channelsTabVisible,
    paneActionsVisible: state.paneActionsVisible,
    paneNewTerminalButton: state.paneNewTerminalButton,
    splitInheritsCwd: state.splitInheritsCwd,
    imeResidueGuardEnabled: state.imeResidueGuardEnabled,
    hiddenPaneRetentionEnabled: state.hiddenPaneRetentionEnabled,
    coldParkEnabled: state.coldParkEnabled,
    browserLightweightMode: state.browserLightweightMode,
    browserDiscardHidden: state.browserDiscardHidden,
    startupDirectory: state.startupDirectory || undefined,
    scrollbackLines: state.scrollbackLines,
    scrollbackRestoreEnabled: state.scrollbackRestoreEnabled,
    a2aAutoApproveExecute: state.a2aAutoApproveExecute,
    sidebarPosition: state.sidebarPosition,
    multiviewArrangement: state.multiviewArrangement,
    notificationSoundEnabled: state.notificationSoundEnabled,
    toastEnabled: state.toastEnabled,
    notificationRingEnabled: state.notificationRingEnabled,
    anthropicUsageEnabled: state.anthropicUsageEnabled,
    mutedNotificationCategories: state.mutedNotificationCategories,
    customKeybindings: state.customKeybindings,
    autoUpdateEnabled: state.autoUpdateEnabled,
    customThemeColors: state.customThemeColors ?? undefined,
    onboardingCompleted: state.onboardingCompleted,
    // T8a: persist first-run wizard + cheat sheet flags alongside onboardingCompleted.
    // workspaceSlice.loadSession (T5) reads these back, defaulting to false.
    firstRunCompleted: state.firstRunCompleted,
    cheatSheetDismissed: state.cheatSheetDismissed,
    floatingPanePtyId: state.floatingPanePtyId ?? undefined,
    prefixConfig: state.prefixConfig,
    // Persist user-created layout templates + recent commands so they survive
    // restart. loadSession (workspaceSlice) reads these back; builtins are
    // re-seeded from BUILTIN_TEMPLATES on load, so we exclude them here to
    // avoid bloat and stale duplicates. recentCommands follows the optional-
    // field convention (omit when empty).
    layoutTemplates: state.layoutTemplates.filter((t) => !t.builtin),
    recentCommands: state.recentCommands.length > 0 ? state.recentCommands : undefined,
    agentToolbarEnabled: state.agentToolbarEnabled,
    agentToolbarPinned: state.agentToolbarPinned,
    agentToolbarSnippets: state.toolbarSnippets.length > 0 ? state.toolbarSnippets : undefined,
    agentToolbarNewCommand: state.newConversationCommand,
  };
}

/**
 * Push the persisted UI-scale factor (#822) to main so it can scale the whole
 * renderer (setZoomFactor) and re-place the native chrome. Fires on mount, on
 * every uiScale change (the Settings slider + session hydration), and whenever
 * the theme CSS vars flip — the Windows overlay height is zoom-dependent, so a
 * theme restyle must re-apply the scaled height, not the titleBarOverlay
 * handler's fixed 36. Mirrors useTitleBarOverlaySync's color read. Safe under
 * jsdom: bails when electronAPI is absent.
 */
/**
 * #866 — collect a refused install's reason and say so, once, at mount.
 *
 * PULL rather than a main-side push: the push version fired on a boot timer
 * and the only listener lived in the Settings panel, which is mounted only
 * while Settings is OPEN. With Settings closed — the default — nothing
 * received it and the marker was cleared anyway, so a failed update stayed as
 * invisible as it was before the feature existed. This runs from AppLayout,
 * which is always mounted, and the take is what clears the marker: a notice
 * nobody could receive survives to the next boot instead.
 */
function useRefusedInstallNotice(
  t: (key: string, vars?: Record<string, string | number>) => string,
): void {
  useEffect(() => {
    const take = window.electronAPI?.updater?.takeRefusedInstall;
    if (!take) return; // tests / non-electron / stale preload
    let cancelled = false;
    void take()
      .then((reason) => {
        if (cancelled || !reason) return;
        // #1055 — the marker's own text is the diagnostic this report class
        // was missing, and the toast persists: the refusal is actionable
        // (the install is intact — main suppresses the marker when it is
        // not, deferring to the install-integrity boot notice).
        useStore.getState().pushToast({
          level: 'error',
          persist: true,
          message: t('update.refusedInstall', { detail: truncateReason(reason) }),
        });
      })
      .catch((err) => {
        // Loud on purpose. The first version of this failed exactly here — the
        // main-side handler was registered late and the invoke rejected — and
        // a silent catch is what made a missing notice look like "no refusal
        // happened". Never break mount over it, but never hide it either.
        console.warn('[update] could not collect a refused-install notice:', err);
      });
    return () => { cancelled = true; };
  }, [t]);
}

/**
 * #897 — say that a downloaded update is waiting, somewhere the user will see.
 *
 * The install itself is deliberately NOT automatic: it quits the app and every
 * pane goes with it, so it stays the user's call. What was missing is that we
 * never told them there was a call to make. `UPDATE_AVAILABLE{downloaded}`
 * fires once, when the background download finishes, and the only thing
 * listening is the Settings panel — mounted only while Settings is open. So the
 * app sat on a verified installer in silence. Two reporters and the maintainer
 * described the same thing on #897: it downloads, nothing happens, and pressing
 * "Check for updates" by hand is the only way through (that path sets a
 * one-shot install intent; the background poll never does).
 *
 * Same shape as the refused-install notice above — pull from an always-mounted
 * surface — with one difference that matters: this is a READ, not a take.
 * "An update is ready" is still true five minutes later, so the toast is
 * `persist` — a notice that fades leaves the user exactly where they
 * started. (Since #1055 the refusal notice above persists too: its advice
 * stays actionable, because main suppresses the marker whenever the
 * installation is actually broken.)
 */
/** How long after a user-requested install an UPDATE_ERROR is still that
 *  install's. performInstall's refusals are decided before it launches
 *  anything, so they land almost immediately; a background check or download
 *  failure arriving outside this window belongs to Settings, not here. */
const INSTALL_ERROR_WINDOW_MS = 30_000;

function usePendingInstallNotice(
  t: (key: string, vars?: Record<string, string | number>) => string,
): void {
  useEffect(() => {
    const read = window.electronAPI?.updater?.getPendingInstall;
    const install = window.electronAPI?.updater?.installUpdate;
    const onAvailable = window.electronAPI?.updater?.onUpdateAvailable;
    const onError = window.electronAPI?.updater?.onUpdateError;
    if (!read || !install) return; // tests / non-electron / stale preload

    let cancelled = false;
    // The version this run has already announced, not a bare "did we". An app
    // left open for days can see a second release supersede the first: main
    // replaces the staged installer and re-fires `downloaded`, and a boolean
    // would leave the OLD version named in a persistent toast whose button
    // installs the NEW one. Re-announcing on a version change keeps the
    // sentence and the button describing the same thing.
    let announcedVersion: string | null = null;

    // The toast currently on screen, so a superseding release can replace it
    // rather than stack on top. Leaving the old one up would leave a clickable
    // sentence naming version A over a button that installs the staged B.
    let announcedToastId: string | null = null;
    // Set while an install the USER asked for is in flight — see the error
    // subscription below for why an unfiltered UPDATE_ERROR is not usable.
    let installRequestedAt = 0;

    const announce = (version: string, currentVersion: string): void => {
      if (cancelled || announcedVersion === version) return;
      announcedVersion = version;
      if (announcedToastId) useStore.getState().dismissToast(announcedToastId);
      announcedToastId = useStore.getState().pushToast({
        level: 'info',
        persist: true,
        // t() interpolates; a hand-rolled `.replace()` chain substitutes only
        // the FIRST occurrence of each placeholder, so a locale that names a
        // version twice would silently ship a raw `{version}`.
        message: t('update.readyToInstall', { version, current: currentVersion }),
        action: {
          label: t('update.installNow'),
          // Every pane closes with the app — the toast is the last warning,
          // so the label says "install", not something softer.
          onClick: () => {
            installRequestedAt = Date.now();
            announcedToastId = null; // the action dismisses this toast itself
            void install();
          },
        },
      });
    };

    // 1. What was ALREADY true when this mounted: a poll that finished before
    //    the window existed (or before this surface did).
    void read()
      .then((pending) => { if (pending) announce(pending.version, pending.currentVersion); })
      .catch((err) => {
        // Same posture as the refusal notice: never break mount, never hide it.
        // A silent catch here reads as "no update pending", which is the exact
        // failure being fixed.
        console.warn('[update] could not read a pending install:', err);
      });

    // 2. What becomes true WHILE the app is in use. The mount read alone covers
    //    only "it was ready before you looked" — a background poll finishing an
    //    hour into the session would otherwise stay silent until the next
    //    restart, which is most of the reported experience on #897. The version
    //    for the running build comes from the same read so the two paths cannot
    //    disagree about what "current" means.
    const unsubscribe = onAvailable?.((data) => {
      if (data.status !== 'downloaded') return;
      void read()
        .then((pending) => { if (pending) announce(pending.version, pending.currentVersion); })
        .catch((err) => {
          // NOT silent: `downloaded` does not fire twice for the same staged
          // installer (downloadUpdate returns early once a path is held), so
          // swallowing this loses the notice for the rest of the session —
          // the very shape of the bug being fixed. The event names the new
          // version and the renderer already knows its own, so announce from
          // those rather than give up.
          console.warn('[update] pending-install read failed on the live event:', err);
          if (data.releaseName) announce(data.releaseName, __APP_VERSION__);
        });
    });

    // An install that cannot proceed must say so HERE. The action button
    // dismisses its own toast on click, and every refusal path inside
    // performInstall (a staged path already consumed, no disk space, a dev
    // build, one already running) reports through UPDATE_ERROR — whose only
    // other listener is the Settings panel, which is closed by definition
    // whenever this toast is the thing the user is looking at. Without this,
    // pressing "Install now" and having it fail looks exactly like #897 again:
    // you press the button and nothing happens.
    //
    // CORRELATED to the click, not subscribed outright. UPDATE_ERROR is not an
    // install channel: it also carries a failed background check (the first
    // one runs ~15s after launch) and a failed download, so an offline machine
    // would post "the update could not be installed" on startup and again
    // every poll — a sentence that is false, on a toast that never fades, in a
    // list that evicts its OLDEST entry, which is the ready-notice this whole
    // feature exists to keep on screen. Only a failure that lands while an
    // install the user asked for is outstanding is one this surface can
    // honestly name.
    const unsubscribeError = onError?.((data) => {
      if (cancelled) return;
      // #1055 — tagged errors (source:'install') are install-origin by
      // construction and always shown: the macOS staging/handoff deadlines
      // land minutes after the click, and a one-shot install never stamps
      // one. Untagged errors keep the 30s click window described above.
      if (!shouldShowInstallError(data, installRequestedAt, Date.now(), INSTALL_ERROR_WINDOW_MS)) return;
      installRequestedAt = 0; // one report per request
      useStore.getState().pushToast({
        level: 'error',
        persist: true,
        message: t('update.installFailed', { error: data.message || '' }),
      });
      // The click dismissed the ready toast — a failed install hands the
      // button back (#1055). Skipped for the re-entrancy refusal: the
      // in-flight attempt's own outcome will re-announce. The
      // announcedVersion re-check keeps a stale read from stomping a
      // superseding release announced while this one was in flight.
      if (!shouldReannounceAfterError(data)) return;
      announcedVersion = null;
      void read().then((p) => {
        if (cancelled || announcedVersion !== null || !p) return; // superseded meanwhile
        announce(p.version, p.currentVersion);
      });
    });

    return () => { cancelled = true; unsubscribe?.(); unsubscribeError?.(); };
  }, [t]);
}

function useUiScaleSync(uiScale: number): void {
  useEffect(() => {
    const send = window.electronAPI?.window?.setUiScale;
    if (!send) return; // tests / non-electron
    const push = () => {
      const cs = getComputedStyle(document.documentElement);
      const color = cs.getPropertyValue('--bg-base').trim();
      const symbolColor = cs.getPropertyValue('--text-sub').trim();
      // Factor is always sent (zoom applies on every platform); the overlay
      // color pair only matters on Windows and is skipped when unread, which
      // main treats as "leave the overlay height untouched this round".
      send({
        factor: uiScale,
        ...(color && symbolColor ? { color, symbolColor } : {}),
      });
    };
    push();
    // Re-push on theme change so the Windows overlay keeps the scaled height.
    const mo = new MutationObserver(push);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    });
    return () => mo.disconnect();
  }, [uiScale]);
}

export default function AppLayout() {
  // UI scale (#822): the persisted factor. The sync effect below forwards it
  // to main, which scales the whole renderer and re-places the native chrome.
  const uiScale = useStore((s) => s.uiScale);
  // Global guard: blocks webview pointer capture during panel separator drag
  useResizeGuard();
  // Forward the persisted UI-scale factor to main whenever it changes or the
  // theme (overlay colors) does — see useUiScaleSync below.
  useUiScaleSync(uiScale);
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const channelDockVisible = useStore((s) => s.channelDockVisible);
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const fileTreeVisible = useStore((s) => s.fileTreeVisible);
  const companyViewVisible = useStore((s) => s.companyViewVisible);
  const setCompanyViewVisible = useStore((s) => s.setCompanyViewVisible);
  // PERF (2026-07-13): AppLayout does NOT subscribe to the whole `workspaces`
  // array NOR to `activeWorkspaceId` — those re-rendered its ~1300-line chrome
  // on every pane metadata/surface update (53% CPU at 5 workspaces) and on every
  // workspace SWITCH respectively. Both subscriptions live in <WorkspaceViewport>
  // now; the empty-leaf funnel (which also needs activeWorkspaceId) lives in
  // <EmptyLeafFunnel>. Here we read only DERIVED-STABLE values (see
  // stores/selectors/appLayout.ts) that don't change on churn or switch.
  const hasActiveWorkspace = useStore((s) => s.workspaces.some((w) => w.id === s.activeWorkspaceId));
  const projectCwdSignature = useStore(selectProjectCwdSignature);
  const workspaceCount = useStore((s) => s.workspaces.length);
  // Fix 0 startup gate. See state machine diagram at top of file.
  const paneGate = useStore((s) => s.paneGate);
  const setPaneGate = useStore((s) => s.setPaneGate);
  const clearAllPtyState = useStore((s) => s.clearAllPtyState);

  const prefixMode = useStore((s) => s.prefixMode);
  // Gate the cross-pane SearchResultsPanel mount at the layout level so its
  // 6-field zustand subscription doesn't run when the panel is closed (I3).
  const searchPanelOpen = useStore((s) => s.searchPanelOpen);
  // Mount-gate the Fleet View overlay so its store subscriptions + selector
  // only run while the cockpit is open (the open toggle lives in the global
  // keyboard handler, not inside FleetView, so gating the mount is safe).
  const fleetViewVisible = useStore((s) => s.fleetViewVisible);
  // TASK-2: render gates for the lazy overlays. Lift each component's own
  // internal open/visible flag to the layout so the lazy chunk is fetched only
  // when the overlay actually opens (the components self-gate on these exact
  // fields, so behavior is identical). SettingsPanel must also stay mounted
  // while inspect mode is active (SettingsPanel.tsx: "Settings stays mounted
  // the whole time" during inspect), hence the extra inspectModeActive term.
  const commandPaletteVisible = useStore((s) => s.commandPaletteVisible);
  const worktaskCleanupVisible = useStore((s) => s.worktaskCleanupVisible);
  const settingsPanelVisible = useStore((s) => s.settingsPanelVisible);
  const inspectModeActive = useStore((s) => s.inspectModeActive);
  // S-C2: while the Fleet View's Approvals tab owns the screen, it is the SOLE
  // approval surface — suppress the standalone A2A / MCP modals (delta 5, one
  // surface per item). The container keeps its pluginHost deadlock-break UX in
  // every other state.
  const fleetActiveTab = useStore((s) => s.fleetActiveTab);
  const inboxOwnsApprovals = fleetViewVisible && fleetActiveTab === 'approvals';
  const onboardingActive = useStore((s) => s.onboardingActive);
  const onboardingCompleted = useStore((s) => s.onboardingCompleted);
  const startOnboarding = useStore((s) => s.startOnboarding);
  const completeOnboarding = useStore((s) => s.completeOnboarding);

  // ─── First-run wizard + cheat sheet (T8a) ───────────────────────────────
  // Local visibility state for the wizard (null = hidden, otherwise mode).
  // The cheat sheet visibility is derived from uiSlice: it mounts whenever
  // the first run is completed AND the user has not permanently dismissed it.
  // Flipping `cheatSheetDismissed` back to false from Settings (T8b) is what
  // re-mounts the cheat sheet — observing the slice directly here removes the
  // earlier local-state gate that left the Settings button dead (C1 fix).
  const firstRunCompleted = useStore((s) => s.firstRunCompleted);
  const cheatSheetDismissed = useStore((s) => s.cheatSheetDismissed);
  // Bypasses the dismissed gate when the `?` prefix action sets it. Without
  // this subscription here the component never mounts after a permanent
  // dismissal, so the override would have nothing to react to.
  const cheatSheetForceShown = useStore((s) => s.cheatSheetForceShown);
  const setFirstRunCompleted = useStore((s) => s.setFirstRunCompleted);
  const [showFirstRunWizard, setShowFirstRunWizard] = useState<'firstRun' | 'reopen' | null>(null);

  const [showAutoUpdatePrompt, setShowAutoUpdatePrompt] = useState(false);
  const t = useT();

  useRefusedInstallNotice(t);
  usePendingInstallNotice(t);
  useKeyboard();
  // NOTE: useActivePaneFocus() now runs inside <FocusManager> (a render-null
  // child), NOT here. Its focusKey subscription embeds activeWorkspaceId and
  // re-renders its host on every switch; hosting it in AppLayout dragged the
  // whole chrome through a re-render per switch (2026-07-13 switch-lag fix).
  // Ticks agentClockMs while any agent is recently active so hook-driven
  // 'running' decays to idle on its own (see useAgentActivityClock / fleet.ts).
  useAgentActivityClock();
  // Focus-independent terminal Ctrl+C copy: when the channel dock / composer
  // owns DOM focus, xterm's own Ctrl+C handler never runs (it requires the
  // terminal textarea to be focused), so a selected-then-Ctrl+C goes silent.
  // This document capture-phase listener copies the selected terminal's text
  // while yielding to composer copy / SIGINT (see useTerminalCopyShortcut).
  useTerminalCopyShortcut();
  useNotificationListener();
  useRpcBridge();
  // Keep the main-process WorkspaceMirror warm: push the workspace tree +
  // per-pane agent status whenever it changes, so main resolves hooks/routing
  // locally instead of round-tripping workspace.list back to the renderer.
  useWorkspaceMirrorPush();
  // S-C2 Approval Inbox bridge: the SINGLE owner of permissionPrompt.onOpen /
  // onClosed (guard #2). Always-on (not gated on fleetViewVisible) so MCP
  // prompts accumulate in the store before the cockpit's Approvals tab opens.
  useApprovalInboxBridge();
  // LanLink PR-2 — own the remote-inbox subscription (always-on, mounted once)
  // so remote peer messages accumulate in the store before any surface opens.
  useRemoteInboxBridge();
  // Remote workspace attach — restore persisted attachments on boot (the slice
  // is memory-only, so a reload wipes it) and keep each mirror's pane set in
  // sync with the remote (exit events + a 10s safety-net poll).
  useRemoteAttachmentsLifecycle();
  // Command Deck Phase 2 — own the Commander brain stream subscription
  // (always-on, mounted once) so orchestrator turn events land in deckSlice even
  // when the dock or the Commander tab is not visible.
  useDeckStream();
  // U6 — channel.message subscription. Polls events.poll on a 1s cadence
  // and dispatches into channelsSlice. Always-on (not gated on any
  // panel visibility) so the unread badge stays accurate while the
  // sidebar is collapsed.
  useChannelsEventSubscription();
  // U6 follow-up — hydrate the channel catalog from the daemon's authoritative
  // list on mount + daemon (re)connect. Without this the sidebar only ever
  // showed channels created in THIS renderer session; channels created by MCP
  // agents or persisted across restart were invisible. Decoupled from in-app
  // Company mode (falls back to the active workspace for identity).
  useChannelsHydration();
  // 사이클 C — 미션(WorkTask) 캐시. task.mission.list를 owner-scoped로 폴링해
  // 사이드바 "Missions" 섹션 + FleetCard 미션 라인을 채운다(순수 pull, 성긴 폴링 —
  // useMissionsPolling 헤더 참조).
  useMissionsPolling();
  // TASK-9 cold-park: sparse sweep that unmounts terminals of long-hidden
  // workspaces to reclaim renderer RAM (reveal replays from the daemon snapshot).
  useColdParkSweep();
  // Plugin host (B-1): ui.decoratePane push → uiSlice pane decorations.
  usePaneDecorationChannel();
  const { invoke: ipcInvoke } = useIpc();

  // #517 — mirror the browser lightweight-mode setting to main whenever it
  // changes (Settings toggle or session load), so main immediately recomputes
  // throttling for EVERY registered guest, not just newly registered ones.
  const browserLightweightMode = useStore((s) => s.browserLightweightMode);
  useEffect(() => {
    try {
      (window as any).electronAPI?.browser?.setLightweight?.(browserLightweightMode);
    } catch { /* older main without the handler — setting stays inert */ }
  }, [browserLightweightMode]);

  // Wake-boundary glyph-atlas recovery — sleep can trash the shared WebGL
  // atlas's texture content without any event or page-structure change, so
  // atlasGuard's poll never fires. Rebuild at the wake boundaries instead.
  // Rationale and trigger choice live in terminal/atlasWakeRecovery.ts.
  useEffect(() => {
    // optional-chain electronAPI — jsdom (tests) has no preload bridge; an
    // older main without the push degrades to visibility-only recovery.
    const onResumed = (window as any).electronAPI?.system?.onResumed;
    return initAtlasWakeRecovery({
      onSystemResumed:
        typeof onResumed === 'function' ? onResumed : () => () => {},
    });
  }, []);

  // #882 — one renderer-wide subscription to "is anyone looking at this
  // window" (minimized / hidden to tray / screen locked), which panes fold
  // into their #766 viewer-visibility report. All platforms: the bit is right
  // everywhere, it is only Windows where `document.visibilityState` could not
  // supply it. See hooks/useWindowDisplayed.ts.
  useEffect(() => windowDisplayedStore.init(), []);


  // #517 slice C — discard mode mirrors the same way. Effective only while
  // lightweight mode is also on (belt-and-braces: main enforces this too).
  const browserDiscardHidden = useStore((s) => s.browserDiscardHidden);
  useEffect(() => {
    try {
      (window as any).electronAPI?.browser?.setDiscard?.(browserDiscardHidden && browserLightweightMode);
    } catch { /* older main without the handler — setting stays inert */ }
  }, [browserDiscardHidden, browserLightweightMode]);

  // #517 backend choice — unlike lightweight/discard (session-persisted), MAIN
  // owns this value. On mount, hydrate the non-persisted uiSlice mirror from
  // main's authoritative setting; thereafter mirror Settings changes back to
  // main via IPC. The hydratedRef guard is load-bearing: getBackend() is async,
  // so without it the change-push effect below would fire on first render with
  // the store's default ('builtin') and clobber a persisted 'external' before
  // the boot read resolves. We only push after hydration completes.
  const browserBackend = useStore((s) => s.browserBackend);
  const browserBackendHydrated = useStore((s) => s.browserBackendHydrated);
  const hydrateBrowserBackend = useStore((s) => s.hydrateBrowserBackend);
  useEffect(() => {
    let cancelled = false;
    // optional-chain electronAPI — jsdom (tests) has no preload bridge.
    const getBackend = (window as any).electronAPI?.browser?.getBackend;
    if (typeof getBackend !== 'function') {
      hydrateBrowserBackend(null); // nothing to hydrate; unlock the control
      return;
    }
    Promise.resolve(getBackend())
      .then((backend: unknown) => {
        if (cancelled) return;
        hydrateBrowserBackend(backend === 'builtin' || backend === 'external' ? backend : null);
      })
      .catch(() => { if (!cancelled) hydrateBrowserBackend(null); });
    return () => { cancelled = true; };
  }, [hydrateBrowserBackend]);
  // Mirror Settings changes back to main. The Settings control is disabled
  // until hydration lands (store flag), so a user edit can never race the
  // async boot read — and the value the boot read just applied is not pushed
  // back redundantly (lastPushedRef): only genuine edits reach main.
  const lastPushedBackendRef = useRef<string | null>(null);
  useEffect(() => {
    if (!browserBackendHydrated) return;
    if (lastPushedBackendRef.current === null) {
      // First run after hydration: record the hydrated value, don't echo it.
      lastPushedBackendRef.current = browserBackend;
      return;
    }
    if (lastPushedBackendRef.current === browserBackend) return;
    lastPushedBackendRef.current = browserBackend;
    try {
      (window as any).electronAPI?.browser?.setBackend?.(browserBackend);
    } catch { /* older main without the handler — setting stays inert */ }
  }, [browserBackend, browserBackendHydrated]);

  // ─── File drop — handled in preload where File.path is accessible ──────
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const sessionLoadedRef = useRef(false);
  // Fix 0: monotonic startup generation counter. Each mount-effect run
  // bumps it; the startup catch only fires clearAllPtyState if its own
  // gen still matches the current ref. Prevents a stale startup from
  // wiping state that a fresher startup already reconciled correctly.
  // Also used by the in-flight reconcile share (below) so late mutations
  // from an abandoned run are no-ops.
  const startupGenRef = useRef(0);
  // Fix 0: reconcilePtys in-flight promise (was a boolean ref). The
  // original boolean caused a race where daemon.onConnected fires
  // reconcile first, then startup's `await reconcilePtys()` returned
  // immediately because "already in flight" — flipping paneGate to ready
  // before the racing reconcile actually finished. Now startup awaits
  // the shared promise of whatever run is in flight. Late re-reconciles
  // after the first run completes still trigger a fresh pass.
  const reconcileInFlightRef = useRef<Promise<void> | null>(null);
  // #582: monotonic reconcile cycle counter for clearer console logs —
  // distinguishes "1 cycle walking 4 workspaces" from "4 cycles" (#582).
  const reconcileCycleRef = useRef(0);

  useEffect(() => {
    // File drop via preload onFileDrop (reliable cross-platform)
    const removeDrop = window.electronAPI.onFileDrop((paths) => {
      setIsDragging(false);
      dragCounterRef.current = 0;

      const state = useStore.getState();
      const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
      if (!ws) return;

      const findLeaf = (pane: typeof ws.rootPane): PaneLeaf | null => {
        if (pane.type === 'leaf') return pane.id === ws.activePaneId ? pane : null;
        for (const child of pane.children) {
          const found = findLeaf(child);
          if (found) return found;
        }
        return null;
      };
      const leaf = findLeaf(ws.rootPane);
      if (!leaf) return;

      const activeSurface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
      // browser/editor/diff는 PTY가 없어 경로 붙여넣기 대상이 아님(J2 — diff 추가).
      if (!activeSurface || activeSurface.surfaceType === 'browser' || activeSurface.surfaceType === 'editor' || activeSurface.surfaceType === 'diff') return;

      const text = paths.map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' ');
      // Route the joined path string through the paste chunker. Single-file
      // drops fit easily in one write, but a multi-file drop with long
      // Windows paths (UNC, OneDrive, long-form Program Files) can blow
      // through the main process's 100KB silent backstop. Chunking also
      // paces the IPC writes so the conpty input pipe drains between
      // sends. No bracketed-paste markers — drag-drop targets the prompt,
      // not a paste-aware foreground app.
      const surfacePtyId = activeSurface.ptyId;
      void pastePtyChunked(
        (d) => window.electronAPI.pty.write(surfacePtyId, d),
        text,
        null,
      ).catch((err) => console.error('[wmux:drag-drop] chunk write failed:', err));
    });

    // Visual drag overlay
    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      dragCounterRef.current++;
      if (dragCounterRef.current === 1) setIsDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      dragCounterRef.current--;
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0;
        setIsDragging(false);
      }
    };
    document.addEventListener('dragenter', onEnter, true);
    document.addEventListener('dragleave', onLeave, true);
    return () => {
      removeDrop();
      document.removeEventListener('dragenter', onEnter, true);
      document.removeEventListener('dragleave', onLeave, true);
    };
  }, []);

  // Fix 0 — reconcile saved PTY IDs with daemon's active sessions.
  //
  // Contract changes from pre-Fix-0:
  //   1. Throws (not silently returns) on `pty.list` RPC failure. The
  //      AppLayout startup catch depends on this to fire clearAllPtyState
  //      as the explicit fallback.
  //   2. Accepts an AbortSignal. Each `await` boundary checks
  //      signal.aborted and early-returns; aborted runs do not mutate
  //      the store further.
  //   3. In-flight promise share (not boolean skip). A concurrent caller
  //      awaits the existing run instead of returning immediately —
  //      otherwise the startup gate could flip to ready before the
  //      racing reconcile actually finished.
  //   4. NO replacement pty.create on stale ptyId. The path that called
  //      pty.create + updateSurfacePtyId(newId) is the original
  //      propagation-race source. v2 clears the ptyId and lets
  //      Terminal.tsx self-create on mount — the well-tested fresh-pane
  //      path. The mount gate guarantees Terminal mounts AFTER this
  //      reconcile resolves, so the race is gone.
  const reconcilePtys = useCallback(async (
    signal?: AbortSignal,
    reportProgress?: () => void,
  ): Promise<void> => {
    if (reconcileInFlightRef.current) {
      console.log('[AppLayout] reconcile already in flight — awaiting shared promise');
      return reconcileInFlightRef.current;
    }
    const run = (async () => {
      try {
        // Every remote stage gets the daemon RPC ceiling independently. Report
        // completion so startup's rolling watchdog measures a stalled stage,
        // not the total duration of a legitimate multi-RPC reconcile pass.
        const invokeReconcile = async <T,>(call: () => Promise<T>) => {
          const result = await ipcInvoke<T>(call);
          reportProgress?.();
          return result;
        };
        const listResult = await invokeReconcile<ReconcilePtySession[]>(() =>
          window.electronAPI.pty.list({ includeDead: true })
        );
        if (!listResult.ok) {
          // Throw — the startup catch depends on this to fire
          // clearAllPtyState as the explicit fallback. Pre-Fix-0 this
          // silently returned, which broke the documented fallback
          // contract (codex outside-voice hole #3).
          throw new Error(`reconcilePtys aborted: ${listResult.error.code}`);
        }
        if (signal?.aborted) return;
        const listedPtys = listResult.data;
        const activePtys = listedPtys.filter((p) => p.state !== 'dead');
        const deadPtys = new Map(
          listedPtys.filter((p) => p.state === 'dead').map((p) => [p.id, p]),
        );
        const activeIds = new Set(activePtys.map((p: { id: string }) => p.id));
        // #582: include workspace count so "Reconciling workspace: X" logs that
        // follow are unambiguously a single cycle walking N workspaces, not N
        // separate cycles. The monotonic cycle number helps correlate across
        // startup + late-reconcile runs in the console capture.
        const wsCount = useStore.getState().workspaces.length;
        reconcileCycleRef.current++;
        console.log(`[AppLayout] Reconcile cycle #${reconcileCycleRef.current}: daemon has ${activeIds.size} PTYs across ${wsCount} workspace(s)`);

        // RCA A1 — empty-list guard (the single most important non-destructive
        // change). `pty.list` returning ZERO live sessions on a reconnect
        // almost always means the daemon/RPC isn't ready yet (main just
        // reconnected, daemon mid-rehydrate), NOT that every session died.
        // Preserve every saved id whose death is UNCONFIRMED. #650 is the
        // deliberate exception: includeDead gives us authoritative tombstones,
        // so a pane explicitly present in deadPtys may continue through the
        // recovery path even when it is the only saved session.
        const hasSavedPtyIds = useStore.getState().workspaces.some(ws =>
          getWorkspaceLeafPanes(ws).some(leaf => leaf.surfaces.some(s => !!s.ptyId)),
        );
        const preserveUnconfirmedOnEmpty = activeIds.size === 0 && hasSavedPtyIds;
        if (preserveUnconfirmedOnEmpty) {
          console.warn(`[lifecycle] reconcile: daemon returned 0 live sessions with saved ptyIds — preserving unconfirmed ids; ${deadPtys.size} confirmed dead tombstone(s) may recover`);
        }

        // Fix 0 (round 3) — reconcile is now ONLY a liveness check.
        //
        // The PTY_DATA-loss race we hit in dogfood: reconcile used to call
        // `pty.reconnect(ptyId)` here, which kicked off daemon SessionPipe
        // attach + ringBuffer flush. The replay data left main process
        // BEFORE the renderer's Terminal component mounted, so
        // ipcRenderer.on(PTY_DATA) had no listener registered and Electron
        // IPC dropped every replay chunk. Result: dump succeeds, recovery
        // succeeds, flush succeeds, and the user still sees a fresh empty
        // terminal because the bytes vanished between main and renderer.
        //
        // Fix: reconcile only marks dead ptyIds (not in daemon active
        // list) as empty. Live ptyIds are left alone. useTerminal mount
        // is now responsible for calling pty.reconnect AFTER its
        // pty.onData listener is registered, so the SessionPipe replay
        // always lands on an attached listener.
        // RCA A1/A9 — collect candidate ptyIds (present in the store but
        // ABSENT from the first NON-EMPTY daemon snapshot) WITHOUT clearing.
        // Live ptyIds stay in place (useTerminal mount reconnects). The
        // partial-list case is the still-open hole the empty-list guard above
        // does not cover: a single snapshot can be partial (daemon
        // mid-rehydrate), so clearing on the first cycle could destroy a live
        // session. We defer the destructive decision to a 2-strike re-query.
        const absentCandidates: { paneId: string; surfaceId: string; ptyId: string; stashed: boolean }[] = [];
        const collect = (pane: PaneLeaf, stashed: boolean) => {
          if (signal?.aborted) return;
          for (const surface of pane.surfaces) {
            if (signal?.aborted) return;
            // browser/editor/diff는 PTY를 갖지 않음 — 재조정·자가생성 대상에서 제외(J2).
            if (surface.surfaceType === 'browser' || surface.surfaceType === 'editor' || surface.surfaceType === 'diff') continue;
            if (!surface.ptyId) {
              console.log(`[AppLayout] Surface ${surface.id}: no ptyId, Terminal will self-create`);
              continue;
            }
            if (activeIds.has(surface.ptyId)) {
              console.log(`[AppLayout] Surface ${surface.id}: ptyId ${surface.ptyId} alive in daemon, Terminal will reconnect on mount`);
              // Leave ptyId in place. useTerminal mount reconnects.
            } else if (preserveUnconfirmedOnEmpty && !deadPtys.has(surface.ptyId)) {
              console.warn(`[lifecycle] reconcile preserving unconfirmed ptyId=${surface.ptyId} surface=${surface.id} while live list is empty`);
            } else {
              absentCandidates.push({ paneId: pane.id, surfaceId: surface.id, ptyId: surface.ptyId, stashed });
            }
          }
        };

        // Iterate the freshest workspace snapshot per walk. The reconcile
        // path was previously seeded from a single getState() before the
        // loop, which froze the view of workspaces for the duration of
        // the walk — any concurrent store update (e.g. a fast-spawned
        // surface) was invisible until the next reconcile cycle.
        // #977 — getWorkspaceLeafPanes, not the visible tree: a stashed pane's
        // session is still running, so it must get the same liveness check and
        // the same dead-pane recovery. Skipping it would leave that PTY in a
        // permanent limbo — never confirmed dead, never offered for recovery,
        // and its `exited` state (derived from ptyId presence) would never
        // arrive. Visible panes come first in that order, which is what the
        // promote step below relies on.
        for (const ws of useStore.getState().workspaces) {
          if (signal?.aborted) return;
          console.log(`[AppLayout] Reconciling workspace: ${ws.name}`);
          const visibleIds = new Set(getLeafPanes(ws.rootPane).map((l) => l.id));
          for (const leaf of getWorkspaceLeafPanes(ws)) {
            if (signal?.aborted) return;
            collect(leaf, !visibleIds.has(leaf.id));
          }
        }
        // Visible panes first, ACROSS workspaces. Promotion below competes for
        // the daemon's limited live-session slots, and a session the user
        // cannot see must never take a slot from one they are looking at.
        // Array.prototype.sort is stable, so tree order survives within a tier.
        absentCandidates.sort((a, b) => Number(a.stashed) - Number(b.stashed));

        // RCA A1/A9 — partial-list 2-strike guard. Before destructively
        // clearing any live ptyId absent from the first non-empty snapshot,
        // re-query the daemon ONCE (resolvePtyIdsToClear). It preserves
        // everything on uncertainty (re-query fails or the run aborts) and
        // returns only ptyIds absent from BOTH snapshots. RCA A8 — the actual
        // clear is logged at warn so it lands in the main log file and can be
        // correlated with the daemon's pty.list count.
        if (absentCandidates.length > 0 && !signal?.aborted) {
          // Fix B — before destructively clearing, attempt to promote cap-skipped
          // suspended sessions on demand. A successful promote + reconnect keeps
          // the ptyId stable and restores scrollback from the daemon's ring buffer.
          const stillAbsent: typeof absentCandidates = [];
          if (window.electronAPI?.pty?.promote) {
            // Ask the daemon for suspended sessions that match our absent ptyIds.
            const allRes = await invokeReconcile<{ id: string; state?: string }[]>(() =>
              window.electronAPI.pty.list({ includeSuspended: true }),
            );
            const suspendedIds = new Set(
              allRes.ok
                ? allRes.data.filter((s) => s.state === 'suspended').map((s) => s.id)
                : [],
            );
            for (const candidate of absentCandidates) {
              if (signal?.aborted) break;
              if (!suspendedIds.has(candidate.ptyId)) {
                stillAbsent.push(candidate);
                continue;
              }
              // Try to promote this suspended session.
              const promoteRes = await invokeReconcile<{ success: boolean; error?: string }>(() =>
                window.electronAPI.pty.promote(candidate.ptyId),
              );
              if (promoteRes.ok && promoteRes.data.success) {
                // Promoted! The ptyId is now active — useTerminal mount will reconnect.
                console.log(`[lifecycle] reconcile PROMOTED suspended ptyId=${candidate.ptyId} → active (Fix B)`);
              } else {
                // Promote failed (cap hit, spawn error) — fall through to clear path.
                console.warn(`[lifecycle] reconcile promote FAILED ptyId=${candidate.ptyId}: ${promoteRes.ok ? promoteRes.data.error : 'ipc error'}`);
                stillAbsent.push(candidate);
              }
            }
          } else {
            stillAbsent.push(...absentCandidates);
          }

          // Continue with the 2-strike re-query for truly absent ptyIds.
          const firstAbsent = stillAbsent.map((c) => c.ptyId);
          // v2 RCA fix (axis B-lite hardening): capture the re-query's FULL
          // payload. Rebind targets must come from the freshest snapshot — a
          // session that died between the two snapshots must not be picked
          // (review consensus: codex P2 + testing + adversarial).
          let secondSnapshot: { id: string; surfaceId?: string; createdAt?: string }[] | null = null;
          const toClear = await resolvePtyIdsToClear(firstAbsent, {
            reList: async () => {
              const r = await invokeReconcile<{ id: string; surfaceId?: string; createdAt?: string }[]>(() => window.electronAPI.pty.list());
              if (r.ok) secondSnapshot = r.data;
              return r.ok
                ? { ok: true, ids: new Set(r.data.map((p: { id: string }) => p.id)) }
                : { ok: false };
            },
            isCurrent: () => !signal?.aborted,
            log: (level, message) => (level === 'warn' ? console.warn(message) : console.log(message)),
          });
          // v2 RCA fix (axis B-lite): decide clear-vs-rebind per candidate (pure,
          // unit-tested in resolveReconcileRebind.test.ts). Acts ONLY on ptyIds
          // already judged dead (in toClear), so it never swaps a live-attached
          // ptyId (codex #5). A live session on the SAME surfaceId → rebind
          // (recovers the reboot case where the session survived under a new
          // ptyId); no match → clear→self-create (axis A's immediate save covers
          // empty-pane-origin sessions that carry no surfaceId). Rebind targets
          // come from the SECOND snapshot when the re-query succeeded.
          const rebindActions = resolveReconcileRebind(stillAbsent, toClear, secondSnapshot ?? activePtys);
          for (const a of rebindActions) {
            if (signal?.aborted) break;
            // CAS guard (adversarial review): the decision was computed from a
            // snapshot ≥600ms old. On a late reconcile, useTerminal's own
            // reattach path may have already cleared this surface and
            // self-created a FRESH ptyId — stomping it would orphan a live
            // session (or wrong-bind). Apply only if the surface still holds
            // the exact stale ptyId the decision was made against.
            // Workspace-wide (#977): the decision may name a stashed pane, and
            // a visible-tree-only re-query would report it as "gone" and SKIP
            // every clear — which would silently strand the whole liveness
            // model for stashed panes.
            const wsNow = useStore.getState().workspaces;
            let currentPtyId: string | undefined;
            for (const ws of wsNow) {
              const leaf = getWorkspaceLeafPanes(ws).find((l) => l.id === a.paneId);
              if (!leaf) continue;
              currentPtyId = leaf.surfaces.find((s) => s.id === a.surfaceId)?.ptyId;
              break;
            }
            if (currentPtyId !== a.stalePtyId) {
              console.warn(`[lifecycle] reconcile ${a.kind} SKIPPED surface=${a.surfaceId}: ptyId moved (${a.stalePtyId} → ${currentPtyId ?? 'gone'}) since snapshot`);
              continue;
            }
            if (a.kind === 'rebind') {
              // This is an already-live daemon session, not the self-created
              // replacement covered by #650. Its own live metadata remains
              // authoritative; never attach a different dead session's cwd or
              // resume binding merely because both claimed the same surface.
              console.warn(`[lifecycle] reconcile REBIND surface=${a.surfaceId} stale=${a.stalePtyId} → live=${a.newPtyId} (surfaceId match, dead ptyId recovered)`);
            } else {
              const deadSession = deadPtys.get(a.stalePtyId);
              if (deadSession) {
                // #650: stage before the synchronous clear. Terminal receives
                // both cwd candidates and main validates spawnCwd → cwd → home;
                // any surviving binding moves to the replacement pty on create.
                useStore.getState().stageDeadPaneRecovery(
                  a.surfaceId,
                  createDeadPaneRecovery(deadSession),
                  a.stalePtyId,
                );
              }
              console.warn(`[lifecycle] reconcile clearing ptyId=${a.stalePtyId} surface=${a.surfaceId} (absent from TWO daemon snapshots, no surface match) → Terminal self-create`);
            }
            useStore.getState().updateSurfacePtyId(a.paneId, a.surfaceId, a.newPtyId);
          }
        }
        console.log(`[AppLayout] Reconcile cycle #${reconcileCycleRef.current} complete (${absentCandidates.length} absent candidate(s))`);
      } finally {
        reconcileInFlightRef.current = null;
      }
    })();
    reconcileInFlightRef.current = run;
    return run;
  }, [ipcInvoke]);

  // 앱 시작 시 세션 복원 (Fix 0 — see state machine diagram at top of file)
  useEffect(() => {
    const gen = ++startupGenRef.current;
    let abortCtl: AbortController | null = null;
    // Codex P2 — wrap the entire startup in an async IIFE so a session.load()
    // rejection (preload gap, IPC handler swap mid-call, renderer reload race)
    // still reaches the outer try/finally. The previous structure put try inside
    // .then(), which left paneGate='pending' forever on .then-never-fires paths.
    void (async () => {
      try {
        const saved = await window.electronAPI.session.load();
        if (!saved) {
          sessionLoadedRef.current = true;
          // First ever launch — ask about auto-update
          setShowAutoUpdatePrompt(true);
          return;
        }

        // If autoUpdateEnabled was never set (upgrade from older version), prompt
        const isFirstAutoUpdateChoice = saved.autoUpdateEnabled == null;

        useStore.getState().loadSession(saved);

        // Sanitize stale per-workspace agent state. agentStatus/agentName
        // describe a live PTY's current state; carrying them across an app
        // restart is always wrong — the workspaces just rehydrated, no agent
        // has emitted anything yet in this session. Without this reset the
        // sidebar dot would lie about agents that died last time the user
        // closed wmux (Codex 1st review #4: lifecycle reset).
        const postLoadState = useStore.getState();
        for (const ws of postLoadState.workspaces) {
          // Only update workspaces whose persisted state actually carries a
          // live status. Plain truthiness on agentStatus is true for 'idle'
          // too, so the previous guard re-broadcast a no-op metadata update
          // for every workspace that had ever held agent state.
          const status = ws.metadata?.agentStatus;
          const hasLive = (status && status !== 'idle') || (ws.metadata?.agentName && ws.metadata.agentName.length > 0);
          if (hasLive) {
            postLoadState.updateWorkspaceMetadata(ws.id, { agentStatus: 'idle', agentName: '' });
          }
        }

        sessionLoadedRef.current = true;

        if (isFirstAutoUpdateChoice) {
          setShowAutoUpdatePrompt(true);
        }

        // v2.8.1 hotfix (Bug 3): defer reconciliation until main has
        // settled the daemon-vs-local decision. Without this gate, the
        // reconcile fires while IPC handlers are mid-swap and pty.list
        // can hit a "no handler registered" rejection — the renderer
        // surfaces that as a generic "알 수 없는 오류" toast spam.
        const daemonReady = await window.electronAPI.daemon.whenReady();

        // Codex P1 — set daemonMode flag here, BEFORE paneGate flips ready.
        // The separate daemonMode useEffect also calls setDaemonModeActive
        // from its own .then, but that runs on its own React schedule. If
        // paneGate flips first, Terminals mount with daemonModeAtMount=false
        // and never call pty.reconnect — reproducing blank-terminal exactly
        // as if reconcile never happened. Setting it inside this serialized
        // startup path guarantees daemonMode is correct before Terminal mount.
        setDaemonModeActive(daemonReady.connected);

        // User-facing scrollback restore toggle. OFF: skip reconcile entirely
        // and clear every pty-keyed surface field so each Terminal mounts
        // fresh (Terminal.tsx self-create). Daemon still dumps ringBuffers
        // on graceful Quit; cleanOrphanedBuffers reaps the now-unreferenced
        // .buf files on the next launch. Done renderer-side so the daemon
        // contract stays simple and no extra RPC is needed.
        const restoreEnabled = useStore.getState().scrollbackRestoreEnabled !== false;
        if (!restoreEnabled) {
          console.log('[AppLayout] scrollbackRestoreEnabled=false — clearing pty state for fresh start');
          clearAllPtyState();
          return;
        }

        // Fix 0 — generation-tokened, AbortController-cancellable reconcile.
        // The rolling watchdog aborts only after one stage makes no progress
        // for the full budget; total duration may exceed one RPC timeout when
        // list/promote/re-list stages each complete legitimately under load.
        abortCtl = new AbortController();
        const signal = abortCtl.signal;
        await runWithProgressTimeout(
          (reportProgress) => reconcilePtys(signal, reportProgress),
          {
            timeoutMs: RECONCILE_TIMEOUT_MS,
            label: 'startup reconcile',
            onTimeout: () => abortCtl?.abort(),
          },
        );
        // v2 RCA fix (axis A): persist the reconciled layout ON SUCCESS ONLY.
        // Rebinds/clears from a completed reconcile must reach disk now — not
        // wait for the 5s tick a reboot could pre-empt. Deliberately NOT in the
        // finally: the catch path just ran clearAllPtyState() as a blank-slate
        // fallback, and persisting THAT would wipe good ptyIds from disk. Left
        // unsaved, the old on-disk ptyIds can still reattach next boot (daemon
        // recovery replays the same ids) — strictly better (codex P1).
        // Gen-guarded like clearAllPtyState: a superseded startup must not
        // persist a snapshot the fresher run is still reconciling.
        if (gen === startupGenRef.current) saveSessionNow();
      } catch (err) {
        // Fix 0 explicit fallback. Reconcile aborted, timed out, session.load
        // rejected, daemon.whenReady rejected, or any other startup throw.
        // Clear all pty-keyed state so Terminal.tsx self-create receives a
        // consistent blank slate. Generation check prevents a stale startup
        // from wiping state a fresher startup already reconciled correctly.
        console.warn('[AppLayout] startup reconcile failed:', err);
        abortCtl?.abort();
        if (gen === startupGenRef.current) {
          clearAllPtyState();
        }
      } finally {
        // Always flip the gate, even on error — never leave the user
        // staring at a permanent "Restoring panes…" placeholder.
        setPaneGate('ready');
      }
    })();
  // setPaneGate / clearAllPtyState are stable zustand action refs; reconcilePtys
  // captured by closure. Empty deps mirror pre-Fix-0 mount-only behavior.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── First-run wizard: probe marker on mount (T8a) ────────────────────
  // Calls firstRun:check; if no marker exists yet, mount the wizard. If a
  // marker already exists we mirror that into uiSlice so the spotlight guard
  // (D8) sees firstRunCompleted=true even before SessionData loads.
  // TODO(T8a-tests): AppLayout has no existing test fixture. Adding a
  // mounting integration suite (mocking useStore, useResizeGuard, useIpc,
  // electronAPI surfaces) is its own task. Smoke-test target:
  //   - firstRun.check called once on mount
  //   - shown=false flips showFirstRunWizard to 'firstRun'
  //   - shown=true triggers setFirstRunCompleted(true)
  //   - FIRST_RUN_REOPEN_EVENT flips mode to 'reopen'
  useEffect(() => {
    let cancelled = false;
    const api = window.electronAPI.firstRun;
    if (!api) return; // preload may not yet expose firstRun in non-Electron contexts (tests)
    void api.check().then((result) => {
      if (cancelled) return;
      if (!result.shown) {
        setShowFirstRunWizard('firstRun');
      } else {
        setFirstRunCompleted(true);
      }
    }).catch(() => {
      // Best-effort. If main is unreachable, fall back to "completed" so
      // the user is not blocked by a missing wizard channel.
      if (!cancelled) setFirstRunCompleted(true);
    });
    return () => {
      cancelled = true;
    };
  }, [setFirstRunCompleted]);

  // ─── First-run wizard: reopen contract for SettingsPanel (T8b) ───────
  // T8b's "Open setup wizard" button dispatches FIRST_RUN_REOPEN_EVENT on
  // window. No payload. AppLayout listens here and switches the wizard into
  // mode='reopen' (D9: sample task disabled).
  useEffect(() => {
    const handler = () => setShowFirstRunWizard('reopen');
    window.addEventListener(FIRST_RUN_REOPEN_EVENT, handler);
    return () => window.removeEventListener(FIRST_RUN_REOPEN_EVENT, handler);
  }, []);

  // Sync the orchestrator full-power toggle to MAIN, which is the authority
  // every brain-turn path consults (typed, scheduled, event-woken). Fires on
  // change AND once after session hydration flips the persisted value in, so
  // a restart restores the mode for autonomous turns without a typed command.
  // Fire-and-forget: a failed sync leaves main on the safe default (raw).
  const deckBrainFullPowerLive = useStore((s) => s.deckBrainFullPower);
  useEffect(() => {
    void window.electronAPI?.deck?.fullPowerSet?.(deckBrainFullPowerLive);
  }, [deckBrainFullPowerLive]);

  // Same main-authority sync for the brain vendor (BYOB M0).
  const deckBrainVendorLive = useStore((s) => s.deckBrainVendor);
  useEffect(() => {
    void window.electronAPI?.deck?.brainVendorSet?.(deckBrainVendorLive);
  }, [deckBrainVendorLive]);

  // …and for the orchestrator model. The composer still rides it on each send,
  // but that path does not exist for the terminal brain (no composer — the TUI
  // is the input) and never covered scheduled / event-woken turns.
  const deckBrainModelLive = useStore((s) => s.deckBrainModel);
  useEffect(() => {
    void window.electronAPI?.deck?.modelSet?.(deckBrainModelLive);
  }, [deckBrainModelLive]);

  // ─── First-run onboarding (spotlight) detection ─────────────────────
  // D8: spotlight stays gated behind firstRunCompleted so the wizard always
  // wins the first impression. Once the wizard completes/dismisses, the
  // spotlight tutorial picks up the UI tour for single-workspace users.
  useEffect(() => {
    if (!sessionLoadedRef.current) return;
    if (firstRunCompleted && !onboardingCompleted && workspaceCount === 1) {
      startOnboarding();
    }
  }, [firstRunCompleted, onboardingCompleted, workspaceCount, startOnboarding]);

  // Re-reconcile when daemon connects late (respawn/reconnect after the
  // startup reconcile already ran). Gating + abort/timeout/preserve logic
  // lives in createLateReconcileOnConnect — extracted so the paneGate gate
  // (S-A Step 1: the initial daemon:connected can now arrive mid-startup
  // because the renderer loads in parallel with the daemon bootstrap) and
  // the RCA A1/A3 guards are unit-testable.
  useEffect(() => {
    const late = createLateReconcileOnConnect({
      // Must stay a fresh getState() read — the gate is re-evaluated per
      // daemon:connected event, and a snapshot taken at effect time would
      // freeze 'pending' forever (the unit tests pin the factory's per-event
      // re-read, not this wiring).
      getPaneGate: () => useStore.getState().paneGate,
      reconcile: (signal) => reconcilePtys(signal),
      timeoutMs: RECONCILE_TIMEOUT_MS,
    });
    const remove = window.electronAPI.daemon.onConnected(late.onConnected);
    return () => {
      late.dispose();
      remove();
    };
  }, [reconcilePtys]);

  // Phase A — A6. Keep the module-level daemon-mode flag in sync with the
  // main process. The flag gates the renderer .txt scrollback path: while
  // daemon is connected, autosave skips and the IPC layer short-circuits
  // so the rotation-chain hazard (chronic 64-byte dumps overwriting good
  // backups) cannot fire. Local-mode users (daemon spawn fail / disconnect
  // mid-session) keep the .txt fallback exactly as before.
  useEffect(() => {
    // Read initial state — covers the case where main already finalised the
    // daemon decision before the renderer mounted (reload, crash recovery).
    void window.electronAPI.daemon.whenReady().then(({ connected }) => {
      setDaemonModeActive(connected);
    });
    const offConnected = window.electronAPI.daemon.onConnected(() => {
      setDaemonModeActive(true);
    });
    const offDisconnected = window.electronAPI.daemon.onDisconnected(() => {
      setDaemonModeActive(false);
    });
    // B′ stale-daemon auto-replacement started: without this toast the pane
    // freeze + scrollback replay during suspend→respawn→recover reads as an
    // unexplained glitch.
    const offReplacing = window.electronAPI.daemon.onReplacing(() => {
      useStore.getState().pushToast({ level: 'info', message: t('daemon.replacingToast') });
    });
    return () => {
      offConnected();
      offDisconnected();
      offReplacing();
    };
  }, []);

  // #898 — a Claude Code plugin install still running the bridge that answers
  // `ask` on every fall-through. That state blocks EVERY tool call in a
  // bypass-permissions session and cannot be turned off from inside the
  // session, so the notice persists rather than expiring after five seconds:
  // the user has to run a command, and the breakage outlives any timeout.
  // wmux deliberately does not repair the plugin's own directory (see
  // stalePluginGate) — it hands over the command instead.
  useEffect(() => {
    const off = window.electronAPI.onStalePluginGate?.((found) => {
      if (found.length === 0) return;
      // A user and a project scope install can both be stale, and fixing one
      // leaves the other prompting — so copy every command, not just the first.
      const command = found.map((f) => f.updateCommand).join('\n');
      useStore.getState().pushToast({
        level: 'warn',
        persist: true,
        message: t('plugin.staleGate.message'),
        action: {
          label: t('plugin.staleGate.copy'),
          onClick: () => {
            void (async () => {
              try {
                const clipboard = window.clipboardAPI;
                // An absent bridge has to reach the fallback too, or the
                // button would report a copy that never happened.
                if (!clipboard) throw new Error('clipboard bridge unavailable');
                // Awaited inside the try because writeText MAY throw
                // SYNCHRONOUSLY (review: CodeRabbit) — a `.catch()` chained
                // onto the call sees rejections only, and would miss it.
                await clipboard.writeText(command);
                useStore.getState().pushToast({
                  level: 'info',
                  message: t('plugin.staleGate.copied'),
                });
              } catch {
                // Showing the raw command keeps the user able to act, which is
                // the whole point of the notice.
                useStore.getState().pushToast({
                  level: 'warn',
                  persist: true,
                  message: command,
                });
              }
            })();
          },
        },
      });
    });
    return () => off?.();
  }, []);

  // X8 pane supervision — keep the renderer supervision slice in sync with the
  // daemon's PaneSupervisor. Three inputs:
  //   - pty.onSupervisionChanged: sticky status flip (guard-trip / rearm /
  //     manual-stop) → setSupervision (carries the live restartCount).
  //   - pty.onRestarted: a quiet auto-restart → bump the count, status stays
  //     armed (the in-pane marker lives in useTerminal; this is badge state).
  //   - pty.list() hydration on mount + every daemon:connected: replaces the
  //     whole map from the authoritative session list so a reload / daemon
  //     respawn re-derives badges without waiting for the next event.
  useEffect(() => {
    const hydrate = () => {
      void window.electronAPI.pty.list().then((sessions) => {
        const snapshot: Record<string, { status: 'armed' | 'stopped'; restartCount: number }> = {};
        // X6 ②: resume hints for recovered interactive agent panes.
        const resumeSnapshot: Record<string, AgentSlug> = {};
        // X6 ③: the captured binding (id + cwd + permission mode) for the pill.
        const resumeBindingSnapshot: Record<string, ResumeBinding> = {};
        // OSC 133 shell state per ptyId — the resume chip's authoritative gate.
        const commandRunningSnapshot: Record<string, boolean> = {};
        // Process-truth agent liveness — the chip's edge-trigger gate.
        const agentAliveSnapshot: Record<string, boolean> = {};
        for (const s of sessions) {
          if (s.supervision) snapshot[s.id] = s.supervision;
          if (s.resumeAgent) resumeSnapshot[s.id] = s.resumeAgent as AgentSlug;
          if (s.resumeBinding) resumeBindingSnapshot[s.id] = s.resumeBinding;
          if (s.commandRunning !== undefined) commandRunningSnapshot[s.id] = s.commandRunning;
          if (s.agentProcessAlive !== undefined) agentAliveSnapshot[s.id] = s.agentProcessAlive;
        }
        useStore.getState().hydrateSupervision(snapshot);
        useStore.getState().hydrateResume(resumeSnapshot);
        useStore.getState().hydrateResumeBindings(resumeBindingSnapshot);
        useStore.getState().hydrateCommandRunning(commandRunningSnapshot);
        useStore.getState().hydrateAgentAlive(agentAliveSnapshot);
        // 4d (channels): seed agent identity for panes the user has NOT
        // visited yet, so recovered agents show up as invite/mention
        // candidates right after boot instead of only after a visit.
        // Pull from the daemon AgentDetector (authoritative, race-free);
        // live detection overwrites the seed on visit. Best-effort per pane.
        const seedTargets = planAgentCandidateSeed(
          sessions.map((s) => s.id),
          useStore.getState().surfaceAgent,
        );
        for (const ptyId of seedTargets) {
          void window.electronAPI.metadata.resolveAgent(ptyId).then((name) => {
            // Attempted either way — a null answer means "not an agent pane
            // (yet)"; re-asking on every daemon:connected would fan the RPC
            // out to every plain shell forever (Claude review #5). A later
            // live detection still lands via its own path.
            markSeedAttempted(ptyId);
            if (!name) return;
            const store = useStore.getState();
            // A live detection may have landed while this pull was in
            // flight — setSurfaceAgent keeps existing names, but skip the
            // principal round-trip in that case entirely.
            if (store.surfaceAgent[ptyId]?.name) return;
            store.setSurfaceAgent(ptyId, name, undefined, asAgentSlug(name));
            // R2: freshly-identified panes register into the principal
            // registry exactly like the live-detection path (debounced
            // slice-side, so repeat calls are cheap).
            void useStore.getState().principalRegisterPane(ptyId);
          }).catch(() => { /* best-effort — transient failure; retry allowed on the next connect */ });
        }
      }).catch(() => { /* best-effort — a transient list failure self-heals on the next connect */ });
    };
    hydrate();
    const offConnected = window.electronAPI.daemon.onConnected(hydrate);
    const offChanged = window.electronAPI.pty.onSupervisionChanged((payload) => {
      useStore.getState().setSupervision(payload.ptyId, payload.status, payload.restartCount);
    });
    const offRestarted = window.electronAPI.pty.onRestarted((payload) => {
      useStore.getState().bumpSupervisionRestart(payload.ptyId);
    });
    return () => {
      offConnected();
      offChanged();
      offRestarted();
    };
  }, []);

  // "Anytime" freshness for the per-pane resume affordance (ResumeInfoChip): the
  // hydrate above only runs on mount + daemon:connected, so a conversation started
  // AFTER mount wouldn't surface its UUID until a reconnect. A light 15s poll keeps
  // ONLY the binding map fresh. It deliberately never re-hydrates resume HINTS —
  // that would resurrect a reboot-recovery pill the user dismissed (resumeSlice
  // note). One in-memory list RPC per 15s; negligible against the daemon idle diet.
  useEffect(() => {
    const refreshBindings = () => {
      void window.electronAPI.pty.list().then((sessions) => {
        const snapshot: Record<string, ResumeBinding> = {};
        // OSC 133 shell state rides the same poll — keeps the chip's authoritative
        // gate fresh (a foreground command that started/ended since the last tick).
        const cmdSnapshot: Record<string, boolean> = {};
        // Agent process liveness rides along too — it is the edge (alive→dead)
        // that lets the chip appear on panes without shell integration.
        const agentAliveSnapshot: Record<string, boolean> = {};
        for (const s of sessions) {
          if (s.resumeBinding) snapshot[s.id] = s.resumeBinding;
          if (s.commandRunning !== undefined) cmdSnapshot[s.id] = s.commandRunning;
          if (s.agentProcessAlive !== undefined) agentAliveSnapshot[s.id] = s.agentProcessAlive;
        }
        useStore.getState().hydrateResumeBindings(snapshot);
        useStore.getState().hydrateCommandRunning(cmdSnapshot);
        useStore.getState().hydrateAgentAlive(agentAliveSnapshot);
      }).catch(() => { /* transient list failure — the next tick self-heals */ });
    };
    const id = window.setInterval(refreshBindings, 15_000);
    return () => window.clearInterval(id);
  }, []);

  // Session saver: registered on the sessionSaveBridge (event-driven immediate
  // saves — the axis-A reboot fix) + bound to beforeunload (scrollback dump,
  // sync fire-and-forget legacy exit save).
  useEffect(() => {
    const saveSession = () => {
      const dumped = dumpScrollbackBuffersSync();
      const data = buildSessionData(dumped);
      window.electronAPI.session.save(data);
    };

    // v2 RCA fix (axis A): register the saver for event-driven immediate
    // persistence. beforeunload is unreliable on OS reboot (the process is
    // force-killed before it fires), so ptyId-changing sites (self-create,
    // addSurface, reconcile completion) call saveSessionNow() to flush right away
    // — closing the "vulnerable 5s window" between a self-create and the next
    // periodic tick, which is exactly where a reboot loses the new ptyId.
    //
    // GUARDED like the 5s periodic save: if session.load() failed at startup,
    // the store still holds the DEFAULT empty workspace — an event-driven save
    // (failed startup also flips paneGate and self-creates panes) would sync-
    // overwrite the user's good session.json with that default. Same data-loss
    // class the periodic tick's sessionLoadedRef guard exists to prevent.
    const saveSessionGuarded = () => {
      if (!sessionLoadedRef.current) return;
      saveSession();
    };
    registerSessionSaver(saveSessionGuarded);
    // beforeunload gets the SAME guard (adversarial review): an exit while
    // session.load() is in flight / failed must not overwrite a good
    // session.json with the default workspace either. First launch is safe —
    // load()===null sets sessionLoadedRef=true before any unload can fire.
    window.addEventListener('beforeunload', saveSessionGuarded);
    return () => {
      window.removeEventListener('beforeunload', saveSessionGuarded);
      registerSessionSaver(null);
    };
  }, []);

  // Periodic session save — protects against crashes.
  // Awaits scrollback dump completion before saving session.json to guarantee
  // files referenced in session data actually exist on disk.
  //
  // A4 (NB2 파동 0): 이 주기 틱은 크래시 세이프티 목적이므로 비동기 저장
  // (session.saveAsync)으로 보낸다 — main-side 원자 쓰기가 async라 main 이벤트
  // 루프를 블록하지 않는다. 유실 창은 그대로 ≤5초(틱 간격)다. 리부트 생존의
  // 핵심인 이벤트 기반 저장(saveSessionNow)과 종료 경로(beforeunload/before-quit/
  // session-end)는 여전히 동기 save/flushSync를 써서 마지막 상태 유실을 막는다.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!sessionLoadedRef.current) return;
      // Fix 0: skip autosave while startup reconcile is still in flight.
      // Without this guard, a half-reconciled snapshot (some surfaces
      // with old ptyId, some cleared) could be persisted on top of the
      // saved session — next startup would load garbage state.
      if (useStore.getState().paneGate !== 'ready') return;
      const dumped = dumpScrollbackBuffersSync();
      const data = buildSessionData(dumped);
      window.electronAPI.session.saveAsync(data);
    }, 5_000);
    return () => { clearInterval(interval); };
  }, []);

  // X5 wmux.json discovery. Probes main whenever a workspace's effective cwd
  // (X1 metadata.cwd, seeded by the first pane) appears or changes; the probe
  // caches the result in projectConfigs and runs the auto-apply policy
  // (trusted + layout + fresh workspace, once per run). A newly discovered
  // UNTRUSTED file gets one discoverability toast per workspace+root — the
  // file never executes anything without the explicit trust grant.
  const probedCwdRef = useRef<Map<string, string>>(new Map());
  const discoveryToastedRef = useRef<Set<string>>(new Set());
  // `projectCwdSignature` is a DERIVED-STABLE subscription (selectProjectCwdSignature,
  // read at the top) — it changes only when a workspace's cwd first appears, which
  // is the effect's trigger. It MUST be a subscribed value: a getState read here
  // would never schedule the effect, silently breaking wmux.json auto-discovery.
  useEffect(() => {
    if (paneGate !== 'ready') return;
    for (const ws of useStore.getState().workspaces) {
      const cwd = workspaceProbeCwd(ws);
      if (!cwd) continue;
      if (probedCwdRef.current.get(ws.id) === cwd) continue;
      probedCwdRef.current.set(ws.id, cwd);
      const wsId = ws.id;
      void probeProjectConfig(wsId).then((result) => {
        if (!result?.found) return;
        maybeAutoApplyProjectLayout(wsId);
        const toastKey = `${wsId}:${result.root}`;
        if (result.trust === 'untrusted' && !discoveryToastedRef.current.has(toastKey)) {
          discoveryToastedRef.current.add(toastKey);
          useStore.getState().pushToast({ level: 'info', message: t('project.discoveredToast') });
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- projectCwdSignature + paneGate are the meaningful triggers; workspaces identity churns every render
  }, [projectCwdSignature, paneGate]);

  // Wizard close handler (T8a). Mirrors firstRunCompleted into uiSlice (main
  // already wrote the marker via firstRun:complete or :dismiss). The cheat
  // sheet auto-mounts via the derived condition below as soon as
  // firstRunCompleted flips true (D11) — no separate reveal flag needed.
  const handleWizardClose = useCallback(() => {
    setShowFirstRunWizard(null);
    setFirstRunCompleted(true);
  }, [setFirstRunCompleted]);

  if (!hasActiveWorkspace) return null;

  return (
    <ErrorBoundary name="AppLayout">
    <div
      className="flex flex-col h-screen w-screen bg-[var(--bg-base)] overflow-hidden"
      style={{
        ...(prefixMode ? {
          boxShadow: 'inset 0 0 0 2px var(--accent-red)',
          transition: 'box-shadow 0.15s ease-in-out',
        } : {
          boxShadow: 'none',
          transition: 'box-shadow 0.15s ease-in-out',
        }),
      }}
    >
      {/* Bridge redesign — custom 36px titlebar spans the FULL window width,
          above the sidebar|main|dock row. The BrowserWindow is frameless
          (titleBarStyle:'hidden'), so this bar owns window dragging. */}
      <ErrorBoundary name="Titlebar">
        <Titlebar />
      </ErrorBoundary>
      <div className={`flex flex-1 min-h-0 ${sidebarPosition === 'right' ? 'flex-row-reverse' : ''}`}>
      <ErrorBoundary name="Sidebar">
        {sidebarVisible ? <Sidebar /> : <MiniSidebar />}
      </ErrorBoundary>
      <ErrorBoundary name="Main">
      {/* `relative` anchors ToolbarHost: the agent toolbar overlays this column
          rather than taking a row, so revealing it never resizes a PTY. */}
      <div className="flex-1 min-w-0 flex flex-col relative">
        {/* P1.5 — the status strip moved into the Titlebar (owner feedback:
            the empty titlebar center + a second status row doubled the top
            chrome). This column now starts directly with the pane area. */}
        {/* Workspace center — 페인 그리드 전용(Git·Review는 우측 덱 탭으로 복귀).
            페인 그리드는 WorkspaceViewport가 `workspaces` 구독을 소유(PERF 2026-07-13)
            해 메타데이터/서피스 churn이 뷰포트(메모된 슬롯)만 리렌더하고 AppLayout
            크롬은 건드리지 않는다. */}
        <WorkspaceCenter />
        {/* Render-null logic mounts. Both own subscriptions that change on a
            workspace switch (EmptyLeafFunnel: activeWorkspaceId + empty-leaf
            key; FocusManager: focusKey with activeWorkspaceId) — hosted here,
            NOT in AppLayout, so the switch re-renders these tiny components
            instead of the ~1300-line chrome (2026-07-13 switch-lag fix). */}
        <EmptyLeafFunnel />
        <FocusManager />
        <ErrorBoundary name="ComposeHost">
          <ComposeHost />
        </ErrorBoundary>
        {/* ToolbarHost is layout-neutral (it renders an absolute overlay), but
            ErrorBoundary's fallback is a plain `height:100%` block — as a flex
            child it would join the column's flow and squeeze the pane grid. So
            the BOUNDARY is the absolutely-positioned thing: a crash costs the
            bar's own 36px strip, never the terminals' height. ToolbarHost's
            own `inset-0` fills this box, so the trigger band still measures to
            the column's bottom edge. */}
        <div
          className="absolute inset-x-0 bottom-0"
          style={{ height: AGENT_TOOLBAR_HEIGHT }}
          data-agent-toolbar-strip
        >
          <ErrorBoundary name="AgentToolbar">
            <ToolbarHost />
          </ErrorBoundary>
        </div>
      </div>
      </ErrorBoundary>
      {/* A2A channel dock (Approach A). A flex sibling on the OPPOSITE edge
          from the workspace sidebar — the root row's flex-row-reverse (when
          the sidebar is docked right) puts this on the correct edge, so it
          reflows the panes instead of the old fixed overlay that covered them.
          Holds the channel list + active conversation; collapsible. */}
      {/* Collapsed, the deck renders NOTHING here — the terminals take the
          whole width. The way back is the titlebar's DeckToggle beside
          Settings (owner decision 2026-08-18, replacing the 36px glyph rail).
          The rail spent a full-height column on four glyphs and an expand
          chevron, ~85% of it empty; one button on a row that already exists
          costs the terminals nothing. */}
      {channelDockVisible && (
        <ErrorBoundary name="ChannelDock">
          <ChannelDock />
        </ErrorBoundary>
      )}
      {/* S-C1 Fleet View (Ctrl+Shift+A) — NB2 파동2 사이클 A에서 전체화면 모달을
          상시 크롬으로 전환. ChannelDock과 같은 flex 형제 패턴으로 워크스페이스
          사이드바 반대편 엣지에 고정폭으로 앉아 페인을 reflow한다(더 이상 z-fleet
          fixed 오버레이가 아니다). Mount-gated on fleetViewVisible. */}
      {fleetViewVisible && (
        <ErrorBoundary name="FleetView">
          <FleetView />
        </ErrorBoundary>
      )}
      {fileTreeVisible && (
        <ErrorBoundary name="FileTree">
          <FileTreePanel position={sidebarPosition === 'left' ? 'right' : 'left'} />
        </ErrorBoundary>
      )}
      <NotificationPanel />
      <MessageFeedPanel />
      {/* Cross-pane search results panel (T-F). Mount-gated on
          searchPanelOpen at this level (I3) so the panel's 6-field zustand
          subscriptions don't run when closed. */}
      {searchPanelOpen && (
        <ErrorBoundary name="SearchResultsPanel">
          <SearchResultsPanel />
        </ErrorBoundary>
      )}
      {/* TASK-2: lazy overlays, render-gated on their own store flags and
          wrapped in <Suspense fallback={null}> inside <ErrorBoundary> so a
          failed chunk load surfaces instead of silently dropping the overlay. */}
      {commandPaletteVisible && (
        <ErrorBoundary name="CommandPalette">
          <Suspense fallback={null}><CommandPalette /></Suspense>
        </ErrorBoundary>
      )}
      {worktaskCleanupVisible && (
        <ErrorBoundary name="WorktaskCleanupView">
          <Suspense fallback={null}><WorktaskCleanupView /></Suspense>
        </ErrorBoundary>
      )}
      {/* SettingsPanel: gate on visible OR inspect-active — inspect mode keeps
          the panel mounted while the overlay picks colors (D3 / SettingsPanel
          ESC + inspect contract). */}
      {(settingsPanelVisible || inspectModeActive) && (
        <ErrorBoundary name="SettingsPanel">
          <Suspense fallback={null}><SettingsPanel /></Suspense>
        </ErrorBoundary>
      )}
      {/* Color inspect-mode overlay (S4). Sits at --z-inspect (65, declared
          inside the component) — above SettingsPanel (--z-overlay 50) so it
          captures clicks over the minimized Settings bar, below FirstRunWizard
          (--z-dialog 70). Returns null when inspectModeActive is false. */}
      {inspectModeActive && (
        <ErrorBoundary name="InspectOverlay">
          <Suspense fallback={null}><InspectOverlay /></Suspense>
        </ErrorBoundary>
      )}
      <ApprovalDialog />
      {!inboxOwnsApprovals && <ExecuteApprovalDialog />}
      {!inboxOwnsApprovals && <PermissionApprovalDialogContainer />}
      <ProjectConfigDialog />

      {onboardingActive && (
        <OnboardingOverlay onComplete={() => { completeOnboarding(); }} />
      )}

      {/* First-run auto-update prompt */}
      {showAutoUpdatePrompt && (
        <div
          className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center"
          style={{ backgroundColor: 'var(--backdrop-modal)' }}
        >
          <div
            className="flex flex-col gap-4 p-6 rounded-xl"
            style={{
              width: 400,
              backgroundColor: 'var(--bg-base)',
              border: '1px solid var(--bg-surface)',
              boxShadow: 'var(--shadow-modal)',
            }}
          >
            <p className="text-sm font-semibold text-[color:var(--text-main)] font-mono">
              {t('firstRun.autoUpdateTitle')}
            </p>
            <p className="text-xs text-[color:var(--text-sub)]">
              {t('firstRun.autoUpdateMessage')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  useStore.getState().setAutoUpdateEnabled(false);
                  window.electronAPI.settings.setAutoUpdateEnabled(false);
                  setShowAutoUpdatePrompt(false);
                }}
                className="ui-btn ui-btn-secondary"
              >
                {t('firstRun.disable')}
              </button>
              <button
                onClick={() => {
                  useStore.getState().setAutoUpdateEnabled(true);
                  window.electronAPI.settings.setAutoUpdateEnabled(true);
                  setShowAutoUpdatePrompt(false);
                }}
                className="ui-btn ui-btn-primary"
              >
                {t('firstRun.enable')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* First-run wizard (T8a). Sits at --z-dialog (70, declared inside the
          component) so it stacks above the auto-update prompt. T8b's
          SettingsPanel triggers a FIRST_RUN_REOPEN_EVENT window event to
          set mode='reopen' (D9). */}
      {showFirstRunWizard !== null && (
        <FirstRunWizard mode={showFirstRunWizard} onClose={handleWizardClose} />
      )}

      {/* Keyboard cheat sheet (T8a / Plan 1.18). Mounts derivatively from
          firstRunCompleted + !cheatSheetDismissed so that flipping
          cheatSheetDismissed=false from Settings (T8b) immediately re-mounts
          the sheet. The component itself is a no-op when dismissed (D11).
          `cheatSheetForceShown` (set by the `?` prefix action) bypasses the
          permanent dismissal so the cheat sheet can always be pulled back up. */}
      {firstRunCompleted && (!cheatSheetDismissed || cheatSheetForceShown) && <KeyboardCheatSheet />}

      {companyViewVisible && (
        <CompanyView onClose={() => setCompanyViewVisible(false)} />
      )}

      {/* Visual drag indicator — pointer-events always 'none' so it never
          blocks clicks, scrolling, or keyboard. Drop handling is done entirely
          via the window-level listeners registered in the useEffect above. */}
      {isDragging && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 'var(--z-critical)',
            pointerEvents: 'none',
            backgroundColor: 'rgba(137, 180, 250, 0.08)',
          }}
        />
      )}
      <FloatingPane />
      <ToastContainer />
      <HooksInstallPromptContainer t={t} />
      </div>
    </div>
    </ErrorBoundary>
  );
}
