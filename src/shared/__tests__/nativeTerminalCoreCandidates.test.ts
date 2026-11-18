import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nativeCoreCandidates } from '../nativeTerminalCore';

// Where each bundle's loader finds the staged core. Pure over the loader's
// directory, so every layout is checked on every OS.
const repo = path.resolve('/repo');
const staged = path.join(repo, 'dist', 'wmux-native', 'index.cjs');

describe('nativeCoreCandidates', () => {
  it('the dev MCP broker (tsc output in dist/mcp) finds dist/wmux-native', () => {
    const dir = path.join(repo, 'dist', 'mcp', 'shared');
    expect(nativeCoreCandidates(dir, undefined)).toContain(staged);
  });

  it('the packaged broker bundle finds the core beside mcp-bundle', () => {
    const resources = path.resolve('/app/resources');
    const dir = path.join(resources, 'mcp-bundle');
    expect(nativeCoreCandidates(dir, undefined)[0]).toBe(path.join(resources, 'wmux-native', 'index.cjs'));
  });

  it('`npm start` main (.vite/build) finds dist/wmux-native', () => {
    const dir = path.join(repo, '.vite', 'build');
    expect(nativeCoreCandidates(dir, undefined)).toContain(staged);
  });

  it('resources come first when the process has them', () => {
    const resources = path.resolve('/app/resources');
    expect(nativeCoreCandidates(path.join(repo, 'dist', 'mcp', 'shared'), resources)[0])
      .toBe(path.join(resources, 'wmux-native', 'index.cjs'));
  });

  it('a shared folder outside dist/mcp does not reach two levels up', () => {
    for (const dir of [path.join(repo, 'src', 'shared'), path.join(repo, 'dist', 'cli', 'shared'), path.join(repo, 'out', 'mcp', 'shared')]) {
      const twoUp = path.join(dir, '..', '..', 'wmux-native', 'index.cjs');
      expect(nativeCoreCandidates(dir, undefined)).not.toContain(twoUp);
    }
  });
});
