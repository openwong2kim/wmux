// Test lanes (scripts/lib/test-lanes.mjs, vitest.lanes.json, vitest.config.ts).
//
// The guard half: vitest.lanes.json must be what the rule computes today, and
// a test file that imports child_process must run in the integration lane. A
// new git-backed or process-spawning test therefore either lands in the lane
// (`node scripts/test-lanes.mjs --write`) or carries an explicit
// `// @wmux-lane unit`, and the failure message says which.
//
// The rule half: synthetic trees pin what each rule counts and what it skips.
// Fixture sources spell module names through a variable, so this file's own
// text never reads as an OS import to the rule it tests.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import config from '../../vitest.config.ts';
import {
  LANES_FILE,
  ROOT,
  classifyAll,
  classifyTestFile,
  laneDrift,
  listTestFiles,
  readLanesFile,
  renderLanesFile,
} from '../lib/test-lanes.mjs';

const CP = 'node:' + 'child_process';
const NET = 'net';
const lanes = classifyAll();
const listed = readLanesFile();
const project = (name) => config.test.projects.find((p) => p.test.name === name).test;

describe('the checked-in lanes', () => {
  it('vitest.lanes.json is what the rule computes', () => {
    // Each line names the file, why, and the command or pragma that fixes it.
    expect(laneDrift(listed, lanes).join('\n')).toBe('');
  });

  it('every test file that imports child_process runs in the integration lane', () => {
    const inLane = new Set(listed.integration);
    const offenders = listTestFiles()
      .filter((file) => lanes.byFile.get(file).reasons.includes(`imports node:child_process`))
      .filter((file) => !inLane.has(file))
      .map(
        (file) =>
          `${file} spawns processes but is not in the integration lane: run \`node scripts/test-lanes.mjs --write\`, ` +
          'or put `// @wmux-lane unit` in it with a line saying why it never reaches the OS.',
      );
    expect(offenders.join('\n')).toBe('');
    // A lane with nothing that spawns would mean the rule stopped seeing imports.
    expect(listed.integration.length).toBeGreaterThan(60);
  });

  it('every test file that mentions win32 runs in the integration lane, on Windows', () => {
    const inLane = new Set(listed.integration);
    const offenders = listTestFiles()
      .filter((file) => /win32/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')))
      .filter((file) => !inLane.has(file))
      .map(
        (file) =>
          `${file} mentions win32 but is not in the integration lane, so a PR would run it on Linux only: ` +
          'run `node scripts/test-lanes.mjs --write`, or put `// @wmux-lane unit` in it with a line saying why Windows cannot change its result.',
      );
    expect(offenders.join('\n')).toBe('');
  });

  it('walks exactly the files vitest.config.ts includes', () => {
    const unit = project('unit');
    const globbed = fs
      .globSync(unit.include, { cwd: ROOT })
      .map((f) => f.split(path.sep).join('/'))
      .filter((f) => !/(?:^|\/)(?:node_modules|\.git)\//.test(f) && !/\.runtime\.test\.[^/]+$/.test(f))
      .sort();
    expect(listTestFiles()).toEqual(globbed);
  });

  it('wires the list into the two projects', () => {
    expect(project('integration').include).toEqual(listed.integration);
    expect(project('unit').exclude).toEqual(expect.arrayContaining(listed.integration));
    expect(project('unit').exclude).toEqual(expect.arrayContaining(['**/*.runtime.test.ts']));
    expect(path.relative(ROOT, LANES_FILE)).toBe('vitest.lanes.json');
  });
});

/** A throwaway repo-shaped tree: { 'rel/path': source }. */
function tree(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-lanes-')));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const T = 'src/x/__tests__/a.test.ts';
const classify = (files, file = T) => classifyTestFile(file, { root: tree(files) });

describe('the rule', () => {
  it('counts a direct OS import in any spelling', () => {
    expect(classify({ [T]: `import { spawn } from '${CP}';\n` })).toMatchObject({
      lane: 'integration',
      reasons: ['imports node:child_process'],
    });
    expect(classify({ [T]: `const cp = require("${CP}");\n` }).lane).toBe('integration');
    expect(classify({ [T]: `const net = await import('${NET}');\n` }).reasons).toEqual(['imports node:net']);
    expect(classify({ [T]: `import 'node:${NET}';\n` }).lane).toBe('integration');
  });

  it('keeps a file that names win32 on Windows, whatever it imports', () => {
    expect(classify({ [T]: `it.skipIf(process.platform === 'win32')('x', () => {});\n` })).toMatchObject({
      lane: 'integration',
      reasons: ['mentions win32'],
    });
    expect(classify({ [T]: `// Paths here are POSIX; win32 has its own suite.\n` }).lane).toBe('integration');
    expect(classify({ [T]: `expect(process.platform).toBeDefined();\n` }).lane).toBe('unit');
  });

  it('skips type-only imports and modules the file mocks', () => {
    expect(classify({ [T]: `import type { ChildProcess } from '${CP}';\n` }).lane).toBe('unit');
    expect(classify({ [T]: `import { type Socket, type Server } from '${NET}';\n` }).lane).toBe('unit');
    expect(classify({ [T]: `import { type Socket, connect } from '${NET}';\n` }).lane).toBe('integration');
    expect(
      classify({ [T]: `vi.mock('${CP}', () => ({ spawn: vi.fn() }));\nimport { spawn } from '${CP}';\n` }).lane,
    ).toBe('unit');
    // A module named only in prose or a string that is not an import does not count.
    expect(classify({ [T]: `// runs '${CP}'\nconst name = '${CP}';\n` }).lane).toBe('unit');
  });

  it('lets a pragma decide, and rejects an unknown lane', () => {
    expect(classify({ [T]: `// @wmux-lane unit\nimport { spawn } from '${CP}';\n` })).toEqual({
      file: T,
      lane: 'unit',
      reasons: ['pragma @wmux-lane unit'],
    });
    expect(classify({ [T]: `// @wmux-lane integration\nexport {};\n` }).lane).toBe('integration');
    expect(() => classify({ [T]: '// @wmux-lane slow\n' })).toThrow(/unknown lane "slow"/);
  });

  it('follows test helpers one level: src/test-utils and fixtures in __tests__', () => {
    const helper = { 'src/test-utils/run.ts': `import { spawnSync } from '${CP}';\n` };
    expect(classify({ ...helper, [T]: `import { run } from '../../test-utils/run';\n` }).reasons).toEqual([
      'imports the helper src/test-utils/run.ts, which imports node:child_process',
    ]);
    const twoLevels = {
      ...helper,
      'src/test-utils/wrap.ts': `export { run } from './run';\n`,
      [T]: `import { run } from '../../test-utils/wrap';\n`,
    };
    expect(classify(twoLevels).lane).toBe('unit');
    // A shared fixture next to the tests is a helper too; another test file is not.
    const fixture = { 'src/x/__tests__/fakeServer.ts': `import { createServer } from '${NET}';\n` };
    expect(classify({ ...fixture, [T]: `import { serve } from './fakeServer';\n` }).reasons).toEqual([
      'imports the helper src/x/__tests__/fakeServer.ts, which imports node:net',
    ]);
    const otherTest = { 'src/x/__tests__/b.test.ts': `import { spawn } from '${CP}';\n` };
    expect(classify({ ...otherTest, [T]: `import './b.test';\nfs.mkdtempSync('x');\n` }).lane).toBe('unit');
  });

  it('counts code under test that imports an OS module only when the test makes a temp dir', () => {
    const code = { 'src/x/git.ts': `import { execFile } from '${CP}';\nexport const git = () => {};\n` };
    const withTemp = `import { git } from '../git.js';\nconst dir = fs.mkdtempSync('x');\n`;
    expect(classify({ ...code, [T]: withTemp }).reasons).toEqual([
      'uses mkdtemp and imports src/x/git.ts, which imports node:child_process',
    ]);
    expect(classify({ ...code, [T]: `import { git } from '../git';\n` }).lane).toBe('unit');
    // The module itself mocked, or the OS module it uses mocked: nothing real runs.
    expect(classify({ ...code, [T]: `vi.mock('../git.js');\n${withTemp}` }).lane).toBe('unit');
    expect(classify({ ...code, [T]: `vi.mock('${CP}');\n${withTemp}` }).lane).toBe('unit');
  });

  it('lists the included suites and leaves runtime suites to their own config', () => {
    const root = tree({
      'src/a/__tests__/x.test.ts': '',
      'src/a/__tests__/deep/y.test.tsx': '',
      'src/a/__tests__/z.runtime.test.ts': '',
      'src/a/x.test.ts': '',
      'scripts/__tests__/s.test.mjs': '',
      'integrations/p/__tests__/i.test.ts': '',
      'integrations/p/node_modules/q/__tests__/n.test.ts': '',
      'relay/__tests__/r.test.ts': '',
    });
    expect(listTestFiles(root)).toEqual([
      'integrations/p/__tests__/i.test.ts',
      'relay/__tests__/r.test.ts',
      'scripts/__tests__/s.test.mjs',
      'src/a/__tests__/deep/y.test.tsx',
      'src/a/__tests__/x.test.ts',
    ]);
  });
});

describe('laneDrift', () => {
  const root = tree({
    'src/a/__tests__/spawns.test.ts': `import { spawn } from '${CP}';\n`,
    'src/a/__tests__/pure.test.ts': 'export {};\n',
  });
  const fresh = classifyAll({ root });

  it('is empty for the generated file', () => {
    const text = renderLanesFile(fresh.integration);
    expect(laneDrift({ integration: fresh.integration, text }, fresh)).toEqual([]);
  });

  it('is empty for the generated file checked out with CRLF (Windows, core.autocrlf)', () => {
    const text = renderLanesFile(fresh.integration).replace(/\n/g, '\r\n');
    expect(laneDrift({ integration: fresh.integration, text }, fresh)).toEqual([]);
  });

  it('names the file, the reason, the command and the pragma', () => {
    const [line] = laneDrift({ integration: [], text: renderLanesFile([]) }, fresh);
    expect(line).toContain('src/a/__tests__/spawns.test.ts touches the OS (imports node:child_process)');
    expect(line).toContain('node scripts/test-lanes.mjs --write');
    expect(line).toContain('// @wmux-lane unit');
  });

  it('reports stale, deleted and hand-edited entries', () => {
    const stale = ['src/a/__tests__/pure.test.ts', 'src/a/__tests__/gone.test.ts', ...fresh.integration];
    const drift = laneDrift({ integration: stale, text: renderLanesFile(stale) }, fresh);
    expect(drift).toEqual([
      expect.stringContaining('pure.test.ts is in the integration lane, but the rule now puts it in unit'),
      expect.stringContaining('gone.test.ts is in the integration lane but is not a test file any more'),
    ]);
    const handEdited = `${JSON.stringify({ integration: fresh.integration })}\n`;
    expect(laneDrift({ integration: fresh.integration, text: handEdited }, fresh)).toEqual([
      expect.stringContaining('not in the generated form'),
    ]);
    expect(laneDrift({ integration: [], text: null }, fresh)).toEqual([expect.stringContaining('is missing')]);
  });
});
