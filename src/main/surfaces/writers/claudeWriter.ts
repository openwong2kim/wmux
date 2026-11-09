import type {
  SurfaceApplyResult,
  SurfaceFileEdit,
  SurfacePreview,
} from '../../../shared/tokenUsage/surfaceTypes';
import {
  applyConfigEdit,
  ConfigChangedError,
  rollbackWrittenFiles,
  SurfacesStore,
  snapshotFile,
  type FileSnapshot,
  type JsonEdit,
  type WrittenFile,
} from '../safeWrite';
import type { ResolvedChange, SurfaceWriter, WriterContext, WriterDeps } from './types';
import { buildClaudeJsonEdits, getClaudeJsonPath } from './claude/claudeJsonTarget';
import { buildSettingsEdits, resolveSettingsPath } from './claude/settingsTarget';
import { isPathAllowed } from './claude/pathSecurity';
import { ClaudeConfigLockedError, withClaudeConfigLock } from '../../../shared/claudeConfigLock';

/** Settings changes grouped by the settings file they land in. Project MCP server disables only target ~/.claude.json. */
function settingsChangesByPath(changes: ResolvedChange[], deps: WriterDeps): Map<string, ResolvedChange[]> {
  const byPath = new Map<string, ResolvedChange[]>();
  for (const c of changes) {
    if (c.item.kind === 'mcp-server' && c.item.source === 'project' && !c.enabled) {
      continue;
    }
    const targetPath = resolveSettingsPath(c.item, deps);
    byPath.set(targetPath, [...(byPath.get(targetPath) ?? []), c]);
  }
  return byPath;
}

/** The files written so far in one apply, and the backups taken. */
interface ApplyRun {
  deps: WriterDeps;
  backups: string[];
  writtenFiles: WrittenFile[];
}

function writeJsonEdits(run: ApplyRun, filePath: string, edits: JsonEdit[], snapshot: FileSnapshot): void {
  if (edits.length === 0) return;
  const res = applyConfigEdit({
    path: filePath,
    kind: 'json',
    edits,
    backup: true,
    snapshot,
    now: run.deps.now(),
  });
  if (res.backupPath) run.backups.push(res.backupPath);
  if (res.changed) {
    run.writtenFiles.push({
      path: filePath,
      backupPath: res.backupPath,
      preExisted: snapshot.exists,
      postSnapshot: snapshotFile(filePath),
    });
  }
}

/** Writes ~/.claude.json; returns the ids it applied. */
function applyClaudeJson(run: ApplyRun, changes: ResolvedChange[]): string[] {
  const claudeJsonPath = getClaudeJsonPath(run.deps);
  if (!isPathAllowed(claudeJsonPath, run.deps)) return [];
  const planned = buildClaudeJsonEdits(run.deps, changes, snapshotFile(claudeJsonPath).text);
  // Most applies have nothing for this file, and those must not wait on its lock.
  if (planned.edits.length === 0) return planned.affectedItemIds;
  // Claude Code saves this file under a lock of its own; a held lock throws, and apply reports it.
  return withClaudeConfigLock(claudeJsonPath, () => {
    const snapshot = snapshotFile(claudeJsonPath);
    const result = buildClaudeJsonEdits(run.deps, changes, snapshot.text);
    writeJsonEdits(run, claudeJsonPath, result.edits, snapshot);
    return result.affectedItemIds;
  });
}

/** Puts back what this apply wrote. Restoring ~/.claude.json is a write to it too, so it takes the same lock. */
function rollbackRun(run: ApplyRun): boolean {
  const claudeJsonPath = getClaudeJsonPath(run.deps);
  const undo = (): boolean => rollbackWrittenFiles(run.writtenFiles);
  if (!run.writtenFiles.some((f) => f.path === claudeJsonPath)) return undo();
  try {
    return withClaudeConfigLock(claudeJsonPath, undo);
  } catch {
    return false;
  }
}

