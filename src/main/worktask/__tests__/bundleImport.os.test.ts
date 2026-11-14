import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  BUNDLE_IMPORT_GIT_FLOOR, findImportGit, gitAtLeast, importBundle, importGit, importGitEnv, importGitWith, noHooksDirReady, openHomeRepo, parseBundleHeader, parseGitVersion,
  type BundleImportInput, type ImportGit,
} from '../bundleImport';
import { trackedTempDir } from '../../../test-utils/trackedTempDir';

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

const SPAWN = 'sp-11111111-2222-4333-8444-555555555555';
/** This runner's git, named in the measurement's title. */
const RUNNER_GIT = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();

/**
 * The import as shipped (its floor included). A runner whose git is below the floor fails here, loudly and by that
 * name, never as a failure of the behaviour under test.
 */
async function importOnRunner(input: BundleImportInput, git: ImportGit = importGit): ReturnType<typeof importBundle> {
  const res = await importBundle(input, git);
  if (!res.ok && res.reason === 'git-too-old') {
    throw new Error(`below floor: this runner's ${RUNNER_GIT} is older than the bundle import's floor ${BUNDLE_IMPORT_GIT_FLOOR.join('.')}`);
  }
  return res;
}
const TREE = 'sp-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const REF = `refs/wmux/bundle/${TREE}`;
const BRANCH = `refs/heads/wmux/returned/${SPAWN}`;

describe('parseBundleHeader', () => {
  const oid = 'a'.repeat(40);
  const h = (s: string): ReturnType<typeof parseBundleHeader> => parseBundleHeader(Buffer.from(s, 'latin1'));

  it('reads a v2 and a v3 header with prerequisites and refs', () => {
    const v2 = `# v2 git bundle\n-${oid} base\n${'b'.repeat(40)} ${REF}\n\n`;
    expect(h(`${v2}PACK`)).toEqual({ version: 2, objectFormat: 'sha1', prerequisites: [oid], refs: [{ oid: 'b'.repeat(40), name: REF }], packOffset: v2.length });
    expect(h(`# v3 git bundle\n@object-format=sha256\n${'c'.repeat(64)} ${REF}\n\n`)).toMatchObject({ version: 3, objectFormat: 'sha256', refs: [{ name: REF }] });
  });

  it('refuses another version, an unknown capability, a malformed line or no end of header', () => {
    expect(h(`# v4 git bundle\n${oid} ${REF}\n\n`)).toBeNull();
    expect(h(`# v3 git bundle\n@filter=blob:none\n${oid} ${REF}\n\n`)).toBeNull();
    expect(h(`# v2 git bundle\n@object-format=sha1\n${oid} ${REF}\n\n`)).toBeNull();
    expect(h(`# v2 git bundle\n${oid} HEAD\n\n`)).toBeNull();
    expect(h(`# v2 git bundle\n${'c'.repeat(64)} ${REF}\n\n`)).toBeNull();
    expect(h(`# v2 git bundle\n${oid} ${REF}\n`)).toBeNull();
  });
});

describe('the git version floor', () => {
  it('reads git\'s version line on each platform, and compares it with the floor', () => {
    expect(parseGitVersion('git version 2.50.1 (Apple Git-155)\n')).toEqual([2, 50, 1]);
    expect(parseGitVersion('git version 2.47.1.windows.2')).toEqual([2, 47, 1]);
    expect(parseGitVersion('git version 2.43.0')).toEqual([2, 43, 0]);
    expect(parseGitVersion('hub version 2.14.2')).toBeNull();
    expect(parseGitVersion('')).toBeNull();
    expect(gitAtLeast([2, 50, 1], [2, 50, 1])).toBe(true);
    expect(gitAtLeast([3, 0, 0], [2, 50, 1])).toBe(true);
    expect(gitAtLeast([2, 51, 0], [2, 50, 1])).toBe(true);
    expect(gitAtLeast([2, 50, 0], [2, 50, 1])).toBe(false);
    expect(gitAtLeast([2, 9, 9], [2, 50, 1])).toBe(false);
  });
});

