import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REPO_WATCH_LIMITS,
  RepoWatch,
  WATCH_PAGE_QUERY,
  WATCH_QUERY,
  checksOf,
  diffRepo,
  mapWatchAnswer,
  normalizeRepoKey,
  watchedRepos,
  type WatchGraphql,
} from '../repoWatch';
import { GhPrReviewService } from '../../github/GhPrReviewService';
import { GhRateBreaker } from '../../github/ghRateBreaker';
import { factDedupeKey, type FactDraft } from '../../../shared/facts';
import type { BotProfile } from '../../../shared/bot';
import type { PrReviewRead } from '../../../shared/prReview';

const KEY = 'github.com/acme/app';
const T0 = Date.parse('2026-10-12T00:00:00Z');

interface PrSpec {
  number: number;
  head: string;
  rollup?: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | null;
  rollupOid?: string;
  labels?: string[];
  /** The label count GitHub reports (default: every label was read). */
  labelTotal?: number;
  author?: string;
  createdAt?: number;
}
interface IssueSpec { number: number; labels?: string[]; labelTotal?: number; createdAt?: number; author?: string }
interface RepoSpec { prs: PrSpec[]; prTotal?: number; recent?: Array<{ number: number; state: 'MERGED' | 'CLOSED' }>; issues?: IssueSpec[]; issueTotal?: number }

function prNode(p: PrSpec) {
  return {
    number: p.number, title: `PR ${p.number}`, createdAt: new Date(p.createdAt ?? T0 - 86_400_000).toISOString(),
    state: 'OPEN', isDraft: false, headRefOid: p.head, headRefName: `b${p.number}`, isCrossRepository: false,
    mergeStateStatus: 'CLEAN', author: { login: p.author ?? 'owner' },
    labels: { totalCount: p.labelTotal ?? (p.labels ?? []).length, nodes: (p.labels ?? []).map((name) => ({ name })) },
    commits: { nodes: [{ commit: { oid: p.rollupOid ?? p.head, statusCheckRollup: p.rollup === undefined || p.rollup === null ? null : { state: p.rollup } } }] },
  };
}

function answer(spec: RepoSpec, prs = spec.prs, hasNext = false) {
  return {
    data: {
      rateLimit: { cost: 1, remaining: 4999 },
      repository: {
        open: { totalCount: spec.prTotal ?? spec.prs.length, pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? 'CUR' : null }, nodes: prs.map(prNode) },
        recent: { nodes: spec.recent ?? [] },
        issues: {
          totalCount: spec.issueTotal ?? (spec.issues ?? []).length,
          nodes: (spec.issues ?? []).map((i) => ({
            number: i.number, title: `I ${i.number}`, createdAt: new Date(i.createdAt ?? T0 - 86_400_000).toISOString(),
            state: 'OPEN', author: { login: i.author ?? 'someone' }, labels: { totalCount: i.labelTotal ?? (i.labels ?? []).length, nodes: (i.labels ?? []).map((name) => ({ name })) },
          })),
        },
      },
    },
  };
}

/** A fake gh: serves `spec` (first page = first 100 PRs). */
function fakeGh(get: () => RepoSpec) {
  const calls: Array<{ query: string; vars: Record<string, string | number> }> = [];
  const graphql: WatchGraphql = async (_p, _k, query, vars) => {
    calls.push({ query, vars });
    const spec = get();
    if (query === WATCH_PAGE_QUERY) return { ok: true, value: answer(spec, spec.prs.slice(100), false) };
    return { ok: true, value: answer(spec, spec.prs.slice(0, 100), spec.prs.length > 100) };
  };
  return { graphql, calls };
}

/** A fact log fake that dedupes like the real one. */
function fakeFacts() {
  const keys = new Set<string>();
  const appended: FactDraft[] = [];
  return {
    appended,
    append(draft: FactDraft) {
      const key = factDedupeKey(draft);
      if (!key || keys.has(key)) return null;
      keys.add(key);
      appended.push(draft);
      return { ...draft, id: String(appended.length), seq: appended.length, dedupeKey: key };
    },
  };
}

