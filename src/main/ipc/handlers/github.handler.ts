// Git tab PR section — github:prList / github:prDetail main handlers.
//
// Renderer-only IPC (not exposed on pipe). Flow: detect origin hostname → github.com
// family uses gh (GhPrService), all other hosts use glab (GlabPrService — self-hosted
// GitLab included; gate checks auth for that host). All failures degrade fail-soft with
// code — renderer shows gate guidance or empty state.
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
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

/** hostname → provider. github.com family → gh; everything else → glab. */
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
      return prList(repoPath, force === true);
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
        // Route with the same provider as list (re-detect host — detail is low frequency).
        const host = await detectRemoteHost(repoPath);
        if (!host) return { ok: false, code: 'error', message: 'no origin remote' };
        const res = await providerFor(host).prDetail(
          repoPath,
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
