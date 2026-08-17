/**
 * Task 1 — shared terminal-surface creation helper.
 *
 * Extracted from `useKeyboard.ts` (the Ctrl+T "new surface" path) so the
 * PTY-create → addSurface flow can be unit-tested without mounting
 * `useKeyboard`, `Pane`, or Electron. All side-effecting collaborators are
 * injected through `CreateTerminalSurfaceDeps` (mirrors the same wiring the
 * keyboard handler already had: `ipcInvoke` wrapper + `addSurface` action),
 * keeping the helper a pure function of its inputs.
 *
 * Behavior contract (must stay byte-identical to the keyboard path):
 *   1. Return early when `paneGate !== 'ready'` (the startup reconcile gate;
 *      matches every other surface-create path — see useKeyboard S-A note).
 *   2. Return early when the requested `workspaceId` is absent.
 *   3. Resolve the starting cwd (profile.startupCwd > global startupDirectory).
 *   4. Wrap `ptyCreate` in `ipcInvoke` so a rejected promise (notably the
 *      MAX_SESSIONS / RESOURCE_EXHAUSTED cap) surfaces the existing toast
 *      instead of being silently dropped.
 *   5. On success, adopt the cwd main actually spawned in (so the surface
 *      tracks its real dir from the start) and add the surface for the
 *      REQUESTED pane — nothing happens on failure.
 */
import {
  resolveStartupCwd,
  withDefaultShell,
  withWorkspaceProfile,
  type PtyCreateOptions,
} from './ptyCreateOptions';
import { type IpcResult } from '../hooks/useIpc';
import { type WorkspaceProfile } from '../../shared/types';

export interface CreateTerminalSurfaceDeps {
  workspaceId: string;
  paneId: string;
  paneGate: 'pending' | 'ready';
  workspaces: Array<{ id: string; profile?: WorkspaceProfile }>;
  startupDirectory: string;
  defaultShell: string;
  ipcInvoke: <T>(call: () => Promise<T>) => Promise<IpcResult<T>>;
  ptyCreate: (options: PtyCreateOptions) => Promise<{ id: string; cwd?: string }>;
  addSurface: (paneId: string, ptyId: string, shell: string, cwd: string, workspaceId?: string) => void;
}

/**
 * Create one terminal surface in the requested pane of the requested
 * workspace. Returns a Promise that resolves once the IPC wrap settles (used
 * only for sequencing in callers; the function ignores the resolve value).
 */
export async function createTerminalSurface(deps: CreateTerminalSurfaceDeps): Promise<void> {
  // 1 — startup gate.
  if (deps.paneGate !== 'ready') return;

  // 2 — requested workspace must exist.
  const workspace = deps.workspaces.find((w) => w.id === deps.workspaceId);
  if (!workspace) return;

  // 3 — resolve starting cwd (profile > global fallback).
  const cwd = resolveStartupCwd({
    splitInheritsCwd: false,
    profile: workspace.profile,
    startupDirectory: deps.startupDirectory,
  });

  // 4 — build options through the same profile/shell overlays as the
  // keyboard handler, then run through the IPC wrapper.
  const base: PtyCreateOptions = {
    workspaceId: workspace.id,
    cwd,
    spawnKind: 'user-shell',
  };
  const options = withWorkspaceProfile(withDefaultShell(base, deps.defaultShell), workspace.profile);

  const result = await deps.ipcInvoke(() => deps.ptyCreate(options));

  // 5 — on success adopt the real spawned cwd; nothing to do on failure
  // (ipcInvoke already surfaced the toast).
  if (result.ok) {
    deps.addSurface(deps.paneId, result.data.id, 'Terminal', result.data.cwd || '', workspace.id);
  }
}
