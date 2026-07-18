// GhPrService — PrProvider의 GitHub(gh CLI) 구현.
//
// PrStatusCache와 별개 서비스다(의도): 그쪽은 "브랜치→PR 1건, 5분 TTL,
// metadata 5s 폴 기생" 전용 전역 싱글턴이라 계약을 흔들 수 없다. 여기는
// repo 단위 PR "목록"(30s TTL) + PR 코멘트 상세(updatedAt 키 캐시 —
// 목록의 updatedAt이 안 변했으면 재fetch 생략)를 담당한다.
//
// gh 관례는 기존 스택 그대로: 비대화형 env(GH_PROMPT_DISABLED/GH_PAGER/
// NO_COLOR — TaskPrService.GH_ENV와 동일), 버전≠인증 2단 게이트
// (TaskPrService G3), ENOENT → 프로세스 수명 동안 조용히 미가용
// (PrStatusCache.ghAvailable 패턴), never-throw.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PR_COMMENT_BODY_CAP,
  type PrProvider,
  type PrGate,
  type PrListResult,
  type PrDetailResult,
  type PrSummary,
  type PrComment,
} from './PrProvider';

const execFileAsync = promisify(execFile);

const LIST_TTL_MS = 30_000;
const GH_TIMEOUT_MS = 10_000;
// 열린 PR 목록 상한 — 30은 활발한 repo에서 나머지를 조용히 누락시켰다(Codex P2).
// 100은 현실적으로 "열린 PR 전부"에 해당하며, 정확히 100이면 UI가 100+로 표기.
const LIST_LIMIT = 100;
/** 캐시 상한 — repo 수 기준(목록)·PR 수 기준(상세). 현실 규모 훨씬 위. */
const MAX_ENTRIES = 128;
// gh JSON stdout 버퍼 상한 — 큰 리뷰 스레드가 execFile 기본 1MB를 넘겨
// capBody 전에 터지던 것 방지(Codex P2). 개별 본문은 아래 캡으로 다시 조인다.
const GH_MAX_BUFFER = 16 * 1024 * 1024;

// 캐시 키 — 파일시스템 대소문자 정책 반영(Codex P3). POSIX(case-sensitive)는
// /src/Foo와 /src/foo가 서로 다른 repo다 — 소문자화하면 캐시가 섞인다.
function cacheKey(repoPath: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? repoPath.toLowerCase()
    : repoPath;
}

const GH_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GH_PROMPT_DISABLED: '1',
  GH_PAGER: 'cat',
  NO_COLOR: '1',
};

type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean; maxBuffer: number },
) => Promise<{ stdout: string }>;

// ── gh JSON 페이로드 매핑(순수, 테스트용 export) ────────────────────────────

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

// CI 롤업 3상 — PrStatusCache.mapGhPrView의 규칙을 그대로 복제(그 함수는
// PrStatus 전용 시그니처라 재사용 대신 규칙 복제; 값 계약은 동일).
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
  // HTML 주석 스트립 — 봇 리뷰어(CodeRabbit 등)가 본문 앞뒤에 다는 마커가
  // 렌더러(마크다운)에 raw로 노출되는 걸 dogfood가 잡았다. 표시용 정규화.
  const body = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (Buffer.byteLength(body, 'utf8') <= PR_COMMENT_BODY_CAP) return { body, truncated: false };
  // 문자 단위 절단(UTF-8 바이트 캡 근사) — 표시용이라 정밀 바이트 절단 불요.
  return { body: body.slice(0, PR_COMMENT_BODY_CAP), truncated: true };
}

// 인라인(파일 라인) 리뷰 코멘트 — `gh pr view`의 comments/reviews가 누락하는
// 리뷰 스레드 코멘트(Codex P2). `gh api .../pulls/N/comments` 원형.
interface GhReviewComment {
  user?: { login?: string };
  body?: string;
  created_at?: string;
  html_url?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
}

/** comments + (본문 있는) reviews + 인라인 리뷰 코멘트를 시간순 단일 스트림으로. */
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
    // 본문 없는 순수 승인/거부 리뷰도 상태 자체가 정보라 포함한다.
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
    // 파일:라인 앵커를 본문 앞에 각인 — 어느 코드에 달린 코멘트인지 문맥 보존.
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

