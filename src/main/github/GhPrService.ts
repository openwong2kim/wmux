// GhPrService — GitHub (gh CLI) implementation of PrProvider.
//
// Separate from PrStatusCache (intentional): that singleton is "branch→one PR, 5min TTL,
// metadata 5s poll piggyback" only — its contract must not be shaken. This handles
// repo-scoped PR "list" (30s TTL) + PR comment detail (updatedAt-keyed cache —
// skip re-fetch when list updatedAt unchanged).
//
// gh conventions match existing stack: non-interactive env (GH_PROMPT_DISABLED/GH_PAGER/
// NO_COLOR — same as TaskPrService.GH_ENV), version≠auth two-step gate
// (TaskPrService G3), ENOENT → silently unavailable for process lifetime
// (PrStatusCache.ghAvailable pattern), never-throw.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PR_COMMENT_BODY_CAP,
  cliPath,
  type PrProvider,
  type PrGate,
  type PrListResult,
  type PrDetailResult,
  type PrSummary,
  type PrComment,
} from './PrProvider';
import {
  hostCommandTarget,
  paneCommandIdentity,
  preparePaneCommand,
  type PaneCommandTarget,
} from '../git/paneCommand';

const execFileAsync = promisify(execFile);

const LIST_TTL_MS = 30_000;
const GH_TIMEOUT_MS = 10_000;
// Open PR list cap — 30 silently dropped the rest on active repos (Codex P2).
// 100 is practically "all open PRs"; exactly 100 shows as 100+ in UI.
const LIST_LIMIT = 100;
/** Cache cap — by repo count (list) and PR count (detail). Well above realistic scale. */
const MAX_ENTRIES = 128;
// gh JSON stdout buffer cap — large review threads exceeded execFile default 1MB
// before capBody (Codex P2). Individual bodies are re-capped below.
const GH_MAX_BUFFER = 16 * 1024 * 1024;

// Cache key — filesystem case policy (Codex P3). On POSIX (case-sensitive)
// /src/Foo and /src/foo are different repos — lowercasing would mix caches.
function cacheKey(repoPath: string, target?: PaneCommandTarget): string {
  if (target) return paneCommandIdentity(target);
  const normalized = process.platform === 'win32' || process.platform === 'darwin'
    ? repoPath.toLowerCase()
    : repoPath;
  return `host\0${normalized}`;
}

const GH_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: cliPath(),
  GH_PROMPT_DISABLED: '1',
  GH_PAGER: 'cat',
  NO_COLOR: '1',
};

type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean; maxBuffer: number },
) => Promise<{ stdout: string }>;

// ── gh JSON payload mapping (pure, exported for tests) ────────────────────────────

interface GhListItem {
  number?: number;
  title?: string;
  state?: string;
  isDraft?: boolean;
  author?: { login?: string };
  headRefName?: string;
  updatedAt?: string;
  url?: string;
  reviewDecision?: string;
  mergeable?: string;
  statusCheckRollup?: Array<{ status?: string; conclusion?: string; state?: string }> | null;
}

// CI rollup 3-state — same rules as PrStatusCache.mapGhPrView (that function has
// PrStatus-only signature so rules are duplicated, not reused; value contract identical).
function mapChecks(rollup: GhListItem['statusCheckRollup']): PrSummary['checks'] {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let failing = false;
  let pending = false;
  for (const c of rollup) {
    const conclusion = (c.conclusion ?? c.state ?? '').toUpperCase();
    const status = (c.status ?? '').toUpperCase();
    if (
      conclusion === 'FAILURE' ||
      conclusion === 'TIMED_OUT' ||
      conclusion === 'CANCELLED' ||
      conclusion === 'ERROR'
    ) {
      failing = true;
    } else if (conclusion === 'PENDING' || (status && status !== 'COMPLETED')) {
      pending = true;
    }
  }
  return failing ? 'failing' : pending ? 'pending' : 'passing';
}

export function mapGhListItem(json: GhListItem): PrSummary | null {
  if (typeof json.number !== 'number' || typeof json.url !== 'string') return null;
  const rawState = (json.state ?? '').toUpperCase();
  const state: PrSummary['state'] =
    rawState === 'MERGED' ? 'merged' : rawState === 'CLOSED' ? 'closed' : json.isDraft ? 'draft' : 'open';
  return {
    number: json.number,
    title: json.title ?? '',
    state,
    author: json.author?.login ?? '',
    headRefName: json.headRefName ?? '',
    updatedAt: json.updatedAt ?? '',
    url: json.url,
    reviewDecision: json.reviewDecision ?? '',
    checks: mapChecks(json.statusCheckRollup),
    mergeable: (json.mergeable ?? '').toUpperCase(),
  };
}

