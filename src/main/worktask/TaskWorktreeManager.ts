/**
 * TaskWorktreeManager — J1 §3 D3. fan-out 태스크의 전용 git worktree를 만든다.
 *
 * company/WorktreeManager(고아 코드 2벌)의 재사용 실체는 검증 유틸 계승
 * (validateGitRef·validatePath — 플래그 주입·traversal 방어)이고, §6.J 함정
 * 목록(전용 루트·직렬 큐·dirty 보존·에지 fail-closed·경로 길이)은 신규 구현이다.
 *
 * 핵심 계약:
 *   - 전용 루트: `${getWmuxHomeDir()}/worktrees/{repoHash}/{taskSlug}` — 하드코딩
 *     `~/.wmux` 금지, getWmuxHomeDir() 파생으로 dev/dogfood suffix 격리 상속(C4).
 *   - repoHash = repo 루트 realpath의 해시 12자(J0 normalizeWorktreePath 주석의
 *     "realpath는 호출측 몫" 이행 지점).
 *   - taskSlug = `{title slug 24자}-{taskId 말미 8자}`(충돌은 taskId가 흡수).
 *   - branch = `wtask/{taskSlug}` — 기존 브랜치 충돌 시 명시 에러(자동 접미사 금지).
 *   - per-repo 직렬 큐: repoHash 단위 뮤텍스로 add/remove 순차화(git index.lock 경합 차단).
 *   - dirty 거부: remove 진입 시 porcelain 검사 → dirty면 제거 거부 + 보존 반환.
 *   - 에지 fail-closed: bare·서브모듈·LFS·비repo·경로 260자 초과는 명시 에러.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { getWmuxHomeDir } from '../../shared/constants';
import { getExecEnv } from '../../shared/execEnv';

const execFileAsync = promisify(execFile);

/** Windows MAX_PATH 방어 — 루트+slug 조합 상한(§3 리뷰 G2 편입). */
const MAX_WORKTREE_PATH_LEN = 260;
/** taskSlug: title slug 최대 길이(§3). */
const TITLE_SLUG_MAX = 24;
/** taskSlug: taskId 말미 길이(§3 — 충돌 흡수 엔트로피). */
const TASK_ID_SUFFIX_LEN = 8;

/**
 * git ref(브랜치명) 검증 — 플래그 주입·traversal 방어(company/WorktreeManager 계승).
 */
