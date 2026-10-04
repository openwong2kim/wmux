// Reviewing and merging a PR, and its CI, for the Git page's detail pane.
//
// Every call names the repo (`--repo host/owner/repo`, or the host and path
// for `gh api`) and runs with gh's whitelisted env (ghIssueEnv: no GH_REPO,
// no prompts, no pager, no colour). Reads go through the shared per-host
// rate-limit breaker and short TTL caches with one fetch in flight per key;
// checks are read fresh with the PR's head and mergeability, because those
// change with CI, not with the PR's update time.
//
// Writes are tied to the head the person saw: the head is re-read right
// before writing and a different one is refused ("moved"). A review and a line
// comment name that commit to GitHub; a merge also asks GitHub to refuse any
// other head (--match-head-commit). Nothing here reruns CI by itself.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ghIssueEnv, splitRepoKey } from './GhIssueService';
import { capBody } from './GhPrService';
import { GhRateBreaker, ghRateBreaker, isRateLimitError } from './ghRateBreaker';
import { DIFF_FILE_CAP_BYTES, DIFF_TOTAL_CAP_BYTES, parseUnifiedDiff } from '../../shared/diffParse';
import {
  cleanLogTail,
  mergeBlock,
  parseRunLink,
  type MergeBlock,
  type PrCheck,
  type PrCheckBucket,
  type PrChecksState,
  type PrCommentRequest,
  type PrFilesState,
  type PrMergeRequest,
  type PrReviewHead,
  type PrReviewRead,
  type PrReviewThread,
  type PrRunLog,
  type PrSubmitReviewRequest,
  type PrThreadsState,
  type PrWriteResult,
} from '../../shared/prReview';

type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean; maxBuffer: number },
) => Promise<{ stdout: string; stderr?: string }>;

const execFileAsync = promisify(execFile) as unknown as Exec;

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 60_000;
const GH_MAX_BUFFER = 16 * 1024 * 1024;
const CHECKS_TTL_MS = 15_000;
const THREADS_TTL_MS = 30_000;
const LOG_TTL_MS = 60_000;
const MAX_ENTRIES = 64;
/** Threads and comments per thread read (more are marked as left out). */
const MAX_THREADS = 100;
const MAX_THREAD_COMMENTS = 50;

