// "Star on GitHub" (sidebar foot row and Settings › About).
//
// The one-click star goes through the user's own gh, the same CLI and sign-in
// the Git page uses; wmux never sees a token and adds no sign-in flow of its
// own. Without a signed-in gh, or when the call fails, the repository page
// opens in the browser instead. Nothing here reports anything anywhere: the
// only network traffic is the user's own gh call to GitHub.
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { shell } from 'electron';
import {
  STAR_REPO,
  STAR_REPO_URL,
  starPutSucceeded,
  starredCheckFromGh,
  type GhApiOutcome,
  type StarActionResult,
  type StarredCheck,
} from '../../shared/starPrompt';
import { ghIssueEnv } from './GhIssueService';
import { ghPrService } from './GhPrService';

/** Short on purpose: this is a nicety and must never hold anything up. */
export const STAR_GH_TIMEOUT_MS = 8_000;
const STARRED_PATH = `/user/starred/${STAR_REPO}`;

export interface StarRepoDeps {
  /** True when gh is installed and signed in to github.com (the Git page's gate). */
  ghReady: () => Promise<boolean>;
  /** Runs `gh <args>`; resolves with what gh printed, never rejects. */
  gh: (args: string[]) => Promise<GhApiOutcome>;
  openExternal: (url: string) => Promise<void>;
}

const execFileAsync = promisify(execFile);

async function runGh(args: string[]): Promise<GhApiOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync(process.platform === 'win32' ? 'gh.exe' : 'gh', args, {
      cwd: os.homedir(),
      env: ghIssueEnv(),
      timeout: STAR_GH_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown };
    return { ok: false, stdout: e?.stdout == null ? '' : String(e.stdout), stderr: e?.stderr == null ? '' : String(e.stderr) };
  }
}

const defaultDeps: StarRepoDeps = {
  ghReady: () => ghPrService.gate(os.homedir(), 'github.com').then((g) => g.ok, () => false),
  gh: runGh,
  openExternal: (url) => shell.openExternal(url),
};

/**
 * Whether the gh account already starred wmux. Asked only when the sidebar's
 * star row is about to show for the first time in an app session; without a
 * signed-in gh it makes no call at all and answers `unknown`.
 */
export async function checkStarred(deps: StarRepoDeps = defaultDeps): Promise<StarredCheck> {
  if (!(await deps.ghReady().catch(() => false))) return 'unknown';
  return starredCheckFromGh(await deps.gh(['api', '--include', STARRED_PATH]));
}

/** Star with gh when it is signed in; otherwise (or when that fails) open the repository page. */
export async function starRepo(deps: StarRepoDeps = defaultDeps): Promise<StarActionResult> {
  if (await deps.ghReady().catch(() => false)) {
    const put = await deps.gh(['api', '--include', '--method', 'PUT', STARRED_PATH]);
    if (starPutSucceeded(put)) return 'starred';
  }
  try {
    await deps.openExternal(STAR_REPO_URL);
    return 'opened';
  } catch {
    return 'failed';
  }
}