/** Writes each settings file; returns the ids applied and the restored hooks to take out of the store. */
function applySettingsFiles(
  run: ApplyRun,
  changes: ResolvedChange[],
  store: SurfacesStore,
): { appliedIds: string[]; restoredHookIds: string[] } {
  const appliedIds: string[] = [];
  const restoredHookIds: string[] = [];
  for (const [targetPath, pathChanges] of settingsChangesByPath(changes, run.deps).entries()) {
    if (!isPathAllowed(targetPath, run.deps)) {
      continue;
    }
    const snapshot = snapshotFile(targetPath);
    const sResult = buildSettingsEdits(targetPath, run.deps, pathChanges, true, store, snapshot.text);
    writeJsonEdits(run, targetPath, sResult.edits, snapshot);
    appliedIds.push(...sResult.affectedItemIds);
    for (const c of pathChanges) {
      if (c.item.kind === 'hook' && c.enabled && sResult.affectedItemIds.includes(c.item.id)) {
        restoredHookIds.push(c.item.id);
      }
    }
  }
  return { appliedIds, restoredHookIds };
}

/** After every file write succeeded: restored hooks leave the store, and the wanted state is recorded. */
function recordOutcome(
  store: SurfacesStore,
  changes: ResolvedChange[],
  appliedItemIds: string[],
  restoredHookIds: string[],
): void {
  for (const id of new Set(restoredHookIds)) {
    store.removedHooks.take('claude', id);
  }
  try {
    store.save();
  } catch {
    // If the store save fails after a successful write, still report the hook as applied
  }
  try {
    for (const itemId of appliedItemIds) {
      const c = changes.find((x) => x.item.id === itemId);
      if (c) {
        store.recordIntent('claude', itemId, c.enabled);
      }
    }
    store.save();
  } catch {
    // Store failure must not fail apply
  }
}

/** The message shown for a failed apply; internal error text is never shown, except a hook the user must edit by hand. */
function applyErrorMessage(err: unknown, rollbackFailed: boolean): string {
  if (rollbackFailed) return 'Some files may have changed; check your Claude settings.';
  if (err instanceof Error && err.message.includes('definition not found in store')) {
    return 'Cannot enable hook: definition not found in store';
  }
  if (err instanceof Error && err.message.startsWith('More than one hook matches')) return err.message;
  if (err instanceof ConfigChangedError) return 'The configuration changed while editing; reload and try again.';
  if (err instanceof ClaudeConfigLockedError) return 'Claude Code is saving its config; nothing was changed. Try again in a moment.';
  return 'Applying the change failed; no file was left half-written.';
}

export function createClaudeWriter(): SurfaceWriter {
  return {
    provider: 'claude',

    async preview(ctx: WriterContext): Promise<Omit<SurfacePreview, 'rejected'>> {
      const { deps, changes } = ctx;
      const edits: SurfaceFileEdit[] = [];

      // 1. ~/.claude.json edits
      const claudeJsonPath = getClaudeJsonPath(deps);
      if (isPathAllowed(claudeJsonPath, deps)) {
        const cjResult = buildClaudeJsonEdits(deps, changes);
        edits.push(...cjResult.fileEdits);
      }

      // 2. Settings files edits grouped by target path
      for (const [targetPath, pathChanges] of settingsChangesByPath(changes, deps).entries()) {
        if (!isPathAllowed(targetPath, deps)) {
          continue;
        }
        const sResult = buildSettingsEdits(targetPath, deps, pathChanges, false);
        edits.push(...sResult.fileEdits);
      }

      return {
        provider: 'claude',
        edits,
        requiresNewSession: true,
      };
    },

    async apply(ctx: WriterContext): Promise<SurfaceApplyResult> {
      const { deps, changes } = ctx;
      const store = new SurfacesStore(deps.surfacesStorePath);
      store.load();
      const run: ApplyRun = { deps, backups: [], writtenFiles: [] };

      try {
        const claudeJsonIds = applyClaudeJson(run, changes);
        const settings = applySettingsFiles(run, changes, store);
        const appliedItemIds = [...new Set([...claudeJsonIds, ...settings.appliedIds])];
        recordOutcome(store, changes, appliedItemIds, settings.restoredHookIds);

        const unapplied = changes.some((c) => !appliedItemIds.includes(c.item.id));
        return {
          provider: 'claude',
          ok: !unapplied,
          appliedItemIds,
          backups: run.backups,
          error: unapplied ? 'Some changes could not be applied.' : null,
        };
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('Project directory is required')) {
          throw new Error('Project directory is required to toggle project MCP server');
        }
        // Roll back any files that were written in this apply call
        const rollbackFailed = !rollbackRun(run);
        return {
          provider: 'claude',
          ok: false,
          appliedItemIds: [],
          backups: run.backups,
          error: applyErrorMessage(err, rollbackFailed),
        };
      }
    },
  };
}
