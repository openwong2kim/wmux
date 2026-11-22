/**
 * #2398 — the create a blank terminal surface starts its own shell with.
 *
 * Two callers start it, under the same ptyLifecycle key (the surface id), so
 * whichever comes second joins the attempt the first started:
 * - the surface's Terminal, once the surface is shown (or at boot for a
 *   dead-pane recovery that resumes on start);
 * - a raw terminal write to a pane that has not started yet
 *   (`surface.ensurePty`, from main's input.send / input.sendKey). The
 *   surface's Terminal may not be mounted then (its workspace cold-parked), so
 *   this path reads everything from the store and binds through it.
 */
import type { IpcResult } from './useIpc';
import { createInvoke } from './useIpc';
import { ptyLifecycle, type PtyEnsureOutcome } from './ptyLifecycle';
import { useStore } from '../stores';
import { getLeafPanes, getWorkspaceLeafPanes } from '../../shared/paneUtils';
import type { DeadPaneRecovery } from '../../shared/ptyRecovery';
import { resolveRespawnCwd, shouldHealSurfaceCwd, withDefaultShell, withWorkspaceProfile } from '../utils/ptyCreateOptions';
import { isTerminalSurfaceType } from '../components/Pane/surfaceKinds';
import { attachForWrite } from './useTerminal';

export interface SurfacePtyCreated {
  id: string;
  cwd?: string;
}

/**
 * Whether the surface still exists anywhere a workspace owns it, and — when
 * `ptyId` is given — whether it is bound to exactly that pty ('' = blank).
 */
export function surfaceHoldsPty(surfaceId: string, ptyId: string | undefined): boolean {
  for (const ws of useStore.getState().workspaces) {
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      const surface = leaf.surfaces.find((s) => s.id === surfaceId);
      if (surface) return ptyId === undefined || (surface.ptyId || '') === ptyId;
    }
  }
  return false;
}

/** A tab's worker fence switch (Surface.workerFence); undefined when the
 *  tab is not in the store yet. */
export function surfaceWorkerFence(surfaceId: string): boolean | undefined {
  for (const ws of useStore.getState().workspaces) {
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      const surface = leaf.surfaces.find((s) => s.id === surfaceId);
      if (surface) return surface.workerFence === true;
    }
  }
  return undefined;
}

export interface SurfaceCreateInput {
  workspaceId: string;
  surfaceId?: string;
  shell?: string;
  /** The surface's tracked cwd. */
  cwd?: string;
  /** The surface's staged dead-session recovery (`surface.pendingRecovery`). */
  pendingRecovery?: DeadPaneRecovery;
  cols?: number;
  rows?: number;
}

export interface SurfaceCreate {
  create: () => Promise<IpcResult<SurfacePtyCreated>>;
  /** After the bind: heal the surface's tracked cwd to where main spawned. */
  heal: (created: SurfacePtyCreated) => void;
}

