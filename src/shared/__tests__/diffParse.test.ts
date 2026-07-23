// J2 diffParse round-trip oracle tests (spec §3·§6 R11)
//
// Core principle: no parser self-consensus. Re-serialized output is verified
// by applying it with real `git apply` in a temp repo — git is the oracle.
//
// Cases (spec §6 tests row): no-newline·CRLF·untracked new-file·skip leading hunk·
// duplicate context.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseUnifiedDiff,
  reassembleFile,
  reassemblePatch,
  synthesizeNewFileDiff,
} from '../diffParse';

// Every case spins a real temp git repo and shells out to git many times
// (init, config×2, add, commit, apply, …). On a loaded GitHub Windows runner
// that serial spawn chain can exceed vitest's 5s default per-test timeout,
// flaking with "Test timed out in 5000ms" — a runner-speed artifact, not a
// logic failure (the suite passes locally and on faster runners). Raise the
// ceiling file-wide so slow spawns get room without masking real hangs.
vi.setConfig({ testTimeout: 30000 });

// In a temp git repo: commit base content, apply the given patch via `git apply`,
// return post-apply file contents. git is the oracle.
function applyPatchInRepo(
  files: Record<string, string>,
  patch: string,
): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'diffparse-'));
  try {
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    git(['config', 'core.autocrlf', 'false']);
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    if (Object.keys(files).length > 0) {
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'base']);
    }
    // Save as patch file then apply (preserve raw bytes).
    const patchPath = join(dir, '__patch.diff');
    writeFileSync(patchPath, patch);
    git(['apply', patchPath]);

    // Collect tracked + new file contents after apply.
    const out: Record<string, string> = {};
    const tracked = git(['ls-files'])
      .split('\n')
      .filter((l) => l.length > 0 && l !== '__patch.diff');
    for (const f of tracked) {
      out[f] = readFileSync(join(dir, f), 'utf8');
    }
    // Check untracked (newly added files not yet staged). -uall yields individual
    // file paths, not directories.
    const status = git(['status', '--porcelain', '-uall']).split('\n').filter(Boolean);
    for (const line of status) {
      const p = line.slice(3);
      if (p === '__patch.diff' || out[p] !== undefined) continue;
      try {
        out[p] = readFileSync(join(dir, p), 'utf8');
      } catch {
        /* deleted */
      }
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// git diff helper: change files from base → after and return raw `git diff` output.
function makeDiff(
  base: Record<string, string>,
  after: Record<string, string>,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffgen-'));
  try {
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    git(['config', 'core.autocrlf', 'false']);
    for (const [path, content] of Object.entries(base)) {
      writeFileSync(join(dir, path), content);
    }
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);
    // Apply after (overwrite files — delete not handled here, modify only).
    for (const [path, content] of Object.entries(after)) {
      writeFileSync(join(dir, path), content);
    }
    return git(['diff']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('parseUnifiedDiff — basic parsing', () => {
  it('parses simple modify diff into file·hunks', () => {
    const diff = makeDiff({ 'a.txt': 'l1\nl2\nl3\n' }, { 'a.txt': 'l1\nCHANGED\nl3\n' });
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].path).toBe('a.txt');
    expect(parsed.files[0].kind).toBe('modify');
    expect(parsed.files[0].hunkSelectable).toBe(true);
    expect(parsed.files[0].hunks.length).toBeGreaterThan(0);
  });

  it('classifies new file as add', () => {
    // Real git-generated new-file diff.
    const dir = mkdtempSync(join(tmpdir(), 'newf-'));
    try {
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
      git(['init', '-q']);
      git(['config', 'user.email', 't@t']);
      git(['config', 'user.name', 't']);
      writeFileSync(join(dir, 'seed.txt'), 'seed\n');
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'base']);
      writeFileSync(join(dir, 'new.txt'), 'hello\nworld\n');
      git(['add', 'new.txt']);
      const diff = git(['diff', '--cached']);
      const parsed = parseUnifiedDiff(diff);
      expect(parsed.files[0].kind).toBe('add');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('binary·rename get non-selectable label', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bin-'));
    try {
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
      git(['init', '-q']);
      git(['config', 'user.email', 't@t']);
      git(['config', 'user.name', 't']);
      writeFileSync(join(dir, 'orig.txt'), 'content here\n');
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'base']);
      git(['mv', 'orig.txt', 'renamed.txt']);
      const diff = git(['diff', '--cached', '-M']);
      const parsed = parseUnifiedDiff(diff);
      expect(parsed.files[0].kind).toBe('rename');
      expect(parsed.files[0].hunkSelectable).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('round-trip oracle — reassemble → git apply (R11)', () => {
  it('full hunk re-serialization applies same result as original diff', () => {
    const base = { 'a.txt': 'l1\nl2\nl3\nl4\nl5\n' };
    const after = { 'a.txt': 'l1\nX2\nl3\nl4\nY5\n' };
    const diff = makeDiff(base, after);
    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0];
    const allIdx = file.hunks.map((_, i) => i);
    const patch = reassembleFile(file, allIdx);
    const result = applyPatchInRepo(base, patch);
    expect(result['a.txt']).toBe(after['a.txt']);
  });

  it('skip leading hunk — apply trailing hunk only', () => {
    // Two separate changes → expect 2 hunks. Select only the second.
    const base = {
      'a.txt': Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n',
    };
    const afterLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    afterLines[1] = 'CHANGED2'; // leading hunk
    afterLines[17] = 'CHANGED18'; // trailing hunk
    const after = { 'a.txt': afterLines.join('\n') + '\n' };
    const diff = makeDiff(base, after);
    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0];
    expect(file.hunks.length).toBe(2);
    // Select trailing hunk (index 1) only.
    const patch = reassembleFile(file, [1]);
    const result = applyPatchInRepo(base, patch);
    // Expect: line2 unchanged, line18 only CHANGED18.
    const expectedLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    expectedLines[17] = 'CHANGED18';
    expect(result['a.txt']).toBe(expectedLines.join('\n') + '\n');
  });

  it('select leading hunk only — offset correction check', () => {
    const base = {
      'a.txt': Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n',
    };
    const afterLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    afterLines[1] = 'CHANGED2';
    afterLines[17] = 'CHANGED18';
    const after = { 'a.txt': afterLines.join('\n') + '\n' };
    const diff = makeDiff(base, after);
    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0];
    const patch = reassembleFile(file, [0]);
    const result = applyPatchInRepo(base, patch);
    const expectedLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    expectedLines[1] = 'CHANGED2';
    expect(result['a.txt']).toBe(expectedLines.join('\n') + '\n');
  });

  it('no-newline at end of file — marker preserved in round-trip', () => {
    // base ends without newline → after also has no trailing newline.
    const base = { 'a.txt': 'l1\nl2\nl3' }; // no trailing newline
    const after = { 'a.txt': 'l1\nCHANGED\nl3' }; // still no trailing newline
    const diff = makeDiff(base, after);
    // Verify no-newline marker is actually present in diff (precondition).
    expect(diff).toContain('\\ No newline at end of file');
    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0];
    const patch = reassembleFile(file, file.hunks.map((_, i) => i));
    // Re-serialized patch must preserve the marker too.
    expect(patch).toContain('\\ No newline at end of file');
    const result = applyPatchInRepo(base, patch);
    expect(result['a.txt']).toBe(after['a.txt']);
    // Result must not end with newline (contamination guard).
    expect(result['a.txt'].endsWith('\n')).toBe(false);
  });

  it('CRLF — preserved in round-trip', () => {
    const base = { 'a.txt': 'l1\r\nl2\r\nl3\r\n' };
    const after = { 'a.txt': 'l1\r\nCHANGED\r\nl3\r\n' };
    const diff = makeDiff(base, after);
    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0];
    const patch = reassembleFile(file, file.hunks.map((_, i) => i));
    const result = applyPatchInRepo(base, patch);
    expect(result['a.txt']).toBe(after['a.txt']);
    // CRLF preserved.
    expect(result['a.txt']).toContain('\r\n');
  });

  it('duplicate context — applies specific hunk in file with repeated lines', () => {
    // Repeated identical context lines → ambiguous context case.
    const base = {
      'a.txt': 'x\nx\nx\nMARKER\nx\nx\nx\n',
    };
    const after = {
      'a.txt': 'x\nx\nx\nCHANGED\nx\nx\nx\n',
    };
    const diff = makeDiff(base, after);
    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0];
    const patch = reassembleFile(file, file.hunks.map((_, i) => i));
    const result = applyPatchInRepo(base, patch);
    expect(result['a.txt']).toBe(after['a.txt']);
  });
});

