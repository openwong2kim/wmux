// The guard tests scripts/verify.sh runs on every change (see
// scripts/verify-guards.txt for what a guard is and why it is listed).
//
// The list is read twice: from the change's merge base (`git show
// <base>:scripts/verify-guards.txt`) and from the working tree, and the two
// are joined. The base copy is what makes the list hold: a change that drops
// a line from the working tree copy still runs that guard, the same way the
// task gate runs the base's verify.sh and never the worker's. A line only the
// working tree has still runs, since adding a guard can only make the gate
// stricter.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const GUARD_LIST = 'scripts/verify-guards.txt';

/** The paths in a guard list: one per line, `#` comments and blank lines
 *  dropped, `\` written as `/`. */
export function parseGuardList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim().replace(/\\/g, '/'))
    .filter((line) => line !== '');
}

/** The list as committed at `base`; '' when that commit has none (e.g.
 *  before the list existed). A `base` git cannot read throws: running the
 *  tree's list alone would let a change drop a guard unnoticed. */
function listAtBase(root, base) {
  if (!base) return '';
  const opts = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], opts);
  } catch {
    throw new Error(`verify-guards: cannot read base commit ${base}`);
  }
  try {
    execFileSync('git', ['cat-file', '-e', `${base}:${GUARD_LIST}`], opts);
  } catch {
    return '';
  }
  return execFileSync('git', ['show', `${base}:${GUARD_LIST}`], opts);
}

function listInTree(root) {
  try {
    return fs.readFileSync(path.join(root, GUARD_LIST), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return '';
    throw err;
  }
}

/** `fs.statSync`, or undefined when nothing is there: a missing entry, or one
 *  under a path that is a file (ENOTDIR). Any other error (EACCES) throws,
 *  since the entry may exist but cannot be checked. */
function statIfPresent(full) {
  try {
    return fs.statSync(full);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return undefined;
    throw err;
  }
}

/**
 * The guards to run in `root`: the base's list, then the lines only the
 * working tree's list has, each once. `run` holds the files that exist in
 * the tree, `missing` the listed paths that do not (or that point outside
 * the repository), for the caller to name.
 */
export function guardTests({ root, base }) {
  const seen = new Set();
  const run = [];
  const missing = [];
  for (const entry of [...parseGuardList(listAtBase(root, base)), ...parseGuardList(listInTree(root))]) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    const full = path.resolve(root, entry);
    const rel = path.relative(root, full);
    const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (inside && statIfPresent(full)?.isFile()) run.push(entry);
    else missing.push(entry);
  }
  return { run, missing };
}