// ── 서비스 본체 ───────────────────────────────────────────────────────────────

interface ListEntry {
  value: PrListResult;
  fetchedAt: number;
  pending: Promise<PrListResult> | null;
}

export class GhPrService implements PrProvider {
  private listCache = new Map<string, ListEntry>();
  /** 상세 캐시 — key = repo\0number, updatedAt이 같으면 재fetch 생략. */
  private detailCache = new Map<string, { updatedAt: string; value: PrDetailResult }>();
  private ghAvailable: boolean | null = null;

  constructor(
    private now: () => number = Date.now,
    private exec: Exec = execFileAsync,
  ) {}

  private gh(args: string[], cwd: string): Promise<{ stdout: string }> {
    return this.exec(process.platform === 'win32' ? 'gh.exe' : 'gh', args, {
      cwd,
      timeout: GH_TIMEOUT_MS,
      env: GH_ENV,
      windowsHide: true,
      maxBuffer: GH_MAX_BUFFER,
    });
  }

  // host 인자는 미사용 — gh는 github.com 인증이 곧 게이트(PrProvider 계약 참조).
  async gate(repoPath: string, _host?: string): Promise<PrGate> {
    if (this.ghAvailable === false) {
      return { ok: false, reason: 'cli-missing', message: 'GitHub CLI (gh) is not installed' };
    }
    try {
      await this.gh(['--version'], repoPath);
      this.ghAvailable = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') this.ghAvailable = false;
      return { ok: false, reason: 'cli-missing', message: 'GitHub CLI (gh) is not installed' };
    }
    try {
      await this.gh(['auth', 'status'], repoPath);
    } catch {
      return {
        ok: false,
        reason: 'unauthenticated',
        message: 'GitHub CLI is not authenticated — run `gh auth login`',
      };
    }
    return { ok: true };
  }

  // force=true: 수동 새로고침 — TTL 캐시를 건너뛰고 즉시 gh를 호출한다(Codex P2).
  //   방금 랜딩한 PR/체크를 새로고침 버튼이 관측 못 하던 문제.
  async listPrs(repoPath: string, force = false): Promise<PrListResult> {
    const key = cacheKey(repoPath);
    const entry = this.listCache.get(key);
    const now = this.now();
    if (entry) {
      if (entry.pending) return entry.pending; // 진행 중 fetch는 항상 공유(중복 방지).
      if (!force && now - entry.fetchedAt < LIST_TTL_MS) return entry.value;
    }
    const pending = this.fetchList(repoPath)
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

  private async fetchList(repoPath: string): Promise<PrListResult> {
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

  async prDetail(repoPath: string, number: number, updatedAt: string): Promise<PrDetailResult> {
    const key = `${cacheKey(repoPath)}\0${number}`;
    const cached = this.detailCache.get(key);
    // updatedAt 불변 → 코멘트 재fetch 생략(rate limit 상한의 핵심).
    if (cached && cached.updatedAt === updatedAt && cached.value.ok) return cached.value;
    try {
      const { stdout } = await this.gh(
        ['pr', 'view', String(number), '--json', 'number,url,comments,reviews'],
        repoPath,
      );
      const json = JSON.parse(stdout) as GhDetailJson & { url?: string };
      // 인라인 리뷰 코멘트는 gh pr view가 누락 → gh api로 별도 조회(Codex P2).
      // {owner}/{repo}는 gh가 cwd repo로 치환. 실패는 무시(핵심 코멘트는 위에서 확보).
      let reviewComments: GhReviewComment[] = [];
      try {
        const rc = await this.gh(
          ['api', '--paginate', `repos/{owner}/{repo}/pulls/${number}/comments?per_page=100`],
          repoPath,
        );
        const parsed = JSON.parse(rc.stdout) as GhReviewComment[];
        if (Array.isArray(parsed)) reviewComments = parsed;
      } catch {
        /* 인라인 코멘트 조회 실패 — 대화 코멘트만으로 강등 */
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

/** 프로세스 전역 싱글턴 — 30s TTL 창을 모든 호출자가 공유. */
export const ghPrService = new GhPrService();