describe('synthesizeNewFileDiff — untracked new-file synthesis (R4)', () => {
  it('file ending with newline — accepted by git apply', () => {
    const patch = synthesizeNewFileDiff('sub/new.txt', 'alpha\nbeta\n');
    const result = applyPatchInRepo({ 'seed.txt': 'seed\n' }, patch);
    expect(result['sub/new.txt']).toBe('alpha\nbeta\n');
  });

  it('file ending without newline — marker synthesized', () => {
    const patch = synthesizeNewFileDiff('new.txt', 'alpha\nbeta');
    expect(patch).toContain('\\ No newline at end of file');
    const result = applyPatchInRepo({ 'seed.txt': 'seed\n' }, patch);
    expect(result['new.txt']).toBe('alpha\nbeta');
    expect(result['new.txt'].endsWith('\n')).toBe(false);
  });

  it('synthesizes empty file', () => {
    const patch = synthesizeNewFileDiff('empty.txt', '');
    const result = applyPatchInRepo({ 'seed.txt': 'seed\n' }, patch);
    expect(result['empty.txt']).toBe('');
  });
});

describe('reassemblePatch — multi-file all-or-nothing', () => {
  it('combines selected hunks from two files into single patch apply', () => {
    const base = { 'a.txt': 'a1\na2\na3\n', 'b.txt': 'b1\nb2\nb3\n' };
    const after = { 'a.txt': 'a1\nAX\na3\n', 'b.txt': 'b1\nBX\nb3\n' };
    // Generate each file diff separately, then merge via parser.
    const diffA = makeDiff({ 'a.txt': base['a.txt'] }, { 'a.txt': after['a.txt'] });
    const diffB = makeDiff({ 'b.txt': base['b.txt'] }, { 'b.txt': after['b.txt'] });
    const fileA = parseUnifiedDiff(diffA).files[0];
    const fileB = parseUnifiedDiff(diffB).files[0];
    const patch = reassemblePatch([
      { file: fileA, hunkIndices: fileA.hunks.map((_, i) => i) },
      { file: fileB, hunkIndices: fileB.hunks.map((_, i) => i) },
    ]);
    const result = applyPatchInRepo(base, patch);
    expect(result['a.txt']).toBe(after['a.txt']);
    expect(result['b.txt']).toBe(after['b.txt']);
  });

  it('empty patch when zero hunks selected', () => {
    const diff = makeDiff({ 'a.txt': 'l1\nl2\n' }, { 'a.txt': 'l1\nX\n' });
    const file = parseUnifiedDiff(diff).files[0];
    expect(reassembleFile(file, [])).toBe('');
  });
});

