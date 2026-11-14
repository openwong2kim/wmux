// Bring-back end to end on one machine: a real headless start's worktree, the
// real box (bundleBox.ts, bundleMaker.ts) and the real asker (bundleAsker.ts),
// their envelopes handed straight to each other, the transfer a file copy in
// place of the PUT, and the real import (main/worktask/bundleImport.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { A2aRemoteEnvelope, HostId } from '../../../shared/a2aRemote';
import type { A2aBundleManifestV1 } from '../../../shared/a2aBundle';
import { BundleAsker } from '../bundleAsker';
import { BundleBox } from '../bundleBox';
import { bundleStagedFile, type BundlePull } from '../bundleIntake';
import type { BundleOffer, BundleSend } from '../bundleOutbox';
import { headlessTreeId } from '../headlessStarter';
import type { HeadlessStartRecordV1 } from '../headlessStartStore';
import { importBundle } from '../../../main/worktask/bundleImport';
import { trackedTempDir } from '../../../test-utils/trackedTempDir';

const ASKER = '0f1e2d3c-4b5a-4968-8776-655443322110' as HostId;
const BOX = '1f1e2d3c-4b5a-4968-8776-655443322111' as HostId;
const SPAWN = 'sp-11111111-2222-4333-8444-555555555555';
const ORIGIN = 'github.com/o/r';
/** The import on whatever git this runner has: its floor is tested in bundleImport.os. */
const ANY_GIT: readonly [number, number, number] = [0, 0, 0];

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let home: string;
let worktree: string;
let rec: HeadlessStartRecordV1;

