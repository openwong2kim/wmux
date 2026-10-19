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
import * as os from 'node:os';
import { getWmuxHomeDir } from '../../shared/constants';
import { getExecEnv } from '../../shared/execEnv';
import { originPinFromConfigList } from './workerGit';
import type { PendingRemovalStore, PendingWorktreeRemoval } from './pendingWorktreeRemovals';

const execFileAsync = promisify(execFile);

/** Windows MAX_PATH 방어 — 루트+slug 조합 상한(§3 리뷰 G2 편입). */
const MAX_WORKTREE_PATH_LEN = 260;
/** taskSlug: title slug 최대 길이(§3). */
const TITLE_SLUG_MAX = 24;
/** taskSlug: taskId 말미 길이(§3 — 충돌 흡수 엔트로피). */
const TASK_ID_SUFFIX_LEN = 8;
/** One `git fetch origin <default>` per fan-out — short, so an offline or
 *  credential-prompting remote degrades to the HEAD fallback quickly. */
const BASE_FETCH_TIMEOUT_MS = 10000;
/** Cap on git stderr quoted back in a base warning. */
const BASE_WARNING_DETAIL_MAX = 200;

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

/** First line of a git failure (stderr when execFile attached it), capped. */
function gitErrorDetail(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown; killed?: boolean };
  if (e?.killed) return 'timed out';
  const raw = typeof e?.stderr === 'string' && e.stderr.trim() ? e.stderr : String(e?.message ?? err);
  const line = raw.trim().split('\n')[0] ?? '';
  return line.length > BASE_WARNING_DETAIL_MAX ? `${line.slice(0, BASE_WARNING_DETAIL_MAX)}…` : line;
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
  /** The repository's common git dir, resolved; absent when it could not be
   *  read. Recorded on the task's ledger row (LedgerDispatch.gitCommonDir). */
  gitCommonDir?: string;
  /** origin's pin, read through gitCommonDir; absent when origin is not a
   *  plain https or ssh address. Recorded on the task's ledger row
   *  (LedgerDispatch.originPin). */
  originPin?: string;
}

export type PreflightResult =
  | { ok: true; plan: TaskWorktreePlan }
  | { ok: false; error: string };

export type CreateResult =
  | { ok: true; worktreePath: string; branch: string; gitWorktreeDir?: string }
  | { ok: false; error: string };

/**
 * Where fan-out task branches start. `oid` is the commit every task of one
 * fan-out branches from — origin's default branch, pinned once so a fetch or
 * pull landing mid-fan-out cannot split the tasks across commits. `ref` names
 * it for messages. Absent `oid` means "branch from HEAD", and `warning` says
 * why. `error` refuses the fan-out (the base carries submodules or LFS).
 */
export interface WorktreeBase {
  oid?: string;
  ref?: string;
  warning?: string;
  error?: string;
}

/** Injectable git runner options for network calls: a per-call timeout, no
 *  credential prompts, and (when the user has no ssh command of their own)
 *  ssh in batch mode so a host-key or passphrase prompt fails fast. */
export interface RunGitOptions {
  timeoutMs?: number;
  noPrompt?: boolean;
  sshBatchMode?: boolean;
  /** Added to the environment of this call (a temporary GIT_INDEX_FILE). */
  env?: Record<string, string>;
}

type RunGit = (args: string[], cwd: string, opts?: RunGitOptions) => Promise<{ stdout: string; stderr: string }>;

export type RemoveResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      preserved?: boolean;
      /** Set only when the worktree was kept because it has uncommitted changes —
       *  not when the status check itself failed (also preserved, cause unknown). */
      dirty?: boolean;
    };

/** What the second layer did with a folder `git worktree remove` left. */
type LeftoverResult =
  | { ok: true }
  | { ok: false; error: string; registered?: boolean; dirty?: boolean };

/** `child` is strictly inside `parent` (both canonical). */
function strictlyInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Why a leftover's `.git` makes it a checkout that is still alive, or null
 * when it does not: none, or a gitfile naming a git dir that is gone (the
 * marker of the worktree git just dropped). A `.git` folder is a repository
 * of its own; a gitfile naming a git dir that exists is a live checkout (the
 * path reused for another worktree); one that cannot be read is not known.
 */
function leftoverGitEntry(folder: string): string | null {
  const marker = path.join(folder, '.git');
  let st: fs.Stats;
  try {
    st = fs.lstatSync(marker);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : (err as Error).message;
  }
  if (!st.isFile()) return 'it holds a repository of its own';
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(marker, 'utf8'));
    if (!m) return 'its .git file cannot be read';
    return fs.existsSync(path.resolve(folder, m[1])) ? 'its .git file names a git dir that exists (a live checkout)' : null;
  } catch (err) {
    return (err as Error).message;
  }
}

