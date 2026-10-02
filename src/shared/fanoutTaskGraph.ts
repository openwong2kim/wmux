// ─── Fan-out task graph: per-task write scopes + dependencies ───────────────
//
// Two optional per-task fields, both index-aligned with the fan-out's titles:
//
//   files[k]     — the globs task k alone may edit. Two tasks of one fan-out
//                  may not claim overlapping scopes; that is refused before
//                  anything spawns, since the point of a scope is that no
//                  other worker of the batch writes there.
//   dependsOn[k] — indices of tasks in the same fan-out that must be done
//                  before task k's worktree is created and its agent launched.
//
// Pure and shared: the pipe handler validates before it claims the key, and
// FanOutService validates again because the IPC path can send anything.

import { FANOUT_MAX_TASKS } from './workTask';

/** Bounds on a scope list — a scope is a short claim, not a file manifest. */
export const FANOUT_SCOPE_MAX_ENTRIES = 32;
export const FANOUT_SCOPE_ENTRY_MAX_CHARS = 256;

const GLOB_CHARS = /[*?[\]{}]/;

/** Normalize one scope entry to a repo-relative, `/`-separated pattern.
 *  `.` (or `./`, `**`) means the whole repository. */
export function normalizeScopeEntry(raw: string): { scope: string } | { error: string } {
  const s = raw.trim().replace(/\\/g, '/');
  if (s.length === 0) return { error: 'a scope entry is empty' };
  if (s.length > FANOUT_SCOPE_ENTRY_MAX_CHARS) {
    return { error: `a scope entry exceeds ${FANOUT_SCOPE_ENTRY_MAX_CHARS} characters` };
  }
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) {
    return { error: `scope "${raw}" is absolute — use a path relative to the repository root` };
  }
  const parts = s.split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.includes('..')) return { error: `scope "${raw}" leaves the repository ('..')` };
  return { scope: parts.length === 0 ? '.' : parts.join('/') };
}

/** The directory segments before the first segment holding a wildcard. A
 *  literal path is all of its segments (a directory owns its descendants). */
function fixedPrefix(scope: string): string[] {
  if (scope === '.') return [];
  const out: string[] = [];
  for (const seg of scope.split('/')) {
    if (GLOB_CHARS.test(seg)) break;
    out.push(seg);
  }
  return out;
}

function isPrefix(a: string[], b: string[]): boolean {
  return a.length <= b.length && a.every((seg, i) => seg === b[i]);
}

/**
 * Conservative overlap test: two scopes overlap when one fixed prefix is equal
 * to or an ancestor of the other. Real glob intersection is not decided —
 * `src/*.ts` and `src/*.md` count as overlapping — so a false "overlap" is
 * possible and a missed one is not.
 */
export function scopesOverlap(a: string, b: string): boolean {
  const pa = fixedPrefix(a);
  const pb = fixedPrefix(b);
  return isPrefix(pa, pb) || isPrefix(pb, pa);
}

export interface FanoutTaskGraph {
  /** Normalized scopes per task ([] = no scope declared). */
  files: string[][];
  /** Deduplicated dependency indices per task ([] = none). */
  dependsOn: number[][];
}

/**
 * Validate both fields against a task count. Absent fields validate as empty.
 * Errors name the task by its 0-based index — the same index the caller used.
 */
export function validateFanoutTaskGraph(
  rawFiles: unknown,
  rawDependsOn: unknown,
  taskCount: number,
): FanoutTaskGraph | { error: string } {
  const files: string[][] = Array.from({ length: taskCount }, () => []);
  const dependsOn: number[][] = Array.from({ length: taskCount }, () => []);

  if (rawFiles !== undefined) {
    if (!Array.isArray(rawFiles)) return { error: 'files must be an array (one glob list per task)' };
    if (rawFiles.length > taskCount) {
      return { error: `files has ${rawFiles.length} entries but there are ${taskCount} tasks` };
    }
    for (const [k, list] of rawFiles.entries()) {
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list)) return { error: `files[${k}] must be an array of globs` };
      if (list.length > FANOUT_SCOPE_MAX_ENTRIES) {
        return { error: `files[${k}] has more than ${FANOUT_SCOPE_MAX_ENTRIES} entries` };
      }
      const seen = new Set<string>();
      for (const entry of list) {
        if (typeof entry !== 'string') return { error: `files[${k}] must contain only strings` };
        const n = normalizeScopeEntry(entry);
        if ('error' in n) return { error: `files[${k}]: ${n.error}` };
        seen.add(n.scope);
      }
      files[k] = [...seen];
    }
    for (let i = 0; i < taskCount; i++) {
      for (let j = i + 1; j < taskCount; j++) {
        for (const a of files[i]) {
          const b = files[j].find((s) => scopesOverlap(a, s));
          if (b !== undefined) {
            return {
              error:
                `files[${i}] "${a}" overlaps files[${j}] "${b}" — two tasks of one fan-out cannot share a write scope ` +
                '(scopes are compared by their fixed directory prefix; narrow them, or make one task depend on the other and give it the shared files)',
            };
          }
        }
      }
    }
  }

  if (rawDependsOn !== undefined) {
    if (!Array.isArray(rawDependsOn)) return { error: 'dependsOn must be an array (one index list per task)' };
    if (rawDependsOn.length > taskCount) {
      return { error: `dependsOn has ${rawDependsOn.length} entries but there are ${taskCount} tasks` };
    }
    for (const [k, list] of rawDependsOn.entries()) {
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list) || list.length > FANOUT_MAX_TASKS) {
        return { error: `dependsOn[${k}] must be an array of task indices` };
      }
      const seen = new Set<number>();
      for (const d of list) {
        if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d >= taskCount) {
          return { error: `dependsOn[${k}] has ${JSON.stringify(d)}, not a task index in 0..${taskCount - 1}` };
        }
        if (d === k) return { error: `dependsOn[${k}] names the task itself` };
        seen.add(d);
      }
      dependsOn[k] = [...seen].sort((a, b) => a - b);
    }
    // Cycle check: depth-first, a node met again while still on the stack.
    const state = new Array<0 | 1 | 2>(taskCount).fill(0);
    const visit = (k: number): number | null => {
      if (state[k] === 1) return k;
      if (state[k] === 2) return null;
      state[k] = 1;
      for (const d of dependsOn[k]) {
        const hit = visit(d);
        if (hit !== null) return hit;
      }
      state[k] = 2;
      return null;
    };
    for (let k = 0; k < taskCount; k++) {
      const hit = visit(k);
      if (hit !== null) return { error: `dependsOn has a cycle through task ${hit}` };
    }
  }

  return { files, dependsOn };
}

/** True when any task declares a scope or a dependency. */
export function hasTaskGraph(g: FanoutTaskGraph): boolean {
  return g.files.some((f) => f.length > 0) || g.dependsOn.some((d) => d.length > 0);
}
