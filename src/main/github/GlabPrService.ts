// GlabPrService — PrProvider의 GitLab(glab CLI) 구현.
//
// GhPrService와 대칭 구조(비대화형 env·버전≠인증 2단 게이트·ENOENT 영구침묵·
// never-throw·30s 목록 TTL·updatedAt 키 상세캐시). 차이점:
//  - 인증은 호스트 단위: self-hosted GitLab이 흔하므로 게이트가
//    `glab auth status --hostname <host>`를 쓴다 (gate가 host를 받는 이유).
//  - 데이터는 GitLab REST 원형: 목록 = `glab mr list --output json`(REST MR
//    배열), 코멘트 = `glab api projects/:id/merge_requests/<iid>/notes`
//    (`:id`는 glab이 cwd의 repo로 치환). system 노트("added 1 commit" 등)는
//    사람 코멘트가 아니라 노이즈라 걸러낸다.
//  - checks: the REST list carries no pipeline, and `head_pipeline` is on the
//    single-MR GET only (one call per MR). So one GraphQL call reads every
//    listed MR's head pipeline at once; if it fails (an old self-managed
//    schema, a timeout) the list still shows, with no dot (checks null).
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

const execFileAsync = promisify(execFile);

const LIST_TTL_MS = 30_000;
const GLAB_TIMEOUT_MS = 10_000;
const LIST_LIMIT = 30;
const MAX_ENTRIES = 128;
/** How long a missing / found glab binary is believed before probing again. */
const GATE_TTL_MS = 5 * 60 * 1000;
/** How long `glab auth status --hostname` is believed, per host. */
const AUTH_TTL_MS = 60 * 1000;
/** A forced probe (Check again, refresh) answered this recently is reused. */
const FORCED_REUSE_MS = 3_000;

export const GLAB_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: cliPath(),
  // glab 비대화형 강제 — 프롬프트/페이저가 폴을 블록하면 안 된다(gh와 동일 계약).
  NO_PROMPT: '1',
  GLAB_PAGER: 'cat',
  NO_COLOR: '1',
};

// 캐시 키 — 파일시스템 대소문자 정책 반영(gh 경로와 동일). POSIX는 원형 유지.
function cacheKey(repoPath: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? repoPath.toLowerCase()
    : repoPath;
}

type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean },
) => Promise<{ stdout: string }>;

// ── GitLab REST 페이로드 매핑(순수, 테스트용 export) ─────────────────────────

interface GlabMrItem {
  iid?: number;
  title?: string;
  state?: string; // "opened" | "merged" | "closed" | "locked"
  draft?: boolean;
  work_in_progress?: boolean;
  author?: { username?: string };
  source_branch?: string;
  updated_at?: string;
  web_url?: string;
  has_conflicts?: boolean;
  /** `full` is `group/subgroup/project!iid`: the project's full path, which
   *  the GraphQL `project(fullPath:)` lookup needs. */
  references?: { full?: string };
}

/** GitLab's PipelineStatusEnum → the 3-state rollup. MANUAL (blocked on a
 *  manual job) is unfinished, so pending; skipped or unknown → null. */
export function mapGlabPipelineStatus(status: string | null | undefined): PrSummary['checks'] {
  switch ((status ?? '').toUpperCase()) {
    case 'SUCCESS':
      return 'passing';
    case 'FAILED': // cancelled counts as failing, as in GhPrService mapChecks
    case 'CANCELED':
      return 'failing';
    case 'CREATED':
    case 'WAITING_FOR_RESOURCE':
    case 'PREPARING':
    case 'WAITING_FOR_CALLBACK':
    case 'PENDING':
    case 'RUNNING':
    case 'CANCELING':
    case 'SCHEDULED':
    case 'MANUAL':
      return 'pending';
    default:
      return null;
  }
}

/** The project's full path from an MR's `references.full`, or null. */
export function glabProjectPath(item: GlabMrItem): string | null {
  const full = item.references?.full ?? '';
  const bang = full.lastIndexOf('!');
  const path = bang > 0 ? full.slice(0, bang) : '';
  return /^[\w.-]+(?:\/[\w.-]+)+$/.test(path) ? path : null;
}

/** The GraphQL query for the head pipelines of these MRs (iids are numbers). */
export function glabPipelinesQuery(iids: readonly number[]): string {
  const list = iids.map((n) => JSON.stringify(String(n))).join(',');
  return `query($fullPath: ID!) { project(fullPath: $fullPath) { mergeRequests(iids: [${list}]) { nodes { iid headPipeline { status } } } } }`;
}

