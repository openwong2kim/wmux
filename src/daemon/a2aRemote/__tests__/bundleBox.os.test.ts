// The box's side of bringing back an agent's work, with real git: a headless
// start's worktree and branch, the bundle made of it (bundleMaker.ts), the
// box answering another PC's asks with its bounds (bundleBox.ts), and the
// made bundle reaching a crafted asking PC both ways (bundleOutbox.ts GET,
// bundleIntake.ts PUT) over a real route table and HTTP server.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteEnvelope, type HostId } from '../../../shared/a2aRemote';
import { bundleRefName, parseBundleMade, type A2aBundleAskV1, type A2aBundleMadeV1 } from '../../../shared/a2aBundle';
import { BundleBox, type BundleBoxLimits } from '../bundleBox';
import { makeBundle, sweepBundleRefs, type BundleMakeInput } from '../bundleMaker';
import { BundleIntake, bundleStagedFile } from '../bundleIntake';
import { BundleOutbox } from '../bundleOutbox';
import { headlessTreeId } from '../headlessStarter';
import type { HeadlessStartRecordV1 } from '../headlessStartStore';
import { PinnedClientError } from '../pinnedClient';
import { deliberateSleep } from '../../../test-utils/waitFor';
import { A2aRouteTable } from '../routes';
import type { StreamedGet, StreamedPut } from '../session';

const ASKER = '11111111-1111-4111-8111-111111111111' as HostId;
const OTHER = '22222222-2222-4222-8222-222222222222' as HostId;
const BOX = '33333333-3333-4333-8333-333333333333' as HostId;
const ORIGIN = 'github.com/acme/app';
const spawnIdOf = (): string => `sp-${crypto.randomUUID()}`;
const askIdOf = (): string => `ba-${crypto.randomUUID()}`;
/** POSIX file modes, shell scripts as programs and unprivileged links. */
const posix = process.platform !== 'win32';

const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const g = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
function commit(cwd: string, file: string, text: string): string {
  fs.writeFileSync(path.join(cwd, file), text);
  g(cwd, 'add', file);
  g(cwd, 'commit', '-q', '-m', `add ${file}`);
  return g(cwd, 'rev-parse', 'HEAD');
}