describe('importBundle (real git)', () => {
  let root: string;
  let home: string;
  let box: string;
  let base: string;
  let noHooks: string;

  /** A bundle of `rev` past `exclude`, made on the box under `refs`, and the input that imports it. */
  const bundleOf = (name: string, refs: string[] = [REF], exclude = base, rev = 'HEAD'): BundleImportInput => {
    for (const r of refs) g(box, 'update-ref', r, rev);
    const file = path.join(root, `${name}.bundle`);
    g(box, 'bundle', 'create', '-q', file, ...refs, `^${exclude}`);
    return inputFor(file);
  };
  const inputFor = (file: string): BundleImportInput => {
    const bytes = fs.readFileSync(file);
    return {
      top: home, gitDir: fs.realpathSync.native(path.join(home, '.git')), spawnId: SPAWN, file, ref: REF, noHooksDir: noHooks,
      manifest: { bundleId: 'bd-11111111-2222-4333-8444-555555555555', sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length },
    };
  };
  const tipOf = (repo: string, ref: string): string | null => {
    try {
      return g(repo, 'rev-parse', '--verify', '--quiet', ref);
    } catch {
      return null;
    }
  };
  /** An object written as given, unchecked (a tree with names git would refuse). */
  const rawObject = (type: string, body: Buffer): string =>
    execFileSync('git', ['hash-object', '-t', type, '-w', '--literally', '--stdin'], { cwd: box, input: body, encoding: 'utf8' }).trim();
  const blob = (text: string): string => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: box, input: text, encoding: 'utf8' }).trim();
  const tree = (entries: Array<[mode: string, name: string, oid: string]>): string =>
    rawObject('tree', Buffer.concat(entries.map(([mode, name, oid]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`, 'latin1'), Buffer.from(oid, 'hex')]))));
  /** A commit on `base` whose tree is base's a.txt plus `extra`. */
  const commitWith = (extra: Array<[string, string, string]>): string => {
    const a = g(box, 'rev-parse', `${base}:a.txt`);
    const entries = [...extra, ['100644', 'a.txt', a] as [string, string, string]].sort((x, y) => (x[1] < y[1] ? -1 : 1));
    return g(box, 'commit-tree', tree(entries), '-p', base, '-m', 'hostile');
  };
  /** What git leaves in the pack folder (the measurement prints it). */
  const packFiles = (): string[] => fs.readdirSync(path.join(home, '.git', 'objects', 'pack')).sort();

  /** The cases every runner's git must refuse through the import's index-pack. */
  const hostile = (): Array<{ name: string; input: () => BundleImportInput }> => [
    { name: 'a .gitmodules whose submodule name climbs out', input: () => bundleOf('h-name', [REF], base, commitWith([['100644', '.gitmodules', blob('[submodule "../../../hooks"]\n\tpath = x\n\turl = ./x\n')]])) },
    { name: 'a symlinked .gitmodules', input: () => bundleOf('h-link', [REF], base, commitWith([['120000', '.gitmodules', blob('../../outside')]])) },
    { name: 'a tree with a .git entry', input: () => bundleOf('h-dotgit', [REF], base, commitWith([['40000', '.git', tree([['100644', 'config', blob('[core]\n\tbare = false\n')]])]])) },
    { name: 'a tree with a .. entry', input: () => bundleOf('h-dotdot', [REF], base, commitWith([['40000', '..', tree([['100644', 'x', blob('x\n')]])]])) },
    { name: 'a tree with a .GIT entry', input: () => bundleOf('h-dotgit-case', [REF], base, commitWith([['40000', '.GIT', tree([['100644', 'config', blob('x\n')]])]])) },
    { name: 'a tree with a git~1 entry', input: () => bundleOf('h-dotgit-ntfs', [REF], base, commitWith([['40000', 'git~1', tree([['100644', 'config', blob('x\n')]])]])) },
    { name: 'a .gitmodules url that starts with -', input: () => bundleOf('h-url', [REF], base, commitWith([['100644', '.gitmodules', blob('[submodule "x"]\n\tpath = x\n\turl = -x\n')]])) },
    { name: 'a .gitmodules update command', input: () => bundleOf('h-update', [REF], base, commitWith([['100644', '.gitmodules', blob('[submodule "x"]\n\tpath = x\n\turl = ./x\n\tupdate = !true\n')]])) },
    { name: 'a symlinked .gitattributes', input: () => bundleOf('h-attr-link', [REF], base, commitWith([['120000', '.gitattributes', blob('../../outside')]])) },
    { name: 'a tree with duplicate entries', input: () => bundleOf('h-dup', [REF], base, commitWith([['100644', 'a.txt', blob('again\n')]])) },
    { name: 'a tip that is not a commit', input: () => { g(box, 'tag', '-a', '-m', 't', 'not-a-commit', 'HEAD'); return bundleOf('h-tag', [REF], base, g(box, 'rev-parse', 'not-a-commit')); } },
    {
      // The manifest is computed over the damaged file, as a box would name it: the hash passes and git refuses the pack.
      name: 'a damaged pack',
      input: () => {
        const input = bundleOf('h-damaged');
        const bytes = fs.readFileSync(input.file);
        bytes[bytes.length - 30] ^= 0xff;
        fs.writeFileSync(input.file, bytes);
        return inputFor(input.file);
      },
    },
  ];

  beforeEach(() => {
    root = fs.realpathSync(trackedTempDir('wmux-bundle-import-'));
    home = path.join(root, 'home');
    box = path.join(root, 'box');
    noHooks = path.join(root, 'no-hooks');
    execFileSync('git', ['init', '-q', '-b', 'main', home]);
    // Big enough that the box's change to it is packed as a delta against base's copy: the bundle's pack is thin.
    fs.writeFileSync(path.join(home, 'a.txt'), Array.from({ length: 400 }, (_, i) => `line ${i} of the base file\n`).join(''));
    g(home, 'add', 'a.txt');
    g(home, 'commit', '-q', '-m', 'base');
    base = g(home, 'rev-parse', 'HEAD');
    execFileSync('git', ['clone', '-q', home, box]);
    fs.writeFileSync(path.join(box, 'b.txt'), 'agent work\n');
    fs.appendFileSync(path.join(box, 'a.txt'), 'one more line from the agent\n');
    g(box, 'add', 'a.txt', 'b.txt');
    g(box, 'commit', '-q', '-m', 'work');
  });

  it('indexes the pack and sets wmux/returned/<spawn id>, checks nothing out, and a repeat is a no-op', async () => {
    const input = bundleOf('ok');
    const headBefore = g(home, 'rev-parse', 'HEAD');
    const res = await importOnRunner(input);
    const tip = g(box, 'rev-parse', 'HEAD');
    expect(res).toEqual({ ok: true, branch: `wmux/returned/${SPAWN}`, sha: tip, noop: false, warnings: [] });
    expect(tipOf(home, BRANCH)).toBe(tip);
    expect(g(home, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(fs.existsSync(path.join(home, 'b.txt'))).toBe(false);
    expect(g(home, 'status', '--porcelain')).toBe('');
    // Nothing but the branch: no remote, no FETCH_HEAD, no bundle ref.
    expect(tipOf(home, REF)).toBeNull();
    expect(fs.existsSync(path.join(home, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(g(home, 'remote')).toBe('');
    g(home, 'fsck', '--strict', '--no-dangling');
    expect(await importOnRunner(input)).toMatchObject({ ok: true, sha: tip, noop: true });
  });

  it('completes a thin pack from the prerequisites', async () => {
    const input = bundleOf('thin');
    const bytes = fs.readFileSync(input.file);
    const pack = bytes.subarray(parseBundleHeader(bytes)!.packOffset);
    // Thin: index-pack without --fix-thin cannot resolve its deltas.
    expect(() => execFileSync('git', ['index-pack', '--stdin'], { cwd: home, input: pack, stdio: ['pipe', 'pipe', 'pipe'] })).toThrow();
    const res = await importOnRunner(input);
    expect(res.ok).toBe(true);
    expect(g(home, 'show', `${BRANCH}:a.txt`).endsWith('one more line from the agent')).toBe(true);
    g(home, 'fsck', '--strict', '--no-dangling');
  });

  it('runs no hook of the home repository, the reference-transaction hook included', async () => {
    const sentinel = path.join(root, 'hook-ran');
    const hooks = path.join(home, '.git', 'hooks');
    for (const name of ['reference-transaction', 'post-checkout', 'post-merge', 'pre-auto-gc', 'fsmonitor-watchman']) {
      fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\necho ${name} >> '${sentinel}'\n`, { mode: 0o755 });
    }
    const res = await importOnRunner(bundleOf('hooks'));
    expect(res.ok).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('takes only the ref this PC computed: another ref, or two refs, write nothing', async () => {
    const wrong = bundleOf('wrong', ['refs/heads/main']);
    expect(await importOnRunner(wrong)).toEqual({ ok: false, reason: 'bundle-unexpected' });
    const two = bundleOf('two', [REF, 'refs/wmux/bundle/other']);
    expect(await importOnRunner(two)).toEqual({ ok: false, reason: 'bundle-unexpected' });
    expect(tipOf(home, BRANCH)).toBeNull();
  });

  it('refuses a spawn id that is not an sp-<uuid> before git runs', async () => {
    const input = bundleOf('id');
    expect(await importOnRunner({ ...input, spawnId: '../../heads/main' })).toEqual({ ok: false, reason: 'bundle-unexpected' });
    expect(tipOf(home, 'refs/heads/main')).toBe(base);
  });

  it('refuses a file whose size or hash is not the manifest\'s', async () => {
    const input = bundleOf('sha');
    expect(await importOnRunner({ ...input, manifest: { ...input.manifest, sha256: 'f'.repeat(64) } })).toEqual({ ok: false, reason: 'bundle-unexpected' });
    expect(await importOnRunner({ ...input, manifest: { ...input.manifest, bytes: input.manifest.bytes + 1 } })).toEqual({ ok: false, reason: 'bundle-unexpected' });
    expect(tipOf(home, BRANCH)).toBeNull();
  });

  it('answers base-not-local when the home repository lacks a prerequisite, and writes nothing', async () => {
    fs.writeFileSync(path.join(box, 'c.txt'), 'more\n');
    g(box, 'add', 'c.txt');
    g(box, 'commit', '-q', '-m', 'more');
    // Its prerequisite is the box's own first commit of work, which the home repository never had.
    const input = bundleOf('prereq', [REF], 'HEAD~1');
    expect(await importOnRunner(input)).toEqual({ ok: false, reason: 'base-not-local' });
    expect(tipOf(home, BRANCH)).toBeNull();
  });

  it('refuses to move a returned branch that holds other work (no force)', async () => {
    fs.writeFileSync(path.join(home, 'mine.txt'), 'mine\n');
    g(home, 'add', 'mine.txt');
    g(home, 'commit', '-q', '-m', 'mine');
    const mine = g(home, 'rev-parse', 'HEAD');
    g(home, 'update-ref', BRANCH, mine);
    expect(await importOnRunner(bundleOf('nonff'))).toEqual({ ok: false, reason: 'not-fast-forward' });
    expect(tipOf(home, BRANCH)).toBe(mine);
  });

  it('moves a returned branch forward, compare-and-swap from the commit it read', async () => {
    g(home, 'update-ref', BRANCH, base);
    const res = await importOnRunner(bundleOf('ff'));
    expect(res).toMatchObject({ ok: true, noop: false });
    expect(tipOf(home, BRANCH)).toBe(g(box, 'rev-parse', 'HEAD'));
  });

  it('refuses a returned branch that is a symbolic ref, and moves neither it nor what it points to', async () => {
    g(home, 'symbolic-ref', BRANCH, 'refs/heads/main');
    expect(await importOnRunner(bundleOf('symref'))).toEqual({ ok: false, reason: 'import-failed' });
    expect(tipOf(home, 'refs/heads/main')).toBe(base);
  });

  it(`measurement: ${RUNNER_GIT} refuses every hostile case through the import's index-pack (floor bypassed; never skipped)`, async () => {
    const refsBefore = g(home, 'for-each-ref', '--format=%(refname)');
    const results: Array<{ name: string; res: unknown }> = [];
    for (const c of hostile()) {
      // The floor is bypassed with the test-only seam (a floor of 0.0.0): this measures git, not the floor.
      const res = await importBundle(c.input(), importGit, [0, 0, 0]);
      console.info(`[bundleImport measurement] ${RUNNER_GIT}: ${c.name}: ${res.ok ? 'NOT refused' : `refused (${res.reason})`}; pack folder: ${packFiles().join(' ') || '(empty)'}`);
      results.push({ name: c.name, res });
    }
    expect({ git: RUNNER_GIT, results }).toEqual({ git: RUNNER_GIT, results: hostile().map((c) => ({ name: c.name, res: { ok: false, reason: 'import-failed' } })) });
    expect(tipOf(home, BRANCH)).toBeNull();
    expect(g(home, 'for-each-ref', '--format=%(refname)')).toBe(refsBefore);
    expect(fs.existsSync(path.join(home, '.git', 'FETCH_HEAD'))).toBe(false);
  });

  it('refuses before indexing when git is older than the floor or its version cannot be read', async () => {
    const input = bundleOf('old');
    for (const out of ['git version 2.20.1', `git version ${BUNDLE_IMPORT_GIT_FLOOR[0]}.${BUNDLE_IMPORT_GIT_FLOOR[1]}.${BUNDLE_IMPORT_GIT_FLOOR[2] - 1}`, 'not git', '']) {
      const calls: string[][] = [];
      const old: ImportGit = (args, cwd, opts) => {
        calls.push(args);
        return args.includes('--version') ? Promise.resolve({ code: 0, stdout: `${out}\n`, stderr: '' }) : importGit(args, cwd, opts);
      };
      expect(await importBundle(input, old)).toEqual({ ok: false, reason: 'git-too-old' });
      expect(calls.some((a) => a.includes('index-pack'))).toBe(false);
    }
    expect(tipOf(home, BRANCH)).toBeNull();
    // At the floor and above it, the import goes on.
    for (const out of [`git version ${BUNDLE_IMPORT_GIT_FLOOR.join('.')}`, `git version ${BUNDLE_IMPORT_GIT_FLOOR[0]}.${BUNDLE_IMPORT_GIT_FLOOR[1] + 1}.0.windows.1`]) {
      const at: ImportGit = (args, cwd, opts) => (args.includes('--version') ? Promise.resolve({ code: 0, stdout: `${out}\n`, stderr: '' }) : importGit(args, cwd, opts));
      expect((await importBundle(input, at)).ok).toBe(true);
    }
  });

  it('refuses, and does not move, a returned branch checked out in any worktree', async () => {
    const other = path.join(root, 'wt');
    g(home, 'worktree', 'add', '-q', '-b', `wmux/returned/${SPAWN}`, other, base);
    expect(await importOnRunner(bundleOf('wt'))).toEqual({ ok: false, reason: 'import-failed' });
    expect(tipOf(home, BRANCH)).toBe(base);
    g(home, 'worktree', 'remove', '--force', other);
    // Checked out in the home repository's own worktree.
    g(home, 'checkout', '-q', `wmux/returned/${SPAWN}`);
    expect(await importOnRunner(bundleOf('main-wt'))).toEqual({ ok: false, reason: 'import-failed' });
    expect(tipOf(home, BRANCH)).toBe(base);
  });

  it('reads the repository\'s config again right before indexing: a key added after it was opened is refused', async () => {
    const input = bundleOf('late-config');
    let added = false;
    const late: ImportGit = (args, cwd, opts) => {
      // Added once the version is read, after the home repository was opened.
      if (!added && args.includes('--version')) {
        added = true;
        g(home, 'config', 'url./elsewhere/.insteadOf', '/');
      }
      return importGit(args, cwd, opts);
    };
    expect(await importOnRunner(input, late)).toEqual({ ok: false, reason: 'home-repo-config', kind: 'url' });
    g(home, 'config', '--remove-section', 'url./elsewhere/');
    g(home, 'config', 'fsck.hasDotgit', 'ignore');
    expect(await importOnRunner(input)).toEqual({ ok: false, reason: 'home-repo-config', kind: 'fsck' });
    expect(tipOf(home, BRANCH)).toBeNull();
  });

  it('runs index-pack strict and update-ref compare-and-swap, every git with the empty hooks folder, and no transport', async () => {
    const calls: string[][] = [];
    const recording: ImportGit = (args, cwd, opts) => {
      calls.push(args);
      return importGit(args, cwd, opts);
    };
    const input = bundleOf('argv');
    expect((await importOnRunner(input, recording)).ok).toBe(true);
    for (const a of calls) expect(a).toEqual(expect.arrayContaining(['core.fsmonitor=false', `core.hooksPath=${noHooks}`]));
    expect(calls.some((a) => a.some((x) => ['fetch', 'clone', 'pull', 'remote', 'ls-remote'].includes(x)))).toBe(false);
    const index = calls.find((a) => a.includes('index-pack'))!;
    expect(index.slice(index.indexOf('index-pack'))).toEqual(['index-pack', '--stdin', '--fix-thin', '--strict=gitattributesSymlink=error,gitignoreSymlink=error,mailmapSymlink=error', '--fsck-objects']);
    const update = calls.find((a) => a.includes('update-ref'))!;
    expect(update.slice(update.indexOf('update-ref'))).toEqual(['update-ref', '--no-deref', '-m', 'wmux: bring back', BRANCH, g(box, 'rev-parse', 'HEAD'), '0'.repeat(40)]);
  });

  it('refuses a home repository whose .git was swapped after it was opened', async () => {
    const input = bundleOf('swapped');
    fs.renameSync(path.join(home, '.git'), path.join(root, 'home-git'));
    fs.writeFileSync(path.join(home, '.git'), `gitdir: ${path.join(box, '.git')}\n`);
    expect(await importOnRunner(input)).toEqual({ ok: false, reason: 'import-failed' });
    expect(tipOf(box, BRANCH)).toBeNull();
    fs.rmSync(path.join(home, '.git'));
    fs.renameSync(path.join(root, 'home-git'), path.join(home, '.git'));
    expect(tipOf(home, BRANCH)).toBeNull();
  });

  it('refuses when no git is found on this PC, before anything runs', async () => {
    const input = bundleOf('no-git');
    expect(await importBundle(input, importGitWith(() => null))).toEqual({ ok: false, reason: 'git-missing' });
    expect(await openHomeRepo(home, importGitWith(() => null))).toEqual({ ok: false, reason: 'git-missing' });
    expect(tipOf(home, BRANCH)).toBeNull();
  });

  it('refuses a hooks folder that is not empty or not a folder', async () => {
    const input = bundleOf('hooks-dir');
    fs.mkdirSync(noHooks, { recursive: true });
    fs.writeFileSync(path.join(noHooks, 'reference-transaction'), '#!/bin/sh\n', { mode: 0o755 });
    expect(await importOnRunner(input)).toEqual({ ok: false, reason: 'import-failed' });
    fs.rmSync(noHooks, { recursive: true });
    fs.writeFileSync(noHooks, 'a file');
    expect(await importOnRunner(input)).toEqual({ ok: false, reason: 'import-failed' });
    expect(tipOf(home, BRANCH)).toBeNull();
  });
});

