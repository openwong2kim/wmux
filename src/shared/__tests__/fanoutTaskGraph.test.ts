import { describe, it, expect } from 'vitest';
import { normalizeScopeEntry, scopesOverlap, validateFanoutTaskGraph } from '../fanoutTaskGraph';

describe('fanout task graph', () => {
  it('normalizes scopes and refuses absolute or escaping ones', () => {
    expect(normalizeScopeEntry('./src//a/')).toEqual({ scope: 'src/a' });
    expect(normalizeScopeEntry('.')).toEqual({ scope: '.' });
    expect(normalizeScopeEntry('/etc/passwd')).toHaveProperty('error');
    expect(normalizeScopeEntry('C:\\x')).toHaveProperty('error');
    expect(normalizeScopeEntry('src/../..')).toHaveProperty('error');
    expect(normalizeScopeEntry('{../x,src}/**')).toHaveProperty('error');
    expect(normalizeScopeEntry('@(..|src)/**')).toHaveProperty('error');
    expect(normalizeScopeEntry('src/a..b.ts')).toEqual({ scope: 'src/a..b.ts' });
  });

  it('compares scopes by their fixed directory prefix', () => {
    expect(scopesOverlap('src/a', 'src/a/b.ts')).toBe(true);
    expect(scopesOverlap('src/**/*.ts', 'src/a/b.ts')).toBe(true);
    expect(scopesOverlap('src/a/**', 'src/b/**')).toBe(false);
    expect(scopesOverlap('src/ab', 'src/a')).toBe(false);
    expect(scopesOverlap('.', 'docs')).toBe(true);
    // Conservative on purpose: same fixed prefix, different extensions.
    expect(scopesOverlap('src/*.ts', 'src/*.md')).toBe(true);
    // Extglob ends the fixed prefix instead of being read as a directory name.
    expect(scopesOverlap('@(src|lib)/**', 'src/a.ts')).toBe(true);
    expect(scopesOverlap('src/+(a|b)/x', 'src/a/x')).toBe(true);
    // Compared case-insensitively.
    expect(scopesOverlap('Src/A', 'src/a/x.ts')).toBe(true);
  });

  it('lets tasks ordered by dependency share a scope', () => {
    expect(validateFanoutTaskGraph([['src'], ['lib'], ['src/x.ts']], [[], [0], [1]], 3)).toHaveProperty('files');
    expect(validateFanoutTaskGraph([['src'], ['lib'], ['src/x.ts']], [[], [], [1]], 3)).toHaveProperty('error');
  });

  it('requires one non-empty scope list per task once files is given', () => {
    expect(validateFanoutTaskGraph([['src']], undefined, 2)).toHaveProperty('error');
    expect(validateFanoutTaskGraph([['src'], []], undefined, 2)).toHaveProperty('error');
    expect(validateFanoutTaskGraph([['src'], null], undefined, 2)).toHaveProperty('error');
  });

  it('refuses overlapping scopes across tasks but not within one', () => {
    const ok = validateFanoutTaskGraph([['src/a/**', 'src/a/x.ts'], ['src/b/**']], undefined, 2);
    expect(ok).toEqual({ files: [['src/a/**', 'src/a/x.ts'], ['src/b/**']], dependsOn: [[], []] });
    const bad = validateFanoutTaskGraph([['src/a/**'], ['src/a/x.ts']], undefined, 2);
    expect(bad).toHaveProperty('error');
    expect((bad as { error: string }).error).toContain('files[0]');
  });

  it('refuses out-of-range, self and cyclic dependencies', () => {
    expect(validateFanoutTaskGraph(undefined, [[], [0], [1]], 3)).toEqual({
      files: [[], [], []],
      dependsOn: [[], [0], [1]],
    });
    expect(validateFanoutTaskGraph(undefined, [[3]], 3)).toHaveProperty('error');
    expect(validateFanoutTaskGraph(undefined, [[1.5]], 3)).toHaveProperty('error');
    expect(validateFanoutTaskGraph(undefined, [[0]], 3)).toHaveProperty('error');
    const cyc = validateFanoutTaskGraph(undefined, [[2], [0], [1]], 3);
    expect((cyc as { error: string }).error).toMatch(/cycle/);
    expect(validateFanoutTaskGraph(undefined, [[], [], []], 2)).toHaveProperty('error');
  });
});