/** iid → head-pipeline rollup from the GraphQL reply; an MR with no pipeline is absent. */
export function mapGlabPipelines(reply: unknown): Map<number, NonNullable<PrSummary['checks']>> {
  const out = new Map<number, NonNullable<PrSummary['checks']>>();
  const nodes = (reply as { data?: { project?: { mergeRequests?: { nodes?: unknown } } | null } } | null)
    ?.data?.project?.mergeRequests?.nodes;
  if (!Array.isArray(nodes)) return out;
  for (const n of nodes as Array<{ iid?: unknown; headPipeline?: { status?: string } | null }>) {
    const iid = Number(n?.iid);
    const checks = mapGlabPipelineStatus(n?.headPipeline?.status);
    if (Number.isInteger(iid) && checks) out.set(iid, checks);
  }
  return out;
}

export function mapGlabMrItem(json: GlabMrItem): PrSummary | null {
  if (typeof json.iid !== 'number' || typeof json.web_url !== 'string') return null;
  const raw = (json.state ?? '').toLowerCase();
  const state: PrSummary['state'] =
    raw === 'merged'
      ? 'merged'
      : raw === 'closed' || raw === 'locked'
        ? 'closed'
        : json.draft || json.work_in_progress
          ? 'draft'
          : 'open';
  return {
    number: json.iid,
    title: json.title ?? '',
    state,
    author: json.author?.username ?? '',
    headRefName: json.source_branch ?? '',
    updatedAt: json.updated_at ?? '',
    url: json.web_url,
    reviewDecision: '',
    // Filled in from the GraphQL head-pipeline read (fetchList); null = no dot.
    checks: null,
    // GitLab의 has_conflicts를 gh 계약(CONFLICTING) 어휘로 정규화. 부재는 ''.
    mergeable: json.has_conflicts === true ? 'CONFLICTING' : '',
  };
}

interface GlabNote {
  system?: boolean;
  author?: { username?: string };
  body?: string;
  created_at?: string;
}

function capBody(raw: string): { body: string; truncated: boolean } {
  // gh 쪽과 동일 정규화: 봇 HTML 주석 마커 스트립 + 캡.
  const body = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (Buffer.byteLength(body, 'utf8') <= PR_COMMENT_BODY_CAP) return { body, truncated: false };
  return { body: body.slice(0, PR_COMMENT_BODY_CAP), truncated: true };
}

