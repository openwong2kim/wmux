import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// #1086 — the "call clearRemoteSelection at every activeWorkspaceId assignment"
// convention was documented but unenforceable, and that is exactly how the
// orphan-adopt path shipped without it: the remote mirror stayed on screen and
// the click looked swallowed. `activateLocalWorkspace` is now the single place
// that makes a local workspace visible; this guard keeps it that way by failing
// the build if a raw assignment reappears anywhere in the renderer — including
// in workspaceSlice.ts itself, which held six of the eight pre-#1282 raw
// assignments and so is exactly the file a whitelist must not exempt.
//
// The one legal assignment carries an inline `// guard-allow` marker, so the
// exemption lives at the line it applies to rather than at a file granularity
// that would re-open the whole slice.

const RENDERER_ROOT = join(__dirname, '..', '..', '..');
const ALLOW_MARKER = 'guard-allow';

// Any receiver name, not just the three this codebase happens to use today:
// `st.`, `d.`, `next.` are the same bug with a different local variable.
const MEMBER_ASSIGNMENT = /[A-Za-z_$][\w$]*\.activeWorkspaceId\s*=(?!=)/;
// zustand's other idiom: a plain patch object handed to set() / Object.assign().
const PATCH_KEY = /\bactiveWorkspaceId\s*:/;
const PATCH_CALL = /\b(?:set|setState|Object\.assign)\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** A patch-object assignment can span lines — `set({\n  activeWorkspaceId: id`
 *  — so a key line counts only when a set()/assign() call is still open above
 *  it. Brace depth since the call is enough to tell that from a type literal. */
function patchAssignmentLines(lines: string[]): Set<number> {
  const hits = new Set<number>();
  let openAt = -1;
  let depth = 0;
  lines.forEach((line, i) => {
    if (openAt < 0 && PATCH_CALL.test(line)) { openAt = i; depth = 0; }
    if (openAt >= 0) {
      if (PATCH_KEY.test(line) && i - openAt <= 6) hits.add(i);
      depth += (line.match(/[({]/g)?.length ?? 0) - (line.match(/[)}]/g)?.length ?? 0);
      if (depth <= 0 && i > openAt) openAt = -1;
    }
  });
  return hits;
}

describe('#1086 — activeWorkspaceId assignment guard', () => {
  it('only activateLocalWorkspace assigns activeWorkspaceId', () => {
    const offenders: string[] = [];
    for (const file of walk(RENDERER_ROOT)) {
      const rel = file.slice(RENDERER_ROOT.length + 1);
      const lines = readFileSync(file, 'utf8').split('\n');
      const patchLines = patchAssignmentLines(lines);
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
        if (line.includes(ALLOW_MARKER)) return;
        if (MEMBER_ASSIGNMENT.test(line) || patchLines.has(i)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders, 'use activateLocalWorkspace(state, id) instead — it drops the remote mirror selection (#1086)').toEqual([]);
  });

  // The marker is the whole exemption, so it must stay a single line in the one
  // function that owns the invariant — not a token anyone can sprinkle.
  it('the only exempt line is the assignment inside activateLocalWorkspace', () => {
    const marked: string[] = [];
    for (const file of walk(RENDERER_ROOT)) {
      const rel = file.slice(RENDERER_ROOT.length + 1);
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (line.includes(ALLOW_MARKER) && MEMBER_ASSIGNMENT.test(line)) marked.push(`${rel}:${i + 1}`);
      });
    }
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatch(/^stores[/\\]slices[/\\]workspaceSlice\.ts:/);
  });
});
