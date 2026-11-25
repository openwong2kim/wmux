import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cargoNamesIn, jsLockNames, newPackagesForCommand, projectDirs, pythonNamesIn, sanitizeNewPackages,
} from '../installPackageLookup';

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

const names = async (command: string, cwd = root) => (await newPackagesForCommand(command, cwd))?.map((p) => `${p.name}<${p.checked}`);

describe('newPackagesForCommand', () => {
  it('a dependency package.json lists is known; one it does not is new', async () => {
    write('package.json', JSON.stringify({ dependencies: { react: '^18' }, devDependencies: { vitest: '2' } }));
    expect(await names('npm i react vitest')).toBeUndefined();
    expect(await names('npm i react react-codeshift')).toEqual(['react-codeshift<package.json']);
  });

  it('optional and peer dependencies count', async () => {
    write('package.json', JSON.stringify({ optionalDependencies: { fsevents: '*' }, peerDependencies: { vue: '3' } }));
    expect(await names('pnpm add fsevents vue')).toBeUndefined();
  });

  it('says nothing without a manifest to compare with', async () => {
    expect(await names('npm i anything')).toBeUndefined();
    expect(await names('pip install anything')).toBeUndefined();
    expect(await names('cargo add anything')).toBeUndefined();
  });

  it('a lockfile entry (a transitive dependency) is known, bounded by delimiters', async () => {
    write('package.json', JSON.stringify({ dependencies: {} }));
    write('package-lock.json', JSON.stringify({ packages: { 'node_modules/express': {}, 'node_modules/@types/react': {} } }));
    expect(await names('npm i express')).toBeUndefined();
    // `expres` is inside `express` and `react` inside `@types/react`: neither is in the project.
    expect(await names('npm i expres react')).toEqual(['expres<package.json', 'react<package.json']);
  });

  it('pnpm and yarn lockfile shapes', async () => {
    expect(jsLockNames('/lodash@4.17.21:\n  resolution: {}', 'lodash')).toBe(true);
    expect(jsLockNames('  lodash:\n    specifier: ^4', 'lodash')).toBe(true);
    expect(jsLockNames('"@babel/core@^7.0.0":\n  version "7.1"', '@babel/core')).toBe(true);
    expect(jsLockNames('lodash-es@^4:\n', 'lodash')).toBe(false);
  });

  it('a lockfile alone, with no manifest, says nothing', async () => {
    write('yarn.lock', 'left-pad@^1:\n  version "1.3.0"\n');
    expect(await names('yarn add some-new-thing')).toBeUndefined();
  });

  it('an installed package is known; a local bin only for a run (npx tsc, not npm i tsc)', async () => {
    write('package.json', JSON.stringify({ devDependencies: { typescript: '5' } }));
    write('node_modules/.bin/tsc', '');
    write('node_modules/semver/package.json', '{}');
    expect(await names('npx tsc --noEmit')).toBeUndefined();
    expect(await names('npm i semver')).toBeUndefined();
    // The registry's `tsc` is another package than typescript's bin.
    expect(await names('npm i tsc')).toEqual(['tsc<package.json']);
    // Run AND installed: the install is what is compared.
    expect(await names('npx tsc && npm i tsc')).toEqual(['tsc<package.json']);
  });

  it('a stat that fails for another reason than "missing" says nothing', async () => {
    write('.git', 'gitdir: /elsewhere');
    write('package.json', JSON.stringify({ dependencies: {} }));
    const sub = path.join(root, 'locked');
    fs.mkdirSync(sub);
    // EACCES from the stat itself, not from a chmod: Windows does not honour
    // POSIX modes, so a chmod-made failure is a stat that succeeds there.
    const stat = fsp.stat.bind(fsp);
    const spy = vi.spyOn(fsp, 'stat').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(p)) === path.join(sub, 'package.json')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return stat(p, ...(rest as []));
    }) as typeof fsp.stat);
    try {
      // `locked/package.json` cannot be told present or absent (EACCES): no
      // line, where reading on to the root's empty package.json would say `x`.
      expect(await names('npm i x', sub)).toBeUndefined();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    // The same folder once its stat answers: absent, so the root's empty package.json says `x`.
    expect(await names('npm i x', sub)).toEqual(['x<package.json']);
  });

  it('looks up to the repo root (a `.git` file in a worktree), not past it', async () => {
    write('.git', 'gitdir: /elsewhere');
    write('package.json', JSON.stringify({ dependencies: { zod: '3' } }));
    write('packages/app/package.json', JSON.stringify({ dependencies: {} }));
    const app = path.join(root, 'packages/app');
    expect(await names('pnpm add zod', app)).toBeUndefined();
    expect(await names('pnpm add zzod', app)).toEqual(['zzod<package.json']);
    expect(await projectDirs(app)).toEqual([app, path.join(root, 'packages'), root]);
  });

  it('without a repo root in reach, only the directory itself', async () => {
    write('package.json', JSON.stringify({ dependencies: { zod: '3' } }));
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    // No `.git` anywhere up to /: only `sub` is read, and it has no manifest.
    expect(await projectDirs(sub)).toEqual([sub]);
    expect(await names('npm i other', sub)).toBeUndefined();
  });

  it('python: pyproject, requirements and uv.lock, names normalized', async () => {
    write('pyproject.toml', '[project]\nname = "app"\ndependencies = ["Requests>=2", "pydantic"]\n');
    write('requirements-dev.txt', 'pytest==8 # tests\n-r base.txt\n');
    write('uv.lock', '[[package]]\nname = "charset-normalizer"\n');
    expect(await names('pip install requests pytest charset_normalizer')).toBeUndefined();
    expect(await names('uv add reqeusts')).toEqual(['reqeusts<pyproject.toml']);
  });

  it('python: a pyproject with no dependency table, or a setup.py project, says nothing', async () => {
    write('pyproject.toml', '[tool.ruff]\nline-length = 100\n');
    expect(await names('pip install requests')).toBeUndefined();
    write('pyproject.toml', '[tool.poetry.dependencies]\npython = "^3.11"\n');
    expect(await names('pip install requests')).toEqual(['requests<pyproject.toml']);
    write('setup.py', 'from setuptools import setup\nsetup(install_requires=["requests"])\n');
    expect(await names('pip install requests')).toBeUndefined();
  });

  it('python: setup.cfg lists install_requires unquoted', async () => {
    write('setup.cfg', '[metadata]\nname = app\n[options]\ninstall_requires =\n    requests>=2\n    Flask\n');
    expect(await names('pip install requests flask')).toBeUndefined();
    expect(await names('pip install reqeusts')).toEqual(['reqeusts<setup.cfg']);
  });

  it('python: requirements alone is a manifest', async () => {
    write('requirements.txt', 'flask\n');
    expect(await names('pip install flask')).toBeUndefined();
    expect(await names('pip install flsak')).toEqual(['flsak<requirements.txt']);
  });

  it('cargo: Cargo.toml and Cargo.lock, `-`/`_` alike', async () => {
    write('Cargo.toml', '[package]\nname = "app"\n[dependencies]\nserde = "1"\n[dependencies.tokio]\nversion = "1"\n');
    write('Cargo.lock', '[[package]]\nname = "serde_derive"\n');
    expect(await names('cargo add serde tokio serde-derive')).toBeUndefined();
    expect(await names('cargo add sered')).toEqual(['sered<Cargo.toml']);
  });

  it('an unreadable manifest says nothing for that ecosystem', async () => {
    write('package.json', '{ not json');
    write('requirements.txt', 'flask\n');
    expect(await names('npm i x && pip install y')).toEqual(['y<requirements.txt']);
  });

  it('a command that installs nothing reads no file', async () => {
    let called = false;
    expect(await newPackagesForCommand('ls -la', root, () => { called = true; return true; })).toBeUndefined();
    expect(called).toBe(false);
  });

  it('the setting off computes nothing', async () => {
    write('package.json', JSON.stringify({ dependencies: {} }));
    expect(await newPackagesForCommand('npm i x', root, () => false)).toBeUndefined();
    expect(await newPackagesForCommand('npm i x', root, () => true)).toEqual([{ ecosystem: 'npm', name: 'x', checked: 'package.json', via: 'install' }]);
  });
});

describe('name scans stay linear', () => {
  it('100k blank lines take well under a second', () => {
    const blank = '\n'.repeat(100_000);
    for (const scan of [pythonNamesIn, cargoNamesIn]) {
      const start = performance.now();
      scan(blank);
      scan(`${blank}x`);
      scan(' \n'.repeat(100_000));
      expect(performance.now() - start).toBeLessThan(1_000);
    }
  });
});

describe('sanitizeNewPackages', () => {
  it('keeps well-formed entries and drops the rest', async () => {
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