/** notes → 코멘트 스트림. system 노트(머지/커밋 자동기록)는 제외. */
export function mapGlabNotes(notes: GlabNote[], mrUrl: string): PrComment[] {
  const out: PrComment[] = [];
  for (const n of notes) {
    if (n.system) continue;
    if (typeof n.body !== 'string') continue;
    const { body, truncated } = capBody(n.body);
    out.push({
      author: n.author?.username ?? '',
      body,
      createdAt: n.created_at ?? '',
      url: mrUrl,
      kind: 'comment',
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

export class GlabPrService implements PrProvider {
  private listCache = new Map<string, ListEntry>();
  /** key = repo\0iid — updatedAt 불변이면 notes 재fetch 생략. + url 동봉 캐시. */
  private detailCache = new Map<string, { updatedAt: string; value: PrDetailResult }>();
  /** iid → web_url (목록에서 채움 — notes의 앵커 URL로 쓴다). */
  private urlByIid = new Map<string, string>();
  private glabMissingAt: number | null = null;
  private glabFoundAt: number | null = null;
  /** Per host: the last `glab auth status` answer, and a probe in flight. */
  private authAt = new Map<string, { ok: boolean; at: number }>();
  private authPending = new Map<string, Promise<boolean>>();

  constructor(
    private now: () => number = Date.now,
    private exec: Exec = execFileAsync,
  ) {}

  private glab(args: string[], cwd: string): Promise<{ stdout: string }> {
    return this.exec(process.platform === 'win32' ? 'glab.exe' : 'glab', args, {
      cwd,
      timeout: GLAB_TIMEOUT_MS,
      env: GLAB_ENV,
      windowsHide: true,
    });
  }

  // Each probe is TTL-cached like GhPrService's: every 30 s list poll asks for
  // the gate, and `glab auth status` may go to the network. `force` (Check
  // again) re-probes both; back-to-back forced reads share one probe.
  async gate(repoPath: string, host: string, force = false): Promise<PrGate> {
    const now = this.now();
    const missing = { ok: false as const, reason: 'cli-missing' as const, message: 'GitLab CLI (glab) is not installed' };
    if (!force && this.glabMissingAt !== null && now - this.glabMissingAt < GATE_TTL_MS) return missing;
    if (force || this.glabFoundAt === null || now - this.glabFoundAt >= GATE_TTL_MS) {
      try {
        await this.glab(['--version'], repoPath);
        this.glabMissingAt = null;
        this.glabFoundAt = this.now();
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') this.glabMissingAt = this.now();
        this.glabFoundAt = null;
        return missing;
      }
    }
    const auth = this.authAt.get(host);
    const fresh = !!auth && now - auth.at < (force ? FORCED_REUSE_MS : AUTH_TTL_MS);
    // Auth is per host (self-managed GitLab): a non-zero exit means signed out.
    const ok = fresh ? auth.ok : await this.probeAuth(repoPath, host);
    if (!ok) {
      return {
        ok: false,
        reason: 'unauthenticated',
        message: `GitLab CLI is not authenticated for ${host} — run \`glab auth login --hostname ${host}\``,
      };
    }
    return { ok: true };
  }

  private probeAuth(repoPath: string, host: string): Promise<boolean> {
    const running = this.authPending.get(host);
    if (running) return running;
    const probe = this.glab(['auth', 'status', '--hostname', host], repoPath)
      .then(() => true, () => false)
      .then((ok) => {
        this.authAt.set(host, { ok, at: this.now() });
        this.authPending.delete(host);
        return ok;
      });
    this.authPending.set(host, probe);
    return probe;
  }

  // force=true: 수동 새로고침 — TTL 캐시를 건너뛴다(gh 경로와 동일 계약).
  async listPrs(repoPath: string, force = false): Promise<PrListResult> {
    const key = cacheKey(repoPath);
    const entry = this.listCache.get(key);
    const now = this.now();
    if (entry) {
      if (entry.pending) return entry.pending;
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
      // REST MR 배열 원형 — glab mr list의 json 출력(open MR 기본).
      const { stdout } = await this.glab(
        ['mr', 'list', '--per-page', String(LIST_LIMIT), '--output', 'json'],
        repoPath,
      );
      const parsed = JSON.parse(stdout) as GlabMrItem[];
      const items = Array.isArray(parsed) ? parsed : [];
      const mapped = items
        .map(mapGlabMrItem)
        .filter((p): p is PrSummary => p !== null);
      for (const p of mapped) this.urlByIid.set(`${cacheKey(repoPath)}\0${p.number}`, p.url);
      const pipelines = await this.readPipelines(repoPath, items, mapped);
      const prs = mapped.map((p) => {
        const checks = pipelines.get(p.number);
        return checks ? { ...p, checks } : p;
      });
      return { ok: true, prs };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      return { ok: false, error: (e.stderr || e.message || String(err)).slice(0, 300) };
    }
  }

  /** Head-pipeline rollups for the listed MRs, in one GraphQL call. Any
   *  failure reads as "no pipelines": the list matters more than its dots. */
  private async readPipelines(
    repoPath: string,
    items: readonly GlabMrItem[],
    prs: readonly PrSummary[],
  ): Promise<Map<number, NonNullable<PrSummary['checks']>>> {
    const fullPath = items.map(glabProjectPath).find((p): p is string => p !== null);
    if (!fullPath || prs.length === 0) return new Map();
    try {
      const { stdout } = await this.glab(
        ['api', 'graphql', '-f', `query=${glabPipelinesQuery(prs.map((p) => p.number))}`, '-f', `fullPath=${fullPath}`],
        repoPath,
      );
      return mapGlabPipelines(JSON.parse(stdout));
    } catch {
      return new Map();
    }
  }

  async prDetail(repoPath: string, number: number, updatedAt: string): Promise<PrDetailResult> {
    const key = `${cacheKey(repoPath)}\0${number}`;
    const cached = this.detailCache.get(key);
    if (cached && cached.updatedAt === updatedAt && cached.value.ok) return cached.value;
    try {
      // `:id`는 glab이 cwd의 repo(URL-encoded full path)로 치환한다.
      const { stdout } = await this.glab(
        ['api', `projects/:id/merge_requests/${number}/notes?sort=asc&per_page=100`],
        repoPath,
      );
      const notes = JSON.parse(stdout) as GlabNote[];
      const mrUrl = this.urlByIid.get(key) ?? '';
      const value: PrDetailResult = {
        ok: true,
        detail: { number, comments: mapGlabNotes(Array.isArray(notes) ? notes : [], mrUrl) },
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

/** 프로세스 전역 싱글턴 — gh 쪽(ghPrService)과 동일 수명 계약. */
export const glabPrService = new GlabPrService();
