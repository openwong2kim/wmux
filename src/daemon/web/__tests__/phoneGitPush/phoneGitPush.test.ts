import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import type http from 'node:http';
import { buildGitEnv, createGitRunner } from '../../sessionDiff';
import { GitWriteReceipts, PhoneGitWriteGate } from '../../phoneGitWriteGate';
import { registerPhoneGitWriteAction, type GitWriteExecuteContext, type GitWriteSessionContext } from '../../phoneGitWriteRegistry';
import { PhoneGitWriteRoutes, type PhoneGitWriteHost } from '../../phoneGitWriteRoutes';
import {
  GIT_NULL_DEVICE, PHONE_GIT_PUSH_INTENTS_DIR, PUSH_RECHECK_DELAY_MS, createNetworkGitRunner, createPhoneGitPushHandlers,
  defaultPushDeps, readPushIntent, recheckUncertainPushes, startPushRecovery,
  type PhoneGitPushDeps, type PushChildResult,
} from '../../phoneGitPush';
import type { GitWritePins, PushPreview } from '../../../../shared/phoneGitWrite';

/**
 * The push action against real repositories: a working clone whose `origin`
 * is `https://github.com/o/r.git`, and a local bare repository the test's
 * network runners map that URL to. gh is a fake; nothing leaves the machine.
 */

const URL_ = 'https://github.com/o/r.git';
const WAIT = { timeout: 15_000 };

