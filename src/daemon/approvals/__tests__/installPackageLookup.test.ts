import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jsLockNames, newPackagesForCommand, projectDirs, sanitizeNewPackages } from '../installPackageLookup';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-new-pkg-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const names = (command: string, cwd = root) => newPackagesForCommand(command, cwd)?.map((p) => `${p.name}<${p.checked}`);

describe('newPackagesForCommand', () => {
  it('a dependency package.json lists is known; one it does not is new', () => {
    write('package.json', JSON.stringify({ dependencies: { react: '^18' }, devDependencies: { vitest: '2' } }));
    expect(names('npm i react vitest')).toBeUndefined();
    expect(names('npm i react react-codeshift')).toEqual(['react-codeshift<package.json']);
  });

  it('optional and peer dependencies count', () => {
    write('package.json', JSON.stringify({ optionalDependencies: { fsevents: '*' }, peerDependencies: { vue: '3' } }));
    expect(names('pnpm add fsevents vue')).toBeUndefined();
  });

  it('says nothing without a manifest to compare with', () => {
    expect(names('npm i anything')).toBeUndefined();
    expect(names('pip install anything')).toBeUndefined();
    expect(names('cargo add anything')).toBeUndefined();
  });

  it('a lockfile entry (a transitive dependency) is known, bounded by delimiters', () => {
    write('package.json', JSON.stringify({ dependencies: {} }));
    write('package-lock.json', JSON.stringify({ packages: { 'node_modules/express': {}, 'node_modules/@types/react': {} } }));
    expect(names('npm i express')).toBeUndefined();
    // `expres` is inside `express` and `react` inside `@types/react`: neither is in the project.
    expect(names('npm i expres react')).toEqual(['expres<package.json', 'react<package.json']);
  });

  it('pnpm and yarn lockfile shapes', () => {
    expect(jsLockNames('/lodash@4.17.21:\n  resolution: {}', 'lodash')).toBe(true);
    expect(jsLockNames('  lodash:\n    specifier: ^4', 'lodash')).toBe(true);
    expect(jsLockNames('"@babel/core@^7.0.0":\n  version "7.1"', '@babel/core')).toBe(true);
    expect(jsLockNames('lodash-es@^4:\n', 'lodash')).toBe(false);
  });

  it('a lockfile alone, with no manifest, says nothing', () => {
    write('yarn.lock', 'left-pad@^1:\n  version "1.3.0"\n');
    expect(names('yarn add some-new-thing')).toBeUndefined();
  });

  it('an installed package or a local bin is known (npx tsc)', () => {
    write('package.json', JSON.stringify({ devDependencies: { typescript: '5' } }));
    write('node_modules/.bin/tsc', '');
    write('node_modules/semver/package.json', '{}');
    expect(names('npx tsc --noEmit')).toBeUndefined();
    expect(names('npm i semver')).toBeUndefined();
  });

  it('looks up to the repo root (a `.git` file in a worktree), not past it', () => {
    write('.git', 'gitdir: /elsewhere');
    write('package.json', JSON.stringify({ dependencies: { zod: '3' } }));
    write('packages/app/package.json', JSON.stringify({ dependencies: {} }));
    const app = path.join(root, 'packages/app');
    expect(names('pnpm add zod', app)).toBeUndefined();
    expect(names('pnpm add zzod', app)).toEqual(['zzod<package.json']);
    expect(projectDirs(app)).toEqual([app, path.join(root, 'packages'), root]);
  });

  it('without a repo root in reach, only the directory itself', () => {
    write('package.json', JSON.stringify({ dependencies: { zod: '3' } }));
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    // No `.git` anywhere up to /: only `sub` is read, and it has no manifest.
    expect(projectDirs(sub)).toEqual([sub]);
    expect(names('npm i other', sub)).toBeUndefined();
  });

  it('python: pyproject, requirements and uv.lock, names normalized', () => {
    write('pyproject.toml', '[project]\nname = "app"\ndependencies = ["Requests>=2", "pydantic"]\n');
    write('requirements-dev.txt', 'pytest==8 # tests\n-r base.txt\n');
    write('uv.lock', '[[package]]\nname = "charset-normalizer"\n');
    expect(names('pip install requests pytest charset_normalizer')).toBeUndefined();
    expect(names('uv add reqeusts')).toEqual(['reqeusts<pyproject.toml']);
  });

  it('python: requirements alone is a manifest', () => {
    write('requirements.txt', 'flask\n');
    expect(names('pip install flask')).toBeUndefined();
    expect(names('pip install flsak')).toEqual(['flsak<requirements.txt']);
  });

  it('cargo: Cargo.toml and Cargo.lock, `-`/`_` alike', () => {
    write('Cargo.toml', '[package]\nname = "app"\n[dependencies]\nserde = "1"\n[dependencies.tokio]\nversion = "1"\n');
    write('Cargo.lock', '[[package]]\nname = "serde_derive"\n');
    expect(names('cargo add serde tokio serde-derive')).toBeUndefined();
    expect(names('cargo add sered')).toEqual(['sered<Cargo.toml']);
  });

  it('an unreadable manifest says nothing for that ecosystem', () => {
    write('package.json', '{ not json');
    write('requirements.txt', 'flask\n');
    expect(names('npm i x && pip install y')).toEqual(['y<requirements.txt']);
  });

  it('a command that installs nothing reads no file', () => {
    let called = false;
    expect(newPackagesForCommand('ls -la', root, () => { called = true; return true; })).toBeUndefined();
    expect(called).toBe(false);
  });

  it('the setting off computes nothing', () => {
    write('package.json', JSON.stringify({ dependencies: {} }));
    expect(newPackagesForCommand('npm i x', root, () => false)).toBeUndefined();
    expect(newPackagesForCommand('npm i x', root, () => true)).toEqual([{ ecosystem: 'npm', name: 'x', checked: 'package.json', via: 'install' }]);
  });
});

describe('sanitizeNewPackages', () => {
  it('keeps well-formed entries and drops the rest', () => {
    expect(sanitizeNewPackages([
      { ecosystem: 'npm', name: '@s/x', checked: 'package.json', via: 'run' },
      { ecosystem: 'gem', name: 'x', checked: 'Gemfile' },
      { ecosystem: 'npm', name: 'x\u001b[31m', checked: 'package.json' },
      'nope',
    ])).toEqual([{ ecosystem: 'npm', name: '@s/x', checked: 'package.json', via: 'run' }]);
    expect(sanitizeNewPackages([])).toBeUndefined();
    expect(sanitizeNewPackages('x')).toBeUndefined();
  });
});
