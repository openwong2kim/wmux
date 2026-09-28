// Type-check slices (scripts/lib/typecheck-slices.mjs).
//
// Splitting the root program is only safe while the slices still add up to it:
// a file that no slice selects is a file nobody type-checks, and nothing else
// would notice. These pin the real slices to tsconfig.json and prove the gap
// check actually reports a missing directory.
import { describe, expect, it } from 'vitest';
import {
  ROOT_CONFIG, SLICES, sliceConfig, coverageGaps, rootFiles, sliceConfigProblems, scopeProblems, casingMismatches,
} from '../lib/typecheck-slices.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// These walk the real repository (thousands of files); slow CI runners need room.
const REPO_WALK_MS = 60_000;

describe('typecheck slices', () => {
  it('cover tsconfig.json exactly', () => {
    const { missing, extra } = coverageGaps(ROOT_CONFIG, SLICES.map((n) => sliceConfig(n)));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  }, REPO_WALK_MS);

  it('put every test file in exactly one test slice', () => {
    const seen = new Map();
    for (const name of SLICES.filter((n) => n.startsWith('tests-'))) {
      for (const f of rootFiles(sliceConfig(name))) {
        if (!/__tests__|\.test\./.test(f)) continue;
        expect(seen.get(f), `${f} is in ${seen.get(f)} and ${name}`).toBeUndefined();
        seen.set(f, name);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  }, REPO_WALK_MS);

  it('leave compiler options to tsconfig.json and keep whole-program checks intact', () => {
    expect(sliceConfigProblems(SLICES)).toEqual([]);
    expect(scopeProblems(ROOT_CONFIG, sliceConfig('src'))).toEqual([]);
  }, REPO_WALK_MS);

  it('reports an unlisted augmentation and a script outside the src slice', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-scope-'));
    try {
      fs.mkdirSync(path.join(dir, 'src/__tests__'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/aug.ts'), 'export {};\ndeclare global { interface Window { x: 1 } }\n');
      fs.writeFileSync(path.join(dir, 'src/__tests__/script.test.ts'), 'const shared = 1;\n');
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*'] }));
      fs.writeFileSync(path.join(dir, 'src.json'), JSON.stringify({ extends: './tsconfig.json', exclude: ['src/**/__tests__/**'] }));

      const problems = scopeProblems(path.join(dir, 'tsconfig.json'), path.join(dir, 'src.json'), dir);
      expect(problems).toHaveLength(2);
      expect(problems).toEqual(expect.arrayContaining([
        expect.stringContaining('src/aug.ts declares a global'),
        expect.stringContaining('src/__tests__/script.test.ts is a script'),
      ]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a program path whose casing differs from the file on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-casing-'));
    try {
      fs.writeFileSync(path.join(dir, 'Widget.ts'), 'export {};\n');
      const caseInsensitive = fs.existsSync(path.join(dir, 'widget.ts'));
      const found = casingMismatches([path.join(dir, 'widget.ts'), path.join(dir, 'Widget.ts')], dir);
      // On a case-sensitive disk the wrong spelling does not exist and tsc reports TS2307 itself.
      expect(found).toEqual(caseInsensitive ? [{ listed: 'widget.ts', onDisk: 'Widget.ts' }] : []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a directory that no slice selects', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-slices-'));
    try {
      for (const d of ['src/a', 'src/b']) fs.mkdirSync(path.join(dir, d), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/a/x.ts'), 'export const x = 1;\n');
      fs.writeFileSync(path.join(dir, 'src/b/y.ts'), 'export const y = 2;\n');
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*'] }));
      fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ extends: './tsconfig.json', include: ['src/a/**/*'] }));

      const { missing, extra } = coverageGaps(path.join(dir, 'tsconfig.json'), [path.join(dir, 'a.json')]);
      expect(missing.map((f) => path.relative(dir, f))).toEqual([path.join('src', 'b', 'y.ts')]);
      expect(extra).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
