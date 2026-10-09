import { execFile } from 'node:child_process';
import { createGitRunner, gitArgv, type GitRunner } from './sessionDiff';
import { githubRepository } from './sessionPullRequests';
import { registerPhoneGitWriteAction, type GitWriteExecuteContext, type GitWritePreviewResult, type GitWriteSessionContext, type PhoneGitWriteActionHandlers } from './phoneGitWriteRegistry';
import { GhRateBreaker, isRateLimitError } from '../../main/github/ghRateBreaker';
import { projectCheck, summarizeChecks, type PhoneCheckState } from '../../shared/phoneGitV1';
import { mergeBlock, squashSubject, type PrCheck, type PrCheckBucket, type PrReviewHead } from '../../shared/prReview';
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
 * (repository, number). A merge whose outcome cannot be read back is left
 * `uncertain` and is never run again from here.
 */

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 60_000;
const GH_MAX_BUFFER = 4 * 1024 * 1024;
const GITHUB_HOST = 'github.com';

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

/** A refusal raised inside a handler; becomes the preview's answer or the receipt's `refused`. */
class Refusal extends Error {
  constructor(readonly body: GitWriteErrorBody) { super(body.error); }
}

/** What a failed gh call says about GitHub's answer. */
type GhFailure = 'rate-limited' | 'auth' | 'forbidden' | 'pr-not-found' | 'head-moved' | 'refused' | 'unknown';

