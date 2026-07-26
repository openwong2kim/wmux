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
import { detectRemoteHost, isGithubHost } from '../../github/PrProvider';
import type { PrSummary, PrDetail, PrProvider } from '../../github/PrProvider';
import { ghPrService } from '../../github/GhPrService';
import { glabPrService } from '../../github/GlabPrService';

export type GithubPrListResult =
  | { ok: true; prs: PrSummary[] }
  | {
      ok: false;
      code: 'no-remote' | 'unsupported-host' | 'cli-missing' | 'unauthenticated' | 'error';
      message: string;
    };

export type GithubPrDetailResult =
  | { ok: true; detail: PrDetail }
  | { ok: false; code: 'error'; message: string };

/** hostname → provider. github.com 계열은 gh, 그 외 전부 glab 경로. */
function providerFor(host: string): PrProvider {
  return isGithubHost(host) ? ghPrService : glabPrService;
}

async function prList(repoPath: string, force: boolean): Promise<GithubPrListResult> {
  const host = await detectRemoteHost(repoPath);
  if (!host) return { ok: false, code: 'no-remote', message: 'no origin remote' };
  const provider = providerFor(host);
  const gate = await provider.gate(repoPath, host);
  if (!gate.ok) {
    return {
      ok: false,
      code: gate.reason === 'cli-missing' ? 'cli-missing' : 'unauthenticated',
      message: gate.message,
    };
  }
  const res = await provider.listPrs(repoPath, force);
  if (!res.ok) return { ok: false, code: 'error', message: res.error };
  return { ok: true, prs: res.prs };
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
        const host = await detectRemoteHost(safeRepo);
        if (!host) return { ok: false, code: 'error', message: 'no origin remote' };
        const res = await providerFor(host).prDetail(
          safeRepo,
          number,
          typeof updatedAt === 'string' ? updatedAt : '',
        );
        if (!res.ok) return { ok: false, code: 'error', message: res.error };
        return { ok: true, detail: res.detail };
      },
    ),
  );

  return () => {
    ipcMain.removeHandler(IPC.GITHUB_PR_LIST);
    ipcMain.removeHandler(IPC.GITHUB_PR_DETAIL);
  };
}
