// Gate for the internal-document policy that keeps strategy material out of
// this public repository.
//
// The integration test asserts the real tracked tree is clean. The unit tests
// pin the behaviour that actually matters: a check that trusts `.gitignore`
// agrees with whatever `.gitignore` currently says, so editing that one line is
// enough to open the repository up. The cases below stop anyone "simplifying"
// the guard back into that hole.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INTERNAL_DOC_ALLOWLIST,
  checkGitignore,
  checkPaths,
  classifyPath,
} from '../lib/internal-doc-guard.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function trackedPaths() {
  return execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
}

describe('tracked tree', () => {
  it('tracks no internal-only document', () => {
    const violations = checkPaths(trackedPaths());
    expect(
      violations.map((v) => `${v.path} [${v.rule}] ${v.detail}`),
      'an internal document is tracked in this public repo — see `npm run check:internal-docs`',
    ).toEqual([]);
  });

  it('still ignores the internal document directory', () => {
    const gitignore = readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    expect(
      checkGitignore(gitignore).map((v) => `${v.entry}: ${v.detail}`),
      'the .gitignore entry protecting internal documents was weakened',
    ).toEqual([]);
  });

  it('keeps every allowlist entry pointing at a real tracked file', () => {
    // A stale entry is a standing permission for a path nobody reviews.
    const tracked = new Set(trackedPaths());
    for (const allowed of INTERNAL_DOC_ALLOWLIST.keys()) {
      expect(tracked.has(allowed), `${allowed} is allowlisted but no longer tracked`).toBe(true);
    }
  });
});

describe('path classification', () => {
  it('blocks anything under the internal directory', () => {
    expect(classifyPath('plans/whatever.md')?.rule).toBe('internal-path');
    expect(classifyPath('plans/nested/deep/notes.txt')?.rule).toBe('internal-path');
  });

  it('blocks internal filenames written outside that directory', () => {
    // A directory rule only half-covers this: the same note saved as
    // docs/our-roadmap.md would sail through.
    expect(classifyPath('docs/our-roadmap.md')?.rule).toBe('internal-name');
    expect(classifyPath('competitive-analysis.md')?.rule).toBe('internal-name');
    expect(classifyPath('notes/2026-08-14-strategy.md')?.rule).toBe('internal-name');
    expect(classifyPath('docs/as-is-to-be-2026-07-28.md')?.rule).toBe('internal-name');
  });

  it('requires the marker to be a delimited token, not a substring', () => {
    // Precision is the whole design: a gate that fires on ordinary source files
    // gets bypassed with --no-verify, and then guards nothing at all.
    expect(classifyPath('src/renderer/roadmapView.tsx')).toBeNull();
    expect(classifyPath('src/main/strategyResolver.ts')).toBeNull();
    expect(classifyPath('README.md')).toBeNull();
    expect(classifyPath('CHANGELOG.md')).toBeNull();
  });

  it('honours the allowlist', () => {
    for (const allowed of INTERNAL_DOC_ALLOWLIST.keys()) {
      expect(classifyPath(allowed), `${allowed} is allowlisted`).toBeNull();
    }
  });

  it('normalizes Windows separators', () => {
    // Hooks on this platform hand paths back with backslashes often enough that
    // a separator-sensitive rule would silently pass the primary dev OS.
    expect(classifyPath('plans\\note.md')?.rule).toBe('internal-path');
  });
});

describe('gitignore integrity', () => {
  it('accepts the entry being present', () => {
    expect(checkGitignore('node_modules/\nplans/\ndist/\n')).toEqual([]);
  });

  it('reports a removed entry', () => {
    // Caught one step before any document reaches a commit.
    const violations = checkGitignore('node_modules/\ndist/\n');
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe('gitignore-weakened');
  });

  it('reports an entry that a later negation re-admits', () => {
    const violations = checkGitignore('plans/\n!plans/public-notes.md\n');
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe('gitignore-weakened');
  });
});
