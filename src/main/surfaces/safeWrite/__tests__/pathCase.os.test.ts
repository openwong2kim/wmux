import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { foldPathCase } from '../pathCase';
import { isInsideDir } from '../../writers/codex/pathSafety';
import { isSubpathOrEqual } from '../../writers/claude/pathSecurity';

describe('path case folding', () => {
  it('folds only on Windows and macOS', () => {
    expect(foldPathCase('/Home/U', 'win32')).toBe('/home/u');
    expect(foldPathCase('/Home/U', 'darwin')).toBe('/home/u');
    expect(foldPathCase('/Home/U', 'linux')).toBe('/Home/U');
  });

  it('rejects a case-variant parent on a case-sensitive platform', () => {
    const home = path.resolve('/home/u');
    const variant = path.join(path.resolve('/home/U'), '.claude', 'settings.json');
    // path.relative itself ignores case on a Windows host, so this half only means something elsewhere.
    if (process.platform !== 'win32') expect(isInsideDir(variant, home, 'linux')).toBe(false);
    expect(isSubpathOrEqual(variant, home, 'linux')).toBe(false);
    expect(isInsideDir(variant, home, 'win32')).toBe(true);
    expect(isSubpathOrEqual(variant, home, 'darwin')).toBe(true);
  });
});
