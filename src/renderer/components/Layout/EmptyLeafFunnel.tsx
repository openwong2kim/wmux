// ─── EmptyLeafFunnel — auto-creates PTYs for empty leaves, isolated from the
//     chrome so it does NOT re-render AppLayout on workspace switch (2026-07-13)
// ─────────────────────────────────────────────────────────────────────────────
//
// This renders `null`. Its sole job is the empty-leaf → pty.create funnel effect
// that used to live inside AppLayout. Pulling it out (together with the
// `activeWorkspaceId` / `emptyLeafIdsKey` subscriptions it needs) means a
// workspace switch re-renders THIS null component + <WorkspaceViewport>, but NOT
// AppLayout's ~1300-line chrome. Same pattern as the #437 `workspaces` split;
// the switch was the axis #437 didn't cover (the chrome still subscribed to
// `activeWorkspaceId` as a render value).
//
// Behavior is byte-for-byte the funnel that was in AppLayout — the CAPTURED
// activeWorkspaceId dep, paneGate 'ready' gate, version-skew guard, in-flight
// ref, orphan guard, and project/split/browser seed branches all move verbatim.

import { useEffect, useRef } from 'react';
import { useStore } from '../../stores';
import { useIpc } from '../../hooks/useIpc';
import { selectActiveEmptyLeafIdsKey } from '../../stores/selectors/appLayout';
import {
  resolveStartupCwd,
  shellDisplayName,
  withDefaultShell,
  withWorkspaceProfile,
} from '../../utils/ptyCreateOptions';
import {
  PROJECT_SUPERVISION_DEFAULT_BURST,
  PROJECT_SUPERVISION_DEFAULT_HEALTHY_UPTIME_SEC,
} from '../../../shared/wmuxProjectConfig';
import type { Pane, PaneLeaf } from '../../../shared/types';

type LeafPane = PaneLeaf;

const collectEmptyLeaves = (pane: Pane): LeafPane[] => {
  if (pane.type === 'leaf') {
    return pane.surfaces.length === 0 ? [pane] : [];
  }
  return pane.children.flatMap(collectEmptyLeaves);
};

/**
 * Renders nothing. Owns the empty-leaf PTY-create funnel. Deps include the
 * joined empty-leaf id signature so that splitPane (which adds a new empty leaf
 * without changing the workspace id) re-triggers PTY creation. Without this, a
 * freshly split pane stays as the "빈 창" placeholder forever.
 */
