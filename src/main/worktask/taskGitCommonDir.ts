// ─── The git dirs main runs task_push and task_fetch on ────────────────────
//
// Main's record, never the worktree: the common git dir and the worktree git
// dir FanOutService wrote on the task's ledger row at dispatch
// (LedgerDispatch.gitCommonDir / gitWorktreeDir). A bot's task from before
// those fields existed derives them from the repository folder of the bot's
// profile and a scan of the common dir's `worktrees/` (worker-writable, so
// legacy-only and matched strictly). Any other task without the record has
// none.

import fs from 'node:fs';
import path from 'node:path';
import type { LedgerDispatch } from '../../shared/ledger';
import { taskGitEnv } from '../../shared/taskGitRelay';
import { defaultGit, readWorkerFile, type TaskPushGit } from './taskPush';

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** The task's recorded common git dir, or null. Never throws. */
export async function recordedTaskGitCommonDir(
  dispatch: LedgerDispatch | undefined,
  botRepoPath: (botId: string) => string | undefined,
  git: TaskPushGit = defaultGit,
): Promise<string | null> {
  if (dispatch?.gitCommonDir) return dispatch.gitCommonDir;
  const botId = dispatch?.origin.kind === 'bot' ? dispatch.origin.botId : undefined;
  const repoPath = botId ? botRepoPath(botId) : undefined;
  if (!repoPath || !path.isAbsolute(repoPath)) return null;
  const r = await git(['rev-parse', '--git-common-dir'], repoPath, taskGitEnv());
  const out = r.code === 0 ? r.stdout.trim() : '';
  if (!out) return null;
  return realOrNull(path.resolve(repoPath, out));
}

/**
 * The task worktree's own git dir (`<common>/worktrees/<id>`), for reading
 * HEAD on a push. The recorded value when there is one; otherwise, for a
 * legacy row, the single `<common>/worktrees/*` whose `gitdir` file points at
 * the recorded worktree. Returns null (fail closed) when none, or more than
 * one, matches. Never throws.
 */
export async function recordedTaskGitWorktreeDir(
  dispatch: LedgerDispatch | undefined,
  commonDir: string,
  worktreePath: string,
): Promise<string | null> {
  if (dispatch?.gitWorktreeDir) return dispatch.gitWorktreeDir;
  // Legacy: scan the common dir's worktree gitdirs for the one whose `gitdir`
  // file names this worktree's `.git`.
  const wantReal = realOrNull(worktreePath);
  if (!wantReal) return null;
  const want = path.join(wantReal, '.git');
  let names: string[];
  try {
    names = fs.readdirSync(path.join(commonDir, 'worktrees'));
  } catch {
    return null;
  }
  const matches: string[] = [];
  for (const name of names) {
    const dir = path.join(commonDir, 'worktrees', name);
    const pointer = (await readWorkerFile(path.join(dir, 'gitdir')))?.trim();
    if (!pointer) continue;
    const pointerReal = realOrNull(pointer);
    if (pointerReal && pointerReal === want) matches.push(dir);
  }
  return matches.length === 1 ? matches[0] : null;
}
