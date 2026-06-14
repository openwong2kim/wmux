/** Single-letter status badge, VS-Code style. */
export type GitStatusCode = 'M' | 'A' | 'D' | 'U' | 'R';

export interface GitFileStatus {
  /** Repo-relative path (the new name for renames). */
  path: string;
  code: GitStatusCode;
}

/** Map a porcelain v1 XY pair to one display code. Staged (X) wins; '?'->U. */
function toCode(x: string, y: string): GitStatusCode | null {
  const pick = (c: string): GitStatusCode | null => {
    if (c === 'M') return 'M';
    if (c === 'A') return 'A';
    if (c === 'D') return 'D';
    if (c === 'R') return 'R';
    if (c === '?') return 'U';
    return null;
  };
  return pick(x) ?? pick(y);
}

/**
 * Parse `git status --porcelain` (v1) output into per-file display codes.
 * Format: two status chars, a space, then the path. Renames are
 * `R  old -> new`; we keep the new name. Lines we can't classify are dropped.
 */
export function parsePorcelain(output: string): GitFileStatus[] {
  const result: GitFileStatus[] = [];
  for (const line of output.split('\n')) {
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    const code = toCode(x, y);
    if (!code) continue;
    let path = line.slice(3).trim();
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4).trim();
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (path) result.push({ path, code });
  }
  return result;
}
