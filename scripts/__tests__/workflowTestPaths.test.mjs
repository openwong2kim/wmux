// Every test file a workflow or a package.json script names by path exists.
//
// `vitest run a.test.ts b.test.ts` runs b, passes, and says nothing when a is
// gone, so a renamed or deleted test silently drops out of the CI step that
// named it. (ESLint does fail on a missing path, but only once the step runs,
// which a path-filtered workflow may not do on the PR that broke it.)
// Renaming the integration lane to `*.os.test.*` moved nine such paths at
// once; this guard keeps the next rename from losing one.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A repo-relative path to one test file. Globs (`*`) are left out: they name
// no file in particular.
const TEST_PATH = /(?<![\w./*-])(?:src|scripts|integrations|relay|e2e|rig|bench)\/[\w./@-]*\.test\.(?:tsx?|[cm]?js)(?![\w*])/g;

const sources = [
  ...fs
    .readdirSync(path.join(ROOT, '.github', 'workflows'))
    .filter((name) => /\.ya?ml$/i.test(name))
    .map((name) => `.github/workflows/${name}`),
  'package.json',
];

describe('test paths named by workflows and package.json', () => {
  it('all exist', () => {
    const missing = [];
    let named = 0;
    for (const source of sources) {
      const text = fs.readFileSync(path.join(ROOT, source), 'utf8');
      for (const [file] of text.matchAll(TEST_PATH)) {
        named++;
        if (!fs.existsSync(path.join(ROOT, file))) missing.push(`${source} names ${file}, which does not exist (renamed or deleted?)`);
      }
    }
    expect(missing.join('\n')).toBe('');
    // ci.yml and native-terminal-core.yml name test files today; none found
    // would mean the pattern stopped matching them.
    expect(named).toBeGreaterThan(10);
  });
});
