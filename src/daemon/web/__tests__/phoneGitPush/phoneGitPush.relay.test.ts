import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildGitEnv } from '../../sessionDiff';
import { GitWriteReceipts } from '../../phoneGitWriteGate';
import type { GitWriteExecuteContext, GitWriteSessionContext } from '../../phoneGitWriteRegistry';
import {
  GIT_NULL_DEVICE, PHONE_GIT_RELAY_DIR, createPhoneGitPushHandlers, defaultPushDeps, type PhoneGitPushDeps,
} from '../../phoneGitPush';
import type { GitWritePins, PushPreview } from '../../../../shared/phoneGitWrite';

/**
 * The phone push's network git runs in a daemon-owned relay and reads the
 * pane repository only by the git dirs it found once. Real repositories; the
 * test transport hands git the local bare repository's path in place of the
 * GitHub URL, so no rewrite of the test's own competes with the pane's config.
 */

const URL_ = 'https://github.com/o/r.git';
const TOKEN = 'gho_relaytoken';
const WAIT = { timeout: 15_000 };

describe('phone git push relay', { timeout: 60_000 }, () => {
  let root: string;
  let bare: string;
  let evil: string;
  let work: string;
  let stateDir: string;
  let receipts: GitWriteReceipts | undefined;
  /** Network calls as the handler asked for them (before the test transport). */
  let network: Array<{ args: string[]; env: NodeJS.ProcessEnv }>;
  /** What git would use for the proxy, the credential helpers and the URL, read in each call's relay. */
  let probes: Array<{ proxy: string; helpers: string[]; url: string }>;
  /** Runs during each gh call, i.e. after the config checks and before ls-remote. */
  let onGh: () => void;

  const env = () => ({ ...buildGitEnv(), GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8' }).trim();
  const commit = (cwd: string, msg: string) => {
    git(cwd, 'commit', '-q', '--allow-empty', '-m', msg);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  /** A path as git reports it, resolved (long names on Windows). */
  const real = (p: string) => fs.realpathSync.native(p);
  /** Replace a file: git marks `.git` hidden on Windows, and a hidden file cannot be opened for writing. */
  const rewrite = (p: string, text: string) => { fs.rmSync(p, { force: true }); fs.writeFileSync(p, text); };
  const refsOf = (repo: string) => git(repo, 'for-each-ref', '--format=%(refname) %(objectname)');

  /** The network runner's args with the test transport: the URL → the bare path, file allowed. */
  const transport = (args: readonly string[]) => ['-c', 'protocol.file.allow=always', ...args.map((a) => (a === URL_ ? bare : a))];
  const probe = (args: readonly string[], cwd: string, e: NodeJS.ProcessEnv) => {
    const sub = args.findIndex((a) => a === 'ls-remote' || a === 'push');
    const prefix = args.slice(0, sub);
    const run = (...rest: string[]) => spawnSync('git', [...prefix, ...rest], { cwd, env: e, encoding: 'utf8' }).stdout;
    probes.push({
      proxy: run('config', '--get-urlmatch', 'http.proxy', URL_).trim(),
      helpers: run('config', '--get-all', 'credential.helper').split('\n').slice(0, -1),
      url: run('ls-remote', '--get-url', URL_).trim(),
    });
  };

  const deps = (): PhoneGitPushDeps => ({
    ...defaultPushDeps,
    remote: (args, cwd, e) => {
      network.push({ args: [...args], env: e });
      probe(args, cwd, e);
      return defaultPushDeps.remote(transport(args), cwd, { ...e, GIT_ALLOW_PROTOCOL: 'https:file' });
    },
    push: (args, cwd, e, t) => {
      network.push({ args: [...args], env: e });
      probe(args, cwd, e);
      return defaultPushDeps.push(transport(args), cwd, { ...e, GIT_ALLOW_PROTOCOL: 'https:file' }, t);
    },
    gh: async (args) => {
      onGh();
      if (/^repos\/[^/]+\/[^/]+$/.test(String(args.at(-1)))) return { ok: true, ran: true, code: 0, stdout: JSON.stringify({ default_branch: 'main' }), stderr: '' };
      return { ok: false, ran: true, code: 1, stdout: '', stderr: 'HTTP 500' };
    },
    stateDir: () => stateDir,
    log: () => undefined,
  });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-git-relay-')));
    bare = path.join(root, 'remote.git');
    evil = path.join(root, 'evil.git');
    work = path.join(root, 'work');
    stateDir = path.join(root, 'state');
    fs.mkdirSync(work);
    git(root, 'init', '-q', '--bare', '-b', 'main', bare);
    git(root, 'init', '-q', '--bare', '-b', 'main', evil);
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'config', 'user.name', 'T');
    git(work, 'config', 'user.email', 't@example.invalid');
    git(work, 'remote', 'add', 'origin', URL_);
    commit(work, 'base');
    git(work, '-c', `url.${bare}.insteadOf=${URL_}`, '-c', 'protocol.file.allow=always', 'push', '-q', '-u', 'origin', 'main');
    network = [];
    probes = [];
    onGh = () => undefined;
    receipts = undefined;
  });

  afterEach(() => {
    receipts?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ctx = (cwd: string): GitWriteSessionContext => ({
    action: 'push', owner: 'device:d1', deviceId: 'd1', sessionId: 's1', cwd,
    repo: { commonReal: path.join(work, '.git') } as GitWriteSessionContext['repo'], login: 'octo', ghEnv: { GH_TOKEN: TOKEN },
  });
  const okPreview = async (cwd: string) => {
    const r = await createPhoneGitPushHandlers(deps()).preview!(ctx(cwd));
    if (!r.ok) throw new Error(`preview refused: ${JSON.stringify(r.body)}`);
    return { facts: r.facts as unknown as PushPreview, pins: r.pins };
  };
  const executeAndSettle = async (cwd: string, pins: GitWritePins, expectedHead: string) => {
    receipts ??= new GitWriteReceipts(stateDir, () => Date.now());
    const store = receipts;
    const requestId = randomUUID();
    const key = GitWriteReceipts.key('device:d1', requestId);
    store.begin(key, { requestId, action: 'push', sessionId: 's1', owner: 'device:d1', repo: work, fingerprint: 'f'.repeat(64) });
    await createPhoneGitPushHandlers(deps()).execute({
      ...ctx(cwd), requestId, pins,
      body: { requestId, confirmToken: 'x'.repeat(43), expectedHead, expectedRef: String(pins.ref) },
      markInFlight: () => store.markInFlight(key),
      settle: (o) => store.settle(key, o),
    } as GitWriteExecuteContext);
    await vi.waitFor(() => expect(['done', 'refused', 'uncertain']).toContain(store.find(key)?.state), WAIT);
    return store.find(key)!;
  };

  /** Every file (by content), symlink (by target) and folder under `dir`. */
  const treeHash = (dir: string): string => {
    const h = crypto.createHash('sha256');
    const walk = (p: string, rel: string) => {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) h.update(`L ${rel} ${fs.readlinkSync(p)}\n`);
      else if (st.isDirectory()) {
        h.update(`D ${rel} ${st.mode}\n`);
        for (const name of fs.readdirSync(p).sort()) walk(path.join(p, name), `${rel}/${name}`);
      } else h.update(`F ${rel} ${st.mode} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}\n`);
    };
    walk(dir, '.');
    return h.digest('hex');
  };

  /** A linked worktree on `feat`, with one commit the remote does not have. */
  const linkedWorktree = () => {
    const wt = path.join(root, 'wt');
    git(work, 'worktree', 'add', '-q', '-b', 'feat', wt);
    return { wt, head: commit(wt, 'feat work'), gitDir: path.join(work, '.git', 'worktrees', 'wt') };
  };
  /** A repository of the worker's choosing, with its own commit on `feat`. */
  const otherRepo = () => {
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    git(other, 'init', '-q', '-b', 'feat');
    git(other, 'config', 'user.name', 'E');
    git(other, 'config', 'user.email', 'e@example.invalid');
    git(other, 'remote', 'add', 'origin', URL_);
    commit(other, 'elsewhere');
    return other;
  };

  it('pushes to the pinned URL from a relay when the pane repository changes after the checks', async () => {
    const { wt, head, gitDir } = linkedWorktree();
    const { facts, pins } = await okPreview(wt);
    expect(facts).toMatchObject({ branch: 'feat', head, target: { ref: 'refs/heads/feat', create: true } });
    expect(pins).toMatchObject({ gitDir: real(gitDir), commonDir: real(path.join(work, '.git')) });

    const other = otherRepo();
    // After the config checks and before the first network call of the execute.
    onGh = () => {
      onGh = () => undefined;
      git(work, 'config', `url.${evil}.insteadOf`, bare);
      git(work, 'config', `url.${evil}.pushInsteadOf`, bare);
      git(work, 'config', 'http.https://github.com/.proxy', 'http://127.0.0.1:9');
      git(work, 'config', '--add', 'credential.helper', 'store');
      rewrite(path.join(wt, '.git'), `gitdir: ${path.join(other, '.git')}\n`);
      rewrite(path.join(gitDir, 'commondir'), `${path.join(other, '.git')}\n`);
    };
    const row = await executeAndSettle(wt, pins, head);
    expect(row).toMatchObject({ state: 'done', fields: { pushed: head, target: 'refs/heads/feat' } });

    expect(git(bare, 'rev-parse', 'refs/heads/feat')).toBe(head);
    expect(refsOf(evil)).toBe('');
    const relayRoot = path.join(stateDir, PHONE_GIT_RELAY_DIR);
    expect(fs.readdirSync(relayRoot)).toEqual([]);
    expect(network.length).toBeGreaterThanOrEqual(3); // preview ls-remote, execute ls-remote, push
    for (const call of network) {
      expect(call.args[0]?.startsWith(`--git-dir=${relayRoot}${path.sep}`)).toBe(true);
      expect(call.args).toContain(URL_);
      expect(call.args.filter((a) => /^(?:https?|ssh|file):|^git@/.test(a))).toEqual([URL_]);
      expect(call.args.join('\n')).not.toContain(TOKEN);
      expect(call.env.GIT_CONFIG_GLOBAL).toBe(GIT_NULL_DEVICE);
      expect(call.env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(call.env.GIT_NO_LAZY_FETCH).toBe('1');
    }
    // In every relay, git sees none of the pane repository's transport config.
    expect(probes.length).toBe(network.length);
    for (const p of probes) expect(p).toEqual({ proxy: '', helpers: ['', '!gh auth git-credential'], url: URL_ });
  });

  it('answers stale when the worktree points at another repository after the preview', async () => {
    const { wt, head } = linkedWorktree();
    const { pins } = await okPreview(wt);
    const other = otherRepo();
    rewrite(path.join(wt, '.git'), `gitdir: ${path.join(other, '.git')}\n`);
    const before = network.length;
    const row = await executeAndSettle(wt, pins, head);
    expect(row).toMatchObject({ state: 'refused', error: 'stale' });
    expect(network.length).toBe(before);
    expect(refsOf(bare)).not.toContain('refs/heads/feat');
  });

  it('writes nothing under the pane repository, symlinked ref and log folders included', async () => {
    git(work, 'checkout', '-q', '-b', 'feat');
    commit(work, 'one');
    git(work, '-c', `url.${bare}.insteadOf=${URL_}`, '-c', 'protocol.file.allow=always', 'push', '-q', '-u', 'origin', 'feat');
    const head = commit(work, 'two');
    // refs/remotes/origin and its reflog folder are symlinks to folders outside the repository.
    const common = path.join(work, '.git');
    const outsideRefs = path.join(root, 'outside-refs');
    const outsideLogs = path.join(root, 'outside-logs');
    fs.renameSync(path.join(common, 'refs', 'remotes', 'origin'), outsideRefs);
    fs.symlinkSync(outsideRefs, path.join(common, 'refs', 'remotes', 'origin'));
    fs.renameSync(path.join(common, 'logs', 'refs', 'remotes', 'origin'), outsideLogs);
    fs.symlinkSync(outsideLogs, path.join(common, 'logs', 'refs', 'remotes', 'origin'));
    const before = { repo: treeHash(common), refs: treeHash(outsideRefs), logs: treeHash(outsideLogs) };

    const { facts, pins } = await okPreview(work);
    expect(facts).toMatchObject({ target: { ref: 'refs/heads/feat', create: false }, fastForward: true, ahead: 1 });
    const row = await executeAndSettle(work, pins, head);
    expect(row).toMatchObject({ state: 'done', fields: { pushed: head } });
    expect(git(bare, 'rev-parse', 'refs/heads/feat')).toBe(head);

    expect({ repo: treeHash(common), refs: treeHash(outsideRefs), logs: treeHash(outsideLogs) }).toEqual(before);
  });

  it('pushes from a shallow clone: the relay stops where the clone does', async () => {
    commit(work, 'two');
    git(work, '-c', `url.${bare}.insteadOf=${URL_}`, '-c', 'protocol.file.allow=always', 'push', '-q', 'origin', 'main');
    const shallow = path.join(root, 'shallow');
    git(root, '-c', 'protocol.file.allow=always', 'clone', '-q', '--depth=1', `file://${bare}`, shallow);
    git(shallow, 'remote', 'set-url', 'origin', URL_);
    git(shallow, 'config', 'user.name', 'S');
    git(shallow, 'config', 'user.email', 's@example.invalid');
    git(shallow, 'checkout', '-q', '-b', 'feat');
    const head = commit(shallow, 'from shallow');
    // The remote moves on to a commit the clone never saw, so its refs do not
    // bound the walk: only the shallow list does.
    commit(work, 'three');
    git(work, '-c', `url.${bare}.insteadOf=${URL_}`, '-c', 'protocol.file.allow=always', 'push', '-q', 'origin', 'main');
    const { pins } = await (async () => {
      const r = await createPhoneGitPushHandlers(deps()).preview!({ ...ctx(shallow), repo: { commonReal: path.join(shallow, '.git') } as GitWriteSessionContext['repo'] });
      if (!r.ok) throw new Error(`preview refused: ${JSON.stringify(r.body)}`);
      return r;
    })();
    receipts ??= new GitWriteReceipts(stateDir, () => Date.now());
    const store = receipts;
    const requestId = randomUUID();
    const key = GitWriteReceipts.key('device:d1', requestId);
    store.begin(key, { requestId, action: 'push', sessionId: 's1', owner: 'device:d1', repo: shallow, fingerprint: 'f'.repeat(64) });
    await createPhoneGitPushHandlers(deps()).execute({
      ...ctx(shallow), repo: { commonReal: path.join(shallow, '.git') } as GitWriteSessionContext['repo'], requestId, pins,
      body: { requestId, confirmToken: 'x'.repeat(43), expectedHead: head, expectedRef: 'refs/heads/feat' },
      markInFlight: () => store.markInFlight(key),
      settle: (o) => store.settle(key, o),
    } as GitWriteExecuteContext);
    await vi.waitFor(() => expect(store.find(key)?.state).toBe('done'), WAIT);
    expect(git(bare, 'rev-parse', 'refs/heads/feat')).toBe(head);
  });

  it('refuses a partial clone before any network call', async () => {
    git(work, 'checkout', '-q', '-b', 'feat');
    commit(work, 'x');
    git(work, 'config', 'extensions.partialClone', 'origin');
    const r = await createPhoneGitPushHandlers(deps()).preview!(ctx(work));
    expect(r).toEqual({ ok: false, body: { error: 'remote-unsupported' } });
    expect(network).toEqual([]);
  });

  it('reads HEAD strictly: a symlinked HEAD file is refused', async () => {
    const { wt, gitDir } = linkedWorktree();
    const real = path.join(root, 'head-elsewhere');
    fs.writeFileSync(real, 'ref: refs/heads/feat\n');
    fs.rmSync(path.join(gitDir, 'HEAD'));
    fs.symlinkSync(real, path.join(gitDir, 'HEAD'));
    const r = await createPhoneGitPushHandlers(deps()).preview!(ctx(wt));
    expect(r.ok).toBe(false);
    expect(network).toEqual([]);
  });
});