function sameCanonical(a: string, b: string): boolean {
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * repo 단위 직렬 큐를 갖춘 worktree 매니저. 인스턴스는 프로세스 수명 동안 재사용
 * (repoHash → 뮤텍스 체인을 유지해야 하므로).
 */
export class TaskWorktreeManager {
  /** repoHash → write 체인(§3 per-repo 직렬 큐 — index.lock 경합 차단). */
  private readonly repoChains = new Map<string, Promise<unknown>>();

  /** 주입 가능한 git 러너(테스트) — 기본 execFile. */
  private readonly runGit: RunGit;

  /** Called with the repository root after a task worktree is created
   *  (the app installs its pre-commit secret check there). */
  private onCreated?: (repoRoot: string) => void;

  /** Removals not finished yet (#2388), so a later close or the sweep at
   *  start can finish one. Absent: nothing is recorded. */
  private readonly pendingRemovals?: PendingRemovalStore;

  /** The folder every task worktree lives under; the second layer never
   *  deletes anything outside it. */
  private readonly worktreesRoot: string;

  /** Deletes a leftover folder without following a link (tests inject). */
  private readonly removeTree: (dir: string, root: string) => Promise<void>;

  constructor(opts?: {
    runGit?: RunGit;
    onCreated?: (repoRoot: string) => void;
    pendingRemovals?: PendingRemovalStore;
    worktreesRoot?: string;
    removeTree?: (dir: string, root: string) => Promise<void>;
  }) {
    this.onCreated = opts?.onCreated;
    this.pendingRemovals = opts?.pendingRemovals;
    this.worktreesRoot = opts?.worktreesRoot ?? path.join(getWmuxHomeDir(), 'worktrees');
    // Imported when used: taskFolderCleanup pulls in the bot runtime.
    this.removeTree = opts?.removeTree ?? (async (dir, root) => (await import('../factory/taskFolderCleanup')).removeTreeNoFollow(dir, root));
    this.runGit =
      opts?.runGit ??
      (async (args, cwd, runOpts) => {
        // GIT_TERMINAL_PROMPT=0: the GUI process has no TTY, so a credential
        // prompt would only sit there until the timeout fires.
        let env = runOpts?.noPrompt ? { ...getExecEnv(), GIT_TERMINAL_PROMPT: '0' } : getExecEnv();
        if (runOpts?.env) env = { ...env, ...runOpts.env };
        // GIT_TERMINAL_PROMPT does not cover ssh, which prompts on /dev/tty.
        // An ssh command the user already set in the environment wins.
        if (runOpts?.sshBatchMode && !env.GIT_SSH_COMMAND && !env.GIT_SSH) {
          env = { ...env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
        }
        const { stdout, stderr } = await execFileAsync('git', args, {
          cwd,
          timeout: runOpts?.timeoutMs ?? 30000,
          env,
        });
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
  /** The repository's common git dir (resolved) and origin's pin, read
   *  through that git dir (origin's URL as the config holds it, no URL
   *  rewrite applied); either absent when it cannot be read. Never throws. */
  private async gitDirAndPin(realRoot: string): Promise<{ gitCommonDir?: string; originPin?: string }> {
    let gitCommonDir: string | undefined;
    try {
      const { stdout } = await this.runGit(['rev-parse', '--git-common-dir'], realRoot);
      const out = stdout.trim();
      if (out) {
        const resolved = path.resolve(realRoot, out);
        try {
          gitCommonDir = fs.realpathSync.native(resolved);
        } catch {
          // A repository inside a WSL distro, on a share Windows cannot
          // resolve: the distro resolves the path itself (taskPush.ts).
          gitCommonDir = process.platform === 'win32' && /^\\\\wsl(?:\$|\.localhost)\\/i.test(resolved) ? resolved : undefined;
        }
      }
    } catch {
      gitCommonDir = undefined;
    }
    if (!gitCommonDir) return {};
    try {
      const { stdout } = await this.runGit([`--git-dir=${gitCommonDir}`, 'config', '-z', '--list', '--show-scope'], realRoot);
      const originPin = originPinFromConfigList(stdout) ?? undefined;
      return { gitCommonDir, ...(originPin ? { originPin } : {}) };
    } catch {
      return { gitCommonDir };
    }
  }

  /** origin's pin for the repository at `repoInput`, read as preflight reads
   *  it; undefined when it cannot be read. Never throws. */
  async readOriginPin(repoInput: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.runGit(['rev-parse', '--show-toplevel'], repoInput);
      const top = stdout.trim();
      if (!top) return undefined;
      let realRoot = top;
      try {
        realRoot = fs.realpathSync(top);
      } catch {
        // kept as git printed it, as preflight does
      }
      return (await this.gitDirAndPin(realRoot)).originPin;
    } catch {
      return undefined;
    }
  }

  async preflight(
    repoPathRaw: string,
    title: string,
    taskId: string,
    opts?: { checkBranchConflict?: boolean; branch?: string },
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
    // The git dir task_push and task_fetch later run on, and origin's pin,
    // read here before any worker exists.
    const { gitCommonDir, originPin } = await this.gitDirAndPin(realRoot);

    // 경로 파생.
    const taskSlug = buildTaskSlug(title, taskId);
    const root = `${getWmuxHomeDir()}/worktrees/${repoHash}`;
    const worktreePath = path.join(root, taskSlug);
    const metaDir = path.join(root, '.meta', taskSlug);
    // A caller may name the branch (the Git page's issue-<n>-<slug>); it is
    // validated as a ref below and an existing branch is still refused.
    const branch = opts?.branch ?? `wtask/${taskSlug}`;

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

    return { ok: true, plan: { repoRoot: realRoot, repoHash, taskSlug, worktreePath, branch, metaDir, ...(gitCommonDir ? { gitCommonDir } : {}), ...(originPin ? { originPin } : {}) } };
  }

  /**
   * Resolve the base every task branch of one fan-out starts from: origin's
   * default branch, freshly fetched, pinned to one commit. Called once per
   * fan-out, outside the per-repo lock (a network call there would serialize
   * every task behind it).
   *
   *   1. Name from local refs: `origin/HEAD`, else `origin/main`, else
   *      `origin/master`; with none (never fetched), ask the remote once
   *      (`ls-remote --symref origin HEAD`).
   *   2. `git fetch origin +refs/heads/<name>:refs/remotes/origin/<name>` — an
   *      explicit refspec, because a bare `fetch origin <name>` only moves
   *      FETCH_HEAD when remote.origin.fetch does not cover the branch
   *      (single-branch clones, narrowed refspecs).
   *   3. Pin `refs/remotes/origin/<name>` to an OID.
   *
   * A failed fetch keeps the existing remote-tracking ref (with a "stale"
   * warning) — a concurrent fetch holding the ref lock is a common cause, and
   * the owner's checkout may be an unrelated feature branch. HEAD is the base
   * only when no remote-tracking ref exists at all. Never throws.
   */
  async resolveBase(repoRoot: string): Promise<WorktreeBase> {
    const fallback = (why: string): WorktreeBase => ({
      warning: `${why}; tasks branched from the local HEAD, which may not match origin's default branch`,
    });
    if (!repoRoot) return fallback('no repository root to resolve a base in');

    // ssh prompts are only suppressed when the user has not configured their own ssh command.
    let sshBatchMode = true;
    try {
      const { stdout } = await this.runGit(['config', '--get', 'core.sshCommand'], repoRoot);
      if (stdout.trim()) sshBatchMode = false;
    } catch {
      // unset — batch mode applies.
    }
    const netOpts: RunGitOptions = { timeoutMs: BASE_FETCH_TIMEOUT_MS, noPrompt: true, sshBatchMode };

    let name: string | undefined;
    try {
      const { stdout } = await this.runGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoRoot);
      const target = stdout.trim();
      if (target.startsWith('refs/remotes/origin/')) name = target.slice('refs/remotes/origin/'.length);
    } catch {
      // origin/HEAD unset (common for repos that were not cloned) — try the usual names.
    }
    if (!name) {
      for (const candidate of ['main', 'master']) {
        if (await this.commitOf(`refs/remotes/origin/${candidate}`, repoRoot)) {
          name = candidate;
          break;
        }
      }
    }
    if (!name) {
      try {
        const { stdout } = await this.runGit(['ls-remote', '--symref', 'origin', 'HEAD'], repoRoot, netOpts);
        name = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(stdout)?.[1];
      } catch {
        // no origin, or unreachable — reported below.
      }
    }
    if (!name) return fallback('could not resolve the default branch of remote "origin"');
    try {
      name = validateGitRef(name, 'default branch');
    } catch (err) {
      return fallback(`origin's default branch name was rejected (${(err as Error).message})`);
    }

    const ref = `refs/remotes/origin/${name}`;
    let staleWarning: string | undefined;
    try {
      await this.runGit(['fetch', 'origin', `+refs/heads/${name}:${ref}`], repoRoot, netOpts);
    } catch (err) {
      staleWarning = `git fetch origin ${name} failed (${gitErrorDetail(err)}); tasks branched from the last fetched ${ref}, which may be stale`;
    }

    const oid = await this.commitOf(ref, repoRoot);
    if (!oid) {
      return fallback(
        staleWarning ? `git fetch origin ${name} failed and ${ref} does not exist` : `${ref} does not exist after git fetch origin ${name}`,
      );
    }

    // The preflight looked at the owner's checkout; the tasks get the base
    // commit's tree, so its submodules/LFS are checked here (same fail-closed rule).
    try {
      await this.runGit(['cat-file', '-e', `${oid}:.gitmodules`], repoRoot);
      return { error: `the base ${ref} contains submodules, which are not supported (J1)` };
    } catch {
      // no .gitmodules at the base.
    }
    let attrs = '';
    try {
      attrs = (await this.runGit(['show', `${oid}:.gitattributes`], repoRoot)).stdout;
    } catch {
      // no .gitattributes at the base.
    }
    if (/filter=lfs/.test(attrs)) {
      return { error: `the base ${ref} uses git-LFS, which is not supported (J1)` };
    }

    return { oid, ref, ...(staleWarning ? { warning: staleWarning } : {}) };
  }

  /**
   * The commit a detached task checkout starts at (a PR head for the verify
   * preset): fetch `fetchRef` from origin when given (e.g. `pull/<n>/head`),
   * then require `sha` to be a commit in the repository, with the same
   * submodule / LFS refusal as resolveBase. Never throws.
   */
  async resolveCheckout(repoRoot: string, sha: string, fetchRef?: string): Promise<{ oid: string } | { error: string }> {
    if (!/^[0-9a-f]{40}$/.test(sha)) return { error: 'checkout sha must be a 40-hex commit id' };
    if (fetchRef !== undefined) {
      let ref: string;
      try {
        ref = validateGitRef(fetchRef, 'fetchRef');
      } catch (err) {
        return { error: (err as Error).message };
      }
      // A plain source ref only: no refspec (`src:dst`, `+`), so the fetch
      // updates FETCH_HEAD and never a local ref.
      if (ref.includes(':') || ref.startsWith('+') || /\s/.test(ref)) return { error: 'fetchRef must be a single ref' };
      let sshBatchMode = true;
      try {
        const { stdout } = await this.runGit(['config', '--get', 'core.sshCommand'], repoRoot);
        if (stdout.trim()) sshBatchMode = false;
      } catch {
        // unset — batch mode applies.
      }
      try {
        await this.runGit(['fetch', 'origin', ref], repoRoot, { timeoutMs: BASE_FETCH_TIMEOUT_MS, noPrompt: true, sshBatchMode });
      } catch (err) {
        return { error: `git fetch origin ${ref} failed (${gitErrorDetail(err)})` };
      }
    }
    const oid = await this.commitOf(sha, repoRoot);
    if (oid !== sha) return { error: `commit ${sha} is not in the repository` };
    try {
      await this.runGit(['cat-file', '-e', `${oid}:.gitmodules`], repoRoot);
      return { error: `commit ${sha} contains submodules, which are not supported (J1)` };
    } catch {
      // no .gitmodules at the commit.
    }
    let attrs = '';
    try {
      attrs = (await this.runGit(['show', `${oid}:.gitattributes`], repoRoot)).stdout;
    } catch {
      // no .gitattributes at the commit.
    }
    if (/filter=lfs/.test(attrs)) return { error: `commit ${sha} uses git-LFS, which is not supported (J1)` };
    return { oid };
  }

  /**
   * A worktree checked out DETACHED at `sha` (`git worktree add --detach`):
   * no branch is created, so the task never sits on, or pushes to, the branch
   * it checks. Same lock and path validation as createWorktree; `branch` in
   * the result is ''.
   */
  async createDetachedWorktree(plan: TaskWorktreePlan, sha: string): Promise<CreateResult> {
    return this.withRepoLock(plan.repoHash, async () => {
      const safePath = validatePath(plan.worktreePath, 'worktreePath');
      try {
        await this.runGit(['worktree', 'add', '--detach', safePath, validateGitRef(sha, 'checkout sha')], plan.repoRoot);
      } catch (err) {
        return { ok: false, error: `createWorktree: git worktree add --detach failed: ${(err as Error).message}` };
      }
      const gitWorktreeDir = await this.worktreeGitDir(safePath);
      try {
        this.onCreated?.(plan.repoRoot);
      } catch {
        /* best-effort: never fails a created worktree */
      }
      return { ok: true, worktreePath: safePath, branch: '', ...(gitWorktreeDir ? { gitWorktreeDir } : {}) };
    });
  }

  /** The new worktree's own git dir (`<common>/worktrees/<id>`), read right
   *  after `git worktree add` (no worker exists yet), resolved. Undefined when
   *  it cannot be read: task_push then derives it from the recorded common dir. */
  private async worktreeGitDir(worktreePath: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.runGit(['rev-parse', '--path-format=absolute', '--git-dir'], worktreePath);
      const dir = stdout.trim();
      if (!dir) return undefined;
      try {
        return fs.realpathSync.native(dir);
      } catch {
        // A repository inside a WSL distro, on a share Windows cannot resolve:
        // the distro resolves the path itself (taskPush.ts).
        return process.platform === 'win32' && /^\\\\wsl(?:\$|\.localhost)\\/i.test(dir) ? dir : undefined;
      }
    } catch {
      return undefined;
    }
  }

  /** `rev-parse --verify --quiet <ref>^{commit}` — the commit OID, or undefined. */
  private async commitOf(ref: string, cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
      const oid = stdout.trim();
      return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(oid) ? oid : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * worktree 생성(§3 — per-repo 직렬 큐 하). `git worktree add {path} -b {branch}`.
   * 기존 브랜치 충돌은 명시 에러(자동 접미사 금지). plan은 preflight 산출을 그대로 받는다.
   * With a resolved base commit the branch starts there, `--no-track` so the
   * task branch does not adopt origin's default branch as its upstream.
   */
  async createWorktree(plan: TaskWorktreePlan, baseOid?: string): Promise<CreateResult> {
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
        const args = baseOid
          ? ['worktree', 'add', '--no-track', safePath, '-b', safeBranch, validateGitRef(baseOid, 'baseOid')]
          : ['worktree', 'add', safePath, '-b', safeBranch];
        await this.runGit(args, plan.repoRoot);
      } catch (err) {
        return { ok: false, error: `createWorktree: git worktree add failed: ${(err as Error).message}` };
      }
      const gitWorktreeDir = await this.worktreeGitDir(safePath);
      try {
        this.onCreated?.(plan.repoRoot);
      } catch {
        /* best-effort: never fails a created worktree */
      }
      return { ok: true, worktreePath: safePath, branch: safeBranch, ...(gitWorktreeDir ? { gitWorktreeDir } : {}) };
    });
  }

  /**
   * worktree 제거(§3 — dirty 보존). remove 진입 시 porcelain 검사 → dirty면 제거
   * 거부 + preserved:true 반환(강제 삭제 API 자체를 만들지 않는다 — J3 UX 몫).
   */
  /**
   * `beforeRemove` runs only once removal is decided (the dirty check passed), so a refused close
   * never stops anything. If it throws, the worktree is kept.
   *
   * `force` is only for a worktree no agent ever worked in (a fan-out spawn
   * refused before its pane existed, #2349): whatever is in it was written by
   * wmux's own setup, so the dirty check is skipped and git is told
   * `--force`. Commits are never at stake here; the branch is a separate step.
   *
   * #2388: the status is read again after `beforeRemove`, right before the
   * removal (what the stopped panes wrote meanwhile counts). A folder git
   * leaves behind after dropping its record goes to the second layer
   * (removeDeregisteredLeftover), never in `force` mode; one it cannot finish
   * stays recorded in the pending store for a later close or the sweep at
   * start (finishPendingRemoval).
   */
  async removeWorktree(
    repoRoot: string,
    repoHash: string,
    worktreePath: string,
    beforeRemove?: (worktreePath: string) => Promise<void>,
    opts?: { force?: boolean },
  ): Promise<RemoveResult> {
    return this.withRepoLock(repoHash, async () => {
      const safePath = validatePath(worktreePath, 'worktreePath');
      const force = opts?.force === true;

      // dirty 검사: worktree 안에서 porcelain. 커밋 안 된 변경이 있으면 보존.
      if (!force) {
        try {
          const { stdout } = await this.runGit(['status', '--porcelain'], safePath);
          if (stdout.trim().length > 0) {
            return { ok: false, error: 'removeWorktree: worktree is dirty; preserved', preserved: true, dirty: true };
          }
        } catch (err) {
          // status 실패(경로 부재 등) — 보수적으로 제거 시도하지 않고 보존.
          return { ok: false, error: `removeWorktree: status check failed: ${(err as Error).message}`, preserved: true };
        }
      }

      // The commit a leftover folder is compared with, recorded before
      // anything is stopped, so a later close can finish what this one leaves.
      const pending: PendingWorktreeRemoval | null = force
        ? null
        : { path: safePath, repoRoot, repoHash, ...(await this.headOf(safePath).then((head) => (head ? { head } : {}))), at: Date.now() };
      if (pending) await this.rememberPending(pending);

      if (beforeRemove) {
        try {
          await beforeRemove(safePath);
        } catch (err) {
          await this.forgetPending(safePath);
          return {
            ok: false,
            error: `removeWorktree: could not stop the panes started in the worktree, so it was kept: ${(err as Error).message}`,
            preserved: true,
          };
        }
      }

      // Read again now that the panes are stopped: they may have written
      // since the check above.
      if (!force) {
        try {
          const { stdout } = await this.runGit(['status', '--porcelain'], safePath);
          if (stdout.trim().length > 0) {
            await this.forgetPending(safePath);
            return { ok: false, error: 'removeWorktree: worktree is dirty; preserved', preserved: true, dirty: true };
          }
        } catch (err) {
          await this.forgetPending(safePath);
          return { ok: false, error: `removeWorktree: status check failed: ${(err as Error).message}`, preserved: true };
        }
        // A commit the stopped panes made meanwhile is what the folder is
        // clean against now.
        const headNow = await this.headOf(safePath);
        if (pending && headNow !== pending.head) {
          if (headNow) pending.head = headNow;
          else delete pending.head;
          await this.rememberPending(pending);
        }
      }

      let failure: string | null = null;
      try {
        await this.runGit(['worktree', 'remove', ...(force ? ['--force'] : []), safePath], repoRoot);
      } catch (err) {
        failure = `removeWorktree: git worktree remove failed: ${(err as Error).message}`;
      }
      if (!fs.existsSync(safePath)) {
        await this.forgetPending(safePath);
        // A process that outlived its pane can still hold files: keep the record so nothing is lost silently.
        return failure === null ? { ok: true } : { ok: false, error: failure, preserved: true };
      }
      failure ??= 'removeWorktree: files were left behind in the worktree folder';
      if (!pending) return { ok: false, error: failure, preserved: true };
      const leftover = await this.removeDeregisteredLeftover(pending);
      if (leftover.ok) {
        await this.forgetPending(safePath);
        return { ok: true };
      }
      // Still a worktree: the next close takes the usual route.
      if (leftover.registered) await this.forgetPending(safePath);
      return { ok: false, error: leftover.registered ? failure : `${failure}; ${leftover.error}`, preserved: true, ...(leftover.dirty ? { dirty: true } : {}) };
    });
  }

  /**
   * Finish a removal the pending store still holds (#2388): `git worktree
   * remove` dropped the worktree but left part of its folder, and the leftover
   * could not be deleted then. `beforeRemove` stops what still runs in the
   * folder first. The leftover goes only under the second layer's checks
   * (removeDeregisteredLeftover). Null when no removal of `worktreePath` is
   * recorded; a folder already gone ends the record.
   */
  async finishPendingRemoval(worktreePath: string, beforeRemove?: (worktreePath: string) => Promise<void>): Promise<RemoveResult | null> {
    const rec = this.pendingRemovals?.get(worktreePath);
    if (!rec) return null;
    return this.withRepoLock(rec.repoHash, async () => {
      if (!fs.existsSync(rec.path)) {
        await this.forgetPending(rec.path);
        return { ok: true };
      }
      // Every check first, stopping nothing: a folder that is kept anyway
      // (work written into it since, git listing it again) never costs the
      // panes running in it. The checks run again after the stop.
      const eligible = await this.removeDeregisteredLeftover(rec, { checkOnly: true });
      if (!eligible.ok) return this.leftoverKept(rec, eligible);
      if (beforeRemove) {
        try {
          await beforeRemove(rec.path);
        } catch (err) {
          return {
            ok: false,
            error: `removeWorktree: could not stop the panes started in the folder, so it was kept: ${(err as Error).message}`,
            preserved: true,
          };
        }
      }
      const leftover = await this.removeDeregisteredLeftover(rec);
      if (leftover.ok) {
        await this.forgetPending(rec.path);
        return { ok: true };
      }
      return this.leftoverKept(rec, leftover);
    });
  }

  /** The result of a pending removal the second layer refused; a folder git
   *  lists again ends its record (the next close takes the usual route). */
  private async leftoverKept(rec: PendingWorktreeRemoval, leftover: Exclude<LeftoverResult, { ok: true }>): Promise<RemoveResult> {
    if (leftover.registered) await this.forgetPending(rec.path);
    return {
      ok: false,
      error: leftover.registered ? 'removeWorktree: the folder is a worktree of its repository again; it was kept' : `removeWorktree: ${leftover.error}`,
      preserved: true,
      ...(leftover.dirty ? { dirty: true } : {}),
    };
  }

  /** The removals the pending store holds (the sweep at start). */
  pendingRemovalPaths(): string[] {
    return this.pendingRemovals?.all().map((r) => r.path) ?? [];
  }

  /**
   * Second layer (#2388), not the fix: the fix is that the panes' whole
   * process trees are gone before the removal (stopSessionsInDir). This only
   * finishes a folder `git worktree remove` left behind after dropping the
   * worktree's record (it deletes the record even when the folder could not
   * be deleted), and only when ALL of these hold; otherwise the folder stays:
   *   - its canonical path (links, junctions and 8.3 names resolved) is
   *     strictly inside the canonical worktrees root, is not the repository
   *     and does not hold it, and has no `.git` folder of its own;
   *   - git positively confirms it is no longer a worktree: the repository's
   *     list reads, names the repository itself, and names nothing that is
   *     this folder (compared by file identity, not by spelling);
   *   - what is left matches the commit recorded when it was found clean:
   *     a status against that commit (a temporary index, so the deleted
   *     worktree's own index is not needed) shows nothing but files git
   *     already deleted, so nothing uncommitted is in it;
   *   - it is deleted by removeTreeNoFollow from the trusted root, which
   *     never follows a link and checks each folder is where it was.
   */
  private async removeDeregisteredLeftover(rec: PendingWorktreeRemoval, opts: { checkOnly?: boolean } = {}): Promise<LeftoverResult> {
    let real: string;
    let rootReal: string;
    let repoReal: string;
    try {
      real = fs.realpathSync.native(rec.path);
      rootReal = fs.realpathSync.native(this.worktreesRoot);
      repoReal = fs.realpathSync.native(rec.repoRoot);
    } catch (err) {
      return { ok: false, error: `the leftover folder was kept: a path could not be resolved (${(err as Error).message})` };
    }
    if (!strictlyInside(real, rootReal)) return { ok: false, error: 'the leftover folder was kept: it is not inside the wmux worktrees folder' };
    if (sameCanonical(real, repoReal) || strictlyInside(repoReal, real) || strictlyInside(real, repoReal)) {
      return { ok: false, error: 'the leftover folder was kept: it is, or holds, or sits in the repository' };
    }
    const gitEntry = leftoverGitEntry(real);
    if (gitEntry !== null) return { ok: false, error: `the leftover folder was kept: ${gitEntry}` };

    const registered = await this.listsWorktree(rec.repoRoot, repoReal, real);
    if (registered === null) return { ok: false, error: 'the leftover folder was kept: git did not confirm it is no longer a worktree' };
    if (registered) return { ok: false, registered: true, error: 'the folder is still a worktree' };

    if (!rec.head) return { ok: false, error: 'the leftover folder was kept: no clean commit was recorded to compare it with' };
    const changed = await this.leftoverChanges(rec.repoRoot, real, rec.head);
    if (typeof changed !== 'number') return { ok: false, error: `the leftover folder was kept: its contents could not be compared with ${rec.head}: ${changed.error}` };
    if (changed > 0) return { ok: false, dirty: true, error: `the leftover folder was kept: ${changed} file(s) in it are not what git left` };
    if (opts.checkOnly) return { ok: true };

    try {
      await this.removeTree(real, rootReal);
    } catch (err) {
      return { ok: false, error: `the leftover folder could not be deleted: ${(err as Error).message}` };
    }
    try {
      await this.runGit(['worktree', 'prune'], rec.repoRoot);
    } catch {
      /* the record is gone already; prune only tidies */
    }
    return { ok: true };
  }

  /** Whether git lists `folder` as a worktree of the repository, compared by
   *  file identity (device and file id) and canonical path. Null when the
   *  list cannot be read, or does not name the repository itself (an answer
   *  that cannot be trusted), or an entry cannot be compared. */
  private async listsWorktree(repoRoot: string, repoReal: string, folder: string): Promise<boolean | null> {
    let out: string;
    try {
      out = (await this.runGit(['worktree', 'list', '--porcelain'], repoRoot)).stdout;
    } catch {
      return null;
    }
    let mine: fs.BigIntStats;
    let repo: fs.BigIntStats;
    try {
      mine = fs.statSync(folder, { bigint: true });
      repo = fs.statSync(repoReal, { bigint: true });
    } catch {
      return null;
    }
    const same = (a: fs.BigIntStats, b: fs.BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;
    let namesRepo = false;
    for (const line of out.split(/\r?\n/)) {
      if (!line.startsWith('worktree ')) continue;
      const listed = line.slice('worktree '.length);
      let st: fs.BigIntStats;
      let listedReal: string;
      try {
        st = fs.statSync(listed, { bigint: true });
        listedReal = fs.realpathSync.native(listed);
      } catch (err) {
        // A listed folder that is gone is not this one, which exists.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
        return null;
      }
      if (same(st, mine) || sameCanonical(listedReal, folder)) return true;
      if (same(st, repo) || sameCanonical(listedReal, repoReal)) namesRepo = true;
    }
    return namesRepo ? false : null;
  }

  /** How many entries of `folder` differ from `head` other than files that
   *  are missing (git deleted them), through a temporary index seeded from
   *  `head`: the files compared with that index (not with the repository's
   *  own HEAD, which the task's commits are not on), and untracked files
   *  listed; ignored files do not count, as in `git status`. An error when
   *  git cannot say. */
  private async leftoverChanges(repoRoot: string, folder: string, head: string): Promise<number | { error: string }> {
    let tmp: string | null = null;
    try {
      const { stdout } = await this.runGit(['rev-parse', '--git-common-dir'], repoRoot);
      const commonDir = path.resolve(repoRoot, stdout.trim());
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-leftover-'));
      const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
      const base = ['-c', 'core.fsmonitor=false', `--git-dir=${commonDir}`, `--work-tree=${folder}`];
      await this.runGit([...base, 'read-tree', head], folder, { env });
      // read-tree leaves no file stats in the index: refresh hashes each file
      // once, so an unchanged one compares equal. It exits non-zero when some
      // file differs, which the comparison below reports.
      await this.runGit([...base, 'update-index', '-q', '--refresh'], folder, { env }).catch(() => undefined);
      // An ignore file git already deleted still decides what counts as
      // untracked: marked skip-worktree, git reads it from the index.
      const ignoreFiles = (await this.runGit([...base, 'ls-files', '-z'], folder, { env })).stdout.split('\0')
        .filter((f) => (f === '.gitignore' || f.endsWith('/.gitignore')) && !fs.existsSync(path.join(folder, f)));
      if (ignoreFiles.length > 0) await this.runGit([...base, 'update-index', '--skip-worktree', '--', ...ignoreFiles], folder, { env });
      const changed = await this.runGit([...base, 'diff-files', '--name-status', '--ignore-submodules=none'], folder, { env });
      const untracked = await this.runGit([...base, 'ls-files', '--others', '--exclude-standard'], folder, { env });
      const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.length > 0);
      return lines(changed.stdout).filter((l) => !l.startsWith('D\t')).length + lines(untracked.stdout).length;
    } catch (err) {
      return { error: (err as Error).message };
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** The commit a worktree has checked out, or undefined when it cannot be read. */
  private async headOf(worktreePath: string): Promise<string | undefined> {
    try {
      const head = (await this.runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], worktreePath)).stdout.trim().toLowerCase();
      return /^[0-9a-f]{40,64}$/.test(head) ? head : undefined;
    } catch {
      return undefined;
    }
  }

  private async rememberPending(rec: PendingWorktreeRemoval): Promise<void> {
    try {
      await this.pendingRemovals?.put(rec);
    } catch (err) {
      // Only a leftover's later finish needs it; the removal itself goes on.
      console.warn(`[worktask] the pending removal of ${rec.path} was not recorded: ${(err as Error).message}`);
    }
  }

  private async forgetPending(worktreePath: string): Promise<void> {
    try {
      await this.pendingRemovals?.delete(worktreePath);
    } catch (err) {
      console.warn(`[worktask] the pending removal of ${worktreePath} was not forgotten: ${(err as Error).message}`);
    }
  }

  /**
   * Delete a task branch only while it still points at `expectedOid`, the
   * commit it was created from: `git update-ref -d` compares and deletes in
   * one step, so a branch that gained a commit is kept and nothing committed
   * is ever lost. For a task whose worktree was rolled back (#2349).
   */
  async deleteBranchIfAt(
    repoRoot: string,
    repoHash: string,
    branch: string,
    expectedOid: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.withRepoLock(repoHash, async () => {
      const safeBranch = validateGitRef(branch, 'branch');
      const safeOid = validateGitRef(expectedOid, 'expectedOid');
      try {
        await this.runGit(['update-ref', '-d', `refs/heads/${safeBranch}`, safeOid], repoRoot);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: `deleteBranchIfAt: ${(err as Error).message}` };
      }
    });
  }

  /**
   * Put a removed task worktree back at the same path, on its kept branch
   * (`git worktree add <path> <branch>`: no new branch, no reset), or, for a
   * detached checkout (`detached`: `ref` is a commit), on that commit.
   * Refused when the branch or commit is gone or the path is taken. The same
   * folder is what lets an agent's per-folder conversation resume there.
   */
  async restoreWorktree(repoRoot: string, repoHash: string, worktreePath: string, ref: string, detached = false): Promise<CreateResult> {
    return this.withRepoLock(repoHash, async () => {
      const safeRef = validateGitRef(ref, detached ? 'commit' : 'branch');
      if (detached && !/^[0-9a-f]{40,64}$/.test(safeRef)) return { ok: false, error: 'restoreWorktree: not a commit id' };
      const safePath = validatePath(worktreePath, 'worktreePath');
      if (fs.existsSync(safePath)) return { ok: false, error: 'restoreWorktree: the path is already taken' };
      try {
        await this.runGit(['rev-parse', '--verify', '--quiet', detached ? `${safeRef}^{commit}` : `refs/heads/${safeRef}`], repoRoot);
      } catch {
        return { ok: false, error: `restoreWorktree: ${detached ? 'the commit' : 'the branch'} is gone: ${safeRef}` };
      }
      try {
        // A stale record of the removed folder would make git refuse the path.
        await this.runGit(['worktree', 'prune'], repoRoot);
        await this.runGit(detached ? ['worktree', 'add', '--detach', safePath, safeRef] : ['worktree', 'add', safePath, safeRef], repoRoot);
      } catch (err) {
        return { ok: false, error: `restoreWorktree: git worktree add failed: ${(err as Error).message}` };
      }
      return { ok: true, worktreePath: safePath, branch: detached ? '' : safeRef };
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
