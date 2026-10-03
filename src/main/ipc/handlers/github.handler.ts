// Git 탭 PR 섹션 — github:prList / github:prDetail main 핸들러.
//
// 렌더러 전용 IPC(파이프 미노출). 흐름: origin hostname 감지 → github.com
// 계열이면 gh(GhPrService), 그 외 모든 호스트는 glab(GlabPrService — self-
// hosted GitLab 포함, 게이트가 그 호스트 인증을 검사). 모든 실패는 code를
// 담아 fail-soft로 강등 — 렌더러가 게이트 안내문/빈 상태로 렌더한다.
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { resolveAccessiblePath } from './fs.handler';
import { detectRemote, isGithubHost } from '../../github/PrProvider';
import type { PrSummary, PrDetail, PrProvider } from '../../github/PrProvider';
import { ghPrService } from '../../github/GhPrService';
import { glabPrService } from '../../github/GlabPrService';
import { ghIssueService } from '../../github/GhIssueService';
import { parseIssueFilter, type IssueDetailResult, type IssueFilter, type IssueListResult, type IssueRepo } from '../../../shared/issueSurface';

export type GithubPrListResult =
  | { ok: true; prs: PrSummary[] }
  | {
      ok: false;
      code: 'no-remote' | 'unsupported-host' | 'cli-missing' | 'unauthenticated' | 'error';
      message: string;
      /** Which CLI the gate is about, so the page offers the right sign-in. */
      provider?: 'github' | 'gitlab';
    };

export type GithubPrDetailResult =
  | { ok: true; detail: PrDetail }
  | { ok: false; code: 'error'; message: string };

/** hostname → provider. github.com 계열은 gh, 그 외 전부 glab 경로. */
function providerFor(host: string): PrProvider {
  return isGithubHost(host) ? ghPrService : glabPrService;
}

async function prList(repoPath: string, force: boolean): Promise<GithubPrListResult> {
  const remote = await detectRemote(repoPath, force);
  if (!remote) return { ok: false, code: 'no-remote', message: 'no origin remote' };
  const { host } = remote;
  const provider = providerFor(host);
  const gate = await provider.gate(repoPath, host, force);
  if (!gate.ok) {
    return {
      ok: false,
      code: gate.reason === 'cli-missing' ? 'cli-missing' : 'unauthenticated',
      message: gate.message,
      provider: isGithubHost(host) ? 'github' : 'gitlab',
    };
  }
  // Keyed by the remote, so two clones of one repo share one fetch and cache.
  const res = await provider.listPrs(repoPath, force, remote.key ?? undefined);
  if (!res.ok) return { ok: false, code: 'error', message: res.error };
  return { ok: true, prs: res.prs };
}

/** owner/repo as the remote key spells it (lowercased; the page reads the
 *  case-kept form from each issue's URL). */
function repoOfKey(key: string | null): IssueRepo | null {
  const parts = key?.split('/') ?? [];
  return parts.length === 3 ? { host: parts[0], owner: parts[1], repo: parts[2] } : null;
}

async function issueList(repoPath: string, filter: IssueFilter, force: boolean): Promise<IssueListResult> {
  const remote = await detectRemote(repoPath, force);
  if (!remote) return { ok: false, code: 'no-remote', message: 'no origin remote' };
  // GitLab and every other host: no glab issue reader yet, and no gate probe.
  if (!isGithubHost(remote.host)) {
    return { ok: false, code: 'unsupported-host', message: 'Issues are GitHub-only for now', provider: 'gitlab' };
  }
  const gate = await ghPrService.gate(repoPath, remote.host, force);
  if (!gate.ok) {
    return { ok: false, code: gate.reason === 'cli-missing' ? 'cli-missing' : 'unauthenticated', message: gate.message, provider: 'github' };
  }
  const key = remote.key ?? repoPath;
  const res = await ghIssueService.listIssues(repoPath, filter, key, force);
  if (res.ok) return { ok: true, issues: res.issues, repo: repoOfKey(remote.key) };
  return res;
}