export function EmptyLeafFunnel() {
  const { invoke: ipcInvoke } = useIpc();
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const emptyLeafIdsKey = useStore(selectActiveEmptyLeafIdsKey);
  const paneGate = useStore((s) => s.paneGate);
  const addSurface = useStore((s) => s.addSurface);

  // Panes with a pty.create in flight. Guards double-creation when the effect
  // re-runs while an earlier run's create hasn't resolved yet — which happens
  // EVERY multi-pane project-layout apply: the browser-leaf branch below
  // mutates the store synchronously, re-rendering and re-running the effect
  // mid-loop. (The old `cancelled` cleanup flag disposed the in-flight PTYs on
  // any re-run, and since their one-shot seeds were already consumed, the
  // re-run recreated them WITHOUT their startup commands — X5 dogfood S4c.)
  const ptyCreateInFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Read the FULL active workspace fresh (getState) — this component
    // subscribes to activeWorkspaceId as a render value only to fire the effect.
    // Look up the CAPTURED activeWorkspaceId (the dep this run fired for), not
    // the live global, so a switch that raced the effect targets the workspace
    // this run was scheduled for (eng review).
    const activeWorkspace = useStore.getState().workspaces.find((w) => w.id === activeWorkspaceId);
    if (!activeWorkspace) return;
    // Fix 0: wait until startup reconcile finishes before auto-creating
    // PTYs for empty leaves. Without this guard, the default workspace
    // (which has an empty leaf at app construction time) would spawn a
    // PTY before session.load() replaces it with the saved workspace —
    // leaking an orphaned daemon session and racing the user's restored
    // surfaces (codex outside-voice hole #4).
    if (paneGate !== 'ready') return;

    const emptyLeaves = collectEmptyLeaves(activeWorkspace.rootPane);
    if (emptyLeaves.length === 0) return;
    // Version-skew guard: bail if fresh state's empty-leaf set no longer matches
    // the key this run fired for (a structural change raced the effect).
    if (emptyLeaves.map((l) => l.id).join('|') !== emptyLeafIdsKey) return;

    const wsId = activeWorkspace.id;

    const findLiveLeaf = (pane: Pane, id: string): LeafPane | null => {
      if (pane.type === 'leaf') return pane.id === id ? pane : null;
      for (const child of pane.children) {
        const found = findLiveLeaf(child, id);
        if (found) return found;
      }
      return null;
    };

    for (const leaf of emptyLeaves) {
      const paneId = leaf.id;
      if (ptyCreateInFlightRef.current.has(paneId)) continue;
      // Issues #173/#174/#175: split-inherited cwd > profile.startupCwd >
      // global startupDirectory > homedir (main-side fallback). The seed is
      // consumed immediately so a later effect re-run (e.g. PTY create failed
      // at the session cap) can't replay a stale directory.
      const storeState = useStore.getState();
      // X5: a project-layout seed outranks everything — applyProjectLayout
      // pinned this pane's bootstrap (command/cwd/browser url) to the trusted
      // wmux.json. Consumed immediately, same replay rule as splitCwdSeed.
      const projectSeed = storeState.projectPaneSeed[paneId];
      if (projectSeed) storeState.clearProjectPaneSeed(paneId);
      if (projectSeed?.url) {
        // Browser leaf (X3 surface) — no PTY at all. NOTE: this synchronous
        // store write re-renders and re-runs this effect before the loop's
        // other iterations' creates resolve — see ptyCreateInFlightRef above.
        useStore.getState().addBrowserSurface(paneId, projectSeed.url, undefined, wsId);
        continue;
      }
      const startupCwd = projectSeed?.cwd ?? resolveStartupCwd({
        splitSeed: storeState.splitCwdSeed[paneId],
        splitInheritsCwd: storeState.splitInheritsCwd,
        profile: activeWorkspace.profile,
        startupDirectory: storeState.startupDirectory,
      });
      if (storeState.splitCwdSeed[paneId]) storeState.clearSplitCwdSeed(paneId);
      ptyCreateInFlightRef.current.add(paneId);
      // X8: a supervised seed (restart set, terminal leaf only) becomes an
      // exec-style supervised create — the command runs as the pane's ROOT
      // process under the daemon's PaneSupervisor, NOT typed in as an
      // initialCommand. Omitted restartLimit fields fall back to the SSOT
      // defaults here at the funnel. Unsupervised seeds keep the exact prior
      // behavior (initialCommand pasted into the shell).
      const seedRestart = projectSeed?.restart;
      const seedCommand = projectSeed?.command;
      const bootstrapOptions =
        seedRestart !== undefined && seedCommand !== undefined
          ? {
              exec: seedCommand,
              supervision: {
                restart: seedRestart,
                limit: {
                  burst: projectSeed?.restartLimit?.burst ?? PROJECT_SUPERVISION_DEFAULT_BURST,
                  healthyUptimeSec:
                    projectSeed?.restartLimit?.healthyUptimeSec ?? PROJECT_SUPERVISION_DEFAULT_HEALTHY_UPTIME_SEC,
                },
                // U-PERM: consent-gated at layout-apply (buildTree). Included only
                // when true so unsupervised/unconsented panes persist no bit.
                ...(projectSeed?.restorePermissionMode === true ? { restorePermissionMode: true } : {}),
              },
            }
          : (seedCommand !== undefined ? { initialCommand: seedCommand } : {});
      // Wrap through ipcInvoke so a rejected pty.create (e.g.
      // RESOURCE_EXHAUSTED when the daemon session cap is hit during a
      // Ctrl+D split) surfaces an actionable toast instead of leaving the
      // split as a permanent empty-leaf placeholder.
      void ipcInvoke<{ id: string; shell?: string; cwd?: string }>(() =>
        window.electronAPI.pty.create(
          withWorkspaceProfile(
            withDefaultShell(
              // 순수 빈 리프(사용자가 split으로 연 셸)만 user-shell로 스탬프해 env
              // 투과. project seed(seedCommand 존재 — initialCommand/exec 브랜치)는
              // 자동화라 미스탬프 → main이 fail-closed로 gated 처리.
              {
                workspaceId: wsId,
                cwd: startupCwd,
                ...bootstrapOptions,
                ...(seedCommand === undefined ? { spawnKind: 'user-shell' as const } : {}),
              },
              useStore.getState().defaultShell,
            ),
            activeWorkspace.profile,
          )
        )
      ).then((result) => {
        ptyCreateInFlightRef.current.delete(paneId);
        if (!result.ok) return; // toast surfaced by useIpc
        const created = result.data;
        // Orphan guard, replacing the old effect-cleanup `cancelled` flag:
        // adopt the PTY only if the target pane still exists in this
        // workspace AND is still empty. A live-tree check survives benign
        // effect re-runs (which the cancelled flag did not) while keeping
        // the protection against leaking a PTY into a closed/replaced pane.
        const liveWs = useStore.getState().workspaces.find((w) => w.id === wsId);
        const livePane = liveWs ? findLiveLeaf(liveWs.rootPane, paneId) : null;
        if (!livePane || livePane.surfaces.length > 0) {
          window.electronAPI.pty.dispose(created.id);
          return;
        }
        const shellName = created.shell ? shellDisplayName(created.shell) : 'Terminal';
        // v2 RCA fix (axis A): the immediate persist now lives INSIDE addSurface
        // (surfaceSlice centralization) so every binding call site gets it.
        addSurface(paneId, created.id, shellName, created.cwd || '');
        // Set initial CWD in workspace metadata from first pane
        if (created.cwd) {
          const currentMeta = useStore.getState().workspaces.find((w) => w.id === wsId)?.metadata;
          if (!currentMeta?.cwd) {
            useStore.getState().updateWorkspaceMetadata(wsId, { cwd: created.cwd });
          }
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- addSurface & ipcInvoke are stable; activeWorkspaceId + emptyLeafIdsKey + paneGate are the meaningful triggers
  }, [activeWorkspaceId, emptyLeafIdsKey, paneGate]);

  return null;
}
