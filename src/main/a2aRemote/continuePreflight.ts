// ─── Continue on another PC: what this PC checks before it asks ─────────────
//
// A conversation continues on another PC only from a checkout that PC can
// rebuild from origin alone: on a branch that tracks the same branch on
// origin, nothing changed or untracked, and no commit origin lacks (as of
// the last fetch or push: nothing here goes to the network). The answer is
// what the request names (A2aContinueRequestV1.repo).
//
// Read-only git with the worker hardening (spawnWorktree.ts gitRunner):
// fsmonitor and hooks off, no optional locks (the index is not refreshed under
// the agent still running there), the repository's config read first and
// refused when it sets a content filter (a status read would run it), and
// origin taken from the repository's own config, keyed by originUrlRepoKey.
// A repository with submodules is refused: status would read their own
// config, which nothing checked, and the other PC does not check them out.
// So is one with entries status does not look at (assume-unchanged,
// skip-worktree): a change to them would not show, and the other PC would not
// have it. The index is read at the top level, whatever the folder.
//
// The sender runs it twice: before it asks, and again once its agent has
// stopped, to send the manifest only when nothing moved in between.

import fs from 'node:fs';
import path from 'node:path';
import { isContinueBranch, isContinueCommit, isContinueRepoKey, normalizeContinueRel, type A2aContinueRequestV1 } from '../../shared/a2aContinue';
import { normalizeSpawnSub } from '../../shared/a2aSpawn';
import { originUrlFromConfigList, originUrlRepoKey, parseGitConfigList, workerGitConfigRefusal } from '../worktask/workerGit';
import { gitRunner, type Git, type SpawnWorktreeOptions } from './spawnWorktree';

export type ContinuePreflightCode =
  | 'not-a-repo'
  | 'folder-unsupported'
  | 'unsafe-config'
  | 'no-origin'
  | 'origin-unsupported'
  | 'submodules'
  | 'hidden-changes'
  | 'detached'
  | 'no-commit'
  | 'branch-unsupported'
  | 'no-upstream'
  | 'upstream-mismatch'
  | 'unpushed'
  | 'dirty'
  | 'failed';

export type ContinuePreflightResult =
  | { ok: true; repo: A2aContinueRequestV1['repo'] }
  | { ok: false; code: ContinuePreflightCode };

/** The repository at `cwd`, the folder a conversation runs in, as a request names it, or why it cannot continue elsewhere. */
export async function continuePreflight(cwd: string, opts: SpawnWorktreeOptions & { git?: Git } = {}): Promise<ContinuePreflightResult> {
  const run = opts.git ?? gitRunner(cwd, opts);
  const top = await run(['rev-parse', '--show-toplevel']);
  const topDir = top.stdout.trim();
  if (top.code !== 0 || !topDir) return { ok: false, code: 'not-a-repo' };
  let sub: string | null;
  try {
    const rel = path.relative(fs.realpathSync.native(topDir), fs.realpathSync.native(cwd));
    sub = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? null : normalizeSpawnSub(rel.split(path.sep).join('/'));
  } catch {
    sub = null;
  }
  if (sub === null) return { ok: false, code: 'not-a-repo' };
  // The request names it, and the other PC refuses a folder it cannot hold (parseContinueRequest).
  if (sub && normalizeContinueRel(sub) === null) return { ok: false, code: 'folder-unsupported' };

  const config = await run(['config', '-z', '--list', '--show-scope']);
  if (config.code !== 0) return { ok: false, code: 'failed' };
  if (workerGitConfigRefusal(parseGitConfigList(config.stdout), 'read')) return { ok: false, code: 'unsafe-config' };
  const url = originUrlFromConfigList(config.stdout);
  if (!url) return { ok: false, code: 'no-origin' };
  const origin = originUrlRepoKey(url);
  if (!origin || !isContinueRepoKey(origin)) return { ok: false, code: 'origin-unsupported' };

  const branchOut = await run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branchOut.code !== 0) return { ok: false, code: 'detached' };
  const branch = branchOut.stdout.trim();
  if (!isContinueBranch(branch)) return { ok: false, code: 'branch-unsupported' };
  const headOut = await run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (headOut.code !== 0) return { ok: false, code: 'no-commit' };
  const head = headOut.stdout.trim();
  if (!isContinueCommit(head)) return { ok: false, code: 'failed' };

  const upstream = await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (upstream.code !== 0) return { ok: false, code: 'no-upstream' };
  if (upstream.stdout.trim() !== `origin/${branch}`) return { ok: false, code: 'upstream-mismatch' };
  const ahead = await run(['rev-list', '--count', '@{upstream}..HEAD']);
  if (ahead.code !== 0) return { ok: false, code: 'failed' };
  if (ahead.stdout.trim() !== '0') return { ok: false, code: 'unpushed' };

  // A gitlink (mode 160000) in the index is a submodule; the index is read, not refreshed.
  const staged = await run(['ls-files', '--stage', '-z'], [], topDir);
  if (staged.code !== 0) return { ok: false, code: 'failed' };
  if (staged.stdout.split('\0').some((entry) => entry.startsWith('160000 '))) return { ok: false, code: 'submodules' };
  // `-v` tags a skip-worktree entry `S`, and an assume-unchanged one in lower case.
  const tagged = await run(['ls-files', '-v', '-z'], [], topDir);
  if (tagged.code !== 0) return { ok: false, code: 'failed' };
  if (tagged.stdout.split('\0').some((entry) => /^[a-zS] /.test(entry))) return { ok: false, code: 'hidden-changes' };
  const status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], ['--no-optional-locks']);
  if (status.code !== 0) return { ok: false, code: 'failed' };
  if (status.stdout !== '') return { ok: false, code: 'dirty' };

  return { ok: true, repo: { origin, branch, head, ...(sub ? { sub } : {}) } };
}