const HEAD_FIELDS = 'number,title,url,state,isDraft,headRefOid,headRefName,baseRefName,mergeable,mergeStateStatus';
const CHECK_FIELDS = 'name,workflow,bucket,link,startedAt,completedAt';
const BUCKETS: readonly PrCheckBucket[] = ['pass', 'fail', 'pending', 'skipping', 'cancel'];

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: ${MAX_THREADS}) {
        totalCount
        nodes {
          id isResolved isOutdated path line diffSide
          comments(first: ${MAX_THREAD_COMMENTS}) {
            totalCount
            nodes { databaseId body createdAt author { login } }
          }
        }
      }
    }
  }
}`;

class RateLimited extends Error {
  constructor(readonly retryAt: number) {
    super('GitHub rate limit');
  }
}

function errorText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr || e?.message || String(err)).trim().slice(0, 300);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A PR's head from `gh pr view --json`. Null when it is not one. */
export function mapReviewHead(raw: unknown): PrReviewHead | null {
  const j = raw as Record<string, unknown> | null;
  if (!j || typeof j.number !== 'number' || typeof j.headRefOid !== 'string') return null;
  return {
    number: j.number,
    title: str(j.title),
    url: str(j.url),
    state: str(j.state),
    isDraft: j.isDraft === true,
    headRefOid: j.headRefOid,
    headRefName: str(j.headRefName),
    baseRefName: str(j.baseRefName),
    mergeable: str(j.mergeable) || 'UNKNOWN',
    mergeStateStatus: str(j.mergeStateStatus) || 'UNKNOWN',
  };
}

/** Checks from `gh pr checks --json`; anything malformed is dropped. */
export function mapChecks(raw: unknown): PrCheck[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c): PrCheck[] => {
    const j = c as Record<string, unknown>;
    const bucket = BUCKETS.find((b) => b === j?.bucket);
    if (!bucket || typeof j.name !== 'string') return [];
    const link = str(j.link);
    const run = link ? parseRunLink(link) : null;
    return [{
      name: j.name,
      workflow: str(j.workflow),
      bucket,
      link,
      ...(str(j.startedAt) ? { startedAt: str(j.startedAt) } : {}),
      ...(str(j.completedAt) ? { completedAt: str(j.completedAt) } : {}),
      ...(run ? { runId: run.runId, ...(run.jobId ? { jobId: run.jobId } : {}) } : {}),
    }];
  });
}

/** Review threads from the GraphQL answer, comments capped; an outdated
 *  thread has no line. */
export function mapThreads(raw: unknown): PrThreadsState {
  const threadsNode = (raw as { data?: { repository?: { pullRequest?: { reviewThreads?: unknown } } } })
    ?.data?.repository?.pullRequest?.reviewThreads as { totalCount?: number; nodes?: unknown[] } | undefined;
  const nodes = Array.isArray(threadsNode?.nodes) ? threadsNode.nodes : [];
  let truncated = (threadsNode?.totalCount ?? 0) > nodes.length;
  const threads = nodes.flatMap((n): PrReviewThread[] => {
    const t = n as Record<string, unknown>;
    if (typeof t?.id !== 'string' || typeof t.path !== 'string') return [];
    const commentsNode = t.comments as { totalCount?: number; nodes?: unknown[] } | undefined;
    const cnodes = Array.isArray(commentsNode?.nodes) ? commentsNode.nodes : [];
    if ((commentsNode?.totalCount ?? 0) > cnodes.length) truncated = true;
    const comments = cnodes.flatMap((c) => {
      const cm = c as Record<string, unknown>;
      if (typeof cm?.databaseId !== 'number') return [];
      return [{
        id: cm.databaseId,
        author: str((cm.author as { login?: unknown } | null)?.login) || 'ghost',
        body: capBody(str(cm.body)).body,
        createdAt: str(cm.createdAt),
      }];
    });
    const outdated = t.isOutdated === true;
    return [{
      id: t.id,
      path: t.path,
      line: !outdated && typeof t.line === 'number' ? t.line : null,
      side: t.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
      isResolved: t.isResolved === true,
      isOutdated: outdated || typeof t.line !== 'number',
      comments,
    }];
  });
  return { threads, truncated };
}

/** A PR diff within the size caps: whole files past the total cap are left
 *  out, a file past its own cap keeps its header only. */
export function capPrDiff(text: string): { files: PrFilesState['files']; truncated: boolean } {
  let truncated = false;
  let body = text;
  if (Buffer.byteLength(body, 'utf8') > DIFF_TOTAL_CAP_BYTES) {
    truncated = true;
    body = body.slice(0, DIFF_TOTAL_CAP_BYTES);
    const lastFile = body.lastIndexOf('\ndiff --git ');
    body = lastFile > 0 ? body.slice(0, lastFile + 1) : '';
  }
  const files = parseUnifiedDiff(body).files.map((f) => {
    const size = f.hunks.reduce((s, h) => s + h.bodyLines.join('\n').length, 0);
    if (size <= DIFF_FILE_CAP_BYTES) return f;
    truncated = true;
    return { ...f, hunks: [] };
  });
  return { files, truncated };
}

/** A gh error that still printed its JSON answer (gh pr checks exits 8 while
 *  checks are pending and 1 when one failed, with the list on stdout). */
function stdoutOf(err: unknown): string {
  const out = (err as { stdout?: unknown })?.stdout;
  return typeof out === 'string' ? out : '';
}

interface Cached<T> {
  value: T | null;
  at: number;
  pending: Promise<T> | null;
}

export class GhPrReviewService {
  private checksCache = new Map<string, Cached<PrChecksState>>();
  private threadsCache = new Map<string, Cached<PrThreadsState>>();
  private filesCache = new Map<string, PrFilesState>();
  private logCache = new Map<string, Cached<PrRunLog>>();
  private breaker: GhRateBreaker;

  constructor(
    private now: () => number = Date.now,
    private exec: Exec = execFileAsync,
    breaker?: GhRateBreaker,
  ) {
    this.breaker = breaker ?? new GhRateBreaker(now);
  }

  private async gh(host: string, args: string[], cwd: string, write = false): Promise<string> {
    const until = this.breaker.retryAt(host);
    if (until !== null) throw new RateLimited(until);
    try {
      const { stdout } = await this.exec(process.platform === 'win32' ? 'gh.exe' : 'gh', args, {
        cwd,
        timeout: write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS,
        env: ghIssueEnv(),
        windowsHide: true,
        maxBuffer: GH_MAX_BUFFER,
      });
      this.breaker.reset(host);
      return stdout;
    } catch (err) {
      if (isRateLimitError(err)) {
        this.breaker.trip(host);
        throw new RateLimited(this.breaker.retryAt(host) ?? this.now());
      }
      throw err;
    }
  }

  /** Read through a TTL cache with one fetch in flight per key. */
  private async cached<T>(cache: Map<string, Cached<T>>, key: string, ttl: number, force: boolean, fetch: () => Promise<T>): Promise<T> {
    const entry = cache.get(key);
    if (entry?.pending) return entry.pending;
    if (!force && entry?.value && this.now() - entry.at < ttl) return entry.value;
    const pending = fetch().finally(() => {
      const cur = cache.get(key);
      if (cur?.pending === pending) cur.pending = null;
    });
    cache.set(key, { value: entry?.value ?? null, at: entry?.at ?? 0, pending });
    const value = await pending;
    cache.set(key, { value, at: this.now(), pending: null });
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    return value;
  }

  private repo(key: string) {
    const parts = splitRepoKey(key);
    if (!parts) throw new Error(`not a GitHub owner/repo remote: ${key}`);
    return parts;
  }

  private async readHead(repoPath: string, key: string, number: number): Promise<PrReviewHead> {
    const { host } = this.repo(key);
    const out = await this.gh(host, ['pr', 'view', String(number), '--repo', key, '--json', HEAD_FIELDS], repoPath);
    const head = mapReviewHead(JSON.parse(out));
    if (!head) throw new Error('could not read the pull request');
    return head;
  }

  private async readChecks(repoPath: string, key: string, number: number): Promise<PrCheck[]> {
    const { host } = this.repo(key);
    let out: string;
    try {
      out = await this.gh(host, ['pr', 'checks', String(number), '--repo', key, '--json', CHECK_FIELDS], repoPath);
    } catch (err) {
      if (err instanceof RateLimited) throw err;
      out = stdoutOf(err);
      // No checks at all: gh says so on stderr with nothing on stdout.
      if (!out.trim()) {
        if (/no checks reported/i.test(errorText(err))) return [];
        throw err;
      }
    }
    return mapChecks(JSON.parse(out));
  }

  private async readState(repoPath: string, key: string, number: number): Promise<PrChecksState> {
    const [head, checks] = await Promise.all([this.readHead(repoPath, key, number), this.readChecks(repoPath, key, number)]);
    return { head, checks };
  }

  private async read<T>(run: () => Promise<T>): Promise<PrReviewRead<T>> {
    try {
      return { ok: true, value: await run() };
    } catch (err) {
      if (err instanceof RateLimited) return { ok: false, code: 'rate-limited', message: 'GitHub rate limit', retryAt: err.retryAt };
      return { ok: false, code: 'error', message: errorText(err) };
    }
  }

  private async write(run: () => Promise<PrWriteResult>): Promise<PrWriteResult> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof RateLimited) return { ok: false, code: 'rate-limited', message: 'GitHub rate limit', retryAt: err.retryAt };
      return { ok: false, code: 'error', message: errorText(err) };
    }
  }

  /** The head as it is now, or a "moved" refusal when it is not `expectHead`. */
  private async moved(repoPath: string, key: string, number: number, expectHead: string): Promise<PrWriteResult | null> {
    const head = await this.readHead(repoPath, key, number);
    return head.headRefOid === expectHead
      ? null
      : { ok: false, code: 'moved', message: 'the pull request has new commits since it was shown; review them first', headRefOid: head.headRefOid };
  }

  /** The PR's head, mergeability and checks, read together. */
  checks(repoPath: string, key: string, number: number, force = false): Promise<PrReviewRead<PrChecksState>> {
    return this.read(() => this.cached(this.checksCache, `${key}#${number}`, CHECKS_TTL_MS, force, () => this.readState(repoPath, key, number)));
  }

  /** The PR's changed files at its head (cached per head). */
  files(repoPath: string, key: string, number: number, headRefOid: string): Promise<PrReviewRead<PrFilesState>> {
    return this.read(async () => {
      const cacheKey = `${key}#${number}@${headRefOid}`;
      const hit = this.filesCache.get(cacheKey);
      if (hit) return hit;
      const { host } = this.repo(key);
      const head = await this.readHead(repoPath, key, number);
      const text = await this.gh(host, ['pr', 'diff', String(number), '--repo', key], repoPath);
      const value: PrFilesState = { headRefOid: head.headRefOid, ...capPrDiff(text) };
      this.filesCache.set(`${key}#${number}@${head.headRefOid}`, value);
      if (this.filesCache.size > MAX_ENTRIES) this.filesCache.delete(this.filesCache.keys().next().value as string);
      return value;
    });
  }

  /** The PR's review threads with their comments. */
  threads(repoPath: string, key: string, number: number, force = false): Promise<PrReviewRead<PrThreadsState>> {
    return this.read(() => this.cached(this.threadsCache, `${key}#${number}`, THREADS_TTL_MS, force, async () => {
      const { host, owner, repo } = this.repo(key);
      const out = await this.gh(host, [
        'api', 'graphql', '--hostname', host,
        '-f', `query=${THREADS_QUERY}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `number=${number}`,
      ], repoPath);
      return mapThreads(JSON.parse(out));
    }));
  }

  /** A comment on one line of the diff at the head the person saw. */
  comment(repoPath: string, key: string, number: number, req: PrCommentRequest): Promise<PrWriteResult> {
    return this.write(async () => {
      const refused = await this.moved(repoPath, key, number, req.expectHead);
      if (refused) return refused;
      const { host, owner, repo } = this.repo(key);
      const out = await this.gh(host, [
        'api', '--hostname', host, '-X', 'POST', `repos/${owner}/${repo}/pulls/${number}/comments`,
        '-f', `body=${req.body}`, '-f', `commit_id=${req.expectHead}`, '-f', `path=${req.path}`,
        '-F', `line=${req.line}`, '-f', `side=${req.side}`,
      ], repoPath, true);
      this.threadsCache.delete(`${key}#${number}`);
      return { ok: true, ...urlOf(out) };
    });
  }

  /** A reply in an existing thread (to its first comment). */
  reply(repoPath: string, key: string, number: number, commentId: number, body: string): Promise<PrWriteResult> {
    return this.write(async () => {
      const { host, owner, repo } = this.repo(key);
      const out = await this.gh(host, [
        'api', '--hostname', host, '-X', 'POST', `repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`,
        '-f', `body=${body}`,
      ], repoPath, true);
      this.threadsCache.delete(`${key}#${number}`);
      return { ok: true, ...urlOf(out) };
    });
  }

  /** Approve, request changes or comment, on the head the person saw. */
  submitReview(repoPath: string, key: string, number: number, req: PrSubmitReviewRequest): Promise<PrWriteResult> {
    return this.write(async () => {
      const refused = await this.moved(repoPath, key, number, req.expectHead);
      if (refused) return refused;
      const { host, owner, repo } = this.repo(key);
      const out = await this.gh(host, [
        'api', '--hostname', host, '-X', 'POST', `repos/${owner}/${repo}/pulls/${number}/reviews`,
        '-f', `event=${req.event}`, '-f', `commit_id=${req.expectHead}`, ...(req.body ? ['-f', `body=${req.body}`] : []),
      ], repoPath, true);
      this.checksCache.delete(`${key}#${number}`);
      this.threadsCache.delete(`${key}#${number}`);
      return { ok: true, ...urlOf(out) };
    });
  }

  /**
   * Squash-merge with the subject and body given (an empty body stays empty:
   * no commit list, no trailers). Refused when the head is not the one shown,
   * or when the PR cannot merge now; GitHub is also told the head to expect.
   */
  merge(repoPath: string, key: string, number: number, req: PrMergeRequest): Promise<PrWriteResult> {
    return this.write(async () => {
      const state = await this.readState(repoPath, key, number);
      if (state.head.headRefOid !== req.expectHead) {
        return { ok: false, code: 'moved', message: 'the pull request has new commits since it was shown; review them first', headRefOid: state.head.headRefOid };
      }
      const block: MergeBlock | null = mergeBlock(state.head, state.checks);
      if (block) return { ok: false, code: 'blocked', reason: block, message: `the pull request cannot be merged now (${block})` };
      const { host } = this.repo(key);
      await this.gh(host, [
        'pr', 'merge', String(number), '--repo', key, '--squash',
        // `=` forms: a subject or body starting with "-" stays a value.
        `--subject=${req.subject}`, `--body=${req.body}`, `--match-head-commit=${req.expectHead}`,
      ], repoPath, true);
      this.checksCache.delete(`${key}#${number}`);
      return { ok: true, url: state.head.url };
    });
  }

  /** The failed jobs' log of a run, as a capped plain-text tail. */
  runLog(repoPath: string, key: string, runId: string): Promise<PrReviewRead<PrRunLog>> {
    return this.read(() => this.cached(this.logCache, `${key}@${runId}`, LOG_TTL_MS, false, async () => {
      const { host } = this.repo(key);
      try {
        const out = await this.gh(host, ['run', 'view', runId, '--repo', key, '--log-failed'], repoPath);
        return { runId, ...cleanLogTail(out) };
      } catch (err) {
        // Bigger than the buffer: say so rather than read more of it.
        if ((err as { code?: unknown })?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(errorText(err))) {
          return { runId, text: '', truncated: true, tooLarge: true };
        }
        throw err;
      }
    }));
  }

  /** Rerun a run's failed jobs (an explicit request; never automatic). */
  rerunFailed(repoPath: string, key: string, runId: string): Promise<PrWriteResult> {
    return this.write(async () => {
      const { host } = this.repo(key);
      await this.gh(host, ['run', 'rerun', runId, '--failed', '--repo', key], repoPath, true);
      this.checksCache.clear();
      this.logCache.delete(`${key}@${runId}`);
      return { ok: true };
    });
  }
}

function urlOf(out: string): { url?: string } {
  try {
    const url = (JSON.parse(out) as { html_url?: unknown }).html_url;
    return typeof url === 'string' && /^https:\/\//.test(url) ? { url } : {};
  } catch {
    return {};
  }
}

export const ghPrReviewService = new GhPrReviewService(Date.now, execFileAsync, ghRateBreaker);