export function registerGithubHandlers(): () => void {
  ipcMain.removeHandler(IPC.GITHUB_PR_LIST);
  ipcMain.handle(
    IPC.GITHUB_PR_LIST,
    wrapHandler(IPC.GITHUB_PR_LIST, async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown, force: unknown) => {
      if (typeof repoPath !== 'string' || !repoPath) {
        return { ok: false, code: 'error', message: 'repoPath required' } satisfies GithubPrListResult;
      }
      // F2 (#615): confine the renderer path before it reaches `gh -C` / cwd.
      const safeRepo = await resolveAccessiblePath(repoPath);
      if (!safeRepo) {
        return { ok: false, code: 'error', message: 'repoPath required' } satisfies GithubPrListResult;
      }
      return prList(safeRepo, force === true);
    }),
  );

  ipcMain.removeHandler(IPC.GITHUB_PR_DETAIL);
  ipcMain.handle(
    IPC.GITHUB_PR_DETAIL,
    wrapHandler(
      IPC.GITHUB_PR_DETAIL,
      async (
        _e: Electron.IpcMainInvokeEvent,
        repoPath: unknown,
        number: unknown,
        updatedAt: unknown,
      ): Promise<GithubPrDetailResult> => {
        if (typeof repoPath !== 'string' || !repoPath) {
          return { ok: false, code: 'error', message: 'repoPath required' };
        }
        if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
          return { ok: false, code: 'error', message: 'valid PR number required' };
        }
        // F2 (#615): confine the renderer path before it reaches `gh -C` / cwd.
        const safeRepo = await resolveAccessiblePath(repoPath);
        if (!safeRepo) return { ok: false, code: 'error', message: 'repoPath required' };
        // 목록과 동일한 provider로 라우팅(호스트 재감지 — 상세는 저빈도라 무해).
        const remote = await detectRemote(safeRepo);
        if (!remote) return { ok: false, code: 'error', message: 'no origin remote' };
        const res = await providerFor(remote.host).prDetail(
          safeRepo,
          number,
          typeof updatedAt === 'string' ? updatedAt : '',
          remote.key ?? undefined,
        );
        if (!res.ok) return { ok: false, code: 'error', message: res.error };
        return { ok: true, detail: res.detail };
      },
    ),
  );

  ipcMain.removeHandler(IPC.GITHUB_ISSUE_LIST);
  ipcMain.handle(
    IPC.GITHUB_ISSUE_LIST,
    wrapHandler(
      IPC.GITHUB_ISSUE_LIST,
      async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown, filter: unknown, force: unknown): Promise<IssueListResult> => {
        if (typeof repoPath !== 'string' || !repoPath) return { ok: false, code: 'error', message: 'repoPath required' };
        const parsed = parseIssueFilter(filter);
        if (!parsed) return { ok: false, code: 'error', message: 'invalid filter' };
        // F2 (#615): confine the renderer path before it reaches gh's cwd.
        const safeRepo = await resolveAccessiblePath(repoPath);
        if (!safeRepo) return { ok: false, code: 'error', message: 'repoPath required' };
        return issueList(safeRepo, parsed, force === true);
      },
    ),
  );

  ipcMain.removeHandler(IPC.GITHUB_ISSUE_DETAIL);
  ipcMain.handle(
    IPC.GITHUB_ISSUE_DETAIL,
    wrapHandler(
      IPC.GITHUB_ISSUE_DETAIL,
      async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown, number: unknown, updatedAt: unknown): Promise<IssueDetailResult> => {
        if (typeof repoPath !== 'string' || !repoPath) return { ok: false, code: 'error', message: 'repoPath required' };
        if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
          return { ok: false, code: 'error', message: 'valid issue number required' };
        }
        const safeRepo = await resolveAccessiblePath(repoPath);
        if (!safeRepo) return { ok: false, code: 'error', message: 'repoPath required' };
        const remote = await detectRemote(safeRepo);
        if (!remote || !isGithubHost(remote.host)) return { ok: false, code: 'error', message: 'Issues are GitHub-only for now' };
        return ghIssueService.issueDetail(safeRepo, number, typeof updatedAt === 'string' ? updatedAt : '', remote.key ?? safeRepo);
      },
    ),
  );

  // The repo's remote identity, so the Git page can put clones of one repo
  // in one group. No CLI involved: one `git remote get-url`, cached.
  ipcMain.removeHandler(IPC.GITHUB_REPO_KEY);
  ipcMain.handle(
    IPC.GITHUB_REPO_KEY,
    wrapHandler(IPC.GITHUB_REPO_KEY, async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown): Promise<{ key: string | null }> => {
      if (typeof repoPath !== 'string' || !repoPath) return { key: null };
      const safeRepo = await resolveAccessiblePath(repoPath);
      if (!safeRepo) return { key: null };
      return { key: (await detectRemote(safeRepo))?.key ?? null };
    }),
  );

  return () => {
    ipcMain.removeHandler(IPC.GITHUB_PR_LIST);
    ipcMain.removeHandler(IPC.GITHUB_PR_DETAIL);
    ipcMain.removeHandler(IPC.GITHUB_REPO_KEY);
    ipcMain.removeHandler(IPC.GITHUB_ISSUE_LIST);
    ipcMain.removeHandler(IPC.GITHUB_ISSUE_DETAIL);
  };
}
