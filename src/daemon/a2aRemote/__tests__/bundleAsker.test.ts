import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { A2aRemoteEnvelope, HostId } from '../../../shared/a2aRemote';
import { bundleRefName, type A2aBundleManifestV1, type A2aBundleRefusal } from '../../../shared/a2aBundle';
import { BUNDLE_ASK_LIMITS } from '../../../shared/a2aBundleAsk';
import { BundleAsker, type BundleAskerDeps } from '../bundleAsker';
import { bundleStagedFile, type BundlePull } from '../bundleIntake';
import { headlessTreeId } from '../headlessStarter';
import { trackedTempDir } from '../../../test-utils/trackedTempDir';

const HOST = '0f1e2d3c-4b5a-4968-8776-655443322110' as HostId;
const OTHER = '1f1e2d3c-4b5a-4968-8776-655443322111' as HostId;
const SELF = '2f1e2d3c-4b5a-4968-8776-655443322112';
const SPAWN = 'sp-11111111-2222-4333-8444-555555555555';
const ORIGIN = 'github.com/o/r';
const M: A2aBundleManifestV1 = { bundleId: 'bd-11111111-2222-4333-8444-555555555555', sha256: 'a'.repeat(64), bytes: 10 };

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => undefined;
  return { promise: new Promise<T>((r) => { resolve = r; }), resolve };
}