function bot(id: string, repoKey = KEY, workspaceId = 'ws-1'): BotProfile {
  return {
    version: 1, id, workspaceId, role: 'verifier', name: 'V', engine: { kind: 'claude-sdk' }, triggers: [],
    budget: { maxTurnsPerHour: 1, maxTurnsPerDay: 1, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 },
    repo: { repoKey, repoPath: '/repo' }, enabled: true, createdAt: 0, updatedAt: 0,
  };
}

let dir = '';
let now = T0;
let timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
let made: RepoWatch[] = [];

function makeWatch(opts: { graphql: WatchGraphql; facts: ReturnType<typeof fakeFacts>; bots?: BotProfile[]; enabled?: () => boolean }) {
  const w = new RepoWatch({
    facts: opts.facts,
    bots: { listEnabled: () => opts.bots ?? [bot('bot-00000001')] },
    graphql: opts.graphql,
    stateFile: path.join(dir, 'factory', 'repo-watch.json'),
    enabled: opts.enabled,
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    log: () => undefined,
  });
  made.push(w);
  return w;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-repo-watch-'));
  now = T0;
  timers = [];
  made = [];
});

afterEach(async () => {
  // Let every state write land before the directory goes.
  for (const w of made) await w.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('repoWatch — baseline and edges', () => {
  it('the first poll of a repo is a baseline: state saved, zero facts', async () => {
    const spec: RepoSpec = { prs: [{ number: 1, head: 'a1', rollup: 'FAILURE', labels: ['x'] }], issues: [{ number: 9, labels: ['bug'] }] };
    const gh = fakeGh(() => spec);
    const facts = fakeFacts();
    const w = makeWatch({ graphql: gh.graphql, facts });
    await w.start();
    const out = await w.pollNow(KEY);
    expect(out).toMatchObject({ ok: true, baseline: true, emitted: 0, calls: 1 });
    expect(facts.appended).toEqual([]);
    expect(w.stateOf(KEY)?.prs['1']).toMatchObject({ headSha: 'a1', checks: 'fail' });
    await w.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'factory', 'repo-watch.json'), 'utf8'));
    expect(saved.version).toBe(1);
    expect(Object.keys(saved.repos)).toEqual([KEY]);
    await w.dispose();
  });

  it('one head move → exactly one pr.head_moved, and nothing more on the next poll', async () => {
    let spec: RepoSpec = { prs: [{ number: 1, head: 'a1', rollup: 'PENDING' }] };
    const gh = fakeGh(() => spec);
    const facts = fakeFacts();
    const w = makeWatch({ graphql: gh.graphql, facts });
    await w.start();
    await w.pollNow(KEY);
    spec = { prs: [{ number: 1, head: 'a2', rollup: 'PENDING' }] };
    await w.pollNow(KEY);
    await w.pollNow(KEY);
    expect(facts.appended.map((f) => [f.kind, f.ref?.headSha])).toEqual([['pr.head_moved', 'a2']]);
    expect(facts.appended[0]).toMatchObject({ repoKey: KEY, ref: { pr: 1 }, payload: { author: 'owner', previousHeadSha: 'a1' } });
    await w.dispose();
  });

  it('a restart diffs against the saved state: no repeats, the next change still emits', async () => {
    let spec: RepoSpec = { prs: [{ number: 1, head: 'a1', rollup: 'PENDING' }] };
    const gh = fakeGh(() => spec);
    const facts = fakeFacts();
    const w1 = makeWatch({ graphql: gh.graphql, facts });
    await w1.start();
    await w1.pollNow(KEY);
    spec = { prs: [{ number: 1, head: 'a2', rollup: 'SUCCESS' }] };
    await w1.pollNow(KEY);
    await w1.flush();
    await w1.dispose();
    const before = facts.appended.length;
    expect(facts.appended.map((f) => f.kind)).toEqual(['pr.head_moved', 'ci.green']);

    // A fresh process: a new fact log (no dedupe memory) and the saved file.
    const facts2 = fakeFacts();
    const w2 = makeWatch({ graphql: gh.graphql, facts: facts2 });
    await w2.start();
    const out = await w2.pollNow(KEY);
    expect(out).toMatchObject({ ok: true, baseline: false, emitted: 0 });
    expect(facts2.appended).toEqual([]);
    spec = { prs: [{ number: 1, head: 'a3', rollup: 'PENDING' }] };
    await w2.pollNow(KEY);
    expect(facts2.appended.map((f) => [f.kind, f.ref?.headSha])).toEqual([['pr.head_moved', 'a3']]);
    expect(before).toBe(2);
    await w2.dispose();
  });

  it('an unreadable state file is a baseline (silence, not a burst)', async () => {
    fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'factory', 'repo-watch.json'), '{not json');
    const gh = fakeGh(() => ({ prs: [{ number: 1, head: 'a1', rollup: 'SUCCESS' }] }));
    const facts = fakeFacts();
    const w = makeWatch({ graphql: gh.graphql, facts });
    await w.start();
    expect(await w.pollNow(KEY)).toMatchObject({ baseline: true, emitted: 0 });
    await w.dispose();
  });
});