function validateGitRef(ref: string, label: string): string {
  if (!ref || ref.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  const trimmed = ref.trim();
  if (trimmed.startsWith('-')) {
    throw new Error(`${label} must not start with '-'`);
  }
  if (trimmed.includes('..')) {
    throw new Error(`${label} must not contain '..'`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error(`${label} must not contain control characters`);
  }
  if (trimmed.length > 200) {
    throw new Error(`${label} is too long (max 200 characters)`);
  }
  return trimmed;
}

/**
 * 파일시스템 경로 검증(company/WorktreeManager 계승) — 플래그 주입·제어문자 방어
 * 후 절대경로로 resolve.
 */
function validatePath(p: string, label: string): string {
  if (!p || p.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  const trimmed = p.trim();
  if (trimmed.startsWith('-')) {
    throw new Error(`${label} must not start with '-'`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error(`${label} must not contain control characters`);
  }
  return path.resolve(trimmed);
}

/** title → slug(소문자·영숫자·하이픈, 최대 TITLE_SLUG_MAX자). */
export function titleToSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TITLE_SLUG_MAX)
    .replace(/-+$/g, '');
}

/** taskId 말미 8자(= random 세그먼트) 추출 — 충돌 흡수. */
export function taskIdSuffix(taskId: string): string {
  return taskId.replace(/^wtask-/, '').slice(-TASK_ID_SUFFIX_LEN);
}

/**
 * worktree 경로 → meta dir 파생(J3 §1·§3 — preflight의 경로 규칙 역산).
 * preflight가 `worktreePath = {root}/{slug}`·`metaDir = {root}/.meta/{slug}`로
 * 파생하므로, `dirname(worktreePath)/.meta/basename(worktreePath)`가 정합이다.
 * 정리 스캔(task.json 역추적)·미발사 재발사(prompt.md 실존 검사)가 worktreePath
 * 하나로 meta dir를 되찾는 단일 출처.
 */
export function metaDirForWorktree(worktreePath: string): string {
  return path.join(path.dirname(worktreePath), '.meta', path.basename(worktreePath));
}

/** taskSlug = `{titleSlug}-{taskIdSuffix}`. titleSlug 비면 접미사만. */
export function buildTaskSlug(title: string, taskId: string): string {
  const slug = titleToSlug(title);
  const suffix = taskIdSuffix(taskId);
  return slug.length > 0 ? `${slug}-${suffix}` : suffix;
}

/** fan-out 태스크 worktree의 파생 경로 묶음(프리플라이트가 계산·검증). */
export interface TaskWorktreePlan {
  /** repo 루트 realpath. */
  repoRoot: string;
  /** repo 루트 realpath 해시 12자. */
  repoHash: string;
  /** `{titleSlug}-{taskIdSuffix}`. */
  taskSlug: string;
  /** 전용 worktree 경로. */
  worktreePath: string;
  /** `wtask/{taskSlug}`. */
  branch: string;
  /** 프롬프트 등 메타 파일 디렉토리(worktree 밖 — diff 청정성 §4). */
  metaDir: string;
}

export type PreflightResult =
  | { ok: true; plan: TaskWorktreePlan }
  | { ok: false; error: string };

export type CreateResult =
  | { ok: true; worktreePath: string; branch: string }
  | { ok: false; error: string };

export type RemoveResult =
  | { ok: true }
  | { ok: false; error: string; preserved?: boolean };

/**
 * repo 단위 직렬 큐를 갖춘 worktree 매니저. 인스턴스는 프로세스 수명 동안 재사용
 * (repoHash → 뮤텍스 체인을 유지해야 하므로).
 */
export class TaskWorktreeManager {
  /** repoHash → write 체인(§3 per-repo 직렬 큐 — index.lock 경합 차단). */
  private readonly repoChains = new Map<string, Promise<unknown>>();

  /** 주입 가능한 git 러너(테스트) — 기본 execFile. */
  private readonly runGit: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

  constructor(opts?: {
    runGit?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  }) {
    this.runGit =
      opts?.runGit ??
      (async (args, cwd) => {
        const { stdout, stderr } = await execFileAsync('git', args, { cwd, timeout: 30000, env: getExecEnv() });
        return { stdout, stderr };
      });
  }

  /**
   * 프리플라이트(§2 ⓪ — repo 유효성 1회 선검증). 부적격이면 태스크·채널 생성
   * 자체가 일어나선 안 되므로 FanOutService가 fan-out 전체를 거부하는 판정식이다.
   *   - 비 repo·git 부재 → 거부.
   *   - bare repo·서브모듈·LFS → 거부(지원 후속, 조용한 반쪽 동작 금지).
   *   - 전용 루트 쓰기 가능 + 경로 길이(260자) 검증.
   *   - branch·slug·경로 파생 반환(성공 시).
   */
  async preflight(
    repoPathRaw: string,
    title: string,
    taskId: string,
    opts?: { checkBranchConflict?: boolean },
  ): Promise<PreflightResult> {
    let repoInput: string;
    try {
      repoInput = validatePath(repoPathRaw, 'repoPath');
    } catch (err) {
      return { ok: false, error: `preflight: ${(err as Error).message}` };
    }

    // repo 루트 확인(비 repo·git 부재 fail-closed). --show-toplevel은 bare에서 실패한다.
    let repoRoot: string;
    try {
      const { stdout } = await this.runGit(['rev-parse', '--show-toplevel'], repoInput);
      repoRoot = stdout.trim();
      if (repoRoot.length === 0) {
        return { ok: false, error: 'preflight: not a git repository (empty toplevel)' };
      }
    } catch {
      return { ok: false, error: `preflight: not a git repository or git unavailable: ${repoInput}` };
    }

    // bare repo 거부(§3 에지 fail-closed).
    try {
      const { stdout } = await this.runGit(['rev-parse', '--is-bare-repository'], repoRoot);
      if (stdout.trim() === 'true') {
        return { ok: false, error: 'preflight: bare repositories are not supported (J1)' };
      }
    } catch {
      return { ok: false, error: 'preflight: failed to determine repository kind' };
    }

    // 서브모듈 포함 repo 거부(§3). .gitmodules 존재로 판정(보수적 fail-closed).
    if (fs.existsSync(path.join(repoRoot, '.gitmodules'))) {
      return { ok: false, error: 'preflight: repositories with submodules are not supported (J1)' };
    }

    // LFS 거부(§3). .gitattributes에 filter=lfs가 있으면 fail-closed.
    const gitattr = path.join(repoRoot, '.gitattributes');
    if (fs.existsSync(gitattr)) {
      try {
        const content = fs.readFileSync(gitattr, 'utf8');
        if (/filter=lfs/.test(content)) {
          return { ok: false, error: 'preflight: git-LFS repositories are not supported (J1)' };
        }
      } catch {
        // 읽기 실패는 LFS 판정 불가 — 보수적으로 통과시키지 않고 거부.
        return { ok: false, error: 'preflight: failed to inspect .gitattributes' };
      }
    }

    // repo 루트 realpath 해시 12자.
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(repoRoot);
    } catch {
      realRoot = repoRoot;
    }
    const repoHash = crypto.createHash('sha256').update(realRoot).digest('hex').slice(0, 12);

    // 경로 파생.
    const taskSlug = buildTaskSlug(title, taskId);
    const root = `${getWmuxHomeDir()}/worktrees/${repoHash}`;
    const worktreePath = path.join(root, taskSlug);
    const metaDir = path.join(root, '.meta', taskSlug);
    const branch = `wtask/${taskSlug}`;

    // branch·경로 검증(플래그 주입·traversal — 계승 유틸).
    try {
      validateGitRef(branch, 'branch');
      validatePath(worktreePath, 'worktreePath');
    } catch (err) {
      return { ok: false, error: `preflight: ${(err as Error).message}` };
    }

    // Windows MAX_PATH 방어(§3 리뷰 G2).
    if (worktreePath.length > MAX_WORKTREE_PATH_LEN) {
      return {
        ok: false,
        error: `preflight: worktree path exceeds ${MAX_WORKTREE_PATH_LEN} characters (${worktreePath.length}); shorten the title or enable core.longpaths`,
      };
    }

    // 전용 루트 쓰기 가능 검증(디렉토리 생성 시도).
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch (err) {
      return { ok: false, error: `preflight: dedicated worktree root not writable: ${(err as Error).message}` };
    }

    // branch 충돌 선검증(F3 — titles 전체 선검증 시 사용). createWorktree가 락 안에서
    // 다시 검사하지만, 전역 프리플라이트가 mission.start 전에 부적격 태스크를 걸러
    // "부적격이면 태스크 생성 0" 계약을 지키려면 여기서도 확인해야 한다.
    if (opts?.checkBranchConflict) {
      try {
        await this.runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], realRoot);
        // 성공 = 브랜치 존재 → 충돌.
        return { ok: false, error: `preflight: branch already exists: ${branch}` };
      } catch {
        // 실패 = 브랜치 부재 → 정상.
      }
    }

    return { ok: true, plan: { repoRoot: realRoot, repoHash, taskSlug, worktreePath, branch, metaDir } };
  }

  /**
   * worktree 생성(§3 — per-repo 직렬 큐 하). `git worktree add {path} -b {branch}`.
   * 기존 브랜치 충돌은 명시 에러(자동 접미사 금지). plan은 preflight 산출을 그대로 받는다.
   */
  async createWorktree(plan: TaskWorktreePlan): Promise<CreateResult> {
    return this.withRepoLock(plan.repoHash, async () => {
      const safeBranch = validateGitRef(plan.branch, 'branch');
      const safePath = validatePath(plan.worktreePath, 'worktreePath');

      // 기존 브랜치 충돌 선검사(명시 에러 — 사용자 브랜치 공간 오염 금지).
      try {
        await this.runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${safeBranch}`], plan.repoRoot);
        // 성공 = 브랜치 존재 → 충돌.
        return { ok: false, error: `createWorktree: branch already exists: ${safeBranch}` };
      } catch {
        // 실패 = 브랜치 부재 → 정상 진행.
      }

      try {
        await this.runGit(['worktree', 'add', safePath, '-b', safeBranch], plan.repoRoot);
      } catch (err) {
        return { ok: false, error: `createWorktree: git worktree add failed: ${(err as Error).message}` };
      }
      return { ok: true, worktreePath: safePath, branch: safeBranch };
    });
  }

  /**
   * worktree 제거(§3 — dirty 보존). remove 진입 시 porcelain 검사 → dirty면 제거
   * 거부 + preserved:true 반환(강제 삭제 API 자체를 만들지 않는다 — J3 UX 몫).
   */
  async removeWorktree(repoRoot: string, repoHash: string, worktreePath: string): Promise<RemoveResult> {
    return this.withRepoLock(repoHash, async () => {
      const safePath = validatePath(worktreePath, 'worktreePath');

      // dirty 검사: worktree 안에서 porcelain. 커밋 안 된 변경이 있으면 보존.
      try {
        const { stdout } = await this.runGit(['status', '--porcelain'], safePath);
        if (stdout.trim().length > 0) {
          return { ok: false, error: 'removeWorktree: worktree is dirty; preserved', preserved: true };
        }
      } catch (err) {
        // status 실패(경로 부재 등) — 보수적으로 제거 시도하지 않고 보존.
        return { ok: false, error: `removeWorktree: status check failed: ${(err as Error).message}`, preserved: true };
      }

      try {
        await this.runGit(['worktree', 'remove', safePath], repoRoot);
      } catch (err) {
        return { ok: false, error: `removeWorktree: git worktree remove failed: ${(err as Error).message}` };
      }
      return { ok: true };
    });
  }

  /**
   * repoHash 단위 직렬 체인(§3 — index.lock 경합 차단). A2aTaskService.withTaskLock 동형.
   * 프로세스 내 직렬화만 보장한다 — 크로스 프로세스 동시 add는 git 자체의 index.lock에
   * 의존하고, 경합 시 git 에러가 명시 전파된다(조용한 성공 위장 없음).
   */
  private withRepoLock<T>(repoHash: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.repoChains.get(repoHash) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.repoChains.set(
      repoHash,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}
