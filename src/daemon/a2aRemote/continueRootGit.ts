import fs from 'node:fs';
import path from 'node:path';
import type { Git } from '../../main/a2aRemote/spawnWorktree';
import { originUrlFromConfigList, originUrlRepoKey } from '../../main/worktask/workerGit';
import { samePath } from './spawnPolicyStore';
import { notThere, realpathNative } from './spawnChecks';

/**
 * The receiver's two reads of a spawn root, for continuing a conversation
 * from another PC. Each tells what the root IS apart from what could not be
 * read now: the first is an answer (no origin, not the top level), the
 * second throws, so the request waits and is checked again rather than
 * being refused for good on a git that timed out or failed to start.
 */

/** git's own words for a folder that is not, or no longer, a repository (or is gone). */
const NOT_A_REPO = /not a git repository|cannot change to/i;

/**
 * Whether a failed git means the root itself is gone (or no folder): git
 * then fails to start in it (spawn ENOENT), which is an answer, not a read
 * that failed. A git that fails in a folder that is there still throws.
 */
async function rootGone(rootPath: string): Promise<boolean> {
  try {
    return !(await fs.promises.stat(rootPath)).isDirectory();
  } catch (err) {
    if (notThere(err)) return true;
    throw err;
  }
}

/**
 * The origin of the repository at `rootPath`, read through its common git
 * dir and keyed as the asker keys its own (originUrlRepoKey); null when it
 * has none or one that key cannot name, or the folder is no repository.
 */
export async function rootOriginKey(git: Git, rootPath: string): Promise<string | null> {
  const common = await git(['rev-parse', '--git-common-dir'], [], rootPath);
  if (common.code !== 0) {
    if (NOT_A_REPO.test(common.stderr) || (await rootGone(rootPath))) return null;
    throw new Error(`git rev-parse --git-common-dir failed: ${common.stderr.trim().slice(0, 300)}`);
  }
  const dir = common.stdout.trim();
  if (!dir) throw new Error('git rev-parse --git-common-dir printed nothing');
  const list = await git([`--git-dir=${path.resolve(rootPath, dir)}`, 'config', '-z', '--list', '--show-scope'], [], rootPath);
  if (list.code !== 0) throw new Error(`git config --list failed: ${list.stderr.trim().slice(0, 300)}`);
  const url = originUrlFromConfigList(list.stdout);
  return url ? originUrlRepoKey(url) : null;
}

/** Whether `rootPath` is still its repository's top level, not a folder inside another one. */
export async function rootIsRepoTop(git: Git, rootPath: string): Promise<boolean> {
  const out = await git(['rev-parse', '--show-toplevel'], [], rootPath);
  if (out.code !== 0) {
    if (NOT_A_REPO.test(out.stderr) || (await rootGone(rootPath))) return false;
    throw new Error(`git rev-parse --show-toplevel failed: ${out.stderr.trim().slice(0, 300)}`);
  }
  const top = out.stdout.trim();
  if (!top) return false;
  try {
    return samePath(await realpathNative(top), rootPath);
  } catch (err) {
    if (notThere(err)) return false;
    throw err;
  }
}