describe('repoWatch — review regressions', () => {
  it('a fact that fails to append keeps the previous state, so the next poll emits it', async () => {
    let spec: RepoSpec = { prs: [{ number: 1, head: 'a1' }] };
    const gh = fakeGh(() => spec);
    const facts = fakeFacts();
    let broken = false;
    const flaky = { appended: facts.appended, append: (d: FactDraft) => { if (broken) throw new Error('disk full'); return facts.append(d); } };
    const w = makeWatch({ graphql: gh.graphql, facts: flaky as ReturnType<typeof fakeFacts> });
    await w.start();
    await w.pollNow(KEY);
    spec = { prs: [{ number: 1, head: 'a2' }] };
    broken = true;
    expect(await w.pollNow(KEY)).toMatchObject({ ok: false, emitted: 0 });
    expect(w.stateOf(KEY)?.prs['1'].headSha).toBe('a1');
    broken = false;
    expect(await w.pollNow(KEY)).toMatchObject({ ok: true, emitted: 1 });
    expect(facts.appended.map((f) => f.kind)).toEqual(['pr.head_moved']);
    await w.dispose();
  });

  it('a malformed saved entry is not trusted: that repo starts from a baseline', async () => {
    fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'factory', 'repo-watch.json'), JSON.stringify({
      version: 1,
      repos: { [KEY]: { lastPollAt: 1, baselineAt: 1, prsComplete: true, capped: false, prs: { 1: {} }, issues: {} } },
    }));
    const gh = fakeGh(() => ({ prs: [{ number: 1, head: 'sha', rollup: 'FAILURE' }] }));
    const facts = fakeFacts();
    const w = makeWatch({ graphql: gh.graphql, facts });
    await w.start();
    expect(await w.pollNow(KEY)).toMatchObject({ baseline: true, emitted: 0 });
    await w.dispose();
  });

  it('dispose resolves only after the queued state write landed', async () => {
    const w = makeWatch({ graphql: fakeGh(() => ({ prs: [{ number: 1, head: 'a' }] })).graphql, facts: fakeFacts() });
    await w.start();
    await w.pollNow(KEY);
    await w.dispose();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'factory', 'repo-watch.json'), 'utf8'));
    expect(saved.repos[KEY].prs['1'].headSha).toBe('a');
  });
});

