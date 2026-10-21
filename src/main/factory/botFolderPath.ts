// ─── Bot folder paths — where a bot may write ──────────────────────────────
//
// A bot that runs commands writes only inside its own folder (the session's
// cwd, `<wmuxDir>/factory/bots/<botId>`), never the repository it reads.
// Main checks every Write, Edit and output redirection before it runs:
//   - the path names no `..` segment;
//   - the path resolves (relative to the folder) lexically inside it;
//   - its nearest existing parent, symlinks followed, is inside the folder's
//     own real path;
//   - an existing final component is a regular file, not a symlink;
//   - no segment below the folder is a protected name (botRepoRead's list
//     plus files that configure tools or run code: `.githooks`, `.husky`,
//     `.claude`, `.vscode`, `.envrc`, `.github/workflows`, `package.json`,
//     `Makefile`).
// The OS sandbox's write grant (botExecSandbox.ts) is the backstop for
// commands; this check is the gate for the file tools, and for the operands
// of the file utilities the command reviewer judges (botCommandReviewer.ts),
// where an existing folder, the bot folder itself included, may be named
// (`directory`).

import fs from 'node:fs';
import path from 'node:path';
import { protectedPatternOf } from './botRepoRead';

/** Names protected in a bot's folder on top of BOT_REPO_SECRET_PATTERNS. */
export const BOT_FOLDER_PROTECTED_NAMES: readonly string[] = [
  '.githooks',
  '.husky',
  '.claude',
  '.vscode',
  '.envrc',
  'package.json',
  'Makefile',
  'GNUmakefile',
];

export interface BotFolderDeps {
  realpath: (p: string) => string;
  /** lstat, or null when nothing is there. */
  lstat: (p: string) => fs.Stats | null;
}

const defaultDeps: BotFolderDeps = {
  realpath: (p) => fs.realpathSync.native(p),
  lstat: (p) => {
    try {
      return fs.lstatSync(p);
    } catch {
      return null;
    }
  },
};

function inside(root: string, target: string): string | null {
  const rel = path.relative(root, target);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel;
}

/** The protected name a path below the folder hits, or null. */
export function botFolderProtectedName(rel: string): string | null {
  const segments = rel.split(/[\\/]+/).filter((s) => s && s !== '.');
  const repo = protectedPatternOf(rel);
  if (repo) return repo;
  for (let k = 0; k < segments.length; k++) {
    const s = segments[k].toLowerCase();
    const hit = BOT_FOLDER_PROTECTED_NAMES.find((p) => p.toLowerCase() === s);
    if (hit) return hit;
    if (s === '.github' && segments[k + 1]?.toLowerCase() === 'workflows') return '.github/workflows';
  }
  return null;
}

export type BotFolderCheck = { ok: true; real: string } | { ok: false; reason: string };

/**
 * Whether `requested` (absolute, or relative to `botDir`) may be written by
 * the bot. Allowed paths come back as the real path to write (the nearest
 * existing parent resolved, the rest appended). Fails closed: an unreadable
 * folder or an unexpected error is a refusal. With `directory`, an existing
 * folder (never a symlink) passes too.
 */
export function checkBotFolderPath(requested: unknown, botDir: string, deps: BotFolderDeps = defaultDeps, opts: { directory?: boolean } = {}): BotFolderCheck {
  if (typeof requested !== 'string' || requested.length === 0) return { ok: false, reason: 'a file path is required' };
  if (requested.includes('\0')) return { ok: false, reason: 'the path is malformed' };
  // `..` is refused outright: resolved by text it would skip a symlink the
  // shell or the file tool follows (`link/../x` lands beside the link's target).
  if (requested.split(/[\\/]+/).includes('..')) return { ok: false, reason: 'a path with ".." is not used; name it from the bot folder' };
  let realDir: string;
  try {
    realDir = deps.realpath(botDir);
  } catch {
    return { ok: false, reason: 'the bot folder is not readable' };
  }
  const lexical = path.resolve(botDir, requested);
  const rel = inside(botDir, lexical) ?? inside(realDir, lexical);
  if (rel === null || (rel === '' && !opts.directory)) return { ok: false, reason: 'it is outside the bot folder' };
  const hit = botFolderProtectedName(rel);
  if (hit) return { ok: false, reason: `it is a protected file (${hit})` };
  // The nearest existing parent, with symlinks followed, stays inside.
  const missing: string[] = [];
  let cursor = lexical;
  for (;;) {
    if (deps.lstat(cursor)) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) return { ok: false, reason: 'no part of the path exists' };
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  let realParent: string;
  try {
    realParent = deps.realpath(cursor);
  } catch {
    return { ok: false, reason: 'the path could not be resolved' };
  }
  const real = missing.length > 0 ? path.join(realParent, ...missing) : realParent;
  const realRel = inside(realDir, real);
  if (realRel === null || (realRel === '' && !opts.directory)) return { ok: false, reason: 'it resolves outside the bot folder' };
  const realHit = botFolderProtectedName(realRel);
  if (realHit) return { ok: false, reason: `it is a protected file (${realHit})` };
  if (missing.length === 0) {
    // The final component exists: a regular file, never a link to elsewhere.
    const st = deps.lstat(lexical);
    if (!st) return { ok: false, reason: 'the path could not be resolved' };
    if (st.isSymbolicLink()) return { ok: false, reason: 'it is a symbolic link' };
    if (!st.isFile() && !(opts.directory && st.isDirectory())) return { ok: false, reason: 'it is not a regular file' };
  }
  return { ok: true, real };
}