function classify(stderr: string): GhFailure {
  if (isRateLimitError({ stderr })) return 'rate-limited';
  if (/\bHTTP 401\b|Bad credentials/i.test(stderr)) return 'auth';
  if (/Could not resolve to a PullRequest/i.test(stderr)) return 'pr-not-found';
  if (/Could not resolve to a Repository|\bHTTP 40[34]\b|Resource not accessible/i.test(stderr)) return 'forbidden';
  if (/Head branch was modified|head commit|\bHTTP 409\b/i.test(stderr)) return 'head-moved';
  if (/\bHTTP 4\d\d\b|GraphQL:|not mergeable|could not be merged|No commits between|already exists/i.test(stderr)) return 'refused';
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
 * The merge sheet's facts in one read. `isRequired` exists only in GraphQL;
 * when a read with it fails, the read is repeated without it and the required
 * lists are omitted.
 */
const mergeQuery = (withRequired: boolean) => `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    squashMergeAllowed
    pullRequest(number: $number) {
      number title state isDraft mergeable mergeStateStatus
      headRefOid headRefName baseRefName mergeCommit { oid }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                totalCount
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

/** pr.create's checks in one read: the pushed head, the base, open PRs for the head. */
const CREATE_QUERY = `query($owner: String!, $repo: String!, $head: String!, $headQ: String!, $baseQ: String!, $hasBase: Boolean!) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name compare(headRef: $headQ) { aheadBy } }
    baseRef: ref(qualifiedName: $baseQ) @include(if: $hasBase) { name compare(headRef: $headQ) { aheadBy } }
    headRef: ref(qualifiedName: $headQ) { target { oid } }
    pullRequests(headRefName: $head, states: OPEN, first: 50) { nodes { number headRepository { nameWithOwner } } }
  }
}`;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A merge read: the facts plus what execute needs and the sheet does not show. */
export interface PrMergeRead { facts: PrMergeFacts; mergeCommitOid: string | null }

/** PrMergeFacts from a `mergeQuery` answer. Throws a Refusal when there is no such PR. */
export function mapMergeFacts(raw: unknown, number: number, login: string): PrMergeRead {
  const repository = obj(obj(obj(raw)?.data)?.repository);
  if (!repository) throw new Refusal({ error: 'remote-forbidden', login });
  const pr = obj(repository.pullRequest);
  if (!pr || pr.number !== number) throw new Refusal({ error: 'pr-not-found' });
  const headRefOid = str(pr.headRefOid);
  if (!GIT_WRITE_OID.test(headRefOid)) throw new Error('the pull request head is not a commit id');
  const commit = obj(obj((obj(pr.commits)?.nodes as unknown[] | undefined)?.[0])?.commit);
  const contexts = obj(obj(commit?.statusCheckRollup)?.contexts);
  const nodes = Array.isArray(contexts?.nodes) ? contexts.nodes as unknown[] : [];
  // An unreadable count is not proof that every check was read.
  const truncated = contexts !== null && !(typeof contexts.totalCount === 'number' && contexts.totalCount <= nodes.length);
  const summary = summarizeChecks(nodes);
  const rows = nodes.flatMap((n) => {
    const check = projectCheck(n);
    return check ? [{ name: check.name, bucket: bucketOf(check.state), isRequired: obj(n)?.isRequired }] : [];
  });
  const checks: PrMergeChecks = { overall: summary.overall, counts: { ...summary.counts } };
  // Required lists only when GitHub said, for every check read, whether it is required.
  if (!truncated && rows.length === nodes.length && rows.every((r) => typeof r.isRequired === 'boolean')) {
    checks.requiredFailing = rows.filter((r) => r.isRequired && (r.bucket === 'fail' || r.bucket === 'cancel')).map((r) => r.name);
    checks.requiredPending = rows.filter((r) => r.isRequired && r.bucket === 'pending').map((r) => r.name);
  }
  const head: PrReviewHead = {
    number, title: str(pr.title), url: '', state: str(pr.state), isDraft: pr.isDraft === true, headRefOid,
    headRefName: str(pr.headRefName), baseRefName: str(pr.baseRefName),
    mergeable: str(pr.mergeable) || 'UNKNOWN', mergeStateStatus: str(pr.mergeStateStatus) || 'UNKNOWN',
  };
  const forBlock: PrCheck[] = rows.map((r) => ({ name: r.name, workflow: '', bucket: r.bucket, link: '' }));
  const mergeCommitOid = str(obj(pr.mergeCommit)?.oid);
  return {
    facts: {
      number, title: head.title, state: head.state, isDraft: head.isDraft,
      headRefOid, headRefName: head.headRefName, baseRefName: head.baseRefName,
      mergeable: head.mergeable, mergeStateStatus: head.mergeStateStatus,
      block: mergeBlock(head, forBlock),
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

export interface PhoneGitPrDeps {
  gh?: PrGhRunner;
  git?: GitRunner;
  now?: () => number;
}

/** The pr.create and pr.merge handlers over injected gh and git runners. */
export function createPhoneGitPrHandlers(deps: PhoneGitPrDeps = {}): { create: PhoneGitWriteActionHandlers; merge: PhoneGitWriteActionHandlers } {
  const gh = deps.gh ?? runGh;
  const git = deps.git ?? createGitRunner();
  const now = deps.now ?? Date.now;
  const breaker = new GhRateBreaker(now);
  /** `owner/repo#number`, lowercased: two checkouts of one repository share it. */
  const merging = new Set<string>();

  /** One gh call as the write identity. Throws a Refusal for answers no caller reads further. */
  async function call(ctx: GitWriteSessionContext, args: string[], timeoutMs: number, input?: string): Promise<PrGhResult & { failure?: GhFailure }> {
    const until = breaker.retryAt(GITHUB_HOST);
    if (until !== null) throw new Refusal({ error: 'rate-limited', retryAt: until });
    const out = await gh(args, { env: ctx.ghEnv, timeoutMs, ...(input !== undefined ? { input } : {}) });
    if (out.ok) {
      breaker.reset(GITHUB_HOST);
      return out;
    }
    if (!out.spawned) throw new Refusal({ error: 'gh-unavailable' });
    const failure = classify(out.stderr);
    if (failure === 'rate-limited') {
      breaker.trip(GITHUB_HOST);
      throw new Refusal({ error: 'rate-limited', retryAt: breaker.retryAt(GITHUB_HOST) ?? now() });
    }
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

  async function graphql(ctx: GitWriteSessionContext, query: string, vars: string[]): Promise<PrGhResult & { failure?: GhFailure }> {
    return call(ctx, ['api', 'graphql', '--hostname', GITHUB_HOST, '-f', `query=${query}`, ...vars], READ_TIMEOUT_MS);
  }

  /** The merge read; a read GitHub refuses with `isRequired` is repeated without it. */
  async function readMerge(ctx: GitWriteSessionContext, owner: string, repo: string, number: number): Promise<PrMergeRead> {
    const vars = ['-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `number=${number}`];
    for (const withRequired of [true, false]) {
      const out = await graphql(ctx, mergeQuery(withRequired), vars);
      if (out.ok) return mapMergeFacts(JSON.parse(out.stdout), number, ctx.login);
      if (out.failure === 'pr-not-found') throw new Refusal({ error: 'pr-not-found' });
    }
    throw new Refusal({ error: 'gh-unavailable' });
  }

  const lockKey = (slug: string, number: number) => `${slug.toLowerCase()}#${number}`;

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
      const refuse = (b: GitWriteErrorBody) => {
        const { error, ...fields } = b;
        ctx.settle({ state: 'refused', error, ...(Object.keys(fields).length ? { fields } : {}) });
      };
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
        let out: Awaited<ReturnType<typeof call>>;
        try {
          out = await call(ctx, [
            'pr', 'merge', String(number), '--repo', `${GITHUB_HOST}/${slug}`, '--squash',
            // `=` forms: a subject starting with "-" stays a value.
            `--match-head-commit=${body.expectHead}`, `--subject=${body.subject}`, '--body-file', '-',
          ], WRITE_TIMEOUT_MS, body.body);
        } catch (error) {
          // gh never started, the limit or the identity refused it: GitHub took nothing.
          if (error instanceof Refusal) return refuse(error.body);
          throw error;
        }

        // gh does not print the squash commit, and a failed call may still have
        // landed: read the PR back either way.
        let after: PrMergeRead;
        try {
          after = await readMerge(ctx, owner, repo, number);
        } catch {
          throw new Error('the merge outcome could not be read back');
        }
        const landed = after.facts.state === 'MERGED' && after.facts.headRefOid === body.expectHead;
        if (landed && after.mergeCommitOid) return ctx.settle({ state: 'done', fields: { mergeCommitOid: after.mergeCommitOid } });
        if (out.ok || landed) throw new Error('the merge is not readable as merged yet');
        if (after.facts.headRefOid !== body.expectHead) return refuse({ error: 'stale', headRefOid: after.facts.headRefOid });
        if (after.facts.state !== 'OPEN') return refuse({ error: 'blocked', reason: 'not-open' });
        // Still open at the same head. Only a refusal GitHub stated settles it;
        // a timeout or a dropped connection may still land.
        if (out.failure === 'unknown') throw new Error('gh pr merge ended without an answer');
        return refuse({ error: 'blocked', reason: after.facts.block ?? 'unknown' });
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
      const refuse = (b: GitWriteErrorBody) => {
        const { error, ...fields } = b;
        ctx.settle({ state: 'refused', error, ...(Object.keys(fields).length ? { fields } : {}) });
      };
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

        const openPr = (raw: unknown): number | null => {
          const nodes = obj(obj(obj(obj(raw)?.data)?.repository)?.pullRequests)?.nodes;
          for (const n of Array.isArray(nodes) ? nodes : []) {
            const pr = obj(n);
            // A fork's branch of the same name is not this head.
            if (pr && Number.isSafeInteger(pr.number) && str(obj(pr.headRepository)?.nameWithOwner).toLowerCase() === slug.toLowerCase()) {
              return pr.number as number;
            }
          }
          return null;
        };
        const read = async (): Promise<Json> => {
          const out = await graphql(ctx, CREATE_QUERY, [
            '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-f', `head=${headName}`, '-f', `headQ=refs/heads/${headName}`,
            '-f', `baseQ=refs/heads/${body.base ?? headName}`, '-F', `hasBase=${body.base !== undefined}`,
          ]);
          if (!out.ok) throw new Refusal({ error: 'gh-unavailable' });
          return JSON.parse(out.stdout) as Json;
        };

        const facts = await read();
        const repository = obj(obj(facts.data)?.repository);
        if (!repository) return refuse({ error: 'remote-forbidden', login: ctx.login });
        if (str(obj(obj(repository.headRef)?.target)?.oid) !== localHead) return refuse({ error: 'not-pushed' });
        const existing = openPr(facts);
        if (existing !== null) return refuse({ error: 'pr-exists', number: existing });
        const baseRef = obj(body.base !== undefined ? repository.baseRef : repository.defaultBranchRef);
        const baseName = str(baseRef?.name);
        if (!baseName || baseName === headName) return refuse({ error: 'invalid-base' });
        if (obj(baseRef?.compare)?.aheadBy === 0) return refuse({ error: 'no-commits-ahead' });

        ctx.markInFlight();
        let out: Awaited<ReturnType<typeof call>>;
        try {
          out = await call(ctx, ['api', '--hostname', GITHUB_HOST, '-X', 'POST', `repos/${owner}/${repo}/pulls`, '--input', '-'],
            WRITE_TIMEOUT_MS, JSON.stringify({ title: body.title, body: body.body, head: headName, base: baseName, draft: body.draft === true }));
        } catch (error) {
          if (error instanceof Refusal) return refuse(error.body);
          throw error;
        }
        const urlFor = (n: number) => `https://${GITHUB_HOST}/${slug}/pull/${n}`;
        if (out.ok) {
          const made = obj(JSON.parse(out.stdout));
          const number = made?.number;
          if (typeof number === 'number' && Number.isSafeInteger(number) && number > 0) {
            const url = str(made?.html_url);
            return ctx.settle({ state: 'done', fields: { number, url: url.toLowerCase() === urlFor(number).toLowerCase() ? url : urlFor(number) } });
          }
        }
        // No readable answer: an open PR for this head now is the one this call
        // made (there was none before it).
        let made: number | null;
        try {
          made = openPr(await read());
        } catch {
          throw new Error('the pull request outcome could not be read back');
        }
        if (made !== null) return ctx.settle({ state: 'done', fields: { number: made, url: urlFor(made) } });
        if (out.ok || out.failure === 'unknown') throw new Error('gh api ended without a pull request');
        if (/No commits between/i.test(out.stderr)) return refuse({ error: 'no-commits-ahead' });
        if (/\bbase\b/i.test(out.stderr)) return refuse({ error: 'invalid-base' });
        return refuse({ error: 'gh-unavailable' });
      } catch (error) {
        if (error instanceof Refusal) return refuse(error.body);
        throw error;
      }
    },
  };

  return { create, merge };
}

const served = createPhoneGitPrHandlers();
registerPhoneGitWriteAction('pr.create', served.create);
registerPhoneGitWriteAction('pr.merge', served.merge);