describe('the import\'s git', () => {
  it('runs with no global or system config and no variable that moves git elsewhere', () => {
    const env = importGitEnv({ PATH: '/bin', GIT_DIR: '/x', GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='x'", GIT_CONFIG_GLOBAL: '/home/me/.gitconfig' });
    expect(env).toMatchObject({ PATH: '/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
    expect(env['GIT_DIR']).toBeUndefined();
    expect(env['GIT_CONFIG_PARAMETERS']).toBeUndefined();
  });

  it('pipes stdin to git', async () => {
    const dir = fs.realpathSync(trackedTempDir('wmux-import-git-'));
    const out = await importGit(['hash-object', '--stdin'], dir, { stdin: Readable.from([Buffer.from('abc')]) });
    expect(out).toMatchObject({ code: 0, stdout: 'f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f\n' });
  });

  it.skipIf(process.platform === 'win32')('past its time, kills git and what git started', async () => {
    const dir = fs.realpathSync(trackedTempDir('wmux-import-git-'));
    const pidFile = path.join(dir, 'pid');
    const startedAt = Date.now();
    const out = await importGit(['-c', `alias.hang=!echo $$ > '${pidFile}'; exec sleep 30`, 'hang'], dir, { timeoutMs: 1_000 });
    expect(out.code).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    const gone = (): boolean => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    await expect.poll(gone, { timeout: 5_000 }).toBe(true);
  });

  it('finds git only in an absolute folder of PATH, never as a bare name', () => {
    const found = findImportGit(process.env);
    expect(found !== null && path.isAbsolute(found)).toBe(true);
    expect(findImportGit({ PATH: '' })).toBeNull();
    if (process.platform !== 'win32') {
      // A relative folder (here, one holding a git) is skipped.
      const dir = fs.realpathSync(trackedTempDir('wmux-find-git-'));
      fs.writeFileSync(path.join(dir, 'git'), '#!/bin/sh\n', { mode: 0o755 });
      expect(findImportGit({ PATH: path.relative(process.cwd(), dir) })).toBeNull();
      expect(findImportGit({ PATH: dir })).toBe(path.join(dir, 'git'));
    }
  });

  it('takes a hooks folder only while it is ours, a real folder, and empty; it is made 0700 when missing', () => {
    const dir = fs.realpathSync(trackedTempDir('wmux-no-hooks-'));
    const made = path.join(dir, 'a', 'no-hooks');
    expect(noHooksDirReady(made)).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(made).mode & 0o777).toBe(0o700);
    if (process.platform !== 'win32') {
      // An existing folder open to others is refused.
      fs.chmodSync(made, 0o755);
      expect(noHooksDirReady(made)).toBe(false);
      fs.chmodSync(made, 0o700);
    }
    fs.writeFileSync(path.join(made, 'x'), '');
    expect(noHooksDirReady(made)).toBe(false);
    if (process.platform !== 'win32') {
      const link = path.join(dir, 'link');
      fs.mkdirSync(path.join(dir, 'empty'));
      fs.symlinkSync(path.join(dir, 'empty'), link);
      expect(noHooksDirReady(link)).toBe(false);
    }
  });
});

describe('openHomeRepo (real git)', () => {
  it('takes a repository top level with one origin, and refuses a sub-folder, a missing folder and no origin', async () => {
    const root = fs.realpathSync(trackedTempDir('wmux-home-repo-'));
    const repo = path.join(root, 'r');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    expect(await openHomeRepo(repo)).toEqual({ ok: false, reason: 'no-home-repo' });
    g(repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
    expect(await openHomeRepo(repo)).toEqual({ ok: true, top: fs.realpathSync.native(repo), gitDir: fs.realpathSync.native(path.join(repo, '.git')), origin: 'github.com/o/r', linked: false });
    fs.mkdirSync(path.join(repo, 'sub'));
    expect(await openHomeRepo(path.join(repo, 'sub'))).toEqual({ ok: false, reason: 'no-home-repo' });
    expect(await openHomeRepo(path.join(root, 'gone'))).toEqual({ ok: false, reason: 'no-home-repo' });
    g(repo, 'config', 'core.sshCommand', 'touch /tmp/x');
    expect(await openHomeRepo(repo)).toEqual({ ok: false, reason: 'home-repo-config', kind: 'core' });
    g(repo, 'config', '--unset', 'core.sshCommand');
    g(repo, 'config', 'credential.helper', 'store');
    expect(await openHomeRepo(repo)).toEqual({ ok: false, reason: 'home-repo-config', kind: 'credential' });
    g(repo, 'config', '--unset', 'credential.helper');
    g(repo, 'config', 'fetch.fsckObjects', 'false');
    expect(await openHomeRepo(repo)).toEqual({ ok: false, reason: 'home-repo-config', kind: 'fsck' });
    g(repo, 'config', '--unset', 'fetch.fsckObjects');
    // A linked worktree is taken, and said to be one.
    g(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
    const wt = path.join(root, 'wt');
    g(repo, 'worktree', 'add', '-q', '-b', 'other', wt);
    expect(await openHomeRepo(wt)).toEqual({ ok: true, top: fs.realpathSync.native(wt), gitDir: fs.realpathSync.native(path.join(repo, '.git', 'worktrees', 'wt')), origin: 'github.com/o/r', linked: true });
  });

  it('says when the home repository belongs to another user (git\'s ownership check), not that there is none', async () => {
    const repo = fs.realpathSync(trackedTempDir('wmux-home-owner-'));
    const owner: ImportGit = async (args) => (args.includes('--show-toplevel')
      ? { code: 128, stdout: '', stderr: `fatal: detected dubious ownership in repository at '${repo}'\n` }
      : { code: 1, stdout: '', stderr: 'unexpected' });
    expect(await openHomeRepo(repo, owner)).toEqual({ ok: false, reason: 'home-repo-owner' });
  });
});
