// ─── Claude Code's folder for a working directory ───────────────────────────
//
// Claude Code keeps a conversation at `<config dir>/projects/<folder>/<id>.jsonl`,
// <folder> named after the working directory it runs in. A conversation moved
// to another PC goes under the folder Claude Code looks in there, so the name
// is computed exactly as Claude Code computes it (read from 2.1.312): every
// character that is not an ASCII letter or digit becomes '-', one per UTF-16
// code unit, and a name longer than 200 characters is cut to 200 and followed
// by '-' and a hash of the whole path.
//
// Pure module: no node:* imports.

/** Longest folder name Claude Code uses as it is. */
export const CLAUDE_PROJECT_FOLDER_MAX = 200;

/** Claude Code's path hash: h = 31 × h + code unit, as a 32-bit integer. */
function pathHash(cwd: string): number {
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  return h;
}

/**
 * The `projects/` folder name for the working directory `cwd`, taken exactly
 * as the process sees it: the separators and a drive letter's case change it.
 */
export function claudeProjectFolder(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= CLAUDE_PROJECT_FOLDER_MAX) return name;
  return `${name.slice(0, CLAUDE_PROJECT_FOLDER_MAX)}-${Math.abs(pathHash(cwd)).toString(36)}`;
}