interface GhDetailJson {
  number?: number;
  comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string; url?: string }>;
  reviews?: Array<{
    author?: { login?: string };
    body?: string;
    state?: string;
    submittedAt?: string;
    url?: string;
  }>;
}

function capBody(raw: string): { body: string; truncated: boolean } {
  // Strip HTML comments — bot reviewers (CodeRabbit, etc.) prefix/suffix markers that
  // dogfood caught rendering raw in markdown. Display normalization.
  const body = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (Buffer.byteLength(body, 'utf8') <= PR_COMMENT_BODY_CAP) return { body, truncated: false };
  // Character-level truncation (approx UTF-8 byte cap) — display-only, precise byte cut not needed.
  return { body: body.slice(0, PR_COMMENT_BODY_CAP), truncated: true };
}

// Inline (file line) review comments — review thread comments missing from
// `gh pr view` comments/reviews (Codex P2). Raw `gh api .../pulls/N/comments`.
interface GhReviewComment {
  user?: { login?: string };
  body?: string;
  created_at?: string;
  html_url?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
}

/** Single time-ordered stream of comments + (body-bearing) reviews + inline review comments. */
export function mapGhDetail(
  json: GhDetailJson,
  prUrl: string,
  reviewComments: GhReviewComment[] = [],
): PrComment[] {
  const out: PrComment[] = [];
  for (const c of json.comments ?? []) {
    if (typeof c.body !== 'string') continue;
    const { body, truncated } = capBody(c.body);
    out.push({
      author: c.author?.login ?? '',
      body,
      createdAt: c.createdAt ?? '',
      url: c.url ?? prUrl,
      kind: 'comment',
      reviewState: '',
      truncated,
    });
  }
  for (const r of json.reviews ?? []) {
    // Include approve/reject reviews with no body — the state itself is information.
    const raw = typeof r.body === 'string' ? r.body : '';
    const { body, truncated } = capBody(raw);
    out.push({
      author: r.author?.login ?? '',
      body,
      createdAt: r.submittedAt ?? '',
      url: r.url ?? prUrl,
      kind: 'review',
      reviewState: (r.state ?? '').toUpperCase(),
      truncated,
    });
  }
  for (const rc of reviewComments) {
    if (typeof rc.body !== 'string') continue;
    // Prefix body with file:line anchor — preserve context for which code was commented on.
    const anchor = rc.path ? `${rc.path}${rc.line ?? rc.original_line ? `:${rc.line ?? rc.original_line}` : ''} — ` : '';
    const { body, truncated } = capBody(`${anchor}${rc.body}`);
    out.push({
      author: rc.user?.login ?? '',
      body,
      createdAt: rc.created_at ?? '',
      url: rc.html_url ?? prUrl,
      kind: 'review',
      reviewState: '',
      truncated,
    });
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

// ── Service body ───────────────────────────────────────────────────────────────

interface ListEntry {
  value: PrListResult;
  fetchedAt: number;
  pending: Promise<PrListResult> | null;
}

export class GhPrService implements PrProvider {
  private listCache = new Map<string, ListEntry>();
  /** Detail cache — key = repo\0number; skip re-fetch when updatedAt unchanged. */
  private detailCache = new Map<string, { updatedAt: string; value: PrDetailResult }>();
  private ghAvailable: boolean | null = null;

  constructor(
    private now: () => number = Date.now,
    private exec: Exec = execFileAsync,
  ) {}

  private gh(args: string[], repoPath: string, target?: PaneCommandTarget): Promise<{ stdout: string }> {
    const command = preparePaneCommand(
      target ?? hostCommandTarget(repoPath),
      process.platform === 'win32' ? 'gh.exe' : 'gh',
      args,
    );
    if (!command.ok) return Promise.reject(new Error(command.error));
    return this.exec(command.file, command.args, {
      ...(command.cwd ? { cwd: command.cwd } : {}),
      timeout: GH_TIMEOUT_MS,
      env: GH_ENV,
      windowsHide: true,
      maxBuffer: GH_MAX_BUFFER,
    });
  }

  // host arg unused — gh gate is github.com auth (see PrProvider contract).
  async gate(repoPath: string, _host?: string, target?: PaneCommandTarget): Promise<PrGate> {
    if (this.ghAvailable === false) {
      return { ok: false, reason: 'cli-missing', message: 'GitHub CLI (gh) is not installed' };
    }
    try {
      await this.gh(['--version'], repoPath, target);
      this.ghAvailable = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') this.ghAvailable = false;
      return { ok: false, reason: 'cli-missing', message: 'GitHub CLI (gh) is not installed' };
    }
    try {
      await this.gh(['auth', 'status'], repoPath, target);
    } catch {
      return {
        ok: false,
        reason: 'unauthenticated',
        message: 'GitHub CLI is not authenticated — run `gh auth login`',
      };
    }
    return { ok: true };
  }

  // force=true: manual refresh — skip TTL cache and call gh immediately (Codex P2).
  //   Fixes refresh button missing just-landed PRs/checks.
  async listPrs(repoPath: string, force = false, target?: PaneCommandTarget): Promise<PrListResult> {
    const prepared = target
      ? preparePaneCommand(target, process.platform === 'win32' ? 'gh.exe' : 'gh', ['pr', 'list'])
      : null;
    if (prepared && !prepared.ok) {
      return { ok: false, error: prepared.error };
    }
    const key = cacheKey(repoPath, target);
    const entry = this.listCache.get(key);
    const now = this.now();
    if (entry) {
      if (entry.pending) return entry.pending; // in-flight fetch always shared (dedup).
      if (!force && now - entry.fetchedAt < LIST_TTL_MS) return entry.value;
    }
    const pending = this.fetchList(repoPath, target)
      .then((value) => {
        this.listCache.set(key, { value, fetchedAt: this.now(), pending: null });
        return value;
      })
      .catch((err) => {
        const value: PrListResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
        this.listCache.set(key, { value, fetchedAt: this.now(), pending: null });
        return value;
      });
    this.listCache.set(key, {
      value: entry?.value ?? { ok: true, prs: [] },
      fetchedAt: entry?.fetchedAt ?? 0,
      pending,
    });
    this.evict(this.listCache);
    return pending;
  }

  private async fetchList(repoPath: string, target?: PaneCommandTarget): Promise<PrListResult> {
    try {
      const { stdout } = await this.gh(
        [
          'pr',
          'list',
          '--limit',
          String(LIST_LIMIT),
          '--json',
          'number,title,state,isDraft,author,headRefName,updatedAt,url,reviewDecision,mergeable,statusCheckRollup',
        ],
        repoPath,
        target,
      );
      const arr = JSON.parse(stdout) as GhListItem[];
      const prs = (Array.isArray(arr) ? arr : [])
        .map(mapGhListItem)
        .filter((p): p is PrSummary => p !== null);
      return { ok: true, prs };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      return { ok: false, error: (e.stderr || e.message || String(err)).slice(0, 300) };
    }
  }

  async prDetail(
    repoPath: string,
    number: number,
    updatedAt: string,
    target?: PaneCommandTarget,
  ): Promise<PrDetailResult> {
    const prepared = target
      ? preparePaneCommand(target, process.platform === 'win32' ? 'gh.exe' : 'gh', ['pr', 'view'])
      : null;
    if (prepared && !prepared.ok) {
      return { ok: false, error: prepared.error };
    }
    const key = `${cacheKey(repoPath, target)}\0${number}`;
    const cached = this.detailCache.get(key);
    // unchanged updatedAt → skip comment re-fetch (key to rate-limit ceiling).
    if (cached && cached.updatedAt === updatedAt && cached.value.ok) return cached.value;
    try {
      const { stdout } = await this.gh(
        ['pr', 'view', String(number), '--json', 'number,url,comments,reviews'],
        repoPath,
        target,
      );
      const json = JSON.parse(stdout) as GhDetailJson & { url?: string };
      // Inline review comments missing from gh pr view → separate gh api fetch (Codex P2).
      // {owner}/{repo} substituted by gh from cwd repo. Ignore failure (conversation comments above).
      let reviewComments: GhReviewComment[] = [];
      try {
        const rc = await this.gh(
          ['api', '--paginate', `repos/{owner}/{repo}/pulls/${number}/comments?per_page=100`],
          repoPath,
          target,
        );
        const parsed = JSON.parse(rc.stdout) as GhReviewComment[];
        if (Array.isArray(parsed)) reviewComments = parsed;
      } catch {
        /* inline comment fetch failed — degrade to conversation comments only */
      }
      const value: PrDetailResult = {
        ok: true,
        detail: { number, comments: mapGhDetail(json, json.url ?? '', reviewComments) },
      };
      this.detailCache.set(key, { updatedAt, value });
      this.evict(this.detailCache);
      return value;
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      return { ok: false, error: (e.stderr || e.message || String(err)).slice(0, 300) };
    }
  }

  private evict(cache: Map<string, unknown>): void {
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
}

/** Process-global singleton — all callers share the 30s TTL window. */
export const ghPrService = new GhPrService();
