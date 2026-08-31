import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getWmuxMcpServerInstructions,
  resolveMcpServerVersion,
  WMUX_MCP_CRITICAL_INSTRUCTIONS,
} from '../serverMetadata';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-mcp-metadata-'));
  tempDirs.push(dir);
  return dir;
}

function writePackage(root: string, version: string): void {
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'wmux', version }),
    'utf8',
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveMcpServerVersion', () => {
  it('prefers the build-time version for a self-contained bundle', () => {
    const dir = makeTempDir();
    expect(
      resolveMcpServerVersion({ bundleDir: dir, injectedVersion: '3.37.2-next.1' }),
    ).toBe('3.37.2-next.1');
  });

  it('reads the adjacent stable-copy generation marker', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, '.wmux-mcp-version'), '3.37.2\n', 'utf8');
    expect(resolveMcpServerVersion({ bundleDir: dir, injectedVersion: '' })).toBe('3.37.2');
  });

  it('finds package.json from the source layout', () => {
    const root = makeTempDir();
    const sourceDir = path.join(root, 'src', 'mcp');
    fs.mkdirSync(sourceDir, { recursive: true });
    writePackage(root, '4.0.0-source');
    expect(resolveMcpServerVersion({ bundleDir: sourceDir, injectedVersion: '' })).toBe(
      '4.0.0-source',
    );
  });

  it('finds package.json from the unbundled dist layout', () => {
    const root = makeTempDir();
    const distDir = path.join(root, 'dist', 'mcp', 'mcp');
    fs.mkdirSync(distDir, { recursive: true });
    writePackage(root, '4.0.0-dist');
    expect(resolveMcpServerVersion({ bundleDir: distDir, injectedVersion: '' })).toBe(
      '4.0.0-dist',
    );
  });

  it('fails startup when every version source is malformed', () => {
    const root = makeTempDir();
    const distDir = path.join(root, 'dist', 'mcp', 'mcp');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, '.wmux-mcp-version'), 'not-a-version\n', 'utf8');
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'another-app', version: '9.9.9' }),
      'utf8',
    );
    expect(() =>
      resolveMcpServerVersion({ bundleDir: distDir, injectedVersion: '' }),
    ).toThrow(
      'wmux MCP server version unavailable',
    );
  });

  it.each(['not-a-version', '1.2', '01.2.3', '1.2.3-01'])(
    'rejects non-SemVer build value %s',
    (injectedVersion) => {
      const dir = makeTempDir();
      expect(() => resolveMcpServerVersion({ bundleDir: dir, injectedVersion })).toThrow(
        'wmux MCP server version unavailable',
      );
    },
  );
});

describe('getWmuxMcpServerInstructions', () => {
  it.each([
    ['full'],
    ['core'],
    ['commander'],
  ] as const)('keeps the %s profile concise and self-contained', (profile) => {
    const instructions = getWmuxMcpServerInstructions(profile);
    const prefix = instructions.slice(0, 512);

    expect(Buffer.byteLength(instructions, 'utf8')).toBeLessThanOrEqual(2 * 1024);
    expect(prefix).toContain(WMUX_MCP_CRITICAL_INSTRUCTIONS);
    expect(prefix).toContain('wmux');
    expect(prefix).toContain('opaque IDs');
    expect(prefix).toContain('untrusted data');
    expect(prefix).toContain('send_message');
    expect(prefix).toContain('silent:true only delivers');
    expect(prefix).toContain('Do not assume channel_post starts a turn');
    expect(prefix).toContain('ambiguous mutation timeout');
  });

  it('keeps profile-specific discovery guidance inside the advertised surface', () => {
    // Only `full` registers browser_*, so only `full` may name one. A profile
    // that advertises a tool it did not register sends the agent after
    // something its own tools/list does not contain.
    expect(getWmuxMcpServerInstructions('full')).toContain('browser_tabs');
    expect(getWmuxMcpServerInstructions('core')).not.toContain('browser_tabs');
    expect(getWmuxMcpServerInstructions('commander')).not.toContain('browser_tabs');
    // The prose blurb must agree with the discovery list, not just the list.
    expect(getWmuxMcpServerInstructions('full')).toContain('terminal, browser, pane');
    expect(getWmuxMcpServerInstructions('core')).not.toContain('browser');
  });
});
