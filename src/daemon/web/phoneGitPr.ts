import { execFile } from 'node:child_process';
import { createGitRunner, gitArgv, type GitRunner } from './sessionDiff';
import { githubRepository } from './sessionPullRequests';
import {
  phoneGitWriteHandlers, registerPhoneGitWriteAction,
  type GitWriteExecuteContext, type GitWritePreviewResult, type GitWriteSessionContext, type PhoneGitWriteActionHandlers,
} from './phoneGitWriteRegistry';
import { GhRateBreaker, isRateLimitError } from '../../main/github/ghRateBreaker';
import { getExecEnv } from '../../shared/execEnv';
import { projectCheck, summarizeChecks, type PhoneCheckState } from '../../shared/phoneGitV1';
import { mergeBlock, squashSubject, type MergeBlock, type PrCheck, type PrCheckBucket, type PrReviewHead } from '../../shared/prReview';
import {
  GIT_WRITE_MERGE_METHODS, GIT_WRITE_OID,
  type GitWriteErrorBody, type PrCreateExecuteBody, type PrMergeChecks, type PrMergeExecuteBody, type PrMergeFacts,
} from '../../shared/phoneGitWrite';

/**
 * The phone's `pr.create` and `pr.merge` actions (docs/phone-client-contract.md,
 * "Phone git write actions"). The routes own the gate, tokens and receipts;
 * this module owns the gh work.
 *
 * Every gh call names the repository (`--repo github.com/<owner>/<repo>`, or
 * GraphQL variables) taken from the session's `origin`, and runs with the
 * write identity's environment (`ctx.ghEnv`). Large text (a PR body, a squash
 * body) goes over stdin, never argv.
 *
 * Merge is squash only, always with `--match-head-commit`, one at a time per
 * (repository, number).
 *
 * Once a write may have reached GitHub, its receipt settles only from what a
 * read shows: `done` when the read proves this request's effect, otherwise
 * `uncertain` (the handler rejects and the routes record it). Such a request is
 * never `refused` and never run again from here. `refused` is for what was
 * decided before anything was sent.
 */

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 60_000;
const GH_MAX_BUFFER = 4 * 1024 * 1024;
const GITHUB_HOST = 'github.com';
/** Checks are read 100 per page, at most this many pages. */
const MAX_CHECK_PAGES = 10;
/** Waits before each read of a merge gh reported as done, until the squash commit shows. */
const MERGED_READ_DELAYS_MS = [0, 1_000, 2_000];
/** Clock difference tolerated between this host and GitHub when matching a created PR. */
const CREATED_SKEW_MS = 2 * 60_000;

export type PrGhResult =
  | { ok: true; stdout: string }
  /** `spawned: false`: gh never started (not installed), so nothing reached GitHub. */
  | { ok: false; spawned: boolean; stdout: string; stderr: string };

/**
 * No `cwd`: every call names its repository, so gh never runs in the session's
 * checkout. On Windows a bare `gh` is looked up in the working directory before
 * PATH, so a `gh.exe` committed to the repository root would otherwise be
 * started with the write token in its environment.
 */
export type PrGhRunner = (args: readonly string[], opts: { env: NodeJS.ProcessEnv; input?: string; timeoutMs: number }) => Promise<PrGhResult>;

