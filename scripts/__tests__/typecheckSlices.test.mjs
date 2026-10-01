// Type-check slices (scripts/lib/typecheck-slices.mjs).
//
// Splitting the root program is only safe while the slices still add up to it:
// a file that no slice selects is a file nobody type-checks, and nothing else
// would notice. These pin the real slices to tsconfig.json and prove the gap
// check actually reports a missing directory.
import { describe, expect, it } from 'vitest';
import {
  ROOT, ROOT_CONFIG, SLICES, PROGRAMS, CHECKS, sliceConfig, checkConfig, assertSlicesExist, coverageGaps, rootFiles,
  sliceConfigProblems, scopeProblems, casingMismatches, selectChecks,
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

  it('still parses scripts that only look like modules', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-lookalike-'));
    try {
      fs.mkdirSync(path.join(dir, 'src/__tests__'), { recursive: true });
      const scripts = {
        'dynamic.test.ts': "import('node:fs').then(() => {});\n",
        'key.test.ts': 'const o = {\n  export: true,\n};\n',
        'comment.test.ts': '/*\nimport x from "y";\n*/\nconst a = 1;\n',
        'template.test.ts': 'const t = `\nexport const b = 2;\n`;\n',
      };
      for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(dir, 'src/__tests__', name), body);
      fs.writeFileSync(path.join(dir, 'src/__tests__/real.test.ts'), 'import fs from "node:fs";\nvoid fs;\n');
      fs.writeFileSync(path.join(dir, 'src/app.ts'), 'export const app = 1;\n');
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*'] }));
      fs.writeFileSync(path.join(dir, 'src.json'), JSON.stringify({ extends: './tsconfig.json', exclude: ['src/**/__tests__/**'] }));

      const problems = scopeProblems(path.join(dir, 'tsconfig.json'), path.join(dir, 'src.json'), dir);
      for (const name of Object.keys(scripts)) {
        expect(problems).toEqual(expect.arrayContaining([expect.stringContaining(`src/__tests__/${name} is a script`)]));
      }
      expect(problems.some((p) => p.includes('real.test.ts'))).toBe(false);
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

  // #1681 — the MCP bundle targets ES2020, so an ES2022 API in a shared file
  // passed every slice (tsconfig.json targets ESNext) and only failed its build.
  it('also runs the build programs, each with its own tsconfig', () => {
    expect(Object.keys(PROGRAMS)).toEqual(['mcp', 'cli', 'daemon']);
    expect(CHECKS).toEqual([...SLICES, 'mcp', 'cli', 'daemon']);
    for (const name of Object.keys(PROGRAMS)) {
      const config = checkConfig(name);
      expect(path.dirname(config)).toBe(ROOT);
      expect(fs.existsSync(config), `${config} is missing`).toBe(true);
    }
    expect(checkConfig('mcp')).toBe(path.join(ROOT, 'tsconfig.mcp.json'));
    expect(checkConfig('src')).toBe(sliceConfig('src'));
    expect(() => assertSlicesExist(CHECKS)).not.toThrow();
    expect(() => assertSlicesExist(['nope'])).toThrow(/unknown type-check slice "nope"/);
  });

  it('selects named checks, or all of them, minus --skip build programs', () => {
    expect(selectChecks([])).toEqual(CHECKS);
    expect(selectChecks(['src', 'mcp'])).toEqual(['src', 'mcp']);
    expect(selectChecks(['--skip', 'mcp,daemon'])).toEqual([...SLICES, 'cli']);
    expect(selectChecks(['--skip', 'mcp', '--skip', 'cli'])).toEqual([...SLICES, 'daemon']);
    expect(selectChecks(['src', 'mcp', '--skip', 'mcp'])).toEqual(['src']);
    // Skipping only makes sense for a program something else compiles; a
    // slice or a typo must not quietly check less.
    expect(() => selectChecks(['--skip', 'src'])).toThrow(/build programs only/);
    expect(() => selectChecks(['--skip', 'mcp,'])).toThrow(/build programs only/);
    expect(() => selectChecks(['--skip'])).toThrow(/needs a comma-separated list/);
    expect(() => selectChecks(['--except', 'mcp'])).toThrow(/unknown option "--except"/);
  });

  // #1685 — CI skips a build program in its type check only because a CI step
  // compiles the same tsconfig anyway. Pin that: every program ci.yml skips
  // must have a `build:<name>` script that starts with `tsc -p <its tsconfig>`,
  // and ci.yml must run that script.
  it('skips in CI only the programs a CI build step compiles', () => {
    const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const step = /^\s*run:\s*node scripts\/typecheck\.mjs\b(.*)$/m.exec(ci);
    expect(step, 'ci.yml no longer runs scripts/typecheck.mjs').toBeTruthy();
    const skipped = CHECKS.filter((n) => !selectChecks(step[1].trim().split(/\s+/).filter(Boolean)).includes(n));

    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
    for (const name of skipped) {
      const tsconfig = PROGRAMS[name].replace(/\./g, '\\.');
      expect(scripts[`build:${name}`], `build:${name} no longer compiles ${PROGRAMS[name]}`)
        .toMatch(new RegExp(`^tsc -p ${tsconfig}(\\s|$)`));
      expect(ci, `ci.yml no longer runs build:${name}`).toMatch(new RegExp(`npm run build:${name}(?![\\w:-])`));
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
