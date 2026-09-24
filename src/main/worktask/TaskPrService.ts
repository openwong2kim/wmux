/**
 * TaskPrService — J3 §2 D2. 태스크 산출물의 1클릭 PR(main측 오케스트레이션).
 *
 * gh 4중 게이트(§2):
 *   ① `gh --version` + `gh auth status` — 버전≠인증(G3). 부재·미인증은 안내 +
 *      브라우저 폴백 사유 반환(예외 없음).
 *   ② dirty 검사 — 미커밋 변경이 있으면 "PR에 포함 안 됨" 차단 + 커밋 안내(CX7).
 *   ③ `git push -u origin {branch}` — execFile argv(셸 조립 금지 계약 G6).
 *   ④ `gh pr create --head {branch} --title --body --base {base}` — --base 명시
 *      (CL4: base 추론 실패 방지. base = repo default via
 *      `gh repo view --json defaultBranchRef`).
 *
 * 멱등 재진입(CX5+G4): pr create 실패 시 `gh pr list --head {branch}` 조회 —
 * 기존 PR 있으면 URL 회수로 성공 수렴. push의 "이미 존재"는 fast-forward면 무해
 * 통과. half-done(push만 성공) 상태는 재클릭이 자연 수렴한다.
 *
 * 성공 시: prUrl을 데몬 task.mission.update로 커밋 + PrStatusCache.invalidate로
 * 5분 TTL 공백 제거(CX8).
 *
 * fork 워크플로(§7·CL9): origin remote 부재는 명시 에러(자동 추측 금지).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WORKTASK_PR_URL_RE } from '../../shared/workTask';

const execFileAsync = promisify(execFile);

const GH_TIMEOUT_MS = 20_000;
const GIT_TIMEOUT_MS = 60_000;

/** gh를 대화형으로 절대 멈추지 않게 하는 환경(로그인 프롬프트·pager 봉쇄). */
const GH_ENV = { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' };

/** 데몬 RPC 최소 표면(prUrl 커밋 — 테스트 주입 가능). */
export interface PrDaemonPort {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** PrStatusCache 무효화 최소 표면(테스트 주입 가능). */
export interface PrCachePort {
  invalidate(cwd: string, branch: string): void;
}

/** exec 최소 표면(테스트 주입). {stdout,stderr} 또는 throw(비0 종료). */
export type PrExec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean },
) => Promise<{ stdout: string; stderr: string }>;

export interface TaskPrServiceOptions {
  daemon: PrDaemonPort;
  cache?: PrCachePort;
  exec?: PrExec;
}

export interface CreatePrInput {
  taskId: string;
  verifiedWorkspaceId: string;
  worktreePath: string;
  branch: string;
  /** PR 제목(태스크 title). */
  title: string;
  /** PR 본문(선택 — 기본 자동 1줄). */
  body?: string;
}

export type CreatePrResult =
  | {
      ok: true;
      prUrl: string;
      /** pr create 실패 후 기존 PR URL을 회수해 수렴함(멱등 재진입). */
      recovered?: boolean;
      /** prUrl 데몬 커밋 실패(비치명 — PR 자체는 성립). */
      commitPending?: boolean;
    }
  | {
      ok: false;
      reason: 'gh-missing' | 'gh-unauth' | 'dirty' | 'no-origin' | 'push-failed' | 'pr-failed' | 'error';
      error: string;
      /** 브라우저 폴백 안내(gh 부재·미인증 시). */
      browseFallback?: string;
    };

export class TaskPrService {
  private readonly daemon: PrDaemonPort;
  private readonly cache: PrCachePort | undefined;
  private readonly exec: PrExec;

  constructor(opts: TaskPrServiceOptions) {
    this.daemon = opts.daemon;
    this.cache = opts.cache;
    this.exec = opts.exec ?? (execFileAsync as unknown as PrExec);
  }

  private gh(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return this.exec(process.platform === 'win32' ? 'gh.exe' : 'gh', args, {
      cwd,
      timeout: GH_TIMEOUT_MS,
      env: GH_ENV,
      windowsHide: true,
    });
  }

