import { describe, expect, it } from 'vitest';
import {
  globToRegex,
  parsePermission,
  parsePermissionList,
} from '../permissionGrammar';

describe('permissionGrammar.parsePermission', () => {
  it('accepts a bare capability', () => {
    const result = parsePermission('pane.read');
    expect(result).toEqual({ ok: true, permission: { capability: 'pane.read' } });
  });

  it('accepts a capability with a path glob', () => {
    const result = parsePermission('meta.write:custom.dashboard.*');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.permission.capability).toBe('meta.write');
      expect(result.permission.pathGlob).toBe('custom.dashboard.*');
      expect(result.permission.pathRegex).toBeInstanceOf(RegExp);
    }
  });

  it('rejects unknown capabilities', () => {
    const result = parsePermission('pane.teleport');
    expect(result).toEqual({
      ok: false,
      error: 'unknown capability "pane.teleport"',
    });
  });

  it('rejects reserved wmux.* capabilities', () => {
    const result = parsePermission('wmux.internal');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/reserved/);
  });

  it('rejects empty strings and empty path globs', () => {
    expect(parsePermission('').ok).toBe(false);
    expect(parsePermission('meta.write:').ok).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(parsePermission(42).ok).toBe(false);
    expect(parsePermission(null).ok).toBe(false);
    expect(parsePermission(undefined).ok).toBe(false);
  });
});

describe('permissionGrammar.globToRegex', () => {
  it('treats * as "any except dot"', () => {
    const re = globToRegex('custom.dashboard.*');
    expect(re.test('custom.dashboard.label')).toBe(true);
    // single * does NOT cross a dot
    expect(re.test('custom.dashboard.nested.label')).toBe(false);
    expect(re.test('custom.other.label')).toBe(false);
  });

  it('treats ** as "any including dot"', () => {
    const re = globToRegex('custom.dashboard.**');
    expect(re.test('custom.dashboard.label')).toBe(true);
    expect(re.test('custom.dashboard.nested.deep.label')).toBe(true);
    expect(re.test('custom.other.label')).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    const re = globToRegex('events.poll+special');
    expect(re.test('events.poll+special')).toBe(true);
    // the `+` is a literal, not a regex repetition operator
    expect(re.test('events.pollllspecial')).toBe(false);
  });

  it('handles a bare * (any non-dot run, including empty)', () => {
    const re = globToRegex('*');
    expect(re.test('')).toBe(true);
    expect(re.test('label')).toBe(true);
    expect(re.test('with.dot')).toBe(false);
  });

  it('handles a bare ** (any run, dots included)', () => {
    const re = globToRegex('**');
    expect(re.test('')).toBe(true);
    expect(re.test('a.b.c.d')).toBe(true);
  });

  it('handles leading * (e.g. *.foo)', () => {
    const re = globToRegex('*.foo');
    expect(re.test('a.foo')).toBe(true);
    expect(re.test('.foo')).toBe(true);
    expect(re.test('a.b.foo')).toBe(false);
  });

  it('handles a glob with no dots', () => {
    const re = globToRegex('foo');
    expect(re.test('foo')).toBe(true);
    expect(re.test('foo.bar')).toBe(false);
    expect(re.test('xfoo')).toBe(false);
  });

  it('escapes triple-star degenerately as **+single-star', () => {
    // ***  →  ** + *  →  .*[^.]*  — matches any run; behaviour is
    // intentionally undefined-but-safe (no regex compile error, no
    // catastrophic backtracking).
    expect(() => globToRegex('***')).not.toThrow();
  });
});

describe('permissionGrammar.parsePermission — separator semantics', () => {
  it('treats colons after the first one as literal glob characters', () => {
    // Spec §3.1: the first `:` splits capability from glob; further colons
    // belong to the glob and are regex-escaped during compilation.
    const result = parsePermission('meta.write:custom.foo:bar');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.permission.capability).toBe('meta.write');
      expect(result.permission.pathGlob).toBe('custom.foo:bar');
      expect(result.permission.pathRegex?.test('custom.foo:bar')).toBe(true);
      // The literal `:` must NOT match `x` (i.e. not regex-special).
      expect(result.permission.pathRegex?.test('custom.fooXbar')).toBe(false);
    }
  });
});

describe('permissionGrammar.parsePermissionList', () => {
  it('parses all entries when valid', () => {
    const result = parsePermissionList(['pane.read', 'meta.write:custom.x.*']);
    expect(result.errors).toEqual([]);
    expect(result.parsed).toHaveLength(2);
  });

  it('collects errors and parses successes', () => {
    const result = parsePermissionList(['pane.read', 'bogus.capability']);
    expect(result.parsed).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/unknown capability/);
  });

  it('rejects non-array input', () => {
    expect(parsePermissionList('pane.read').errors).toContain(
      'permissions must be an array',
    );
  });
});