// ── F4: delete file display path is real path (not '/dev/null') ────────────────────
describe('parseUnifiedDiff — F4 delete display path', () => {
  it('delete diff path is real oldPath', () => {
    // Commit gone.txt then rm → real git delete diff. newPath is /dev/null.
    const dir = mkdtempSync(join(tmpdir(), 'del-'));
    try {
      const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
      git(['init', '-q']);
      git(['config', 'user.email', 't@t']);
      git(['config', 'user.name', 't']);
      git(['config', 'core.autocrlf', 'false']);
      writeFileSync(join(dir, 'gone.txt'), 'x1\nx2\n');
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'base']);
      rmSync(join(dir, 'gone.txt'));
      const diff = git(['diff']);
      const parsed = parseUnifiedDiff(diff);
      const f = parsed.files.find((ff) => ff.kind === 'delete')!;
      expect(f).toBeDefined();
      // Display/match path is real gone.txt, not /dev/null.
      expect(f.path).toBe('gone.txt');
      expect(f.path).not.toBe('/dev/null');
      expect(f.hunkSelectable).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── F9: empty-string hunk body termination only on last element ──────────────────────
describe('parseUnifiedDiff — F9 empty-string line handling', () => {
  it('trailing newline artifact (last empty element) terminates; round-trip apply consistent', () => {
    // Standard file with trailing newline → split's last element is empty string.
    const base = { 'a.txt': 'l1\nl2\nl3\n' };
    const after = { 'a.txt': 'l1\nCHANGED\nl3\n' };
    const diff = makeDiff(base, after);
    const file = parseUnifiedDiff(diff).files[0];
    const patch = reassemblePatch([{ file, hunkIndices: file.hunks.map((_, i) => i) }]);
    // git oracle: re-serialized result applies and matches after.
    const result = applyPatchInRepo(base, patch);
    expect(result['a.txt']).toBe(after['a.txt']);
  });
});
