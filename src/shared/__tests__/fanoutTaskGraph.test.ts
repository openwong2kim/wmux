import { describe, it, expect } from 'vitest';
import { normalizeScopeEntry, scopesOverlap, validateFanoutTaskGraph } from '../fanoutTaskGraph';

describe('fanout task graph', () => {
  it('normalizes scopes and refuses absolute or escaping ones', () => {
    expect(normalizeScopeEntry('./src//a/')).toEqual({ scope: 'src/a' });
    expect(normalizeScopeEntry('.')).toEqual({ scope: '.' });
    expect(normalizeScopeEntry('/etc/passwd')).toHaveProperty('error');
    expect(normalizeScopeEntry('C:\\x')).toHaveProperty('error');
    expect(normalizeScopeEntry('src/../..')).toHaveProperty('error');
  });

  it('compares scopes by their fixed directory prefix', () => {
    expect(scopesOverlap('src/a', 'src/a/b.ts')).toBe(true);
    expect(scopesOverlap('src/**/*.ts', 'src/a/b.ts')).toBe(true);
    expect(scopesOverlap('src/a/**', 'src/b/**')).toBe(false);
    expect(scopesOverlap('src/ab', 'src/a')).toBe(false);
    expect(scopesOverlap('.', 'docs')).toBe(true);
    // Conservative on purpose: same fixed prefix, different extensions.
    expect(scopesOverlap('src/*.ts', 'src/*.md')).toBe(true);
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
