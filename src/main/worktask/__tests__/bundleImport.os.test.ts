import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { importBundle, openHomeRepo, parseBundleHeader, type BundleImportInput } from '../bundleImport';
import { defaultGit, type TaskPushGit } from '../taskPush';
import { trackedTempDir } from '../../../test-utils/trackedTempDir';

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

const SPAWN = 'sp-11111111-2222-4333-8444-555555555555';
const TREE = 'sp-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const REF = `refs/wmux/bundle/${TREE}`;
const BRANCH = `refs/heads/wmux/returned/${SPAWN}`;

describe('parseBundleHeader', () => {
  const oid = 'a'.repeat(40);
  const h = (s: string): ReturnType<typeof parseBundleHeader> => parseBundleHeader(Buffer.from(s, 'latin1'));

  it('reads a v2 and a v3 header with prerequisites and refs', () => {
    expect(h(`# v2 git bundle\n-${oid} base\n${'b'.repeat(40)} ${REF}\n\nPACK`)).toEqual({ version: 2, objectFormat: 'sha1', prerequisites: [oid], refs: [{ oid: 'b'.repeat(40), name: REF }] });
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

describe('importBundle (real git)', () => {
  let root: string;
  let home: string;
  let box: string;
  let base: string;
  let noHooks: string;

  /** A bundle of `rev` past `base` made on the box under `refs`, and the input that imports it. */
  const bundleOf = (name: string, refs: string[] = [REF], exclude = base): BundleImportInput => {
    for (const r of refs) g(box, 'update-ref', r, 'HEAD');
    const file = path.join(root, `${name}.bundle`);
    g(box, 'bundle', 'create', '-q', file, ...refs, `^${exclude}`);
    return inputFor(file);
  };
  const inputFor = (file: string): BundleImportInput => {
    const bytes = fs.readFileSync(file);
    return {
      top: home, spawnId: SPAWN, file, ref: REF, noHooksDir: noHooks,
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

  beforeEach(() => {
    root = fs.realpathSync(trackedTempDir('wmux-bundle-import-'));
    home = path.join(root, 'home');
    box = path.join(root, 'box');
    noHooks = path.join(root, 'no-hooks');
    fs.mkdirSync(noHooks);
    execFileSync('git', ['init', '-q', '-b', 'main', home]);
    fs.writeFileSync(path.join(home, 'a.txt'), 'a\n');
    g(home, 'add', 'a.txt');
    g(home, 'commit', '-q', '-m', 'base');
    base = g(home, 'rev-parse', 'HEAD');
    execFileSync('git', ['clone', '-q', home, box]);
    fs.writeFileSync(path.join(box, 'b.txt'), 'agent work\n');
    g(box, 'add', 'b.txt');
    g(box, 'commit', '-q', '-m', 'work');
  });

  it('fetches the one ref into wmux/returned/<spawn id>, checks nothing out, and a repeat is a no-op', async () => {
    const input = bundleOf('ok');
    const headBefore = g(home, 'rev-parse', 'HEAD');
    const res = await importBundle(input);
    const tip = g(box, 'rev-parse', 'HEAD');
    expect(res).toEqual({ ok: true, branch: `wmux/returned/${SPAWN}`, sha: tip, noop: false, warnings: [] });
    expect(tipOf(home, BRANCH)).toBe(tip);
    expect(g(home, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(fs.existsSync(path.join(home, 'b.txt'))).toBe(false);
    expect(g(home, 'status', '--porcelain')).toBe('');
    // Nothing but the branch: no tag, no FETCH_HEAD, no bundle ref.
    expect(tipOf(home, REF)).toBeNull();
    expect(fs.existsSync(path.join(home, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(await importBundle(input)).toMatchObject({ ok: true, sha: tip, noop: true });
  });

  it('runs no hook of the home repository, the reference-transaction hook included', async () => {
    const sentinel = path.join(root, 'hook-ran');
    const hooks = path.join(home, '.git', 'hooks');
    for (const name of ['reference-transaction', 'post-checkout', 'post-merge', 'pre-auto-gc', 'fsmonitor-watchman']) {
      fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\necho ${name} >> '${sentinel}'\n`, { mode: 0o755 });
    }
    const res = await importBundle(bundleOf('hooks'));
    expect(res.ok).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('takes only the ref this PC computed: another ref, or two refs, write nothing', async () => {
    const wrong = bundleOf('wrong', ['refs/heads/main']);
    expect(await importBundle(wrong)).toEqual({ ok: false, reason: 'bundle-unexpected' });
    const two = bundleOf('two', [REF, 'refs/wmux/bundle/other']);
    expect(await importBundle(two)).toEqual({ ok: false, reason: 'bundle-unexpected' });
    expect(tipOf(home, BRANCH)).toBeNull();
  });

  it('refuses a spawn id that is not an sp-<uuid> before git runs', async () => {
    const input = bundleOf('id');
    expect(await importBundle({ ...input, spawnId: '../../heads/main' })).toEqual({ ok: false, reason: 'bundle-unexpected' });
    expect(tipOf(home, 'refs/heads/main')).toBe(base);
  });

  it('refuses a file whose size or hash is not the manifest\'s', async () => {
    const input = bundleOf('sha');
    expect(await importBundle({ ...input, manifest: { ...input.manifest, sha256: 'f'.repeat(64) } })).toEqual({ ok: false, reason: 'bundle-unexpected' });
    expect(await importBundle({ ...input, manifest: { ...input.manifest, bytes: input.manifest.bytes + 1 } })).toEqual({ ok: false, reason: 'bundle-unexpected' });
    expect(tipOf(home, BRANCH)).toBeNull();
  });

  it('answers base-not-local when the home repository lacks a prerequisite, and writes nothing', async () => {
    fs.writeFileSync(path.join(box, 'c.txt'), 'more\n');
    g(box, 'add', 'c.txt');
    g(box, 'commit', '-q', '-m', 'more');
    // Its prerequisite is the box's own first commit of work, which the home repository never had.
    const input = bundleOf('prereq', [REF], 'HEAD~1');
    expect(await importBundle(input)).toEqual({ ok: false, reason: 'base-not-local' });
    expect(tipOf(home, BRANCH)).toBeNull();
  });

  it('refuses to move a returned branch that holds other work (no force)', async () => {
    fs.writeFileSync(path.join(home, 'mine.txt'), 'mine\n');
    g(home, 'add', 'mine.txt');
    g(home, 'commit', '-q', '-m', 'mine');
    const mine = g(home, 'rev-parse', 'HEAD');
    g(home, 'update-ref', BRANCH, mine);
    expect(await importBundle(bundleOf('nonff'))).toEqual({ ok: false, reason: 'not-fast-forward' });
    expect(tipOf(home, BRANCH)).toBe(mine);
  });

  it('refuses a damaged pack (fsck) and writes nothing', async () => {
    const input = bundleOf('corrupt');
    const bytes = fs.readFileSync(input.file);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(input.file, bytes);
    expect(await importBundle(inputFor(input.file))).toEqual({ ok: false, reason: 'import-failed' });
    expect(tipOf(home, BRANCH)).toBeNull();
  });

  it('refuses a hostile .gitmodules (fsck) and writes nothing', async () => {
    fs.writeFileSync(path.join(box, '.gitmodules'), '[submodule "../../../hooks"]\n\tpath = x\n\turl = ./x\n');
    g(box, 'add', '.gitmodules');
    g(box, 'commit', '-q', '-m', 'modules');
    expect(await importBundle(bundleOf('modules'))).toEqual({ ok: false, reason: 'import-failed' });
    expect(tipOf(home, BRANCH)).toBeNull();
  });

  it('runs git with no global or system config, the file after --, no tags, no submodules and no force', async () => {
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const recording: TaskPushGit = (args, cwd, env, opts) => {
      calls.push({ args, env });
      return defaultGit(args, cwd, env, opts);
    };
    const input = bundleOf('argv');
    expect((await importBundle(input, recording)).ok).toBe(true);
    const fetch = calls.find((c) => c.args.includes('fetch'));
    expect(fetch).toBeDefined();
    const a = fetch!.args;
    expect(a.slice(a.indexOf('--'))).toEqual(['--', input.file, `${REF}:${BRANCH}`]);
    expect(a).toEqual(expect.arrayContaining(['--no-tags', '--recurse-submodules=no', 'core.fsmonitor=false', `core.hooksPath=${noHooks}`, 'transfer.fsckObjects=true']));
    expect(a.some((x) => x.startsWith('+'))).toBe(false);
    for (const c of calls) expect(c.env).toMatchObject({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  });
});

describe('openHomeRepo (real git)', () => {
  it('takes a repository top level with one origin, and refuses a sub-folder, a missing folder and no origin', async () => {
    const root = fs.realpathSync(trackedTempDir('wmux-home-repo-'));
    const repo = path.join(root, 'r');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    expect(await openHomeRepo(repo)).toEqual({ ok: false, reason: 'no-home-repo' });
    g(repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
    expect(await openHomeRepo(repo)).toEqual({ ok: true, top: repo, origin: 'github.com/o/r' });
    fs.mkdirSync(path.join(repo, 'sub'));
    expect(await openHomeRepo(path.join(repo, 'sub'))).toEqual({ ok: false, reason: 'no-home-repo' });
    expect(await openHomeRepo(path.join(root, 'gone'))).toEqual({ ok: false, reason: 'no-home-repo' });
    g(repo, 'config', 'core.sshCommand', 'touch /tmp/x');
    expect(await openHomeRepo(repo)).toEqual({ ok: false, reason: 'home-repo-config' });
  });
});
