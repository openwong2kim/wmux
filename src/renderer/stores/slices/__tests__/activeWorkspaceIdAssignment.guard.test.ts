import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// #1086 — the "call clearRemoteSelection at every activeWorkspaceId assignment"
// convention was documented but unenforceable, and that is exactly how the
// orphan-adopt path shipped without it: the remote mirror stayed on screen and
// the click looked swallowed. `activateLocalWorkspace` is now the single place
// that makes a local workspace visible; this guard keeps it that way by failing
// the build if a raw assignment reappears anywhere in the renderer.

const RENDERER_ROOT = join(__dirname, '..', '..', '..');
// The helper itself is the one legal assignment site.
const ALLOWED = new Set([join('stores', 'slices', 'workspaceSlice.ts')]);
const ASSIGNMENT = /(?:state|draft|s)\.activeWorkspaceId\s*=(?!=)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('#1086 — activeWorkspaceId assignment guard', () => {
  it('only activateLocalWorkspace assigns activeWorkspaceId', () => {
    const offenders: string[] = [];
    for (const file of walk(RENDERER_ROOT)) {
      const rel = file.slice(RENDERER_ROOT.length + 1);
      if (ALLOWED.has(rel)) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
        if (ASSIGNMENT.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders, 'use activateLocalWorkspace(state, id) instead — it drops the remote mirror selection (#1086)').toEqual([]);
  });
});
