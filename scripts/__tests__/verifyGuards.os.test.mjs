// The guard tests scripts/verify.sh runs on every change
// (scripts/lib/verify-guards.mjs, scripts/verify-guards.txt).
//
// `vitest --changed` follows imports from the changed files, and a guard reads
// the tree itself, so a change that breaks a repository rule (a new agent slug
// branch, an RPC change without regenerating docs/api/reference.md) reached
// CI with the gate green. These pin what the gate now runs on top of the
// related tests: the base's list joined with the change's, every listed file
// that exists, and nothing when there is no list.
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUARD_LIST, guardTests, parseGuardList } from '../lib/verify-guards.mjs';

// The resolver tests run real git in a temp repository; bound them by the
// file, not vitest's 5s default (a git spawn is slow on a loaded runner).
vi.setConfig({ testTimeout: 30_000 });

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

function tempRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-verify-guards-')));
  git(root, 'init', '-q');
  return root;
}

describe('parseGuardList', () => {
  it('keeps one path per line and drops comments and blank lines', () => {
    expect(parseGuardList('# why\n\na/one.test.ts\r\n  b/two.test.ts  # trailing note\n#c/three.test.ts\n')).toEqual([
      'a/one.test.ts',
      'b/two.test.ts',
    ]);
  });

  it('writes a Windows separator as /', () => {
    expect(parseGuardList('src\\shared\\__tests__\\x.test.ts\n')).toEqual(['src/shared/__tests__/x.test.ts']);
  });
});

describe('guardTests', () => {
  it('runs the base list joined with the lines the change adds: dropping a line does not drop the guard', () => {
    const root = tempRepo();
    try {
      for (const f of ['g/a.test.ts', 'g/b.test.ts', 'g/c.test.ts']) write(root, f, '');
      write(root, GUARD_LIST, '# guards\ng/a.test.ts\ng/b.test.ts\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'base');
      const base = git(root, 'rev-parse', 'HEAD');
      // The change removes b from the list and adds c.
      write(root, GUARD_LIST, 'g/a.test.ts\ng/c.test.ts\n');
      expect(guardTests({ root, base })).toEqual({ run: ['g/a.test.ts', 'g/b.test.ts', 'g/c.test.ts'], missing: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('names a listed path that is not in the tree, or is outside it, instead of running it', () => {
    const root = tempRepo();
    try {
      write(root, 'g/a.test.ts', '');
      write(root, GUARD_LIST, 'g/a.test.ts\ng/deleted.test.ts\n../outside.test.ts\ng\n');
      expect(guardTests({ root, base: '' })).toEqual({ run: ['g/a.test.ts'], missing: ['g/deleted.test.ts', '../outside.test.ts', 'g'] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('has nothing to run when neither the base nor the tree has a list', () => {
    const root = tempRepo();
    try {
      write(root, 'README.md', 'x\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'base');
      expect(guardTests({ root, base: git(root, 'rev-parse', 'HEAD') })).toEqual({ run: [], missing: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a base it cannot read instead of running the tree list alone', () => {
    const root = tempRepo();
    try {
      write(root, 'g/a.test.ts', '');
      write(root, GUARD_LIST, 'g/a.test.ts\n');
      expect(() => guardTests({ root, base: 'no-such-ref' })).toThrow(/cannot read base commit no-such-ref/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('names a listed path under a file (ENOTDIR) as missing', () => {
    const root = tempRepo();
    try {
      write(root, 'g/a.test.ts', '');
      write(root, GUARD_LIST, 'g/a.test.ts\ng/a.test.ts/inner.test.ts\n');
      expect(guardTests({ root, base: '' })).toEqual({ run: ['g/a.test.ts'], missing: ['g/a.test.ts/inner.test.ts'] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('this repository\'s guard list', () => {
  const listed = parseGuardList(fs.readFileSync(path.join(REPO_ROOT, GUARD_LIST), 'utf8'));

  it('lists the guards that bot pull requests failed in CI', () => {
    expect(listed).toEqual(expect.arrayContaining([
      'src/shared/__tests__/phoneRoomNotices.test.ts',
      'src/shared/__tests__/agentSlugBranches.guard.test.ts',
      'src/renderer/i18n/__tests__/plLocaleCoverage.test.ts',
      'scripts/__tests__/genApiReference.os.test.mjs',
    ]));
  });

  it('lists only main-lane test files that exist (verify.sh runs them with vitest.config.ts)', () => {
    for (const entry of listed) {
      expect(fs.existsSync(path.join(REPO_ROOT, entry)), entry).toBe(true);
      expect(entry, entry).toMatch(/^(?:(?:src|integrations)\/.*__tests__\/.*\.test\.tsx?|scripts\/__tests__\/.*\.test\.mjs|relay\/__tests__\/.*\.test\.ts)$/);
      expect(entry, entry).not.toMatch(/\.runtime\.test\./);
    }
  });

  it('is what verify.sh runs after the related tests', () => {
    const verify = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'verify.sh'), 'utf8');
    expect(verify).toContain('node scripts/verify-guards.mjs "$base"');
    expect(verify.indexOf('verify: guard tests')).toBeGreaterThan(verify.indexOf('verify: related runtime tests'));
  });
});