describe('diffRepo — ci, labels, open/close, issues', () => {
  const base = (prs: PrSpec[], extra: Partial<RepoSpec> = {}) => diffRepo(undefined, snap({ prs, ...extra }), KEY, T0).next;
  function snap(spec: RepoSpec) {
    const m = mapWatchAnswer(answer(spec));
    if (!m) throw new Error('fixture did not map');
    return m.snapshot;
  }

  it('ci edges on one head: pending → pass once, pass → fail once, level never repeats', () => {
    let state = base([{ number: 1, head: 'h', rollup: 'PENDING' }]);
    const kinds: string[] = [];
    for (const rollup of ['PENDING', 'SUCCESS', 'SUCCESS', 'FAILURE', 'FAILURE', 'ERROR'] as const) {
      const d = diffRepo(state, snap({ prs: [{ number: 1, head: 'h', rollup }] }), KEY, T0 + 1);
      kinds.push(...d.drafts.map((f) => f.kind));
      state = d.next;
    }
    expect(kinds).toEqual(['ci.green', 'ci.failed']);
  });

  it('a new head that is already red yields head_moved then ci.failed; a rollup of another commit is pending', () => {
    const state = base([{ number: 1, head: 'h1', rollup: 'FAILURE' }]);
    const d = diffRepo(state, snap({ prs: [{ number: 1, head: 'h2', rollup: 'FAILURE' }] }), KEY, T0 + 1);
    expect(d.drafts.map((f) => [f.kind, f.ref?.headSha])).toEqual([['pr.head_moved', 'h2'], ['ci.failed', 'h2']]);
    const stale = diffRepo(state, snap({ prs: [{ number: 1, head: 'h3', rollup: 'SUCCESS', rollupOid: 'h1' }] }), KEY, T0 + 1);
    expect(stale.drafts.map((f) => f.kind)).toEqual(['pr.head_moved']);
    expect(checksOf('SUCCESS', 'x', 'y')).toBe('pending');
    expect(checksOf(undefined, 'y', 'y')).toBe('pending');
  });

  it('pr.opened (with its ci), pr.labelled per added label, merged / closed from the recent list', () => {
    const state = base([{ number: 1, head: 'h1', labels: ['a'] }, { number: 2, head: 'h2' }, { number: 3, head: 'h3' }]);
    const d = diffRepo(state, snap({
      prs: [{ number: 1, head: 'h1', labels: ['a', 'b', 'c'] }, { number: 4, head: 'h4', rollup: 'SUCCESS', author: 'ext' }],
      recent: [{ number: 2, state: 'MERGED' }],
    }), KEY, T0 + 1);
    expect(d.drafts.map((f) => [f.kind, f.ref?.pr, f.ref?.label])).toEqual([
      ['pr.labelled', 1, 'b'],
      ['pr.labelled', 1, 'c'],
      ['pr.opened', 4, undefined],
      ['ci.green', 4, undefined],
      ['pr.merged', 2, undefined],
      ['pr.closed', 3, undefined],
    ]);
    expect(d.drafts.find((f) => f.kind === 'pr.closed')?.payload).toMatchObject({ stateUnknown: true });
    expect(d.drafts.find((f) => f.kind === 'pr.opened')?.payload).toMatchObject({ author: 'ext', isCrossRepository: false });
    expect(d.next.prs['2']).toBeUndefined();
    for (const f of d.drafts) expect(factDedupeKey(f)).not.toBeNull();
  });

  it('issues: opened only when created after the baseline; an older one entering the window is silent; labels emit per added label', () => {
    const state = base([], { issues: [{ number: 1, labels: [] }] });
    const d = diffRepo(state, snap({
      prs: [],
      issues: [{ number: 1, labels: ['bug'] }, { number: 2, createdAt: T0 + 5 }, { number: 3, createdAt: T0 - 5 }],
    }), KEY, T0 + 10);
    expect(d.drafts.map((f) => [f.kind, f.ref?.issue, f.ref?.label])).toEqual([
      ['issue.labelled', 1, 'bug'],
      ['issue.opened', 2, undefined],
    ]);
    expect(d.next.issues['3']).toBeDefined();
  });

  it('a label list cut short on either side yields no label edge', () => {
    const many = Array.from({ length: 20 }, (_, i) => `l${String(i).padStart(2, '0')}`);
    // 21 labels, 20 read; one removed → the unread one shows up, which is not an addition.
    const state = base([{ number: 1, head: 'h', labels: many, labelTotal: 21 }], { issues: [{ number: 5, labels: many, labelTotal: 21 }] });
    const shown = [...many.slice(1), 'l20'];
    const d = diffRepo(state, snap({ prs: [{ number: 1, head: 'h', labels: shown, labelTotal: 20 }], issues: [{ number: 5, labels: shown, labelTotal: 20 }] }), KEY, T0 + 1);
    expect(d.drafts).toEqual([]);
    expect(d.next.prs['1'].labelsTruncated).toBeUndefined();
    // Both sides complete again → a real addition emits.
    const d2 = diffRepo(d.next, snap({ prs: [{ number: 1, head: 'h', labels: [...shown.slice(1), 'new'] }] }), KEY, T0 + 2);
    expect(d2.drafts.map((f) => [f.kind, f.ref?.label])).toEqual([['pr.labelled', 'new']]);
  });

  it('issues outside an incomplete window are kept, not forgotten', () => {
    const state = base([], { issues: [{ number: 1 }, { number: 2 }] });
    const d = diffRepo(state, snap({ prs: [], issues: [{ number: 2 }], issueTotal: 500 }), KEY, T0 + 1);
    expect(Object.keys(d.next.issues).sort()).toEqual(['1', '2']);
  });
});