/** The self-create of one blank surface (moved here from Terminal.tsx). */
export function surfaceCreate(
  input: SurfaceCreateInput,
  invoke: <T>(call: () => Promise<T>) => Promise<IpcResult<T>>,
): SurfaceCreate {
  const { workspaceId, surfaceId, shell, cwd, pendingRecovery: deadPaneRecovery, cols, rows } = input;
  const defaultShell = useStore.getState().defaultShell;
  // Owning workspace's profile (env + startup command) for this new pane.
  const profile = useStore.getState().workspaces.find((w) => w.id === workspaceId)?.profile;
  const fenceSwitch = surfaceId ? surfaceWorkerFence(surfaceId) : undefined;
  // Issue #515: a self-create is a NEW shell for a blank surface — resolve the
  // startup dir with the workspace default OUTRANKING the (possibly stale/home-
  // contaminated) surface.cwd prop, so a dead-session respawn heals back to
  // profile.startupCwd instead of perpetuating home.
  const startupDirectory = useStore.getState().startupDirectory;
  // #650: a known-dead session carries BOTH persisted cwd candidates to
  // main, which validates spawnCwd → live cwd → home. Ordinary blank surfaces
  // stay on #515's profile-first resolver; recovery never changes that policy.
  const respawnCwd = deadPaneRecovery
    ? undefined
    : resolveRespawnCwd({ surfaceCwd: cwd, profile, startupDirectory });
  // Derive the source tag from the RESOLVED value (not a parallel branch tree)
  // so the log can never disagree with what was actually requested.
  const cwdSource =
    deadPaneRecovery ? 'dead-session'
    : respawnCwd === undefined ? 'none'
    : respawnCwd === profile?.startupCwd ? 'profile'
    : respawnCwd === cwd ? 'surface'
    : 'global';
  const requestedCwd = deadPaneRecovery?.spawnCwd ?? deadPaneRecovery?.cwd ?? respawnCwd;
  return {
    create: () => {
      console.log(`[Terminal] self-create PTY: shell=${shell}, cwd=${requestedCwd ?? '(home)'} source=${cwdSource} surfaceCwd=${cwd ?? '-'} cols=${cols}, rows=${rows}, ws=${workspaceId}, surface=${surfaceId ?? '-'}`);
      return invoke<SurfacePtyCreated>(() =>
        window.electronAPI.pty.create(withWorkspaceProfile(withDefaultShell({
          shell,
          ...(deadPaneRecovery
            ? { recoveryCwds: { spawnCwd: deadPaneRecovery.spawnCwd, cwd: deadPaneRecovery.cwd, wslTarget: deadPaneRecovery.wslTarget, args: deadPaneRecovery.args, sourceSessionId: deadPaneRecovery.sourceSessionId } }
            : { cwd: respawnCwd }),
          cols,
          rows,
          workspaceId,
          surfaceId,
          spawnKind: 'user-shell',
          // A tab that exists keeps its own worker fence switch over the profile's.
          ...(fenceSwitch !== undefined ? { workerFence: fenceSwitch } : {}),
        }, defaultShell), profile)),
      );
    },
    heal: (created) => {
      // Heal the surface's tracked cwd to what main actually spawned in, so a
      // contaminated-home surface.cwd is corrected the moment it respawns and a
      // later split seeds from the real dir (issue #515). The ptyId is bound
      // first, so this write lands on the now-bound surface.
      // Skip the heal when main landed somewhere OTHER than what we requested
      // (validateCwd dropped it → homedir fallback): engraving the fallback
      // would hide a broken/missing startup dir behind a healthy-looking cwd.
      const spawned = created.cwd;
      const shouldHeal = shouldHealSurfaceCwd({
        spawnedCwd: spawned,
        requestedCwd: respawnCwd,
        recoveryCwds: deadPaneRecovery,
      });
      if (spawned && shouldHeal) {
        useStore.getState().updateSurfaceCwd(created.id, spawned);
      } else if (spawned && (respawnCwd || deadPaneRecovery)) {
        console.warn(`[Terminal] requested cwd ${requestedCwd ?? '(recovery home fallback)'} but spawned in ${spawned} (requested dirs missing/invalid?) — keeping surface cwd untouched`);
      }
    },
  };
}

/** Bind a created pty to its surface the way the pane does (Pane.tsx onPtyCreated). */
function bindSurfacePty(surfaceId: string, ptyId: string): void {
  for (const ws of useStore.getState().workspaces) {
    const leaf = getWorkspaceLeafPanes(ws).find((l) => l.surfaces.some((s) => s.id === surfaceId));
    if (!leaf) continue;
    useStore.getState().updateSurfacePtyId(leaf.id, surfaceId, ptyId);
    useStore.getState().completeDeadPaneRecovery(surfaceId, ptyId);
    return;
  }
}

export type EnsureSurfacePtyResult = { ptyId: string } | { error: string } | { notRunning: true };

/**
 * `surface.ensurePty` by ptyId (#2398) — main asks this, after its access
 * check, for a daemon session it holds no writable pipe to: one a hidden pane
 * attached without promoting, or one whose pane is not mounted at all (its
 * workspace outside the multiview grid, or cold-parked) and whose session the
 * startup reconcile held suspended. Attach it, promoting a suspended session:
 * through the mounted pane's own reattach (so its replay lands once), else
 * directly. Main checks the pipe afterwards; this answers a refusal it saw.
 */
