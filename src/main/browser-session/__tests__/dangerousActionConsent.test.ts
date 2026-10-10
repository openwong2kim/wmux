import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserPolicyStore } from '../BrowserPolicyStore';
import { ApprovalQueue, type ApprovalPromptInfo } from '../../mcp/ApprovalQueue';
import type { PluginTrustStore } from '../../mcp/PluginTrustStore';
import {
  DangerousActionConsent,
  openDownloadPass,
  type ConsentCaller,
  type DownloadGuardPort,
} from '../dangerousActionConsent';
import type { AutomationRunOwnership } from '../../automation/AutomationBridge';

// The consent rules end to end over the real policy store and the real
// approval queue: grant → silent; attended → one prompt per operation;
// unattended → needs_consent with nothing queued; any deny, timeout, late
// answer or changed terms → policy_denied, nothing allowed.

const WS = 'ws-1';
const PANE = 'pane-1';
const PROFILE = 'pa';
const HOSTS = { mode: 'allowlist' as const, allow: ['a.test', 'mail.google.com', 'bank.test'], block: [] };

let dir: string;
let store: BrowserPolicyStore;
let queue: ApprovalQueue;
let opened: ApprovalPromptInfo[];
let ownership: AutomationRunOwnership;

const flush = () => new Promise((r) => setTimeout(r, 0));

function caller(over: Partial<ConsentCaller> = {}): ConsentCaller {
  return { workspaceId: WS, paneId: PANE, profileId: PROFILE, epoch: store.epoch(), hosts: HOSTS, ptyId: 'pty-1', ...over };
}

/** Re-resolution reads the store as it is now, like main's real path. */
const revalidate = async () => caller();

