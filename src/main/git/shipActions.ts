// The Git page's ship button, main side: the current branch's status (one
// `git status --porcelain=v2 --branch`, the default branch, the last commit
// subject, and the branch's PR from the shared PR cache) and the three writes
// it can start — commit everything, push to the upstream, create a PR.
// Every command is argv (never a shell); a push never prompts.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getExecEnv } from '../../shared/execEnv';
import { ghIssueEnv } from '../github/GhIssueService';
import { prStatusCache } from '../metadata/PrStatusCache';
import type { PrStatus } from '../../shared/types';

const execFileAsync = promisify(execFile);

export interface ShipStatus {
  /** null when detached. */
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Changed, staged or untracked files. */
  dirty: number;
  /** The remote's default branch (origin/HEAD), null when unknown. */
  defaultBranch: string | null;
  /** The last commit's subject, the Create PR title's starting point. */
  headSubject: string;
  pr: { state: PrStatus['state']; url: string } | null;
}

export type ShipStatusResult = { ok: true; status: ShipStatus } | { ok: false; error: string };
export type ShipActionResult = { ok: true; url?: string } | { ok: false; error: string };

/** Longest commit message / PR title accepted. */
export const SHIP_TEXT_MAX = 10_000;

/** branch / upstream / ahead-behind / dirty count from `git status --porcelain=v2 --branch`. Pure. */
export function parseStatusV2(raw: string): Pick<ShipStatus, 'branch' | 'detached' | 'upstream' | 'ahead' | 'behind' | 'dirty'> {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let dirty = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      branch = head === '(detached)' ? null : head;
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim() || null;
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (/^[12u?] /.test(line)) {
      dirty++;
    }
  }
  return { branch, detached: branch === null, upstream, ahead, behind, dirty };
}

type Run = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) => Promise<{ stdout: string }>;

const defaultRun: Run = (cmd, args, opts) =>
  execFileAsync(cmd, args, { ...opts, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });

function failure(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr || e?.message || String(err)).trim().slice(0, 500);
}

export class ShipActions {
  constructor(
    private run: Run = defaultRun,
    private prOf: (cwd: string, branch: string) => Promise<PrStatus | null> = (cwd, branch) => prStatusCache.get(cwd, branch),
    private forgetPr: (cwd: string, branch: string) => void = (cwd, branch) => prStatusCache.invalidate(cwd, branch),
  ) {}

  private git(args: string[], cwd: string, timeout = 30_000, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ stdout: string }> {
    return this.run('git', args, { cwd, env: { ...getExecEnv(), ...extraEnv }, timeout });
  }

  async status(cwd: string): Promise<ShipStatusResult> {
    let parsed: ReturnType<typeof parseStatusV2>;
    try {
      parsed = parseStatusV2((await this.git(['status', '--porcelain=v2', '--branch'], cwd)).stdout);
    } catch (err) {
      return { ok: false, error: failure(err) };
    }
    const [defaultBranch, headSubject, pr] = await Promise.all([
      this.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd)
        .then(({ stdout }) => stdout.trim().replace(/^origin\//, '') || null)
        .catch(() => null),
      this.git(['log', '-1', '--format=%s'], cwd).then(({ stdout }) => stdout.trim()).catch(() => ''),
      parsed.branch ? this.prOf(cwd, parsed.branch).catch(() => null) : Promise.resolve(null),
    ]);
    return {
      ok: true,
      status: { ...parsed, defaultBranch, headSubject, pr: pr ? { state: pr.state, url: pr.url } : null },
    };
  }

  /** Stage every change (tracked and untracked) and commit it. */
  async commit(cwd: string, message: string): Promise<ShipActionResult> {
    const msg = message.trim();
    if (!msg) return { ok: false, error: 'a commit message is required' };
    if (msg.length > SHIP_TEXT_MAX) return { ok: false, error: 'the commit message is too long' };
    try {
      await this.git(['add', '-A'], cwd);
      await this.git(['commit', '-m', msg], cwd, 60_000);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: failure(err) };
    }
  }

  /** Push to the branch's existing upstream; never prompts for credentials. */
  async push(cwd: string): Promise<ShipActionResult> {
    try {
      await this.git(['push'], cwd, 120_000, { GIT_TERMINAL_PROMPT: '0' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: failure(err) };
    }
  }

  /** `gh pr create --fill` with the given title; answers the new PR's URL. */
  async createPr(cwd: string, branch: string, title: string): Promise<ShipActionResult> {
    const t = title.trim();
    if (!t) return { ok: false, error: 'a title is required' };
    if (t.length > SHIP_TEXT_MAX) return { ok: false, error: 'the title is too long' };
    try {
      const { stdout } = await this.run(process.platform === 'win32' ? 'gh.exe' : 'gh', ['pr', 'create', '--fill', '--title', t], {
        cwd,
        env: ghIssueEnv(),
        timeout: 60_000,
      });
      this.forgetPr(cwd, branch);
      const url = stdout.split('\n').map((l) => l.trim()).find((l) => /^https:\/\//.test(l));
      return { ok: true, ...(url ? { url } : {}) };
    } catch (err) {
      return { ok: false, error: failure(err) };
    }
  }
}

export const shipActions = new ShipActions();