export async function ensurePtyStarted(ptyId: string, promote = true): Promise<EnsureSurfacePtyResult> {
  // `promote: false` — a stop key (ctrl+c, escape): attach a live session main
  // has no pipe to (a pane that never mounted keeps its daemon session
  // detached and running across an app restart), but never start one. The
  // daemon's answer tells them apart: a suspended session comes back
  // deferred, a dead one dead, and either has nothing running to stop.
  const mounted = await attachForWrite(ptyId, promote);
  if (mounted === 'not-running') return { notRunning: true };
  if (mounted === 'attached') return { ptyId };
  // A stop key is join-only: an exec or supervised unit whose background
  // start failed or never covered it is not spawned for the key (answered
  // deferred); one whose background start is in flight is joined, runs on
  // its own and takes the key.
  const res = await window.electronAPI.pty.reconnect(ptyId, promote ? { promote } : { promote, joinOnly: true });
  // Started by the attempt this reconnect joined (`promoted`: another
  // caller's promote, a raw write's say): nothing of the key's to stop, as
  // on the mounted path.
  // A join-only that joined a start which then failed (recoveryPending): the
  // unit is not running, as the mounted path answers it (awaitingRetry).
  if (!promote && (res.deferred === true || res.code === 'session-dead' || res.promoted === true || res.recoveryPending === true)) return { notRunning: true };
  if (!res.success) return { error: `the pane's session could not be attached: ${res.error ?? 'unknown error'}` };
  useStore.getState().setPtyDeferred(ptyId, false);
  return { ptyId };
}

/**
 * `surface.ensurePty` — start a deferred surface's shell for a raw terminal
 * write and answer its ptyId once bound (owner decision #2398 §6-6). A
 * surface that already has a pty answers it; one whose create is in flight
 * joins it. Only a terminal surface of the workspace's visible tree (not a
 * stashed pane) is started, and only inside `workspaceId` when one is given.
 * A refused create is answered as refused, never retried from here: the
 * pane's Retry is the one way to start it again.
 */
export async function ensureSurfacePty(surfaceId: string, workspaceId?: string): Promise<EnsureSurfacePtyResult> {
  const state = useStore.getState();
  const ws = state.workspaces.find((w) => (!workspaceId || w.id === workspaceId)
    && getLeafPanes(w.rootPane).some((l) => l.surfaces.some((s) => s.id === surfaceId)));
  const surface = ws && getLeafPanes(ws.rootPane).flatMap((l) => l.surfaces).find((s) => s.id === surfaceId);
  if (!ws || !surface) {
    return { error: `surface "${surfaceId}" not found${workspaceId ? ` in workspace "${workspaceId}"` : ''}` };
  }
  if (!isTerminalSurfaceType(surface.surfaceType)) return { error: `surface "${surfaceId}" has no local terminal` };
  // Bound already: main attaches it if it has no pipe (ensurePtyStarted).
  if (surface.ptyId) return { ptyId: surface.ptyId };
  const { create, heal } = surfaceCreate({
    workspaceId: ws.id,
    surfaceId,
    cwd: surface.cwd || undefined,
    pendingRecovery: surface.pendingRecovery,
  // An agent's write has no one to show a toast to: the refusal is its answer.
  }, createInvoke({ toastOnError: false }, () => undefined));
  const outcome: PtyEnsureOutcome = await ptyLifecycle.ensure<SurfacePtyCreated>(surfaceId, {
    create,
    bind: (created) => {
      if (!surfaceHoldsPty(surfaceId, '')) return false;
      bindSurfacePty(surfaceId, created.id);
      if (!surfaceHoldsPty(surfaceId, created.id)) return false;
      heal(created);
      return true;
    },
  });
  if (outcome.status === 'bound') return { ptyId: outcome.ptyId };
  // A Terminal that joined the attempt bound it through its own bind.
  const now = useStore.getState().workspaces.flatMap((w) => getWorkspaceLeafPanes(w))
    .flatMap((l) => l.surfaces).find((s) => s.id === surfaceId);
  if (now?.ptyId) return { ptyId: now.ptyId };
  if (outcome.status === 'createFailed') return { error: `the terminal could not start: ${outcome.error}` };
  return { error: `surface "${surfaceId}" closed before its terminal started` };
}