let root: string;
let repo: string;
let base: string;
let a2aDir: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-bundle-box-')));
  repo = path.join(root, 'repo');
  a2aDir = path.join(root, 'a2a');
  fs.mkdirSync(repo);
  fs.mkdirSync(a2aDir);
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'remote.origin.url', `https://${ORIGIN}.git`);
  base = commit(repo, 'README.md', 'base\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A headless start `hostId` made here: its worktree on its own branch from `base`. */
function start(hostId: HostId = ASKER, spawnId = spawnIdOf()): HeadlessStartRecordV1 {
  const treeId = headlessTreeId(hostId, spawnId);
  const branch = `wmux/remote/${treeId}`;
  const worktreePath = path.join(root, `wt-${treeId}`);
  g(repo, 'worktree', 'add', '-q', '-b', branch, worktreePath, base);
  return {
    v: 1, hostId, spawnId, agent: 'claude', repoPath: repo, treeId, sessionId: 's', workspaceId: 'w', agentSessionId: 'a',
    lineage: hostId, runId: 'r', phase: 'started', worktreePath, cwd: worktreePath, baseCommit: base, branch, startedAt: new Date().toISOString(),
  } as HeadlessStartRecordV1;
}

const input = (rec: HeadlessStartRecordV1, over: Partial<BundleMakeInput> = {}): BundleMakeInput => ({
  worktree: rec.worktreePath!, branch: rec.branch!, base: rec.baseCommit!, treeId: rec.treeId!, origin: ORIGIN,
  file: path.join(root, `${crypto.randomUUID()}.bundle`), maxBytes: 64 * 1024 * 1024, ...over,
});
const bundleRefs = (): string => g(repo, 'for-each-ref', '--format=%(refname)', 'refs/wmux/');

/** The bundle read back in a new repository that has only `base`: the commits it brings, and its one ref's commit. */
function readBack(file: string, treeId: string): { head: string; commits: string[] } {
  const fresh = path.join(root, `fresh-${crypto.randomUUID()}`);
  fs.mkdirSync(fresh);
  g(fresh, 'init', '-q');
  g(fresh, 'fetch', '-q', repo, `${base}:refs/heads/base`);
  g(fresh, 'bundle', 'verify', '-q', file);
  g(fresh, 'fetch', '-q', file, `${bundleRefName(treeId)}:refs/heads/returned`);
  return { head: g(fresh, 'rev-parse', 'returned'), commits: g(fresh, 'rev-list', 'returned', '^base').split('\n').filter(Boolean) };
}

describe('makeBundle', () => {
  it('makes a bundle of the branch past its base, holding one ref named from the tree id at the head, and leaves no ref', async () => {
    const rec = start();
    const head = commit(rec.worktreePath!, 'work.txt', 'done\n');
    const inp = input(rec);
    const made = await makeBundle(inp);
    expect(made).toMatchObject({ kind: 'made', head });
    if (made.kind !== 'made') return;
    expect(made.bytes).toBe(fs.statSync(inp.file).size);
    expect(made.sha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(inp.file)).digest('hex'));
    if (posix) expect(fs.statSync(inp.file).mode & 0o777).toBe(0o600);
    expect(g(repo, 'bundle', 'list-heads', inp.file)).toBe(`${head} ${bundleRefName(rec.treeId!)}`);
    expect(readBack(inp.file, rec.treeId!)).toEqual({ head, commits: [head] });
    expect(bundleRefs()).toBe('');
  });

  it('nothing committed: `empty` on a clean tree, `uncommitted-only` with changes; nothing is committed for the agent', async () => {
    const rec = start();
    const clean = input(rec);
    expect(await makeBundle(clean)).toMatchObject({ kind: 'refused', reason: 'empty' });
    fs.writeFileSync(path.join(rec.worktreePath!, 'notes.txt'), 'not committed\n');
    const dirty = input(rec);
    expect(await makeBundle(dirty)).toMatchObject({ kind: 'refused', reason: 'uncommitted-only' });
    expect(g(rec.worktreePath!, 'rev-parse', 'HEAD')).toBe(base);
    expect(fs.existsSync(clean.file) || fs.existsSync(dirty.file)).toBe(false);
  });

  it('a branch with no history from the base (an orphan) is `base-missing`', async () => {
    const rec = start();
    const tree = g(repo, 'mktree', '--missing');
    const orphan = execFileSync('git', ['commit-tree', tree, '-m', 'orphan'], { cwd: repo, env: GIT_ENV, input: '', encoding: 'utf8' }).trim();
    g(repo, 'update-ref', `refs/heads/${rec.branch}`, orphan);
    expect(await makeBundle(input(rec))).toMatchObject({ kind: 'refused', reason: 'base-missing' });
    expect(bundleRefs()).toBe('');
  });

  it('another repository than the asking PC names is `origin-mismatch`', async () => {
    const rec = start();
    commit(rec.worktreePath!, 'work.txt', 'done\n');
    expect(await makeBundle(input(rec, { origin: 'github.com/acme/other' }))).toMatchObject({ kind: 'refused', reason: 'origin-mismatch' });
  });

  it.runIf(posix)('a repository config that names a program is refused before anything runs; a planted hooks folder never runs', async () => {
    const rec = start();
    commit(rec.worktreePath!, 'work.txt', 'done\n');
    const sentinel = path.join(root, 'ran');
    const script = path.join(root, 'program.sh');
    fs.writeFileSync(script, `#!/bin/sh\necho ran >> '${sentinel}'\n`, { mode: 0o755 });
    // A hooks folder of the repository's own: a reference-transaction hook would run on the make's ref.
    const hooks = path.join(root, 'hooks');
    fs.mkdirSync(hooks);
    fs.copyFileSync(script, path.join(hooks, 'reference-transaction'));
    fs.chmodSync(path.join(hooks, 'reference-transaction'), 0o755);
    g(repo, 'config', 'core.hooksPath', hooks);
    const inp = input(rec);
    expect(await makeBundle(inp)).toMatchObject({ kind: 'made' });
    expect(fs.existsSync(sentinel)).toBe(false);
    // An fsmonitor (a program git runs on a status read): refused.
    g(repo, 'config', 'core.fsmonitor', script);
    expect(await makeBundle(input(rec))).toMatchObject({ kind: 'refused', reason: 'repo-config' });
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('GIT_* of the daemon\'s own environment does not reach git', async () => {
    const rec = start();
    const head = commit(rec.worktreePath!, 'work.txt', 'done\n');
    const env = { ...GIT_ENV, GIT_DIR: path.join(root, 'nowhere'), GIT_WORK_TREE: path.join(root, 'nowhere'), GIT_INDEX_FILE: path.join(root, 'nowhere') };
    expect(await makeBundle(input(rec), { env })).toMatchObject({ kind: 'made', head });
  });

  it('a branch that moves while the bundle is made: the bundle holds the head read before it', async () => {
    const rec = start();
    const head = commit(rec.worktreePath!, 'work.txt', 'done\n');
    const inp = input(rec);
    const made = await makeBundle(inp, {
      onCreate: () => {
        const next = execFileSync('git', ['commit-tree', `${head}^{tree}`, '-p', head, '-m', 'later'], { cwd: repo, env: GIT_ENV, input: '', encoding: 'utf8' }).trim();
        g(repo, 'update-ref', `refs/heads/${rec.branch}`, next);
      },
    });
    expect(made).toMatchObject({ kind: 'made', head });
    expect(readBack(inp.file, rec.treeId!).head).toBe(head);
    expect(bundleRefs()).toBe('');
  });

  it('history merged into the branch from elsewhere in the repository comes with it (the agent could read it anyway)', async () => {
    const rec = start();
    g(repo, 'branch', 'unrelated', base);
    const other = path.join(root, 'other-wt');
    g(repo, 'worktree', 'add', '-q', other, 'unrelated');
    const elsewhere = commit(other, 'elsewhere.txt', 'from another branch\n');
    const own = commit(rec.worktreePath!, 'work.txt', 'done\n');
    g(rec.worktreePath!, 'merge', '-q', '--no-edit', 'unrelated');
    const head = g(rec.worktreePath!, 'rev-parse', 'HEAD');
    const inp = input(rec);
    expect(await makeBundle(inp)).toMatchObject({ kind: 'made', head });
    expect(readBack(inp.file, rec.treeId!).commits.sort()).toEqual([head, own, elsewhere].sort());
  });

  it('known too large before any byte: refused with no file', async () => {
    const rec = start();
    fs.writeFileSync(path.join(rec.worktreePath!, 'big.bin'), crypto.randomBytes(200_000));
    g(rec.worktreePath!, 'add', 'big.bin');
    g(rec.worktreePath!, 'commit', '-q', '-m', 'big');
    const inp = input(rec, { maxBytes: 10_000 });
    expect(await makeBundle(inp)).toMatchObject({ kind: 'refused', reason: 'too-large' });
    expect(fs.existsSync(inp.file)).toBe(false);
    expect(bundleRefs()).toBe('');
  });

  it('a git killed while it makes the bundle leaves no file and no ref', async () => {
    const rec = start();
    commit(rec.worktreePath!, 'work.txt', 'done\n');
    const inp = input(rec);
    expect(await makeBundle(inp, { onCreate: (kill) => kill() })).toMatchObject({ kind: 'refused', reason: 'unavailable' });
    expect(fs.existsSync(inp.file)).toBe(false);
    expect(bundleRefs()).toBe('');
  });

  it('a ref a stopped make left: the next make does not take it over, and the start sweep removes it', async () => {
    const rec = start();
    const head = commit(rec.worktreePath!, 'work.txt', 'done\n');
    g(repo, 'update-ref', bundleRefName(rec.treeId!), base);
    expect(await makeBundle(input(rec))).toMatchObject({ kind: 'refused', reason: 'unavailable' });
    expect(g(repo, 'rev-parse', bundleRefName(rec.treeId!))).toBe(base);
    expect(await sweepBundleRefs(rec.worktreePath!)).toBe(1);
    expect(bundleRefs()).toBe('');
    expect(await makeBundle(input(rec))).toMatchObject({ kind: 'made', head });
  });
});

describe('BundleBox', () => {
  let answers: Array<{ hostId: HostId; made: A2aBundleMadeV1 }>;
  let outbox: BundleOutbox;
  let starts: HeadlessStartRecordV1[];
  let takes: boolean;
  let limits: Partial<BundleBoxLimits>;
  let putter: StreamedPut | null;

  beforeEach(() => {
    answers = [];
    starts = [];
    takes = true;
    limits = {};
    putter = null;
    outbox = new BundleOutbox({ enabled: () => true, putTo: () => putter, root: path.join(a2aDir, 'bundle-out'), log: () => undefined });
  });

  function box(over: Partial<ConstructorParameters<typeof BundleBox>[0]> = {}): BundleBox {
    return new BundleBox({
      a2aDir,
      enabled: () => true,
      peerTakes: () => takes,
      startOf: (hostId, spawnId) => starts.find((s) => s.hostId === hostId && s.spawnId === spawnId),
      starts: () => starts,
      outbox,
      enqueue: (hostId, env) => {
        const made = parseBundleMade(env.bundleMade);
        expect(env).toMatchObject({ kind: 'link', link: { state: 'bundle-made', version: 0 }, linkVersion: 0 });
        if (made) answers.push({ hostId, made });
      },
      log: () => undefined,
      limits: () => limits,
      ...over,
    });
  }

  type AskBody = { op: 'make'; spawnId: string; origin: string } | { op: 'send' | 'done'; bundleId: string };
  function ask(b: BundleBox, hostId: HostId, a: AskBody): string {
    const askId = askIdOf();
    const env: A2aRemoteEnvelope = {
      protocol: A2A_REMOTE_PROTOCOL, linkId: askId, linkVersion: 0, messageId: `m-${crypto.randomUUID()}`, kind: 'link',
      link: { state: 'bundle-ask', version: 0 }, bundleAsk: { v: 1, ...a, askId } as A2aBundleAskV1, sentAt: new Date().toISOString(),
    };
    expect(b.applyInbound(env, { hostId })).toEqual({ ok: true, duplicate: false });
    return askId;
  }
  const answerTo = async (askId: string): Promise<A2aBundleMadeV1> => {
    await vi.waitFor(() => expect(answers.some((x) => x.made.askId === askId)).toBe(true), { timeout: 10_000 });
    return answers.find((x) => x.made.askId === askId)!.made;
  };

  it('makes and offers a start\'s bundle under bundle-out/<host>/, and the same head asked again is the same offer', async () => {
    const rec = start();
    starts.push(rec);
    commit(rec.worktreePath!, 'work.txt', 'done\n');
    const b = box();
    const first = await answerTo(ask(b, ASKER, { op: 'make', spawnId: rec.spawnId, origin: ORIGIN }));
    expect(first).toMatchObject({ op: 'made' });
    if (first.op !== 'made') return;
    const file = path.join(a2aDir, 'bundle-out', ASKER, `${first.manifest.bundleId}.bundle`);
    expect(fs.statSync(file).size).toBe(first.manifest.bytes);
    if (posix) expect(fs.statSync(path.join(a2aDir, 'bundle-out', ASKER)).mode & 0o777).toBe(0o700);
    expect(await answerTo(ask(b, ASKER, { op: 'make', spawnId: rec.spawnId, origin: ORIGIN }))).toEqual({ ...first, askId: expect.any(String) });
    expect(b.standing(ASKER)).toHaveLength(1);
    // Taken: the offer ends and the file goes.
    ask(b, ASKER, { op: 'done', bundleId: first.manifest.bundleId });
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(false), { timeout: 10_000 });
    expect(b.standing(ASKER)).toEqual([]);
  });

  it('only the asking PC\'s own starts: another PC\'s spawn and an unknown one are `unknown-spawn`; one started in the app is `not-supported`', async () => {
    const rec = start(OTHER);
    starts.push(rec);
    const b = box({ startedInApp: (hostId, spawnId) => hostId === ASKER && spawnId === 'sp-00000000-0000-4000-8000-000000000000' });
    expect(await answerTo(ask(b, ASKER, { op: 'make', spawnId: rec.spawnId, origin: ORIGIN }))).toMatchObject({ op: 'refused', reason: 'unknown-spawn' });
    expect(await answerTo(ask(b, ASKER, { op: 'make', spawnId: spawnIdOf(), origin: ORIGIN }))).toMatchObject({ op: 'refused', reason: 'unknown-spawn' });
    expect(await answerTo(ask(b, ASKER, { op: 'make', spawnId: 'sp-00000000-0000-4000-8000-000000000000', origin: ORIGIN }))).toMatchObject({ op: 'refused', reason: 'not-supported' });
  });

  it('a start recorded before tree ids is `not-supported` (its ref would not be the one the asking PC computes)', async () => {
    const rec = start();
    starts.push({ ...rec, treeId: undefined });
    commit(rec.worktreePath!, 'work.txt', 'done\n');
    expect(await answerTo(ask(box(), ASKER, { op: 'make', spawnId: rec.spawnId, origin: ORIGIN }))).toMatchObject({ op: 'refused', reason: 'not-supported' });
  });

  it('a PC removed while its bundle is made: nothing is kept for it and it is not answered', async () => {
    const rec = start();
    starts.push(rec);
    commit(rec.worktreePath!, 'work.txt', 'done\n');
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    let made: Promise<unknown> = Promise.resolve();
    const b = box({ make: (inp, opts) => (made = held.then(() => makeBundle(inp, opts))) as ReturnType<typeof makeBundle> });
    ask(b, ASKER, { op: 'make', spawnId: rec.spawnId, origin: ORIGIN });
    await vi.waitFor(() => expect(fs.existsSync(path.join(a2aDir, 'bundle-out', ASKER))).toBe(true), { timeout: 10_000 });
    b.forgetHost(ASKER);
    release();
    await made;
    await deliberateSleep(100, 'negative: the finished make keeps nothing and answers nobody');
    expect(b.standing(ASKER)).toEqual([]);
    expect(answers).toEqual([]);
    expect(fs.readdirSync(path.join(a2aDir, 'bundle-out', ASKER))).toEqual([]);
  });

  it('an offer past its time ends on its own, and its file goes', async () => {
    const rec = start();
    starts.push(rec);
    commit(rec.worktreePath!, 'work.txt', 'done\n');
    let clock = Date.now();
    const b = box({ now: () => clock });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await b.start();
      const made = await answerTo(ask(b, ASKER, { op: 'make', spawnId: rec.spawnId, origin: ORIGIN }));
      if (made.op !== 'made') throw new Error('not made');
      const file = path.join(a2aDir, 'bundle-out', ASKER, `${made.manifest.bundleId}.bundle`);
      clock += 61 * 60_000;
      vi.advanceTimersByTime(60_000);
      expect(b.standing(ASKER)).toEqual([]);
      await vi.waitFor(() => expect(fs.existsSync(file)).toBe(false), { timeout: 10_000 });
    } finally {
      b.stop();
      vi.useRealTimers();
    }
  });

  it('a PC that does not advertise bundle.1 is not answered, and nothing is made', async () => {
    const rec = start();
    starts.push(rec);
    commit(rec.worktreePath!, 'work.txt', 'done\n');
    takes = false;
    const make = vi.fn();
    const b = box({ make });
    ask(b, ASKER, { op: 'make', spawnId: rec.spawnId, origin: ORIGIN });
    await deliberateSleep(100, 'negative: no make starts and no answer is queued');
    expect(make).not.toHaveBeenCalled();
    expect(answers).toEqual([]);
  });

  it('bounds each PC: asks per minute, one make at a time, offers standing, and the bytes they take', async () => {
    const recs = [start(), start(), start()];
    starts.push(...recs);
    for (const r of recs) commit(r.worktreePath!, 'work.txt', `done ${r.spawnId}\n`);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const b = box({
      make: async (inp, opts) => {
        calls += 1;
        if (calls === 1) await held;
        return makeBundle(inp, opts);
      },
    });
    // One make at a time from a PC.
    const first = ask(b, ASKER, { op: 'make', spawnId: recs[0].spawnId, origin: ORIGIN });
    expect(await answerTo(ask(b, ASKER, { op: 'make', spawnId: recs[1].spawnId, origin: ORIGIN }))).toMatchObject({ reason: 'busy' });
    release();
    expect(await answerTo(first)).toMatchObject({ op: 'made' });
    // Offers standing: at most one here.
    limits = { offersPerHost: 1 };
    expect(await answerTo(ask(b, ASKER, { op: 'make', spawnId: recs[1].spawnId, origin: ORIGIN }))).toMatchObject({ reason: 'busy' });
    // The bytes they take: no room left past the first.
    const taken = b.standing(ASKER)[0].bytes;
    limits = { bytesPerHost: taken };
    expect(await answerTo(ask(b, ASKER, { op: 'make', spawnId: recs[2].spawnId, origin: ORIGIN }))).toMatchObject({ reason: 'busy' });
    // Asks per minute, of any kind: four so far this minute.
    limits = { asksPerMinute: 4 };
    const refused = ask(b, ASKER, { op: 'make', spawnId: recs[2].spawnId, origin: ORIGIN });
    expect(await answerTo(refused)).toMatchObject({ reason: 'rate-limited' });
    // Another PC has its own share.
    expect(await answerTo(ask(b, OTHER, { op: 'make', spawnId: spawnIdOf(), origin: ORIGIN }))).toMatchObject({ reason: 'unknown-spawn' });
  });

  it('makes at once, all PCs together, are bounded too', async () => {
    const a = start(ASKER);
    const o = start(OTHER);
    starts.push(a, o);
    commit(a.worktreePath!, 'a.txt', 'a\n');
    commit(o.worktreePath!, 'o.txt', 'o\n');
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    limits = { makesAtOnce: 1 };
    const b = box({ make: async (inp, opts) => { await held; return makeBundle(inp, opts); } });
    const first = ask(b, ASKER, { op: 'make', spawnId: a.spawnId, origin: ORIGIN });
    expect(await answerTo(ask(b, OTHER, { op: 'make', spawnId: o.spawnId, origin: ORIGIN }))).toMatchObject({ reason: 'busy' });
    release();
    expect(await answerTo(first)).toMatchObject({ op: 'made' });
  });

  it('a send of an offer that does not stand is `gone`; at start every staged file and every left ref goes', async () => {
    const rec = start();
    starts.push(rec);
    commit(rec.worktreePath!, 'work.txt', 'done\n');
    const b = box();
    expect(await answerTo(ask(b, ASKER, { op: 'send', bundleId: `bd-${crypto.randomUUID()}` }))).toMatchObject({ reason: 'gone' });
    const made = await answerTo(ask(b, ASKER, { op: 'make', spawnId: rec.spawnId, origin: ORIGIN }));
    expect(made.op).toBe('made');
    g(repo, 'update-ref', bundleRefName(rec.treeId!), base);
    await box().start();
    expect(fs.existsSync(path.join(a2aDir, 'bundle-out'))).toBe(false);
    expect(bundleRefs()).toBe('');
  });

  it('the outbox offers only a file in the maker\'s own folder for that PC, never through a link', () => {
    const own = path.join(a2aDir, 'bundle-out', ASKER);
    fs.mkdirSync(own, { recursive: true });
    const id = `bd-${crypto.randomUUID()}`;
    const outside = path.join(root, `${id}.bundle`);
    fs.writeFileSync(outside, 'x');
    const offer = (file: string, bundleId = id) => outbox.offer({ hostId: ASKER, bundleId, file, sha256: 'a'.repeat(64), bytes: 1 });
    expect(offer(outside)).toBe(false);
    if (posix) {
      fs.symlinkSync(outside, path.join(own, `${id}.bundle`));
      expect(offer(path.join(own, `${id}.bundle`))).toBe(false);
    }
    const other = `bd-${crypto.randomUUID()}`;
    fs.writeFileSync(path.join(a2aDir, 'bundle-out', `${other}.bundle`), 'x');
    expect(offer(path.join(a2aDir, 'bundle-out', `${other}.bundle`), other)).toBe(false);
    const good = `bd-${crypto.randomUUID()}`;
    fs.writeFileSync(path.join(own, `${good}.bundle`), 'x');
    expect(offer(path.join(own, `${good}.bundle`), good)).toBe(true);
  });

  describe('the made bundle reaches a crafted asking PC', () => {
    let server: http.Server;
    let port: number;
    let table: A2aRouteTable;
    const askerA2a = (): string => path.join(root, 'asker-a2a');

    beforeEach(async () => {
      table = new A2aRouteTable();
      outbox.registerRoutes(table);
      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const hostId = typeof req.headers['x-test-host'] === 'string' ? req.headers['x-test-host'] : ASKER;
        void table.handle(req, res, url, url.pathname, { peerId: 'p', hostId, name: 'peer' });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      port = (server.address() as AddressInfo).port;
    });

    afterEach(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });

    const getAs = (hostId: string): StreamedGet => (p, o, consume) => new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: p, headers: { 'x-test-host': hostId }, signal: o.signal }, (res) => {
        if ((res.statusCode ?? 0) >= 300) {
          res.resume();
          reject(new PinnedClientError('http', `HTTP ${res.statusCode}`, { sent: true, status: res.statusCode }));
          return;
        }
        consume({ headers: res.headers, body: res }).then(resolve, reject);
      });
      req.on('error', reject);
    });

    const putAs = (hostId: string): StreamedPut => (p, body, o) => new Promise((resolve, reject) => {
      const req = http.request({
        method: 'PUT', host: '127.0.0.1', port, path: p, signal: o.signal,
        headers: { 'x-test-host': hostId, 'content-type': 'application/octet-stream', 'content-length': String(o.bytes) },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) as unknown : null }));
      });
      req.on('error', reject);
      body.on('error', (err) => req.destroy(err));
      body.pipe(req);
    });

    async function made(b: BundleBox): Promise<{ rec: HeadlessStartRecordV1; head: string; manifest: { bundleId: string; sha256: string; bytes: number } }> {
      const rec = start();
      starts.push(rec);
      const head = commit(rec.worktreePath!, 'work.txt', 'done\n');
      const answer = await answerTo(ask(b, ASKER, { op: 'make', spawnId: rec.spawnId, origin: ORIGIN }));
      if (answer.op !== 'made') throw new Error(`not made: ${answer.reason}`);
      return { rec, head, manifest: answer.manifest };
    }

    it('fetched by the asking PC (it joined the box): staged whole, and it reads back as the head', async () => {
      const b = box();
      const { rec, head, manifest } = await made(b);
      const intake = new BundleIntake({ a2aDir: askerA2a(), enabled: () => true, fetchFrom: () => getAs(ASKER), log: () => undefined });
      expect(await intake.pull(BOX, manifest)).toMatchObject({ kind: 'staged' });
      const staged = bundleStagedFile(askerA2a(), BOX, manifest);
      expect(readBack(staged, rec.treeId!).head).toBe(head);
      // Another PC cannot fetch it.
      const stranger = new BundleIntake({ a2aDir: path.join(root, 'stranger'), enabled: () => true, fetchFrom: () => getAs(OTHER), log: () => undefined });
      expect(await stranger.pull(BOX, manifest)).toMatchObject({ kind: 'fatal' });
    });

    it('a PUT the asking PC was not waiting for (404) keeps the offer; once it waits, its next send lands it', async () => {
      const intake = new BundleIntake({ a2aDir: askerA2a(), enabled: () => true, fetchFrom: () => null, log: () => undefined });
      intake.registerRoutes(table);
      putter = putAs(BOX);
      const b = box();
      const { manifest } = await made(b);
      // Not waiting (the asking PC restarted): refused, and the box does not try again by itself.
      expect(await answerTo(ask(b, ASKER, { op: 'send', bundleId: manifest.bundleId }))).toMatchObject({ op: 'refused', reason: 'unavailable' });
      expect(b.standing(ASKER).map((m) => m.bundleId)).toEqual([manifest.bundleId]);
      const waiting = intake.receive(BOX, manifest);
      ask(b, ASKER, { op: 'send', bundleId: manifest.bundleId });
      expect(await waiting).toMatchObject({ kind: 'staged' });
    });

    it('an offer the outbox no longer serves is offered again when the same head is asked for', async () => {
      const b = box();
      const { manifest } = await made(b);
      outbox.withdraw(ASKER, manifest.bundleId);
      const rec = starts[starts.length - 1];
      expect(await answerTo(ask(b, ASKER, { op: 'make', spawnId: rec.spawnId, origin: ORIGIN }))).toMatchObject({ op: 'made', manifest });
      const intake = new BundleIntake({ a2aDir: askerA2a(), enabled: () => true, fetchFrom: () => getAs(ASKER), log: () => undefined });
      expect(await intake.pull(BOX, manifest)).toMatchObject({ kind: 'staged' });
    });

    it('put by the box (it joined the asking PC) once the asking PC waits and asks it to send', async () => {
      const intake = new BundleIntake({ a2aDir: askerA2a(), enabled: () => true, fetchFrom: () => null, log: () => undefined });
      intake.registerRoutes(table);
      putter = putAs(BOX);
      const b = box();
      const { rec, head, manifest } = await made(b);
      const waiting = intake.receive(BOX, manifest);
      ask(b, ASKER, { op: 'send', bundleId: manifest.bundleId });
      expect(await waiting).toMatchObject({ kind: 'staged' });
      expect(readBack(bundleStagedFile(askerA2a(), BOX, manifest), rec.treeId!).head).toBe(head);
    });
  });
});
