import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stabilizeMcpBundle, MCP_VERSION_MARKER } from '../stabilizeBundle';

// Real fs against a per-test temp dir — the copy/gate logic is the whole point,
// so mocking fs would test nothing. `src` stands in for the versioned
// resourcesPath bundle; `stable` stands in for ~/.wmux/mcp.
let tmp = '';
let srcDir = '';
let stableDir = '';

/** Write a fake mcp-bundle dir: entry + a big sibling + a package.json. */
function makeBundle(dir: string, indexBody: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const index = path.join(dir, 'index.js');
  fs.writeFileSync(index, indexBody, 'utf8');
  fs.writeFileSync(path.join(dir, 'playwright-chunk.js'), 'CHUNK', 'utf8');
  fs.writeFileSync(path.join(dir, 'playwright-core-package.json'), '{"name":"x"}', 'utf8');
  return index;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-stab-'));
  srcDir = path.join(tmp, 'app-1.0.0', 'resources', 'mcp-bundle');
  stableDir = path.join(tmp, 'home', '.wmux', 'mcp');
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('stabilizeMcpBundle', () => {
  it('cold boot: copies the whole bundle dir and registers the STABLE path', () => {
    const source = makeBundle(srcDir, 'INDEX_V1');
    const r = stabilizeMcpBundle(source, stableDir, '1.0.0');

    expect(r.stabilized).toBe(true);
    expect(r.synced).toBe(true);
    // The registered path is the stable copy, NOT the versioned source.
    expect(r.scriptPath).toBe(path.join(stableDir, 'index.js'));
    expect(r.scriptPath).not.toBe(source);
    // Siblings travelled too (index.js resolves them via __dirname).
    expect(fs.readFileSync(path.join(stableDir, 'index.js'), 'utf8')).toBe('INDEX_V1');
    expect(fs.existsSync(path.join(stableDir, 'playwright-chunk.js'))).toBe(true);
    expect(fs.existsSync(path.join(stableDir, 'playwright-core-package.json'))).toBe(true);
    // Version marker recorded.
    expect(fs.readFileSync(path.join(stableDir, MCP_VERSION_MARKER), 'utf8')).toBe('1.0.0');
  });

  it('registered stable path survives deletion of the versioned source dir', () => {
    const source = makeBundle(srcDir, 'INDEX_V1');
    const r = stabilizeMcpBundle(source, stableDir, '1.0.0');
    // Simulate Squirrel removing the old app-*/ (or a worktree/out wipe).
    fs.rmSync(path.join(tmp, 'app-1.0.0'), { recursive: true, force: true });
    expect(fs.existsSync(source)).toBe(false);
    // The registered path still resolves — the whole point of the fix.
    expect(fs.existsSync(r.scriptPath)).toBe(true);
  });

  it('warm boot (same version, entry present): no re-copy', () => {
    const source = makeBundle(srcDir, 'INDEX_V1');
    stabilizeMcpBundle(source, stableDir, '1.0.0');
    // Mutate the SOURCE after the first sync; a warm boot must NOT re-copy.
    fs.writeFileSync(source, 'INDEX_MUTATED', 'utf8');

    const r = stabilizeMcpBundle(source, stableDir, '1.0.0');
    expect(r.stabilized).toBe(true);
    expect(r.synced).toBe(false);
    // Stable copy is untouched (still V1) because the version gate short-circuited.
    expect(fs.readFileSync(path.join(stableDir, 'index.js'), 'utf8')).toBe('INDEX_V1');
  });

  it('version change: re-syncs the stable copy to the new bundle', () => {
    const source = makeBundle(srcDir, 'INDEX_V1');
    stabilizeMcpBundle(source, stableDir, '1.0.0');
    fs.writeFileSync(source, 'INDEX_V2', 'utf8');

    const r = stabilizeMcpBundle(source, stableDir, '2.0.0');
    expect(r.synced).toBe(true);
    expect(fs.readFileSync(path.join(stableDir, 'index.js'), 'utf8')).toBe('INDEX_V2');
    expect(fs.readFileSync(path.join(stableDir, MCP_VERSION_MARKER), 'utf8')).toBe('2.0.0');
  });

  it('repair: re-syncs when the marker matches but the stable entry was deleted', () => {
    const source = makeBundle(srcDir, 'INDEX_V1');
    stabilizeMcpBundle(source, stableDir, '1.0.0');
    // Marker still says 1.0.0, but the entry is gone (partial prior copy / manual rm).
    fs.rmSync(path.join(stableDir, 'index.js'), { force: true });

    const r = stabilizeMcpBundle(source, stableDir, '1.0.0');
    expect(r.synced).toBe(true);
    expect(fs.existsSync(path.join(stableDir, 'index.js'))).toBe(true);
  });

  it('fails open to the versioned source path when the source is missing', () => {
    const source = path.join(srcDir, 'index.js'); // never created
    const r = stabilizeMcpBundle(source, stableDir, '1.0.0');
    expect(r.stabilized).toBe(false);
    expect(r.synced).toBe(false);
    expect(r.reason).toBe('source-missing');
    expect(r.scriptPath).toBe(source);
    // No stable dir materialized from a missing source.
    expect(fs.existsSync(stableDir)).toBe(false);
  });

  it('leaves no .tmp files behind after a sync', () => {
    const source = makeBundle(srcDir, 'INDEX_V1');
    stabilizeMcpBundle(source, stableDir, '1.0.0');
    const leftovers = fs.readdirSync(stableDir).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('stabilizes a broker shim entry the same way (basename preserved)', () => {
    fs.mkdirSync(srcDir, { recursive: true });
    const shim = path.join(srcDir, 'shim.js');
    fs.writeFileSync(shim, 'SHIM', 'utf8');
    fs.writeFileSync(path.join(srcDir, 'index.js'), 'INDEX', 'utf8');

    const r = stabilizeMcpBundle(shim, stableDir, '1.0.0');
    expect(r.scriptPath).toBe(path.join(stableDir, 'shim.js'));
    expect(fs.readFileSync(r.scriptPath, 'utf8')).toBe('SHIM');
    // The sibling entry came along too (the broker still needs the full dir).
    expect(fs.existsSync(path.join(stableDir, 'index.js'))).toBe(true);
  });
});