describe('phone git push', { timeout: 60_000 }, () => {
  let root: string;
  let bare: string;
  let work: string;
  let stateDir: string;
  let now: number;
  let calls: { remote: string[][]; gh: string[][]; push: string[][] };
  let deps: PhoneGitPushDeps;
  let receipts: GitWriteReceipts | undefined;
  let logs: string[];

  const env = () => ({ ...buildGitEnv(), GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8' }).trim();
  const commit = (cwd: string, msg: string) => {
    git(cwd, 'commit', '-q', '--allow-empty', '-m', msg);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  /** The test's only transport: the GitHub URL, rewritten to the bare repository. */
  const toBare = (args: readonly string[]) => ['-c', `url.${bare.replace(/\\/g, '/')}.insteadOf=${URL_}`, '-c', 'protocol.file.allow=always', ...args];
  /** The production network environment allows HTTPS only; the test transport is a local file. */
  const fileToo = (e: NodeJS.ProcessEnv) => ({ ...e, GIT_ALLOW_PROTOCOL: 'https:file' });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-git-push-')));
    bare = path.join(root, 'remote.git');
    work = path.join(root, 'work');
    stateDir = path.join(root, 'state');
    fs.mkdirSync(work);
    git(root, 'init', '-q', '--bare', '-b', 'main', bare);
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'config', 'user.name', 'T');
    git(work, 'config', 'user.email', 't@example.invalid');
    git(work, 'remote', 'add', 'origin', URL_);
    commit(work, 'base');
    git(work, ...toBare(['push', '-q', '-u', 'origin', 'main']));
    now = 5_000_000;
    calls = { remote: [], gh: [], push: [] };
    deps = {
      ...defaultPushDeps,
      remote: (args, cwd, e) => {
        calls.remote.push([...args]);
        expect(e.GIT_ALLOW_PROTOCOL).toBe('https');
        return defaultPushDeps.remote(toBare(args), cwd, fileToo(e));
      },
      gh: async (args) => {
        calls.gh.push([...args]);
        if (/^repos\/[^/]+\/[^/]+$/.test(String(args.at(-1)))) return { ok: true, ran: true, code: 0, stdout: JSON.stringify({ default_branch: 'main' }), stderr: '' };
        return { ok: false, ran: true, code: 1, stdout: '', stderr: 'HTTP 500' };
      },
      push: (args, cwd, e, t) => { calls.push.push([...args]); return defaultPushDeps.push(toBare(args), cwd, fileToo(e), t); },
      stateDir: () => stateDir,
      now: () => now,
      log: (msg) => { logs.push(msg); },
    };
    receipts = undefined;
    logs = [];
  });

  afterEach(() => {
    receipts?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ctx = (): GitWriteSessionContext => ({
    action: 'push', owner: 'device:d1', deviceId: 'd1', sessionId: 's1', cwd: work,
    repo: {} as GitWriteSessionContext['repo'], login: 'octo', ghEnv: { GH_TOKEN: 'gho_octo' },
  });

  const preview = async () => {
    const r = await createPhoneGitPushHandlers(deps).preview!(ctx());
    return r;
  };
  const okPreview = async () => {
    const r = await preview();
    if (!r.ok) throw new Error(`preview refused: ${JSON.stringify(r.body)}`);
    return { facts: r.facts as unknown as PushPreview, pins: r.pins };
  };

  /** Run execute with a real receipt row, the way the routes do. */
  const execute = async (pins: GitWritePins, expectedHead: string, d: PhoneGitPushDeps = deps) => {
    receipts ??= new GitWriteReceipts(stateDir, () => now);
    const requestId = randomUUID();
    const key = GitWriteReceipts.key('device:d1', requestId);
    receipts.begin(key, { requestId, action: 'push', sessionId: 's1', owner: 'device:d1', repo: work, fingerprint: 'f'.repeat(64) });
    const store = receipts;
    const run = createPhoneGitPushHandlers(d).execute({
      ...ctx(), requestId, pins,
      body: { requestId, confirmToken: 'x'.repeat(43), expectedHead, expectedRef: String(pins.ref) },
      markInFlight: () => store.markInFlight(key),
      settle: (o) => store.settle(key, o),
    } as GitWriteExecuteContext);
    return { key, run };
  };
  const settled = async (key: string) => {
    let row = receipts!.find(key);
    await vi.waitFor(() => {
      row = receipts!.find(key);
      expect(['done', 'refused', 'uncertain']).toContain(row?.state);
    }, WAIT);
    return row!;
  };
  const bareRef = (ref: string) => {
    try { return git(bare, 'rev-parse', '--verify', '-q', ref); } catch { return null; }
  };

  it('pushes to the upstream ref when its name differs from the local branch, and pushes exactly expectedHead', async () => {
    const base = git(work, 'rev-parse', 'HEAD');
    git(work, ...toBare(['push', '-q', 'origin', 'main:refs/heads/remote-y']));
    git(work, 'checkout', '-q', '-b', 'local-x');
    git(work, 'config', 'branch.local-x.remote', 'origin');
    git(work, 'config', 'branch.local-x.merge', 'refs/heads/remote-y');
    const head = commit(work, 'one');

    const { facts, pins } = await okPreview();
    expect(facts).toMatchObject({
      branch: 'local-x', ref: 'refs/heads/local-x', head,
      target: { remote: 'origin', ref: 'refs/heads/remote-y', create: false },
      repo: 'github.com/o/r', ahead: 1, behind: 0, remoteTip: base, fastForward: true, commitsTruncated: false,
    });
    expect(facts.commits).toEqual([{ oid: head, subject: 'one', author: 'T' }]);
    expect(pins).toEqual({ head, ref: 'refs/heads/local-x', targetRef: 'refs/heads/remote-y', remoteTip: base, repo: 'o/r', pushUrl: URL_ });
    expect(calls.remote.every((a) => a.includes(URL_) && !a.includes('origin'))).toBe(true);

    commit(work, 'after the preview'); // HEAD moves on; the reviewed commit is what goes out.
    const { key, run } = await execute(pins, head);
    await run;
    expect(await settled(key)).toMatchObject({ state: 'done', fields: { pushed: head, target: 'refs/heads/remote-y' } });
    expect(bareRef('refs/heads/remote-y')).toBe(head);
    expect(bareRef('refs/heads/local-x')).toBeNull();
    expect(calls.push).toHaveLength(1);
    expect(calls.push[0].slice(-2)).toEqual([URL_, `${head}:refs/heads/remote-y`]);
    expect(calls.push[0]).toEqual(expect.arrayContaining(['http.proxy=', 'https.proxy=', 'http.sslVerify=true', 'credential.helper=']));
    expect(git(work, 'rev-parse', 'refs/remotes/origin/remote-y')).toBe(head);
    expect(fs.readdirSync(path.join(stateDir, PHONE_GIT_PUSH_INTENTS_DIR))).toEqual([]);
    for (const a of calls.push[0]) expect(a).not.toMatch(/^(--force|-f|--mirror|--delete|--tags|\+)/);
  });

  it('creates the remote branch when there is no upstream, then records it as the upstream', async () => {
    git(work, 'checkout', '-q', '-b', 'phone/x');
    const head = commit(work, 'phone work');
    const { facts, pins } = await okPreview();
    expect(facts).toMatchObject({ target: { remote: 'origin', ref: 'refs/heads/phone/x', create: true }, remoteTip: null, fastForward: true, ahead: 1 });

    const { key, run } = await execute(pins, head);
    await run;
    expect((await settled(key)).state).toBe('done');
    expect(bareRef('refs/heads/phone/x')).toBe(head);
    expect(git(work, 'config', '--get', 'branch.phone/x.merge')).toBe('refs/heads/phone/x');
    // The next preview targets the upstream, which now holds HEAD.
    expect(await preview()).toEqual({ ok: false, body: { error: 'no-commits-ahead' } });
  });

  it('refuses to create a branch the remote already has', async () => {
    git(work, 'checkout', '-q', '-b', 'taken');
    commit(work, 'mine');
    git(work, ...toBare(['push', '-q', 'origin', 'main:refs/heads/taken']));
    expect(await preview()).toEqual({ ok: false, body: { error: 'remote-branch-exists' } });
  });

  it('refuses the default branch, also under another local name', async () => {
    commit(work, 'on main');
    expect(await preview()).toEqual({ ok: false, body: { error: 'protected-target' } });
    git(work, 'checkout', '-q', '-b', 'topic');
    git(work, 'config', 'branch.topic.remote', 'origin');
    git(work, 'config', 'branch.topic.merge', 'main'); // short form still names the default branch
    expect(await preview()).toEqual({ ok: false, body: { error: 'protected-target' } });
    expect(calls.remote).toHaveLength(0);
  });

  it.each([
    ['an insteadOf rewrite', ['url.https://example.invalid/.insteadOf', 'https://github.com/']],
    ['a pushInsteadOf rewrite', ['url.https://example.invalid/.pushInsteadOf', 'https://github.com/']],
    ['an ssh pushurl', ['remote.origin.pushurl', 'git@github.com:o/r.git']],
    ['a pushurl on another repository', ['remote.origin.pushurl', 'https://github.com/o/other.git']],
    ['an http url', ['remote.origin.url', 'http://github.com/o/r.git']],
  ])('refuses %s with zero network calls', async (_name, [key, value]) => {
    git(work, 'checkout', '-q', '-b', 'feat');
    commit(work, 'x');
    git(work, 'config', key, value);
    expect(await preview()).toEqual({ ok: false, body: { error: 'remote-unsupported' } });
    expect(calls).toEqual({ remote: [], gh: [], push: [] });
  });

  it.each([
    ['http.proxy', 'http://127.0.0.1:9'],
    ['https.proxy', 'http://127.0.0.1:9'],
    ['http.https://github.com/.sslVerify', 'false'],
    ['http.https://github.com/.followRedirects', 'true'],
    ['http.sslCAInfo', '/tmp/ca.pem'],
    ['credential.helper', 'store'],
    ['credential.https://github.com.helper', 'store'],
    ['url.https://github.com/o/r.git.insteadOf', 'https://github.com/o/r.git'],
    ['core.sshCommand', 'ssh -v'],
    ['core.gitProxy', 'proxy-cmd'],
    ['protocol.ext.allow', 'always'],
    ['remote.origin.vcs', 'x'],
    ['remote.origin.proxy', 'http://127.0.0.1:9'],
    ['remote.origin.pushurl', URL_],
    ['include.path', '/dev/null'],
    ['includeIf.onbranch:feat.path', '/dev/null'],
  ])('refuses repository config %s before any network call', async (key, value) => {
    git(work, 'checkout', '-q', '-b', 'feat');
    commit(work, 'x');
    git(work, 'config', key, value);
    expect(await preview()).toEqual({ ok: false, body: { error: 'remote-unsupported' } });
    expect(calls).toEqual({ remote: [], gh: [], push: [] });
  });

  it('refuses a key that arrives through an included file', async () => {
    git(work, 'checkout', '-q', '-b', 'feat');
    commit(work, 'x');
    fs.writeFileSync(path.join(root, 'inc'), '[http]\n\tproxy = http://127.0.0.1:9\n');
    git(work, 'config', 'include.path', path.join(root, 'inc'));
    expect(await preview()).toEqual({ ok: false, body: { error: 'remote-unsupported' } });
    expect(calls).toEqual({ remote: [], gh: [], push: [] });
  });

  it.each([
    ['another repository', 'https://github.com/o/other.git'],
    ['another spelling of the same repository', 'https://github.com/o/r'],
  ])('answers stale when origin is changed to %s after the preview', async (_name, url) => {
    git(work, 'checkout', '-q', '-b', 'feat');
    const head = commit(work, 'x');
    const { pins } = await okPreview();
    git(work, 'remote', 'set-url', 'origin', url);
    const before = { remote: calls.remote.length, push: calls.push.length };
    const { key, run } = await execute(pins, head);
    await run;
    expect(await settled(key)).toMatchObject({ state: 'refused', error: 'stale' });
    // Refused before any network call under the new URL.
    expect({ remote: calls.remote.length, push: calls.push.length }).toEqual(before);
    expect(bareRef('refs/heads/feat')).toBeNull();
  });

  it('refuses an upstream on a remote other than origin before any network call', async () => {
    git(work, 'remote', 'add', 'fork', URL_);
    git(work, 'checkout', '-q', '-b', 'feat');
    git(work, 'config', 'branch.feat.remote', 'fork');
    git(work, 'config', 'branch.feat.merge', 'refs/heads/feat');
    commit(work, 'x');
    expect(await preview()).toEqual({ ok: false, body: { error: 'remote-unsupported' } });
    expect(calls).toEqual({ remote: [], gh: [], push: [] });
  });

  it('never loads global config', async () => {
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), '[url "https://example.invalid/"]\n\tinsteadOf = https://github.com/\n');
    git(work, 'checkout', '-q', '-b', 'feat');
    commit(work, 'x');
    const r = await createPhoneGitPushHandlers({ ...deps, baseEnv: () => ({ ...process.env, HOME: home, XDG_CONFIG_HOME: home }) }).preview!(ctx());
    expect(r.ok).toBe(true);
  });

  it('ignores followTags, submodule recursion and signing set in the repository', async () => {
    git(work, 'checkout', '-q', '-b', 'feat');
    const head = commit(work, 'tagged');
    git(work, 'tag', '-a', 'v9', '-m', 'v9');
    git(work, 'config', 'push.followTags', 'true');
    git(work, 'config', 'push.recurseSubmodules', 'on-demand');
    git(work, 'config', 'push.gpgSign', 'true');
    const { pins } = await okPreview();
    const { key, run } = await execute(pins, head);
    await run;
    expect((await settled(key)).state).toBe('done');
    expect(git(bare, 'for-each-ref', '--format=%(refname)').split('\n').sort()).toEqual(['refs/heads/feat', 'refs/heads/main']);
    expect(calls.push[0]).toEqual(expect.arrayContaining(['--no-recurse-submodules', '--no-follow-tags', '--no-signed', '--no-verify', 'push.pushOption=', 'core.askPass=', 'http.followRedirects=false']));
  });

  it('reports a remote that moved past the local clone as non-fast-forward', async () => {
    git(work, 'checkout', '-q', '-b', 'feat');
    git(work, ...toBare(['push', '-q', '-u', 'origin', 'feat']));
    // Someone else pushes to the branch from another clone.
    const other = path.join(root, 'other');
    git(root, ...toBare(['clone', '-q', '-b', 'feat', URL_, other]));
    git(other, 'config', 'user.name', 'O');
    git(other, 'config', 'user.email', 'o@example.invalid');
    const theirs = commit(other, 'theirs');
    git(other, ...toBare(['push', '-q', 'origin', 'feat']));
    const head = commit(work, 'mine');

    const { facts, pins } = await okPreview();
    expect(facts).toMatchObject({ remoteTip: theirs, fastForward: false, remoteMoved: true });
    expect(facts.behind).toBeGreaterThanOrEqual(1);
    const { key, run } = await execute(pins, head);
    await run;
    expect(await settled(key)).toMatchObject({ state: 'refused', error: 'non-fast-forward', fields: { remoteTip: theirs } });
    expect(calls.push).toHaveLength(0);
    expect(bareRef('refs/heads/feat')).toBe(theirs);
  });

  it('refuses stale when the remote moved after the preview, even along our own history', async () => {
    git(work, 'checkout', '-q', '-b', 'feat');
    commit(work, 'one');
    git(work, ...toBare(['push', '-q', '-u', 'origin', 'feat']));
    const two = commit(work, 'two');
    const head = commit(work, 'three');
    const { pins } = await okPreview();
    git(work, ...toBare(['push', '-q', 'origin', `${two}:refs/heads/feat`]));
    const { key, run } = await execute(pins, head);
    await run;
    expect(await settled(key)).toMatchObject({ state: 'refused', error: 'stale', fields: { head } });
    expect(calls.push).toHaveLength(0);
    expect(bareRef('refs/heads/feat')).toBe(two);
  });

  describe('restart while a push is in flight', () => {
    /** Start an execute whose child never reports back: the daemon dies under it. */
    const crashMidPush = async () => {
      git(work, 'checkout', '-q', '-b', 'feat');
      const head = commit(work, 'in flight');
      const { pins } = await okPreview();
      let release: (r: PushChildResult) => void = () => undefined;
      let dead = false;
      const hung: PhoneGitPushDeps = {
        ...deps,
        push: () => new Promise<PushChildResult>((resolve) => { release = resolve; }),
        // Once the daemon is gone its handler learns nothing more.
        remote: (args, cwd, e) => dead ? Promise.resolve({ ok: false, ran: false, stdout: '', stderr: '' }) : deps.remote(args, cwd, e),
      };
      const { key, run } = await execute(pins, head, hung);
      await vi.waitFor(() => expect(receipts!.find(key)?.state).toBe('inFlight'), WAIT);
      receipts!.close();
      receipts = new GitWriteReceipts(stateDir, () => now);
      // Free the old handler's push slot; it ends without an outcome and leaves the intent in place.
      dead = true;
      release({ spawned: true, code: null, timedOut: true, stdout: '', stderr: '' });
      await expect(run).rejects.toThrow('push outcome unknown');
      expect(receipts.find(key)?.state).toBe('uncertain');
      expect(readPushIntent(stateDir, key).state).toBe('ok');
      return { key, head };
    };
    const identity = async () => ({ ok: true as const, token: 'gho_octo' });

    it('stays uncertain until the delayed check, then reads done once the child landed', async () => {
      const { key, head } = await crashMidPush();
      const started = receipts!.find(key)!.startedAt!;

      now = started + 1_000;
      expect(await recheckUncertainPushes(receipts!, { deps, identity })).toBe(1);
      expect(receipts!.find(key)?.state).toBe('uncertain');

      // The orphaned child finishes after the restart.
      git(work, ...toBare(['push', '-q', 'origin', `${head}:refs/heads/feat`]));
      now = started + PUSH_RECHECK_DELAY_MS;
      expect(await recheckUncertainPushes(receipts!, { deps, identity })).toBe(0);
      expect(receipts!.find(key)).toMatchObject({ state: 'done', fields: { pushed: head, target: 'refs/heads/feat' } });
      expect(git(work, 'config', '--get', 'branch.feat.merge')).toBe('refs/heads/feat');
      expect(calls.push).toHaveLength(0); // never re-run
    });

    it('reads push-not-landed when the remote never got it', async () => {
      const { key } = await crashMidPush();
      now = receipts!.find(key)!.startedAt! + PUSH_RECHECK_DELAY_MS;
      expect(await recheckUncertainPushes(receipts!, { deps, identity })).toBe(0);
      expect(receipts!.find(key)).toMatchObject({ state: 'refused', error: 'push-not-landed' });
    });

    it('stays uncertain while the remote cannot be read', async () => {
      const { key } = await crashMidPush();
      now = receipts!.find(key)!.startedAt! + PUSH_RECHECK_DELAY_MS;
      const offline = { ...deps, remote: async () => ({ ok: false, ran: true, code: 128, stdout: '', stderr: 'Could not resolve host' }) };
      expect(await recheckUncertainPushes(receipts!, { deps: offline, identity })).toBe(1);
      expect(receipts!.find(key)?.state).toBe('uncertain');
    });

    it('resolves on its own once the daemon starts recovery, and removes the intent', async () => {
      const { key, head } = await crashMidPush();
      git(work, ...toBare(['push', '-q', 'origin', `${head}:refs/heads/feat`]));
      now = receipts!.find(key)!.startedAt! + PUSH_RECHECK_DELAY_MS;
      const stop = startPushRecovery(receipts!, { deps, identity });
      try {
        await vi.waitFor(() => expect(receipts!.find(key)?.state).toBe('done'), WAIT);
        expect(readPushIntent(stateDir, key).state).toBe('missing');
      } finally {
        stop();
      }
    });

    it.skipIf(process.platform === 'win32')('keeps the intent directory 0700 and its files 0600', async () => {
      const dir = path.join(stateDir, PHONE_GIT_PUSH_INTENTS_DIR);
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      fs.chmodSync(dir, 0o755);
      const { key } = await crashMidPush();
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(dir, `${key}.json`)).mode & 0o777).toBe(0o600);
    });

    it('reads the intent from .bak when the primary is gone or unreadable', async () => {
      const { key } = await crashMidPush();
      const file = path.join(stateDir, PHONE_GIT_PUSH_INTENTS_DIR, `${key}.json`);
      fs.renameSync(file, `${file}.bak`);
      expect(readPushIntent(stateDir, key).state).toBe('ok');
      fs.writeFileSync(file, '{torn');
      expect(readPushIntent(stateDir, key).state).toBe('ok');
      now = receipts!.find(key)!.startedAt! + PUSH_RECHECK_DELAY_MS;
      expect(await recheckUncertainPushes(receipts!, { deps, identity })).toBe(0);
      expect(receipts!.find(key)).toMatchObject({ state: 'refused', error: 'push-not-landed' });
    });

    it('keeps an unreadable intent uncertain and says so, never treats it as missing', async () => {
      const { key } = await crashMidPush();
      const file = path.join(stateDir, PHONE_GIT_PUSH_INTENTS_DIR, `${key}.json`);
      fs.writeFileSync(file, '{torn');
      expect(readPushIntent(stateDir, key).state).toBe('unreadable');
      now = receipts!.find(key)!.startedAt! + PUSH_RECHECK_DELAY_MS;
      expect(await recheckUncertainPushes(receipts!, { deps, identity })).toBe(1);
      expect(receipts!.find(key)?.state).toBe('uncertain');
      expect(logs.some((l) => l.includes('unreadable'))).toBe(true);
    });
  });

  it('refuses with git-receipts-unavailable when the intent cannot be written, and pushes nothing', async () => {
    git(work, 'checkout', '-q', '-b', 'feat');
    const head = commit(work, 'x');
    const { pins } = await okPreview();
    const blocked = path.join(root, 'blocked');
    fs.writeFileSync(blocked, 'a file where the directory should be');
    const { key, run } = await execute(pins, head, { ...deps, stateDir: () => blocked });
    await run;
    expect(await settled(key)).toMatchObject({ state: 'refused', error: 'git-receipts-unavailable' });
    expect(calls.push).toHaveLength(0);
    expect(logs.some((l) => l.includes('intent could not be written'))).toBe(true);
  });

  it('answers a resend of the same requestId with the stored receipt and pushes once', async () => {
    git(work, 'checkout', '-q', '-b', 'feat');
    const head = commit(work, 'once');
    const unregister = registerPhoneGitWriteAction('push', createPhoneGitPushHandlers(deps));
    const gate = new PhoneGitWriteGate({ wmuxDir: stateDir, now: () => now, ghToken: async () => ({ ok: true, stdout: 'gho_octo\n' }) });
    const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
    const host: PhoneGitWriteHost = {
      ceiling: () => ({ allowGitWrite: true, login: 'octo' }),
      mayInput: () => true,
      explicitInputGrant: () => true,
      refuseInput: () => { throw new Error('unexpected'); },
      session: () => ({ spawnCwd: work }),
      stillAuthorized: async () => true,
      readJsonBody: (_req, _res, onBody) => onBody(pendingBody),
      json: (_res, status, body) => { answers.push({ status, body: body as Record<string, unknown> }); },
      gate: () => gate,
      git: createGitRunner,
      log: () => undefined,
    };
    let pendingBody: unknown = {};
    const routes = new PhoneGitWriteRoutes({ ...host, git: () => createGitRunner() });
    const res = { headersSent: false } as http.ServerResponse;
    const req = {} as http.IncomingMessage;
    const url = new URL('http://localhost/');
    const principal = { kind: 'device' as const, deviceId: 'd1' };
    const send = async (kind: 'preview' | 'execute', body: unknown) => {
      pendingBody = body;
      const n = answers.length;
      await routes.handle(req, res, { action: 'push', kind, rawSessionId: 's1' }, url, principal);
      await vi.waitFor(() => expect(answers.length).toBe(n + 1), WAIT);
      return answers[n];
    };
    try {
      const pv = await send('preview', {});
      expect(pv.status).toBe(200);
      const requestId = randomUUID();
      const body = { requestId, confirmToken: pv.body.confirmToken, expectedHead: head, expectedRef: 'refs/heads/feat' };
      expect(await send('execute', body)).toEqual({ status: 202, body: { requestId, replayed: false, state: 'pending' } });
      const key = GitWriteReceipts.key('device:d1', requestId);
      await vi.waitFor(() => expect(gate.receipts.find(key)?.state).toBe('done'), WAIT);
      expect(await send('execute', body)).toEqual({
        status: 200, body: { requestId, replayed: true, state: 'done', pushed: head, target: 'refs/heads/feat' },
      });
      expect(calls.push).toHaveLength(1);
      expect(bareRef('refs/heads/feat')).toBe(head);
    } finally {
      unregister();
      gate.close();
    }
  });
});

describe('push child timeout', { timeout: 30_000 }, () => {
  it('ends git-remote-https too: a remote that never answers does not outlive the timeout', async () => {
    // Accepts and never answers, so git-remote-https (git's child) hangs in the handshake.
    const sockets: net.Socket[] = [];
    const server = net.createServer((s) => { sockets.push(s); s.on('error', () => undefined); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as net.AddressInfo;
      const env = { ...buildGitEnv(), GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE, GIT_CONFIG_NOSYSTEM: '1' };
      const started = Date.now();
      const out = await defaultPushDeps.push(['ls-remote', `https://127.0.0.1:${port}/r.git`], os.tmpdir(), env, 500);
      expect(out.timedOut).toBe(true);
      // Killing git alone left the helper holding the pipes, and the answer never came.
      expect(Date.now() - started).toBeLessThan(10_000);
      // ls-remote goes through the same process-group runner.
      const read = Date.now();
      const ls = await createNetworkGitRunner(500)(['ls-remote', `https://127.0.0.1:${port}/r.git`], os.tmpdir(), env);
      expect(ls).toMatchObject({ ok: false, ran: false });
      expect(Date.now() - read).toBeLessThan(10_000);
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
    }
  });
});
