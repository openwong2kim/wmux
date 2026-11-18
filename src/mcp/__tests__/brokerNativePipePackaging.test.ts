// @wmux-lane unit
// Reads build and source files as text and checks a pure path function, so
// the OS cannot change the result.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { nativeCoreCandidates } from '../../shared/nativeTerminalCore';

// The broker's Windows pipe listener lives in the Rust terminal core
// (capability pipe-listener-v1, src/mcp/nativePipe.ts), loaded through
// nativeCorePath. The broker finds the core only where the build puts both:
// packaged, the core is staged in resources/wmux-native beside
// resources/mcp-bundle; in development the broker runs from tsc output
// (dist/mcp/mcp/broker.js, the loader in dist/mcp/shared) and the core is
// staged in dist/wmux-native. Each half is pinned over its source.
const repo = path.join(__dirname, '..', '..', '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(repo, ...parts), 'utf8');

describe('the terminal core ships where the MCP broker loads it', () => {
  it('forge ships the staged core and the broker bundle as sibling resources', () => {
    const src = read('forge.config.ts');
    expect(src).toMatch(/const TERMINAL_CORE_STAGE = '\.\/dist\/wmux-native';/);
    const extra = src.slice(src.indexOf('extraResource: ['));
    const list = extra.slice(0, extra.indexOf('\n'));
    expect(list).toMatch(/shipsTerminalCore \? \[TERMINAL_CORE_STAGE\] : \[\]/);
    expect(list).toContain("'./dist/mcp-bundle'");
    expect(src).toMatch(/const shipsTerminalCore = true;/);
  });

  it('build:mcp writes the broker into dist/mcp-bundle, from the tsc output in dist/mcp', () => {
    const src = read('scripts', 'build-mcp.js');
    expect(src).toMatch(/const brokerFile = path\.join\(outdir, 'broker\.js'\);/);
    expect(src).toMatch(/const outdir = 'dist\/mcp-bundle';/);
    expect(src).toContain("entryPoints: ['dist/mcp/mcp/broker.js']");
    const tsconfig = JSON.parse(read('tsconfig.mcp.json')) as { compilerOptions: { outDir: string; rootDir: string } };
    expect(tsconfig.compilerOptions).toMatchObject({ outDir: 'dist/mcp', rootDir: 'src' });
  });

  it('BrokerSupervisor starts the packaged broker from mcp-bundle and the dev one from dist/mcp/mcp', () => {
    const src = read('src', 'main', 'mcp', 'BrokerSupervisor.ts');
    expect(src).toContain("path.join(process.resourcesPath, 'mcp-bundle', 'broker.js')");
    expect(src).toContain("path.join(app.getAppPath(), 'dist', 'mcp', 'mcp', 'broker.js')");
  });

  it('the packaged broker (resources/mcp-bundle) finds resources/wmux-native', () => {
    const resources = path.resolve('/app/resources');
    expect(nativeCoreCandidates(path.join(resources, 'mcp-bundle'), undefined))
      .toContain(path.join(resources, 'wmux-native', 'index.cjs'));
  });

  it('the dev broker (loader in dist/mcp/shared) finds dist/wmux-native', () => {
    const root = path.resolve('/checkout');
    expect(nativeCoreCandidates(path.join(root, 'dist', 'mcp', 'shared'), undefined))
      .toContain(path.join(root, 'dist', 'wmux-native', 'index.cjs'));
  });

  it('nativeCorePath tries those candidates, with ../wmux-native among them', () => {
    const src = read('src', 'shared', 'nativeTerminalCore.ts');
    expect(src).toMatch(/const candidates = nativeCoreCandidates\(__dirname, resources\);/);
    expect(src).toContain("path.join(dirname, '../wmux-native/index.cjs')");
    expect(src).toContain("path.join(dirname, '../../wmux-native/index.cjs')");
  });
});