function harness(over: Partial<BundleAskerDeps> = {}, dir = trackedTempDir('wmux-bundle-asker-')) {
  const sent: Array<{ hostId: HostId; env: A2aRemoteEnvelope }> = [];
  const order: string[] = [];
  let pullResult: () => Promise<BundlePull> = async () => ({ kind: 'staged', file: bundleStagedFile(dir, HOST, M) });
  let receiveResult: () => Promise<BundlePull> = async () => ({ kind: 'staged', file: bundleStagedFile(dir, HOST, M) });
  const intake = {
    pull: vi.fn(async () => pullResult()),
    receive: vi.fn((): Promise<BundlePull> => {
      order.push('receive');
      return receiveResult();
    }),
    cancel: vi.fn(),
    discard: vi.fn(async () => undefined),
    sweepStaged: vi.fn(async (_keep: (hostId: HostId, file: string) => boolean) => 0),
    stop: vi.fn(),
    forgetHost: vi.fn(async () => undefined),
  };
  let enabled = true;
  const deps: BundleAskerDeps = {
    a2aDir: dir,
    intake,
    enabled: () => enabled,
    peerTakes: (h) => h === HOST,
    selfHostId: () => SELF,
    enqueue: (hostId, env) => {
      order.push(`send:${env.bundleAsk?.op}`);
      sent.push({ hostId, env });
    },
    log: () => undefined,
    random: () => 0,
    ...over,
  };
  const asker = new BundleAsker(deps);
  const lastAsk = () => sent[sent.length - 1].env;
  const answer = (made: { op: 'made'; manifest: A2aBundleManifestV1 } | { op: 'refused'; reason: A2aBundleRefusal }, from: HostId = HOST, askId = lastAsk().linkId) =>
    asker.applyInbound({
      protocol: 1, linkId: askId, linkVersion: 0, messageId: `bm_${askId}`, kind: 'link',
      link: { state: 'bundle-made', version: 0 }, bundleMade: { v: 1, askId, ...made }, sentAt: new Date().toISOString(),
    } as unknown as A2aRemoteEnvelope, { hostId: from });
  return {
    dir, asker, intake, sent, order, answer, lastAsk,
    setPull: (f: () => Promise<BundlePull>) => { pullResult = f; },
    setReceive: (f: () => Promise<BundlePull>) => { receiveResult = f; },
    setEnabled: (v: boolean) => { enabled = v; },
  };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('BundleAsker', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  it('asks the box to make a bundle of the spawn, on a link envelope of its own', async () => {
    const h = harness();
    expect(await h.asker.bringBack(HOST, SPAWN, ORIGIN)).toEqual({ state: 'asking' });
    expect(h.sent).toHaveLength(1);
    const env = h.lastAsk();
    expect(env).toMatchObject({ kind: 'link', linkVersion: 0, link: { state: 'bundle-ask', version: 0 }, bundleAsk: { v: 1, op: 'make', spawnId: SPAWN, origin: ORIGIN } });
    expect(env.bundleAsk?.askId).toBe(env.linkId);
  });

  it('refuses a PC that does not take bundles, and everything while the feature is off', async () => {
    const h = harness();
    expect(await h.asker.bringBack(OTHER, SPAWN, ORIGIN)).toEqual({ state: 'refused', reason: 'not-supported' });
    h.setEnabled(false);
    expect(await h.asker.bringBack(HOST, SPAWN, ORIGIN)).toEqual({ state: 'refused', reason: 'feature-off' });
    expect(h.sent).toHaveLength(0);
  });

  it('follows one ask per spawn: a second call sends nothing', async () => {
    const h = harness();
    await h.asker.bringBack(HOST, SPAWN, ORIGIN);
    await h.asker.bringBack(HOST, SPAWN, ORIGIN);
    expect(h.sent).toHaveLength(1);
  });

  it('takes an answer only from the PC asked, for the latest ask id', async () => {
    const h = harness();
    await h.asker.bringBack(HOST, SPAWN, ORIGIN);
    expect(h.answer({ op: 'made', manifest: M }, OTHER)).toEqual({ ok: true, duplicate: false });
    expect(h.answer({ op: 'made', manifest: M }, HOST, 'ba-99999999-2222-4333-8444-555555555555')).toEqual({ ok: true, duplicate: false });
    await flush();
    expect(h.intake.pull).not.toHaveBeenCalled();
    // A malformed answer is refused outright.
    expect(h.answer({ op: 'made', manifest: { ...M, sha256: 'x' } } as never)).toEqual({ ok: false, error: 'bad-request' });
  });

  it('pulls a made bundle, tells the box it has it, and names the ref it computed itself', async () => {
    const h = harness();
    await h.asker.bringBack(HOST, SPAWN, ORIGIN);
    h.answer({ op: 'made', manifest: M });
    await flush();
    expect(h.intake.pull).toHaveBeenCalledWith(HOST, M);
    expect(h.lastAsk().bundleAsk).toMatchObject({ op: 'done', bundleId: M.bundleId });
    fs.mkdirSync(path.dirname(bundleStagedFile(h.dir, HOST, M)), { recursive: true });
    fs.writeFileSync(bundleStagedFile(h.dir, HOST, M), 'x'.repeat(M.bytes));
    expect(await h.asker.bringBack(HOST, SPAWN, ORIGIN)).toEqual({
      state: 'staged', file: bundleStagedFile(h.dir, HOST, M), manifest: M, ref: bundleRefName(headlessTreeId(SELF, SPAWN)),
    });
  });

  it('when the box joined this PC, waits for the bundle before asking it to send', async () => {
    const h = harness();
    h.setPull(async () => ({ kind: 'not-joined' }));
    await h.asker.bringBack(HOST, SPAWN, ORIGIN);
    h.answer({ op: 'made', manifest: M });
    await flush();
    expect(h.order).toEqual(['send:make', 'receive', 'send:send', 'send:done']);
  });

  it('retries again/busy/rate-limited with backoff under a new ask id each time, at most three times', async () => {
    const h = harness();
    await h.asker.bringBack(HOST, SPAWN, ORIGIN);
    const ids = [h.lastAsk().linkId];
    for (let i = 0; i < BUNDLE_ASK_LIMITS.retries; i++) {
      h.answer({ op: 'refused', reason: i === 1 ? 'rate-limited' : 'busy' });
      await vi.advanceTimersByTimeAsync(BUNDLE_ASK_LIMITS.backoffMs[i] - 1);
      expect(h.sent).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sent).toHaveLength(i + 2);
      ids.push(h.lastAsk().linkId);
    }
    expect(new Set(ids).size).toBe(ids.length);
    h.answer({ op: 'refused', reason: 'busy' });
    expect(await h.asker.bringBack(HOST, SPAWN, ORIGIN)).toEqual({ state: 'refused', reason: 'busy' });
  });

  it('makes it again when the box no longer holds it, or cannot send it', async () => {
    const h = harness();
    h.setPull(async () => ({ kind: 'not-joined' }));
    const never = deferred<BundlePull>();
    h.setReceive(() => never.promise);
    await h.asker.bringBack(HOST, SPAWN, ORIGIN);
    h.answer({ op: 'made', manifest: M });
    await flush();
    expect(h.lastAsk().bundleAsk?.op).toBe('send');
    h.answer({ op: 'refused', reason: 'gone' });
    expect(h.intake.cancel).toHaveBeenCalledWith(HOST, M);
    await vi.advanceTimersByTimeAsync(BUNDLE_ASK_LIMITS.backoffMs[0]);
    expect(h.lastAsk().bundleAsk?.op).toBe('make');
    h.answer({ op: 'made', manifest: M });
    await flush();
    h.answer({ op: 'refused', reason: 'unavailable' });
    await vi.advanceTimersByTimeAsync(BUNDLE_ASK_LIMITS.backoffMs[1]);
    expect(h.lastAsk().bundleAsk?.op).toBe('make');
  });

  it('a refusal is told once with its reason; the next call asks anew', async () => {
    const h = harness();
    await h.asker.bringBack(HOST, SPAWN, ORIGIN);
    h.answer({ op: 'refused', reason: 'uncommitted-only' });
    expect(await h.asker.bringBack(HOST, SPAWN, ORIGIN)).toEqual({ state: 'refused', reason: 'uncommitted-only' });
    expect(await h.asker.bringBack(HOST, SPAWN, ORIGIN)).toEqual({ state: 'asking' });
    expect(h.sent.filter((s) => s.env.bundleAsk?.op === 'make')).toHaveLength(2);
  });

  it('keeps at most four asks per PC', async () => {
    const h = harness();
    for (let i = 0; i < BUNDLE_ASK_LIMITS.perHostFiles; i++) {
      expect(await h.asker.bringBack(HOST, `sp-11111111-2222-4333-8444-55555555555${i}`, ORIGIN)).toEqual({ state: 'asking' });
    }
    expect(await h.asker.bringBack(HOST, SPAWN.replace(/5$/, '9'), ORIGIN)).toEqual({ state: 'refused', reason: 'staging-full' });
  });

  it('after a restart asks open asks again and keeps a staged one to import', async () => {
    const h = harness();
    await h.asker.bringBack(HOST, SPAWN, ORIGIN);
    const staged = 'sp-11111111-2222-4333-8444-555555555556';
    await h.asker.bringBack(HOST, staged, ORIGIN);
    h.answer({ op: 'made', manifest: M });
    await flush();
    fs.mkdirSync(path.dirname(bundleStagedFile(h.dir, HOST, M)), { recursive: true });
    fs.writeFileSync(bundleStagedFile(h.dir, HOST, M), 'x'.repeat(M.bytes));

    const again = harness({}, h.dir);
    again.asker.start();
    expect(again.sent.map((s) => [s.env.bundleAsk?.op, (s.env.bundleAsk as { spawnId?: string }).spawnId])).toEqual([['make', SPAWN]]);
    expect(await again.asker.bringBack(HOST, staged, ORIGIN)).toMatchObject({ state: 'staged' });
    again.asker.stop();
  });

  it('the sweep ends asks past their time, ends open asks when the feature is off, and keeps only staged files', async () => {
    const h = harness();
    await h.asker.bringBack(HOST, SPAWN, ORIGIN);
    h.setEnabled(false);
    await h.asker.sweep();
    expect(h.intake.stop).toHaveBeenCalled();
    h.setEnabled(true);
    expect(await h.asker.bringBack(HOST, SPAWN, ORIGIN)).toEqual({ state: 'refused', reason: 'feature-off' });
    const keep = h.intake.sweepStaged.mock.calls[0][0];
    expect(keep(HOST, bundleStagedFile(h.dir, HOST, M))).toBe(false);

    const old = harness({ now: () => 0 });
    await old.asker.bringBack(HOST, SPAWN, ORIGIN);
    const later = harness({ now: () => BUNDLE_ASK_LIMITS.stagedTtlMs + 1 }, old.dir);
    await later.asker.sweep();
    expect(await later.asker.bringBack(HOST, SPAWN, ORIGIN)).toEqual({ state: 'asking' });
    expect(later.sent.filter((s) => s.env.bundleAsk?.op === 'make')).toHaveLength(1);
  });

  it('release discards the staged file and ends the ask', async () => {
    const h = harness();
    await h.asker.bringBack(HOST, SPAWN, ORIGIN);
    h.answer({ op: 'made', manifest: M });
    await flush();
    await h.asker.release(HOST, SPAWN);
    expect(h.intake.discard).toHaveBeenCalledWith(HOST, M);
    expect(await h.asker.bringBack(HOST, SPAWN, ORIGIN)).toEqual({ state: 'asking' });
  });
});