describe('repoWatch — caps', () => {
  it('101–200 open PRs: one extra page read; over 200: watch_cap on the rising edge only, and no close detection', async () => {
    const many = (n: number, head = 'h') => Array.from({ length: n }, (_, i) => ({ number: i + 1, head: `${head}${i + 1}` }));
    let spec: RepoSpec = { prs: many(150) };
    const gh = fakeGh(() => spec);
    const facts = fakeFacts();
    const w = makeWatch({ graphql: gh.graphql, facts, bots: [bot('bot-00000001'), bot('bot-00000002', KEY, 'ws-2')] });
    await w.start();
    expect(await w.pollNow(KEY)).toMatchObject({ ok: true, calls: 2, emitted: 0 });
    expect(gh.calls.map((c) => c.query === WATCH_QUERY ? 'main' : 'page')).toEqual(['main', 'page']);
    expect(gh.calls[1].vars).toMatchObject({ after: 'CUR', owner: 'acme', repo: 'app' });
    expect(Object.keys(w.stateOf(KEY)!.prs)).toHaveLength(150);

    spec = { prs: many(150), prTotal: 250 };
    const out = await w.pollNow(KEY);
    expect(out?.emitted).toBe(2); // one refusal per workspace
    expect(facts.appended.map((f) => [f.kind, f.workspaceId, f.payload.code])).toEqual([
      ['bot.refused', 'ws-1', 'watch_cap'],
      ['bot.refused', 'ws-2', 'watch_cap'],
    ]);
    // Still capped: no new refusal; PRs not read are not reported closed.
    now += 60_001;
    spec = { prs: many(150).slice(10), prTotal: 260 };
    expect((await w.pollNow(KEY))?.emitted).toBe(0);
    expect(w.stateOf(KEY)!.prs['1']).toBeDefined();
    await w.dispose();
  });

  it('more than MAX_REPOS repos: the first ten by key are watched, the rest refused once', async () => {
    const bots = Array.from({ length: 11 }, (_, i) => bot(`bot-0000000${i.toString(16)}`.slice(0, 12), `github.com/acme/r${String(i).padStart(2, '0')}`));
    const { watched, overCap } = watchedRepos(bots);
    expect(watched).toHaveLength(REPO_WATCH_LIMITS.MAX_REPOS);
    expect(overCap.map((r) => r.repoKey)).toEqual(['github.com/acme/r10']);
    const facts = fakeFacts();
    const w = makeWatch({ graphql: fakeGh(() => ({ prs: [] })).graphql, facts, bots });
    await w.start();
    w.reconcile();
    expect(w.watching()).toHaveLength(10);
    expect(facts.appended.filter((f) => f.kind === 'bot.refused')).toHaveLength(1);
    await w.dispose();
  });
});

