// Type-check slices (scripts/lib/typecheck-slices.mjs).
//
// Splitting the root program is only safe while the slices still add up to it:
// a file that no slice selects is a file nobody type-checks, and nothing else
// would notice. These pin the real slices to tsconfig.json and prove the gap
// check actually reports a missing directory.
import { describe, expect, it } from 'vitest';
import { ROOT_CONFIG, SLICES, sliceConfig, coverageGaps, rootFiles } from '../lib/typecheck-slices.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('typecheck slices', () => {
  it('cover tsconfig.json exactly', () => {
    const { missing, extra } = coverageGaps(ROOT_CONFIG, SLICES.map((n) => sliceConfig(n)));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

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
