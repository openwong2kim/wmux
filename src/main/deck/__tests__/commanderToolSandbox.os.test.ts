// Unit tests for the commander Write sandbox (M1b). Pure and hermetic: no
// filesystem is touched (the evaluator only reasons about path STRINGS) and the
// developer's real ~/.wmux is never read or written. A synthetic absolute
// memoryRoot stands in for the store root.

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { evaluateCommanderToolPermission } from '../commanderToolSandbox';

// An absolute, platform-native root so path.resolve inside the evaluator is
// deterministic regardless of process.cwd().
const ROOT = path.resolve(path.sep === '\\' ? 'C:\\wmux-mem-test' : '/wmux-mem-test');
const globalDir = path.join(ROOT, '_global');
const wsDir = path.join(ROOT, 'ws-1');

describe('evaluateCommanderToolPermission', () => {
  it('allows a .md Write into the shared global partition', () => {
    const r = evaluateCommanderToolPermission(
      'Write',
      { file_path: path.join(globalDir, 'operator-pref.md') },
      { memoryRoot: ROOT, workspaceId: 'ws-1' },
    );
    expect(r.behavior).toBe('allow');
  });

  it("allows a .md Write into the brain's own workspace partition", () => {
    const r = evaluateCommanderToolPermission(
      'Write',
      { file_path: path.join(wsDir, 'project-convention.md') },
      { memoryRoot: ROOT, workspaceId: 'ws-1' },
    );
    expect(r.behavior).toBe('allow');
  });

  it("denies a Write into ANOTHER workspace's partition", () => {
    const r = evaluateCommanderToolPermission(
      'Write',
      { file_path: path.join(ROOT, 'ws-2', 'steal.md') },
      { memoryRoot: ROOT, workspaceId: 'ws-1' },
    );
    expect(r.behavior).toBe('deny');
  });

  it('denies path traversal that escapes the partition', () => {
    const r = evaluateCommanderToolPermission(
      'Write',
      { file_path: path.join(globalDir, '..', '..', 'evil.md') },
      { memoryRoot: ROOT, workspaceId: 'ws-1' },
    );
    expect(r.behavior).toBe('deny');
  });

  it('denies a path entirely outside the memory root', () => {
    const outside = path.resolve(path.sep === '\\' ? 'C:\\elsewhere\\evil.md' : '/elsewhere/evil.md');
    const r = evaluateCommanderToolPermission(
      'Write',
      { file_path: outside },
      { memoryRoot: ROOT, workspaceId: 'ws-1' },
    );
    expect(r.behavior).toBe('deny');
  });

  it('denies a non-.md file even inside the partition', () => {
    const r = evaluateCommanderToolPermission(
      'Write',
      { file_path: path.join(globalDir, 'secrets.txt') },
      { memoryRoot: ROOT, workspaceId: 'ws-1' },
    );
    expect(r.behavior).toBe('deny');
  });

  it('denies every other tool that reaches the callback', () => {
    for (const tool of ['Bash', 'WebFetch', 'Edit']) {
      const r = evaluateCommanderToolPermission(
        tool,
        { command: 'whatever' },
        { memoryRoot: ROOT, workspaceId: 'ws-1' },
      );
      expect(r.behavior).toBe('deny');
      // A deny always carries a message (the SDK requires one).
      if (r.behavior === 'deny') expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it('denies a workspace-partition write when the workspaceId is invalid', () => {
    // An unsafe id collapses to _global-only; a write aimed at a partition named
    // by that id must not be allowed.
    const r = evaluateCommanderToolPermission(
      'Write',
      { file_path: path.join(ROOT, '..', 'evil', 'x.md') },
      { memoryRoot: ROOT, workspaceId: '../evil' },
    );
    expect(r.behavior).toBe('deny');
    // The _global branch is still available even with a bad workspaceId.
    const g = evaluateCommanderToolPermission(
      'Write',
      { file_path: path.join(globalDir, 'still-ok.md') },
      { memoryRoot: ROOT, workspaceId: '../evil' },
    );
    expect(g.behavior).toBe('allow');
  });

  it('applies case-insensitive comparison when instructed (win32 semantics)', () => {
    // Same path, different case in the root portion. With caseInsensitive the
    // partition still matches; with case-sensitive it does not.
    const mixed = path.join(ROOT.toUpperCase(), '_global', 'note.md');
    const insensitive = evaluateCommanderToolPermission(
      'Write',
      { file_path: mixed },
      { memoryRoot: ROOT, workspaceId: 'ws-1', caseInsensitive: true },
    );
    const sensitive = evaluateCommanderToolPermission(
      'Write',
      { file_path: mixed },
      { memoryRoot: ROOT, workspaceId: 'ws-1', caseInsensitive: false },
    );
    // On a root that already equals its own upper-case (rare), fall back to a
    // guaranteed-different assertion: the insensitive result must allow.
    expect(insensitive.behavior).toBe('allow');
    if (ROOT.toUpperCase() !== ROOT) {
      expect(sensitive.behavior).toBe('deny');
    }
  });

  it('never throws on garbage input — missing or non-string file_path → deny', () => {
    const missing = evaluateCommanderToolPermission(
      'Write',
      {},
      { memoryRoot: ROOT, workspaceId: 'ws-1' },
    );
    expect(missing.behavior).toBe('deny');

    const nonString = evaluateCommanderToolPermission(
      'Write',
      { file_path: 42 as unknown as string },
      { memoryRoot: ROOT, workspaceId: 'ws-1' },
    );
    expect(nonString.behavior).toBe('deny');

    // A null input object must also be tolerated (no throw).
    const nullish = evaluateCommanderToolPermission(
      'Write',
      null as unknown as Record<string, unknown>,
      { memoryRoot: ROOT, workspaceId: 'ws-1' },
    );
    expect(nullish.behavior).toBe('deny');
  });
});
