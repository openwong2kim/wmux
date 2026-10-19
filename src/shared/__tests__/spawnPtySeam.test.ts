/**
 * #2398 — every pane PTY is spawned through src/shared/spawnPty.ts.
 *
 * node-pty 1.2.0-beta gives a Windows PTY pid 0 until its output pipe
 * connects, and reports a CreateProcess failure as a later exit instead of a
 * throw. spawnPty is the one place that waits for the real pid and turns that
 * exit back into a throw; a spawn that bypasses it would register pid 0 into
 * session meta, the pid map and agent tracking with no visible error. tsc
 * cannot see that, so this scan fails on any production file outside the seam
 * that loads node-pty or calls the lower-level spawn helpers.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readSourceText } from '../../test-utils/sourceText';

const srcRoot = path.join(__dirname, '..', '..');

/** Files allowed to do what the patterns below look for, and why. */
const ALLOWED: Record<string, string> = {
  'shared/spawnPty.ts': 'the seam',
  // Defines spawnTerminalPty and takes node-pty's spawn as a parameter.
  'shared/terminalPty.ts': 'defines spawnTerminalPty',
  // Defines spawnWithConptyPolicy; never imports node-pty.
  'shared/conptyWindows.ts': 'defines spawnWithConptyPolicy',
};

const PATTERNS: Array<[string, RegExp]> = [
  // A value import of node-pty (a type-only import is erased by tsc).
  ['imports node-pty', /^\s*import\s+(?!type\b)[^;]*?from\s+['"]node-pty['"]/m],
  ['requires node-pty', /\brequire\(\s*['"]node-pty['"]\s*\)/],
  ['dynamically imports node-pty', /\bimport\(\s*['"]node-pty['"]\s*\)/],
  ['calls spawnTerminalPty', /\bspawnTerminalPty\s*\(/],
  ['calls spawnWithConptyPolicy', /\bspawnWithConptyPolicy\s*(<[^>]*>)?\s*\(/],
];

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) productionFiles(full, out);
    else if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

describe('the PTY spawn seam (#2398)', () => {
  const files = productionFiles(srcRoot);

  it('finds the production sources it guards', () => {
    const rel = files.map((f) => path.relative(srcRoot, f).split(path.sep).join('/'));
    expect(rel).toContain('daemon/DaemonSessionManager.ts');
    expect(rel).toContain('main/pty/PTYManager.ts');
    expect(rel).toContain('shared/spawnPty.ts');
  });

  it('no production file outside the seam loads node-pty or spawns around spawnPty', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(srcRoot, file).split(path.sep).join('/');
      if (ALLOWED[rel]) continue;
      const text = readSourceText(file);
      for (const [what, pattern] of PATTERNS) {
        if (pattern.test(text)) offenders.push(`${rel} ${what}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the patterns catch what they are for', () => {
    const hit = (text: string) => PATTERNS.filter(([, p]) => p.test(text)).map(([w]) => w);
    expect(hit("import * as pty from 'node-pty';")).toEqual(['imports node-pty']);
    expect(hit("import { spawn, type IPty } from 'node-pty';")).toEqual(['imports node-pty']);
    expect(hit("import type { IPty } from 'node-pty';")).toEqual([]);
    expect(hit("const pty = require('node-pty');")).toEqual(['requires node-pty']);
    expect(hit("const { spawn } = await import('node-pty');")).toEqual(['dynamically imports node-pty']);
    expect(hit('spawnWithConptyPolicy((b) => spawnTerminalPty(c, a, o, s), true, n)')).toEqual([
      'calls spawnTerminalPty', 'calls spawnWithConptyPolicy',
    ]);
  });
});