const runGh: PrGhRunner = (args, opts) => new Promise((resolve) => {
  const child = execFile('gh', [...args], {
    env: opts.env, timeout: opts.timeoutMs, maxBuffer: GH_MAX_BUFFER, windowsHide: true,
  }, (error, stdout, stderr) => {
    if (!error) return resolve({ ok: true, stdout: String(stdout) });
    resolve({ ok: false, spawned: (error as NodeJS.ErrnoException).code !== 'ENOENT', stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
  child.stdin?.on('error', () => { /* gh exited before reading its input; the exit says why */ });
  child.stdin?.end(opts.input ?? '');
});

/**
 * The environment one gh call gets: the write identity's, with the search path
 * a GUI-launched daemon lacks (Homebrew's gh) added, as every other spawn site
 * does. Windows keeps its own `Path`.
 */
export function ghCallEnv(ghEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform === 'win32') return ghEnv;
  const searchPath = getExecEnv().PATH;
  return searchPath ? { ...ghEnv, PATH: searchPath } : ghEnv;
}

/** A refusal raised inside a handler; becomes the preview's answer or the receipt's `refused`. */
class Refusal extends Error {
  constructor(readonly body: GitWriteErrorBody) { super(body.error); }
}

/** What a failed gh call says about GitHub's answer. */
type GhFailure = 'rate-limited' | 'auth' | 'forbidden' | 'pr-not-found' | 'unknown';

function classify(stderr: string): GhFailure {
  if (isRateLimitError({ stderr })) return 'rate-limited';
  if (/\bHTTP 401\b|Bad credentials/i.test(stderr)) return 'auth';
  if (/Could not resolve to a PullRequest/i.test(stderr)) return 'pr-not-found';
  if (/Could not resolve to a Repository|\bHTTP 40[34]\b|Resource not accessible/i.test(stderr)) return 'forbidden';
  return 'unknown';
}

const BUCKETS: Partial<Record<PhoneCheckState, PrCheckBucket>> = {
  success: 'pass', neutral: 'pass', skipped: 'skipping', cancelled: 'cancel',
  queued: 'pending', in_progress: 'pending', pending: 'pending',
};
const bucketOf = (state: PhoneCheckState): PrCheckBucket => BUCKETS[state] ?? 'fail';

const checkFields = (required: string) => `__typename
                  ... on CheckRun { name status conclusion detailsUrl startedAt completedAt ${required} }
                  ... on StatusContext { context state targetUrl ${required} }`;

/**
 * The merge sheet's facts, one page of checks at a time (`$after`). `isRequired`
 * exists only in GraphQL; when a read with it fails, the read is repeated
 * without it and the required lists are omitted.
 */
const mergeQuery = (withRequired: boolean) => `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    squashMergeAllowed
    pullRequest(number: $number) {
      number title state isDraft mergeable mergeStateStatus
      headRefOid headRefName baseRefName mergeCommit { oid }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100, after: $after) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes {
                  ${checkFields(withRequired ? 'isRequired(pullRequestNumber: $number)' : '')}
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/** pr.create's checks in one read: the pushed head and the base. Open PRs are read over REST, by head owner. */
const CREATE_QUERY = `query($owner: String!, $repo: String!, $headQ: String!, $baseQ: String!, $hasBase: Boolean!) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name compare(headRef: $headQ) { aheadBy } }
    baseRef: ref(qualifiedName: $baseQ) @include(if: $hasBase) { name compare(headRef: $headQ) { aheadBy } }
    headRef: ref(qualifiedName: $headQ) { target { oid } }
  }
}`;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The check rollup page inside a `mergeQuery` answer, or null when there is none to read. */
function contextsOf(raw: unknown): { nodes: unknown[]; totalCount: unknown; hasNextPage: boolean; endCursor: string } | null {
  const pr = obj(obj(obj(obj(raw)?.data)?.repository)?.pullRequest);
  const commit = obj(obj((obj(pr?.commits)?.nodes as unknown[] | undefined)?.[0])?.commit);
  const contexts = obj(obj(commit?.statusCheckRollup)?.contexts);
  if (!contexts || !Array.isArray(contexts.nodes)) return null;
  const pageInfo = obj(contexts.pageInfo);
  return { nodes: contexts.nodes, totalCount: contexts.totalCount, hasNextPage: pageInfo?.hasNextPage === true, endCursor: str(pageInfo?.endCursor) };
}

/**
 * Every check read for a merge. `null`: the PR has no readable rollup.
 * `complete: false`: some checks could not be read, so the state is not settled.
 */
export type PrMergeRollup = { nodes: unknown[]; complete: boolean } | null;

/** A merge read: the facts plus what execute needs and the sheet does not show. */
export interface PrMergeRead { facts: PrMergeFacts; mergeCommitOid: string | null }

const UNSETTLED_OVERRIDES: ReadonlySet<MergeBlock | null> = new Set<MergeBlock | null>([null, 'behind', 'blocked', 'unknown']);

/** PrMergeFacts from a `mergeQuery` answer and its checks. Throws a Refusal when there is no such PR. */
export function mapMergeFacts(raw: unknown, rollup: PrMergeRollup, number: number, login: string): PrMergeRead {
  const repository = obj(obj(obj(raw)?.data)?.repository);
  if (!repository) throw new Refusal({ error: 'remote-forbidden', login });
  const pr = obj(repository.pullRequest);
  if (!pr || pr.number !== number) throw new Refusal({ error: 'pr-not-found' });
  const headRefOid = str(pr.headRefOid);
  if (!GIT_WRITE_OID.test(headRefOid)) throw new Error('the pull request head is not a commit id');
  const nodes = rollup?.nodes ?? [];
  const settled = rollup === null || rollup.complete;
  const summary = summarizeChecks(nodes);
  const rows = nodes.flatMap((n) => {
    const check = projectCheck(n);
    return check ? [{ name: check.name, bucket: bucketOf(check.state), isRequired: obj(n)?.isRequired }] : [];
  });
  const overall = !settled && (summary.overall === 'success' || summary.overall === 'none') ? 'pending' : summary.overall;
  const checks: PrMergeChecks = { overall, counts: { ...summary.counts } };
  // Required lists only when every check was read and GitHub said, for each, whether it is required.
  if (rollup !== null && settled && rows.length === nodes.length && rows.every((r) => typeof r.isRequired === 'boolean')) {
    checks.requiredFailing = rows.filter((r) => r.isRequired && (r.bucket === 'fail' || r.bucket === 'cancel')).map((r) => r.name);
    checks.requiredPending = rows.filter((r) => r.isRequired && r.bucket === 'pending').map((r) => r.name);
  }
  const head: PrReviewHead = {
    number, title: str(pr.title), url: '', state: str(pr.state), isDraft: pr.isDraft === true, headRefOid,
    headRefName: str(pr.headRefName), baseRefName: str(pr.baseRefName),
    mergeable: str(pr.mergeable) || 'UNKNOWN', mergeStateStatus: str(pr.mergeStateStatus) || 'UNKNOWN',
  };
  const forBlock: PrCheck[] = rows.map((r) => ({ name: r.name, workflow: '', bucket: r.bucket, link: '' }));
  let block = mergeBlock(head, forBlock);
  // Checks not read may still be running: never call that mergeable.
  if (!settled && UNSETTLED_OVERRIDES.has(block)) block = 'checks-pending';
  const mergeCommitOid = str(obj(pr.mergeCommit)?.oid);
  return {
    facts: {
      number, title: head.title, state: head.state, isDraft: head.isDraft,
      headRefOid, headRefName: head.headRefName, baseRefName: head.baseRefName,
      mergeable: head.mergeable, mergeStateStatus: head.mergeStateStatus,
      block,
      squashAllowed: repository.squashMergeAllowed === true,
      checks,
      methods: [...GIT_WRITE_MERGE_METHODS],
      subject: squashSubject(head.title, number),
      body: '',
      identity: { login },
    },
    mergeCommitOid: GIT_WRITE_OID.test(mergeCommitOid) ? mergeCommitOid : null,
  };
}

/** An open PR as the REST list shows it. */
interface OpenPr { number: number; title: string; base: string; draft: boolean; createdAt: number; url: string }

export interface PhoneGitPrDeps {
  gh?: PrGhRunner;
  git?: GitRunner;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The pr.create and pr.merge handlers over injected gh and git runners. */
export function createPhoneGitPrHandlers(deps: PhoneGitPrDeps = {}): { create: PhoneGitWriteActionHandlers; merge: PhoneGitWriteActionHandlers } {
  const gh = deps.gh ?? runGh;
  const git = deps.git ?? createGitRunner();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const breaker = new GhRateBreaker(now);
  /** `owner/repo#number`, lowercased: two checkouts of one repository share it. */
  const merging = new Set<string>();

  /**
   * One gh call as the write identity. Throws a Refusal when nothing was sent
   * (the rate-limit hold, gh missing). A read also throws one for a refusal
   * nobody reads further; a write returns every answer it got, for the
   * read-back to settle.
   */
  async function call(ctx: GitWriteSessionContext, args: string[], opts: { timeoutMs: number; input?: string; write?: boolean; readBack?: boolean }): Promise<PrGhResult & { failure?: GhFailure }> {
    // A read-back still asks: it is the only way to learn what a write did.
    const until = opts.readBack ? null : breaker.retryAt(GITHUB_HOST);
    if (until !== null) throw new Refusal({ error: 'rate-limited', retryAt: until });
    const out = await gh(args, { env: ghCallEnv(ctx.ghEnv), timeoutMs: opts.timeoutMs, ...(opts.input !== undefined ? { input: opts.input } : {}) });
    if (out.ok) {
      // A read-back went past the hold, so it does not lift it either.
      if (!opts.readBack) breaker.reset(GITHUB_HOST);
      return out;
    }
    if (!out.spawned) throw new Refusal({ error: 'gh-unavailable' });
    const failure = classify(out.stderr);
    if (failure === 'rate-limited') breaker.trip(GITHUB_HOST);
    if (opts.write) return { ...out, failure };
    if (failure === 'rate-limited') throw new Refusal({ error: 'rate-limited', retryAt: breaker.retryAt(GITHUB_HOST) ?? now() });
    if (failure === 'auth') throw new Refusal({ error: 'gh-auth-missing', login: ctx.login });
    if (failure === 'forbidden') throw new Refusal({ error: 'remote-forbidden', login: ctx.login });
    return { ...out, failure };
  }

  /** `owner/repo` of the session's `origin` on github.com. */
  async function slugOf(ctx: GitWriteSessionContext): Promise<{ owner: string; repo: string; slug: string }> {
    const remote = await git(gitArgv('remote', 'get-url', 'origin'), ctx.cwd);
    if (!remote.ok && !remote.ran) throw new Refusal({ error: 'git-operation-failed' });
    const slug = remote.ok ? githubRepository(remote.stdout) : null;
    if (!slug) throw new Refusal({ error: 'remote-unsupported' });
    const [owner, repo] = slug.split('/');
    return { owner, repo, slug };
  }

  const graphql = (ctx: GitWriteSessionContext, query: string, vars: string[], readBack = false) =>
    call(ctx, ['api', 'graphql', '--hostname', GITHUB_HOST, '-f', `query=${query}`, ...vars], { timeoutMs: READ_TIMEOUT_MS, readBack });

  /** The PR and every page of its checks; null when the read failed. */
  async function readMergePages(ctx: GitWriteSessionContext, vars: string[], withRequired: boolean, readBack: boolean): Promise<{ raw: unknown; rollup: PrMergeRollup } | null> {
    const first = await graphql(ctx, mergeQuery(withRequired), vars, readBack);
    if (!first.ok) {
      if (first.failure === 'pr-not-found') throw new Refusal({ error: 'pr-not-found' });
      return null;
    }
    const raw = JSON.parse(first.stdout) as unknown;
    let page = contextsOf(raw);
    if (!page) return { raw, rollup: null };
    const head = str(obj(obj(obj(obj(raw)?.data)?.repository)?.pullRequest)?.headRefOid);
    const nodes = [...page.nodes];
    for (let n = 1; page.hasNextPage; n++) {
      if (n >= MAX_CHECK_PAGES || !page.endCursor) return { raw, rollup: { nodes, complete: false } };
      const next = await graphql(ctx, mergeQuery(withRequired), [...vars, '-f', `after=${page.endCursor}`], readBack).catch(() => null);
      const nextRaw = next?.ok ? JSON.parse(next.stdout) as unknown : null;
      const nextPage = contextsOf(nextRaw);
      // A head that moved between pages belongs to other checks.
      if (!nextPage || str(obj(obj(obj(obj(nextRaw)?.data)?.repository)?.pullRequest)?.headRefOid) !== head) {
        return { raw, rollup: { nodes, complete: false } };
      }
      nodes.push(...nextPage.nodes);
      page = nextPage;
    }
    const complete = typeof page.totalCount === 'number' && page.totalCount <= nodes.length;
    return { raw, rollup: { nodes, complete } };
  }

  /** The merge read; a read GitHub refuses with `isRequired` is repeated without it. */
  async function readMerge(ctx: GitWriteSessionContext, owner: string, repo: string, number: number, readBack = false): Promise<PrMergeRead> {
    const vars = ['-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `number=${number}`];
    for (const withRequired of [true, false]) {
      const read = await readMergePages(ctx, vars, withRequired, readBack);
      if (read) return mapMergeFacts(read.raw, read.rollup, number, ctx.login);
    }
    throw new Refusal({ error: 'gh-unavailable' });
  }

  /** Open PRs whose head is `<owner>:<branch>` in this repository; a fork's branch of the same name is not this head. */
  async function openPrsFor(ctx: GitWriteSessionContext, owner: string, repo: string, slug: string, headName: string, readBack = false): Promise<OpenPr[]> {
    const out = await call(ctx, [
      'api', '--hostname', GITHUB_HOST, '-X', 'GET', `repos/${owner}/${repo}/pulls`,
      '-f', `head=${owner}:${headName}`, '-f', 'state=open', '-f', 'per_page=100',
    ], { timeoutMs: READ_TIMEOUT_MS, readBack });
    if (!out.ok) throw new Refusal({ error: 'gh-unavailable' });
    const rows = JSON.parse(out.stdout) as unknown;
    if (!Array.isArray(rows)) throw new Refusal({ error: 'gh-unavailable' });
    return rows.flatMap((r): OpenPr[] => {
      const pr = obj(r);
      const head = obj(pr?.head);
      if (!pr || !Number.isSafeInteger(pr.number) || (pr.number as number) <= 0) return [];
      if (str(head?.ref) !== headName || str(obj(head?.repo)?.full_name).toLowerCase() !== slug.toLowerCase()) return [];
      return [{
        number: pr.number as number, title: str(pr.title), base: str(obj(pr.base)?.ref), draft: pr.draft === true,
        createdAt: Date.parse(str(pr.created_at)), url: str(pr.html_url),
      }];
    });
  }

  const lockKey = (slug: string, number: number) => `${slug.toLowerCase()}#${number}`;
  const refuser = (ctx: GitWriteExecuteContext) => (b: GitWriteErrorBody) => {
    const { error, ...fields } = b;
    ctx.settle({ state: 'refused', error, ...(Object.keys(fields).length ? { fields } : {}) });
  };

  const merge: PhoneGitWriteActionHandlers = {
    async preview(ctx): Promise<GitWritePreviewResult> {
      const number = ctx.number as number;
      try {
        const { owner, repo, slug } = await slugOf(ctx);
        if (merging.has(lockKey(slug, number))) return { ok: false, body: { error: 'merge-in-flight' } };
        const { facts } = await readMerge(ctx, owner, repo, number);
        return { ok: true, facts: { ...facts }, pins: { number, headRefOid: facts.headRefOid } };
      } catch (error) {
        if (error instanceof Refusal) return { ok: false, body: error.body };
        throw error;
      }
    },

    async execute(ctx: GitWriteExecuteContext): Promise<void> {
      const number = ctx.number as number;
      const body = ctx.body as PrMergeExecuteBody;
      const refuse = refuser(ctx);
      let key: string | null = null;
      try {
        const { owner, repo, slug } = await slugOf(ctx);
        if (merging.has(lockKey(slug, number))) return refuse({ error: 'merge-in-flight' });
        key = lockKey(slug, number);
        merging.add(key);

        const before = await readMerge(ctx, owner, repo, number);
        if (before.facts.headRefOid !== body.expectHead) return refuse({ error: 'stale', headRefOid: before.facts.headRefOid });
        if (!before.facts.squashAllowed) return refuse({ error: 'squash-disabled' });
        if (before.facts.block) return refuse({ error: 'blocked', reason: before.facts.block });

        ctx.markInFlight();
        // Throws a Refusal only when nothing was sent.
        const out = await call(ctx, [
          'pr', 'merge', String(number), '--repo', `${GITHUB_HOST}/${slug}`, '--squash',
          // `=` forms: a subject starting with "-" stays a value.
          `--match-head-commit=${body.expectHead}`, `--subject=${body.subject}`, '--body-file', '-',
        ], { timeoutMs: WRITE_TIMEOUT_MS, input: body.body, write: true });

        // gh does not print the squash commit, and a failed call may still have
        // landed: only a read of the PR settles it.
        for (const delay of out.ok ? MERGED_READ_DELAYS_MS : [0]) {
          if (delay) await sleep(delay);
          const after = await readMerge(ctx, owner, repo, number, true).catch(() => null);
          if (after?.facts.state === 'MERGED' && after.facts.headRefOid === body.expectHead && after.mergeCommitOid) {
            return ctx.settle({ state: 'done', fields: { mergeCommitOid: after.mergeCommitOid } });
          }
        }
        throw new Error(out.ok ? 'the merge is not readable as merged yet' : 'gh pr merge failed and the pull request does not read as merged');
      } catch (error) {
        if (error instanceof Refusal) return refuse(error.body);
        throw error;
      } finally {
        if (key) merging.delete(key);
      }
    },
  };

  const create: PhoneGitWriteActionHandlers = {
    async execute(ctx: GitWriteExecuteContext): Promise<void> {
      const body = ctx.body as PrCreateExecuteBody;
      const refuse = refuser(ctx);
      try {
        const branch = ctx.repo.branch;
        if (!branch) return refuse({ error: 'detached-head' });
        const { owner, repo, slug } = await slugOf(ctx);
        const head = await git(gitArgv('rev-parse', '--verify', '-q', 'HEAD^{commit}'), ctx.cwd);
        if (!head.ok) return refuse({ error: 'git-operation-failed' });
        const localHead = head.stdout.trim();
        // The PR's head is the upstream's branch, which may be named differently.
        const upstream = await git(gitArgv('for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${branch}`), ctx.cwd);
        if (!upstream.ok) return refuse({ error: 'git-operation-failed' });
        const [remoteName = '', remoteRef = ''] = upstream.stdout.replace(/\n$/, '').split('\0');
        let headName = branch;
        if (remoteName) {
          if (remoteName !== 'origin' || !remoteRef.startsWith('refs/heads/')) return refuse({ error: 'remote-unsupported' });
          headName = remoteRef.slice('refs/heads/'.length);
        }

        const read = await graphql(ctx, CREATE_QUERY, [
          '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-f', `headQ=refs/heads/${headName}`,
          '-f', `baseQ=refs/heads/${body.base ?? headName}`, '-F', `hasBase=${body.base !== undefined}`,
        ]);
        if (!read.ok) return refuse({ error: 'gh-unavailable' });
        const repository = obj(obj(obj(JSON.parse(read.stdout))?.data)?.repository);
        if (!repository) return refuse({ error: 'remote-forbidden', login: ctx.login });
        if (str(obj(obj(repository.headRef)?.target)?.oid) !== localHead) return refuse({ error: 'not-pushed' });
        const baseRef = obj(body.base !== undefined ? repository.baseRef : repository.defaultBranchRef);
        const baseName = str(baseRef?.name);
        if (!baseName || baseName === headName) return refuse({ error: 'invalid-base' });
        if (obj(baseRef?.compare)?.aheadBy === 0) return refuse({ error: 'no-commits-ahead' });
        const existing = await openPrsFor(ctx, owner, repo, slug, headName);
        if (existing.length > 0) return refuse({ error: 'pr-exists', number: existing[0].number });

        const draft = body.draft === true;
        const urlFor = (n: number) => `https://${GITHUB_HOST}/${slug}/pull/${n}`;
        const sentAt = now();
        ctx.markInFlight();
        // Throws a Refusal only when nothing was sent.
        const out = await call(ctx, ['api', '--hostname', GITHUB_HOST, '-X', 'POST', `repos/${owner}/${repo}/pulls`, '--input', '-'], {
          timeoutMs: WRITE_TIMEOUT_MS, write: true,
          input: JSON.stringify({ title: body.title, body: body.body, head: headName, base: baseName, draft }),
        });
        if (out.ok) {
          const made = obj((() => { try { return JSON.parse(out.stdout) as unknown; } catch { return null; } })());
          const number = made?.number;
          if (typeof number === 'number' && Number.isSafeInteger(number) && number > 0) {
            const url = str(made?.html_url);
            return ctx.settle({ state: 'done', fields: { number, url: url.toLowerCase() === urlFor(number).toLowerCase() ? url : urlFor(number) } });
          }
        }
        // No readable answer: done only for an open PR on this head that matches
        // this request and was opened after it was sent.
        const prs = await openPrsFor(ctx, owner, repo, slug, headName, true).catch(() => []);
        const mine = prs.find((p) => p.title === body.title && p.base === baseName && p.draft === draft && p.createdAt >= sentAt - CREATED_SKEW_MS);
        if (mine) return ctx.settle({ state: 'done', fields: { number: mine.number, url: urlFor(mine.number) } });
        throw new Error('the pull request request ended without a readable outcome');
      } catch (error) {
        if (error instanceof Refusal) return refuse(error.body);
        throw error;
      }
    },
  };

  return { create, merge };
}

// The registry keeps one handler set per action; a second evaluation of this
// module (a bundle that inlines it twice) leaves the first set in place.
if (!phoneGitWriteHandlers('pr.create') && !phoneGitWriteHandlers('pr.merge')) {
  const served = createPhoneGitPrHandlers();
  registerPhoneGitWriteAction('pr.create', served.create);
  registerPhoneGitWriteAction('pr.merge', served.merge);
}