beforeEach(() => {
  root = fs.realpathSync(trackedTempDir('wmux-bring-back-e2e-'));
  repo = path.join(root, 'box-repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  g(repo, 'config', 'remote.origin.url', `https://${ORIGIN}.git`);
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  g(repo, 'add', 'README.md');
  g(repo, 'commit', '-q', '-m', 'base');
  const base = g(repo, 'rev-parse', 'HEAD');
  home = path.join(root, 'home');
  execFileSync('git', ['clone', '-q', repo, home]);
  // The headless start the asking PC made on the box: its worktree, on its own branch, with the agent's commit.
  const treeId = headlessTreeId(ASKER, SPAWN);
  const branch = `wmux/remote/${treeId}`;
  worktree = path.join(root, `wt-${treeId}`);
  g(repo, 'worktree', 'add', '-q', '-b', branch, worktree, base);
  fs.writeFileSync(path.join(worktree, 'work.txt'), 'the agent\'s work\n');
  g(worktree, 'add', 'work.txt');
  g(worktree, 'commit', '-q', '-m', 'work');
  rec = {
    v: 1, hostId: ASKER, spawnId: SPAWN, agent: 'claude', repoPath: repo, treeId, sessionId: 's', workspaceId: 'w', agentSessionId: 'a',
    lineage: ASKER, runId: 'r', phase: 'started', worktreePath: worktree, cwd: worktree, baseCommit: base, branch, startedAt: new Date().toISOString(),
  } as HeadlessStartRecordV1;
});

afterEach(() => vi.useRealTimers());

function wire() {
  const boxDir = path.join(root, 'box-a2a');
  const askerDir = path.join(root, 'asker-a2a');
  fs.mkdirSync(boxDir);
  fs.mkdirSync(askerDir);
  const asks: Array<{ op: string; askId: string }> = [];
  const offers = new Map<string, BundleOffer>();
  const waits = new Map<string, (r: BundlePull) => void>();
  let box: BundleBox | null = null;
  const asker: BundleAsker = new BundleAsker({
    a2aDir: askerDir,
    intake: {
      // The box joined this PC: it puts the bundle here (receive), never fetched.
      pull: async () => ({ kind: 'not-joined' }),
      receive: (_hostId: HostId, m: unknown) => new Promise<BundlePull>((resolve) => { waits.set((m as A2aBundleManifestV1).bundleId, resolve); }),
      cancel: () => undefined,
      discard: async (hostId: HostId, m: unknown) => { fs.rmSync(bundleStagedFile(askerDir, hostId, m as A2aBundleManifestV1), { force: true }); },
      sweepStaged: async () => 0,
      stop: () => undefined,
      forgetHost: async () => undefined,
    },
    enabled: () => true,
    peerTakes: () => true,
    selfHostId: () => ASKER,
    enqueue: (_hostId: HostId, env: A2aRemoteEnvelope) => {
      asks.push({ op: env.bundleAsk!.op, askId: env.linkId });
      box!.applyInbound(env, { hostId: ASKER });
    },
    log: () => undefined,
  });
  box = new BundleBox({
    a2aDir: boxDir,
    enabled: () => true,
    peerTakes: () => true,
    startOf: (hostId, spawnId) => (hostId === rec.hostId && spawnId === rec.spawnId ? rec : undefined),
    starts: () => [rec],
    outbox: {
      offer: (o: BundleOffer) => { offers.set(o.bundleId, o); return true; },
      withdraw: (_hostId: HostId, bundleId: string) => { offers.delete(bundleId); },
      // The PUT: the offered file lands in the asker's staging, and its wait is over.
      send: async (hostId: HostId, bundleId: string): Promise<BundleSend> => {
        const o = offers.get(bundleId);
        const done = waits.get(bundleId);
        if (!o || !done) return { kind: 'fatal', why: 'not offered or not awaited' };
        const m = { bundleId, sha256: o.sha256, bytes: o.bytes };
        const target = bundleStagedFile(askerDir, BOX, m);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(o.file, target);
        done({ kind: 'staged', file: target });
        return { kind: 'sent' };
      },
    },
    enqueue: (_hostId: HostId, env: A2aRemoteEnvelope) => { asker.applyInbound(env, { hostId: BOX }); },
    log: () => undefined,
  });
  return { asker, box, asks, offers };
}

async function stagedOf(asker: BundleAsker) {
  let state = await asker.bringBack(BOX, SPAWN, ORIGIN);
  await vi.waitFor(async () => {
    state = await asker.bringBack(BOX, SPAWN, ORIGIN);
    expect(state.state).toBe('staged');
  }, { timeout: 10_000 });
  if (state.state !== 'staged') throw new Error('not staged');
  return state;
}

describe('bring-back end to end (real box, real asker, real git)', () => {
  it('make → send → done each under its own ask id; the import lands the box head; staging is cleaned; a repeat is a no-op', async () => {
    const { asker, box, asks, offers } = wire();
    const staged = await stagedOf(asker);
    // One ask id per op: the box keeps one answer per host:askId, so a send under the make's id would get the make's answer.
    expect(asks.map((a) => a.op)).toEqual(['make', 'send', 'done']);
    expect(new Set(asks.map((a) => a.askId)).size).toBe(3);
    // The box ended its offer on `done`.
    expect(box.standing(ASKER)).toEqual([]);
    expect(offers.size).toBe(0);

    const noHooks = path.join(root, 'no-hooks');
    fs.mkdirSync(noHooks);
    const imported = await importBundle({ top: home, spawnId: SPAWN, file: staged.file, manifest: staged.manifest, ref: staged.ref, noHooksDir: noHooks }, undefined, ANY_GIT);
    const boxHead = g(worktree, 'rev-parse', 'HEAD');
    expect(imported).toMatchObject({ ok: true, sha: boxHead, noop: false });
    expect(g(home, 'rev-parse', `refs/heads/wmux/returned/${SPAWN}`)).toBe(boxHead);
    await asker.release(BOX, SPAWN);
    expect(fs.existsSync(staged.file)).toBe(false);

    // Again, with nothing new on the box: a new bundle of the same head, and an import that changes nothing.
    asks.length = 0;
    const again = await stagedOf(asker);
    expect(asks.map((a) => a.op)).toEqual(['make', 'send', 'done']);
    expect(await importBundle({ top: home, spawnId: SPAWN, file: again.file, manifest: again.manifest, ref: again.ref, noHooksDir: noHooks }, undefined, ANY_GIT))
      .toMatchObject({ ok: true, sha: boxHead, noop: true });
    await asker.release(BOX, SPAWN);
  });

  it('the box answers a redelivered ask with its stored answer, which the asker no longer takes', async () => {
    const { asker, box, asks } = wire();
    await stagedOf(asker);
    // The make delivered again: the box answers it as before (its answer for that id), and nothing moves on this side.
    const make = asks[0];
    const before = await asker.bringBack(BOX, SPAWN, ORIGIN);
    box.applyInbound({
      protocol: 1, linkId: make.askId, linkVersion: 0, messageId: `bq_${make.askId}_again`, kind: 'link',
      link: { state: 'bundle-ask', version: 0 }, bundleAsk: { v: 1, askId: make.askId, op: 'make', spawnId: SPAWN, origin: ORIGIN }, sentAt: new Date().toISOString(),
    } as unknown as A2aRemoteEnvelope, { hostId: ASKER });
    await new Promise((r) => setImmediate(r));
    expect(await asker.bringBack(BOX, SPAWN, ORIGIN)).toEqual(before);
    expect(asks.filter((a) => a.op === 'send')).toHaveLength(1);
    await asker.release(BOX, SPAWN);
  });
});