function makeConsent(over: Partial<ConstructorParameters<typeof DangerousActionConsent>[0]> = {}) {
  return new DangerousActionConsent({
    store,
    queue: () => queue,
    runOwnership: () => ownership,
    ...over,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wmux-consent-'));
  store = new BrowserPolicyStore(dir);
  await store.write(
    { workspaceId: WS, paneId: PANE, profileId: PROFILE, protected: true, hosts: HOSTS, expectedEpoch: 0 },
    PROFILE,
    true,
  );
  opened = [];
  let n = 0;
  queue = new ApprovalQueue({ setUserDecision: vi.fn() } as unknown as PluginTrustStore, {
    openPrompt: (info) => opened.push(info),
    mintPromptId: () => `prompt-${++n}`,
  });
  ownership = 'not-owned';
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('DangerousActionConsent', () => {
  it('a standing grant allows without asking anyone', async () => {
    await store.setGrants(PANE, { workspaceId: WS, profileId: PROFILE }, () => ({ evaluate: true }), store.epoch());
    const decision = await makeConsent().authorize(caller(), { action: 'evaluate', hosts: ['a.test'] }, { revalidate });
    expect(decision.via).toBe('grant');
    expect(opened).toHaveLength(0);
  });

  it('attended, no grant: one prompt; approve once allows this call only, the next asks again', async () => {
    const consent = makeConsent();
    const first = consent.authorize(caller(), { action: 'evaluate', hosts: ['a.test'], detail: 'document.title' }, { revalidate });
    await flush();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      kind: 'browser-action',
      browserAction: { workspaceId: WS, paneId: PANE, action: 'evaluate', host: 'a.test', detail: 'document.title' },
    });
    await queue.resolvePrompt(opened[0].promptId, true);
    await expect(first).resolves.toMatchObject({ via: 'once' });

    const second = consent.authorize(caller(), { action: 'evaluate', hosts: ['a.test'] }, { revalidate });
    await flush();
    expect(opened).toHaveLength(2);
    await queue.resolvePrompt(opened[1].promptId, false);
    await expect(second).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('remember writes the grant at the caller’s epoch, bumps it, and the next call is silent', async () => {
    const consent = makeConsent();
    const before = store.epoch();
    const pending = consent.authorize(caller(), { action: 'download', hosts: ['a.test'] }, { revalidate });
    await flush();
    await queue.resolvePrompt(opened[0].promptId, true, { remember: true });
    const decision = await pending;
    expect(decision).toMatchObject({ via: 'remembered', epoch: before + 1 });
    expect(store.epoch()).toBe(before + 1);
    expect(store.grantsFor(PANE, WS, PROFILE)?.grants).toEqual({ download: true });
    await expect(
      consent.authorize(caller(), { action: 'download', hosts: ['a.test'] }, { revalidate }),
    ).resolves.toMatchObject({ via: 'grant' });
    expect(opened).toHaveLength(1);
  });

  it('remember is refused when the policy moved under the prompt: a stale answer grants nothing', async () => {
    const consent = makeConsent();
    const c = caller();
    const pending = consent.authorize(c, { action: 'evaluate', hosts: ['a.test'] }, {
      // The terms the operator answered under still match…
      revalidate: async () => c,
    });
    await flush();
    // …but the file moved on before the grant could be written.
    await store.bumpEpoch();
    await queue.resolvePrompt(opened[0].promptId, true, { remember: true });
    await expect(pending).rejects.toMatchObject({ code: 'policy_denied' });
    expect(store.grantsFor(PANE, WS, PROFILE)?.grants).toEqual({});
  });

  it('a timeout denies and takes the prompt off screen; a late click is no answer', async () => {
    const consent = makeConsent({ deadlineMs: 10 });
    const pending = consent.authorize(caller(), { action: 'evaluate', hosts: ['a.test'] }, { revalidate });
    await expect(pending).rejects.toMatchObject({ code: 'policy_denied' });
    expect(queue.inflightCount()).toBe(0);
    await queue.resolvePrompt(opened[0].promptId, true); // late: a no-op
  });

  it('an answer that lands after the deadline (timer not yet fired) is refused', async () => {
    let now = 1_000;
    const consent = makeConsent({ deadlineMs: 60_000, now: () => now });
    const pending = consent.authorize(caller(), { action: 'evaluate', hosts: ['a.test'] }, { revalidate });
    await flush();
    now += 61_000;
    await queue.resolvePrompt(opened[0].promptId, true);
    await expect(pending).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('two concurrent operations are two prompts, never one shared approval', async () => {
    const consent = makeConsent();
    const a = consent.authorize(caller(), { action: 'evaluate', hosts: ['a.test'] }, { revalidate });
    const b = consent.authorize(caller(), { action: 'evaluate', hosts: ['a.test'] }, { revalidate });
    await flush();
    expect(opened).toHaveLength(2);
    expect(opened[0].promptId).not.toBe(opened[1].promptId);
    await queue.resolvePrompt(opened[0].promptId, true);
    await expect(a).resolves.toMatchObject({ via: 'once' });
    await queue.resolvePrompt(opened[1].promptId, false);
    await expect(b).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it.each(['owned', 'unknown'] as const)('an unattended (%s) caller gets needs_consent at once, with zero prompts', async (state) => {
    ownership = state;
    const log = vi.fn();
    await expect(
      makeConsent({ log }).authorize(caller({ ptyId: 'auto-run-1' }), { action: 'download', hosts: ['a.test'] }, { revalidate }),
    ).rejects.toMatchObject({ code: 'needs_consent', message: expect.stringMatching(/^browser\.consent\.request: needs_consent: download on a\.test/) });
    expect(opened).toHaveLength(0);
    expect(queue.inflightCount()).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('an unattended run with a standing grant is allowed without asking', async () => {
    ownership = 'owned';
    await store.setGrants(PANE, { workspaceId: WS, profileId: PROFILE }, () => ({ download: true }), store.epoch());
    await expect(
      makeConsent().authorize(caller(), { action: 'download', hosts: ['a.test'] }, { revalidate }),
    ).resolves.toMatchObject({ via: 'grant' });
  });

  it('a pane whose terms changed under the prompt is refused after an approval', async () => {
    const consent = makeConsent();
    const pending = consent.authorize(caller(), { action: 'evaluate', hosts: ['a.test'] }, {
      revalidate: async () => caller({ profileId: 'other' }),
    });
    await flush();
    await queue.resolvePrompt(opened[0].promptId, true);
    await expect(pending).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('never asks about a host outside the pane’s site policy', async () => {
    await expect(
      makeConsent().authorize(caller(), { action: 'evaluate', hosts: ['evil.test'] }, { revalidate }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    expect(opened).toHaveLength(0);
  });

  it('a sensitive-site grant covers exactly its hosts', async () => {
    await store.setGrants(PANE, { workspaceId: WS, profileId: PROFILE }, () => ({ sensitiveHosts: ['mail.google.com'] }), store.epoch());
    const consent = makeConsent();
    await expect(
      consent.authorize(caller(), { action: 'sensitive', hosts: ['mail.google.com'] }, { revalidate }),
    ).resolves.toMatchObject({ via: 'grant' });
    const other = consent.authorize(caller(), { action: 'sensitive', hosts: ['mail.google.com', 'bank.test'] }, { revalidate });
    await flush();
    expect(opened).toHaveLength(1);
    expect(opened[0].browserAction?.host).toBe('mail.google.com, bank.test');
    await queue.resolvePrompt(opened[0].promptId, false);
    await expect(other).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('a caller that goes away withdraws its prompt', async () => {
    const ac = new AbortController();
    const pending = makeConsent().authorize(caller(), { action: 'evaluate', hosts: ['a.test'] }, { revalidate, signal: ac.signal });
    await flush();
    ac.abort();
    await expect(pending).rejects.toMatchObject({ code: 'policy_denied' });
    expect(queue.inflightCount()).toBe(0);
  });

  it('with no queue yet nobody can be asked, so it is refused', async () => {
    await expect(
      makeConsent({ queue: () => null }).authorize(caller(), { action: 'evaluate', hosts: ['a.test'] }, { revalidate }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });
});

describe('openDownloadPass', () => {
  function fakeGuard() {
    const sent: Array<[string, Record<string, unknown>]> = [];
    let claimant: ((p: Record<string, unknown>) => boolean) | null = null;
    const progress = new Set<(p: Record<string, unknown>) => void>();
    const guard: DownloadGuardPort = {
      send: async (method, params) => {
        sent.push([method, params]);
        return {};
      },
      claim: (fn) => {
        if (claimant) return null;
        claimant = fn;
        return () => {
          if (claimant === fn) claimant = null;
        };
      },
      onProgress: (fn) => {
        progress.add(fn);
        return () => progress.delete(fn);
      },
    };
    return {
      guard,
      sent,
      /** What the launcher's guard does: true = kept by the claimant. */
      begin: (p: Record<string, unknown>) => claimant?.(p) === true,
      progress: (p: Record<string, unknown>) => progress.forEach((l) => l(p)),
      claimed: () => claimant !== null,
    };
  }
  const opts = { frameId: 'T1', dir: '/tmp/x', startTimeoutMs: 5_000, finishTimeoutMs: 5_000, join: (d: string, n: string) => `${d}/${n}` };
  const lastBehavior = (sent: Array<[string, Record<string, unknown>]>) =>
    sent.filter(([m]) => m === 'Browser.setDownloadBehavior').at(-1)?.[1].behavior;

  it('keeps only the first download of the approved tab and restores deny at once', async () => {
    const g = fakeGuard();
    const pass = await openDownloadPass(g.guard, opts);
    expect(lastBehavior(g.sent)).toBe('allowAndName');
    expect(g.begin({ guid: 'other-tab', frameId: 'T2', url: 'http://a.test/x' })).toBe(false);
    expect(g.begin({ guid: 'g1', frameId: 'T1', url: 'http://a.test/f', suggestedFilename: 'f.bin' })).toBe(true);
    expect(g.begin({ guid: 'g2', frameId: 'T1', url: 'http://a.test/again' })).toBe(false);
    // Deny is back as soon as the kept download is under way.
    g.progress({ guid: 'g1', state: 'inProgress' });
    expect(lastBehavior(g.sent)).toBe('deny');
    g.progress({ guid: 'g1', state: 'completed' });
    await expect(pass.done).resolves.toEqual({ url: 'http://a.test/f', suggestedFilename: 'f.bin', path: '/tmp/x/g1' });
    expect(g.claimed()).toBe(false);
  });

  it('no download in time: refused, claim released, deny restored', async () => {
    const g = fakeGuard();
    const pass = await openDownloadPass(g.guard, { ...opts, startTimeoutMs: 5 });
    await expect(pass.done).rejects.toMatchObject({ code: 'policy_denied' });
    expect(g.claimed()).toBe(false);
    expect(lastBehavior(g.sent)).toBe('deny');
  });

  it('a cancelled pass cancels its running download and restores deny', async () => {
    const g = fakeGuard();
    const pass = await openDownloadPass(g.guard, opts);
    g.begin({ guid: 'g1', frameId: 'T1' });
    pass.cancel();
    await expect(pass.done).rejects.toMatchObject({ code: 'policy_denied' });
    expect(g.sent.some(([m, p]) => m === 'Browser.cancelDownload' && p.guid === 'g1')).toBe(true);
    expect(lastBehavior(g.sent)).toBe('deny');
  });

  it('one pass per Chrome at a time', async () => {
    const g = fakeGuard();
    await openDownloadPass(g.guard, opts);
    await expect(openDownloadPass(g.guard, opts)).rejects.toMatchObject({ code: 'policy_denied' });
  });
});