  private git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return this.exec('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: process.env,
      windowsHide: true,
    });
  }

  async createPr(input: CreatePrInput): Promise<CreatePrResult> {
    const { taskId, verifiedWorkspaceId, worktreePath, branch, title } = input;
    const body = input.body && input.body.length > 0 ? input.body : `wmux fan-out task: ${title}`;

    // ── ① gh 게이트: 버전 + 인증(G3 — 버전≠인증) ──
    try {
      await this.gh(['--version'], worktreePath);
    } catch {
      return {
        ok: false,
        reason: 'gh-missing',
        error: 'GitHub CLI (gh) is not installed.',
        browseFallback: `브라우저에서 직접 PR을 생성하세요: 브랜치 ${branch}를 push 후 GitHub 비교 화면 이용`,
      };
    }
    try {
      await this.gh(['auth', 'status'], worktreePath);
    } catch {
      return {
        ok: false,
        reason: 'gh-unauth',
        error: 'GitHub CLI is not signed in — run `gh auth login` and try again.',
        browseFallback: `또는 브라우저에서 브랜치 ${branch}로 직접 PR을 생성하세요`,
      };
    }

    // ── ② dirty 검사(CX7): 미커밋 변경은 PR에 안 들어감 → 차단 + 커밋 안내 ──
    try {
      const { stdout } = await this.git(['status', '--porcelain'], worktreePath);
      if (stdout.trim().length > 0) {
        return {
          ok: false,
          reason: 'dirty',
          error: 'The worktree has uncommitted changes — they would not be in the PR. Commit them first.',
        };
      }
    } catch (err) {
      return { ok: false, reason: 'error', error: `git status failed: ${errMsg(err)}` };
    }

    // origin remote 존재 검증(fork·다중 remote 자동 추측 금지 — §7·CL9).
    try {
      const { stdout } = await this.git(['remote'], worktreePath);
      const remotes = stdout.split('\n').map((r) => r.trim()).filter(Boolean);
      if (!remotes.includes('origin')) {
        return {
          ok: false,
          reason: 'no-origin',
          error: `No origin remote (remotes: ${remotes.join(', ') || 'none'}) — the PR head is not guessed. Set up origin.`,
        };
      }
    } catch (err) {
      return { ok: false, reason: 'error', error: `git remote failed: ${errMsg(err)}` };
    }

    // ── ③ push -u origin -- {branch}(execFile argv + `--` 세퍼레이터 — F6: 브랜치명이
    // 옵션으로 오인되는 표면 차단). 이미 존재(fast-forward)면 무해 통과.
    try {
      await this.git(['push', '-u', 'origin', '--', branch], worktreePath);
    } catch (err) {
      return { ok: false, reason: 'push-failed', error: `git push failed: ${errMsg(err)}` };
    }

    // base = repo default(CL4·[J2대조]4 — fan-out 원본 브랜치 미기록이라 default 조회).
    // F6: 조회 실패·빈 값이면 'main' 추측 대신 명시 에러(엉뚱한 base로 PR 여는 것 방지).
    let base: string;
    try {
      const { stdout } = await this.gh(
        ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
        worktreePath,
      );
      base = stdout.trim();
    } catch (err) {
      return { ok: false, reason: 'pr-failed', error: `Could not determine the base branch (repo default): ${errMsg(err)}` };
    }
    if (!base) {
      return { ok: false, reason: 'pr-failed', error: 'Could not determine the base branch (empty response) — origin has no defaultBranchRef.' };
    }

    // ── ④ gh pr create --head --title --body --base ──
    let prUrl = '';
    try {
      const { stdout } = await this.gh(
        ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body', body],
        worktreePath,
      );
      prUrl = extractPrUrl(stdout);
    } catch (createErr) {
      // 멱등 재진입(CX5+G4): 기존 PR을 조회해 URL 회수로 수렴.
      const recovered = await this.recoverExistingPr(worktreePath, branch);
      if (recovered) {
        return this.finalize(taskId, verifiedWorkspaceId, worktreePath, branch, recovered, true);
      }
      return { ok: false, reason: 'pr-failed', error: `gh pr create failed: ${errMsg(createErr)}` };
    }

    if (!prUrl || !WORKTASK_PR_URL_RE.test(prUrl)) {
      // 출력 파싱 실패 — 재진입 조회로 URL 회수 시도.
      const recovered = await this.recoverExistingPr(worktreePath, branch);
      if (recovered) {
        return this.finalize(taskId, verifiedWorkspaceId, worktreePath, branch, recovered, true);
      }
      return {
        ok: false,
        reason: 'pr-failed',
        error: `The PR was created but its URL could not be parsed: ${prUrl || '(empty output)'}`,
      };
    }

    return this.finalize(taskId, verifiedWorkspaceId, worktreePath, branch, prUrl, false);
  }

  /** 기존 PR URL 조회(멱등 재진입). 없으면 null. */
  private async recoverExistingPr(worktreePath: string, branch: string): Promise<string | null> {
    try {
      const { stdout } = await this.gh(
        ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'url', '--jq', '.[0].url'],
        worktreePath,
      );
      const url = stdout.trim();
      return url.length > 0 && WORKTASK_PR_URL_RE.test(url) ? url : null;
    } catch {
      return null;
    }
  }

  /** prUrl 커밋(데몬) + PrStatusCache invalidate. 커밋 실패는 비치명(commitPending). */
  private async finalize(
    taskId: string,
    verifiedWorkspaceId: string,
    worktreePath: string,
    branch: string,
    prUrl: string,
    recovered: boolean,
  ): Promise<CreatePrResult> {
    let commitPending = false;
    try {
      const res = (await this.daemon.rpc('task.mission.update', {
        taskId,
        verifiedWorkspaceId,
        prUrl,
      })) as { ok?: boolean };
      if (!res || res.ok !== true) commitPending = true;
    } catch {
      commitPending = true;
    }
    // CX8: PR 생성 성공 → 5분 TTL 캐시 무효화(다음 폴이 새 PR 상태를 즉시 반영).
    try {
      this.cache?.invalidate(worktreePath, branch);
    } catch {
      /* 캐시 무효화 실패는 무해 — 다음 TTL 만료가 수렴 */
    }
    return {
      ok: true,
      prUrl,
      ...(recovered ? { recovered: true } : {}),
      ...(commitPending ? { commitPending: true } : {}),
    };
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    const withStderr = err as Error & { stderr?: string };
    const stderr = typeof withStderr.stderr === 'string' ? withStderr.stderr.trim() : '';
    return stderr.length > 0 ? stderr.slice(0, 300) : err.message;
  }
  return String(err);
}

/** gh pr create stdout에서 PR URL 추출(마지막 github pull URL 라인). */
function extractPrUrl(stdout: string): string {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
    if (m) return m[0];
  }
  return '';
}