describe('repoWatch — loop, breaker, scope', () => {
  it('a rate-limited poll waits for the breaker, and no gh call is made while it is open', async () => {
    const breaker = new GhRateBreaker(() => now);
    const execCalls: string[][] = [];
    let limited = true;
    const service = new GhPrReviewService(() => now, async (_cmd, args) => {
      execCalls.push(args);
      if (limited) throw Object.assign(new Error('gh failed'), { stderr: 'gh: API rate limit exceeded for user (HTTP 403)' });
      return { stdout: JSON.stringify(answer({ prs: [] })) };
    }, breaker);
    const graphql: WatchGraphql = (p, k, q, v) => service.watchGraphql(p, k, q, v) as Promise<PrReviewRead<unknown>>;
    const facts = fakeFacts();
    const w = makeWatch({ graphql, facts });
    await w.start();
    // The loop's first tick runs immediately.
    const first = timers.find((t) => t.ms === 0 && !t.cleared)!;
    first.fn();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(execCalls).toHaveLength(1);
    // 60 s backoff on the first trip; the next tick is not before it.
    expect(breaker.retryAt('github.com')).toBe(T0 + 60_000);
    expect(timers.at(-1)!.ms).toBe(60_000);

    // A poll while the breaker is open makes no gh call.
    expect(await w.pollNow(KEY)).toMatchObject({ ok: false, retryAt: T0 + 60_000 });
    expect(execCalls).toHaveLength(1);

    // A second trip doubles the backoff and the loop waits that long.
    now = T0 + 60_000;
    const out = await w.pollNow(KEY);
    expect(out?.retryAt).toBe(T0 + 60_000 + 120_000);
    expect(execCalls).toHaveLength(2);
    limited = false;
    now = T0 + 180_000;
    expect(await w.pollNow(KEY)).toMatchObject({ ok: true, baseline: true });
    await w.dispose();
  });

  it('the loop schedules the next poll at retryAt when that is later than the interval', async () => {
    const graphql: WatchGraphql = async () => ({ ok: false, code: 'rate-limited', message: 'GitHub rate limit', retryAt: T0 + 300_000 });
    const w = makeWatch({ graphql, facts: fakeFacts() });
    await w.start();
    timers.find((t) => t.ms === 0)!.fn();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(timers.at(-1)!.ms).toBe(300_000);
    await w.dispose();
  });

  it('factory off: nothing is watched and the state is dropped (turning it on is a baseline)', async () => {
    let on = true;
    const gh = fakeGh(() => ({ prs: [{ number: 1, head: 'a' }] }));
    const facts = fakeFacts();
    const w = makeWatch({ graphql: gh.graphql, facts, enabled: () => on });
    await w.start();
    await w.pollNow(KEY);
    expect(w.stateOf(KEY)).toBeDefined();
    on = false;
    w.reconcile();
    expect(w.watching()).toEqual([]);
    expect(w.stateOf(KEY)).toBeUndefined();
    on = true;
    w.reconcile();
    expect(await w.pollNow(KEY)).toMatchObject({ baseline: true, emitted: 0 });
    await w.dispose();
  });

  it('repo keys normalize to host/owner/repo', () => {
    expect(normalizeRepoKey('Acme/App')).toBe('github.com/acme/app');
    expect(normalizeRepoKey('github.com/acme/app.git')).toBe('github.com/acme/app');
    expect(normalizeRepoKey('nope')).toBeNull();
    expect(normalizeRepoKey(undefined)).toBeNull();
  });
});
