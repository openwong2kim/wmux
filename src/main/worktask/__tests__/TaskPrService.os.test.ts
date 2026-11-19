// ─── TaskPrService — J3 §2 gh 4중 게이트 1클릭 PR ────────────────────────────

import { afterEach, describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskPrService, type PrExec, type CreatePrInput } from '../TaskPrService';
import { execWithInput } from '../../github/execWithInput';
import { spawnGitLines, type GitLines } from '../../git/secretScan';
import { GlabPrService } from '../../github/GlabPrService';
import type { ForgeHosts } from '../../../shared/forgeHosts';

// The hosts gh and glab are set up for (shared/forgeHosts.ts): none unless a
// test sets them, so the name rule routes as before.
const forge = vi.hoisted(() => ({ hosts: { gh: new Set<string>(), glab: new Map() } as ForgeHosts }));
vi.mock('../../../shared/forgeHosts', async (orig) => ({
  ...(await orig<typeof import('../../../shared/forgeHosts')>()),
  forgeHosts: () => forge.hosts,
}));
afterEach(() => {
  forge.hosts = { gh: new Set(), glab: new Map() };
});

const VALID_PR = 'https://github.com/acme/widget/pull/42';

const INPUT: CreatePrInput = {
  taskId: 'wtask-1',
  verifiedWorkspaceId: 'ws-owner',
  worktreePath: '/wt/task-1',
  branch: 'wtask/task-1-abcd1234',
  title: 'Fix the thing',
};

/** exec 스텁: (cmd,args) 시그니처별로 stdout 반환 또는 throw. 호출 로그 노출. */
function makeExec(
  behavior: (cmd: string, args: string[]) => { stdout: string } | { throw: string },
): { exec: PrExec; calls: Array<{ cmd: string; args: string[]; input?: string }> } {
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
  const exec: PrExec = async (cmd, args, opts) => {
    calls.push({ cmd, args, input: opts.input });
    const r = behavior(cmd, args);
    if ('throw' in r) {
      // As execFile rejects: the message holds the command line, stderr is
      // the tool's own output (the sign-out rule reads stderr only).
      const err = new Error(`Command failed: ${cmd} ${args.join(' ')}`) as Error & { stderr?: string };
      err.stderr = r.throw;
      throw err;
    }
    return { stdout: r.stdout, stderr: '' };
  };
  return { exec, calls };
}

/** The commit the task branch names (the fake git's rev-parse). */
const BRANCH_SHA = 'c0ffee'.padEnd(40, '0');
/** The push of that commit to the task branch. */
const PINNED_PUSH = ['push', 'origin', '--', `${BRANCH_SHA}:refs/heads/${INPUT.branch}`];

function isGh(cmd: string): boolean {
  return cmd === 'gh' || cmd === 'gh.exe';
}
function argStr(args: string[]): string {
  return args.join(' ');
}

/** 정상 경로 기본 동작(테스트가 개별 스텁으로 override). */
function happyBehavior(cmd: string, args: string[]): { stdout: string } | { throw: string } {
  const a = argStr(args);
  if (isGh(cmd)) {
    if (a.startsWith('--version')) return { stdout: 'gh version 2.0.0' };
    if (a.startsWith('auth status')) return { stdout: 'Logged in' };
    if (a.startsWith('repo view')) return { stdout: 'main' };
    if (a.startsWith('pr create')) return { stdout: `Creating pull request\n${VALID_PR}` };
    if (a.startsWith('pr list')) return { stdout: VALID_PR };
  }
  if (cmd === 'git') {
    if (args[0] === 'check-ref-format') return { stdout: `${args[2]}\n` };
    if (args[0] === 'rev-parse') return { stdout: `${BRANCH_SHA}\n` };
    if (a === 'status --porcelain') return { stdout: '' }; // clean
    if (a === 'remote get-url --push origin') return { stdout: 'https://github.com/acme/widget.git\n' };
    if (a === 'remote') return { stdout: 'origin' };
    if (a.startsWith('push')) return { stdout: '' };
  }
  return { stdout: '' };
}

/** The pre-push secret check's git: no commits to read (a clean change). */
const cleanScan = (): GitLines => async () => true;

function makeService(exec: PrExec, opts?: { daemonOk?: boolean; scanGit?: (cwd: string) => GitLines }) {
  const daemonCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const daemon = {
    rpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
      daemonCalls.push({ method, params });
      return { ok: opts?.daemonOk ?? true };
    }),
  };
  const invalidate = vi.fn();
  const svc = new TaskPrService({ daemon, cache: { invalidate }, exec, scanGit: opts?.scanGit ?? cleanScan });
  return { svc, daemon, daemonCalls, invalidate };
}

describe('J3 §2 gh 게이트(버전·인증)', () => {
  it('gh 미설치: gh-missing + 브라우저 폴백', async () => {
    const { exec } = makeExec((cmd, args) =>
      isGh(cmd) && argStr(args).startsWith('--version') ? { throw: 'not found' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('gh-missing');
    expect(res.browseFallback).toBeTruthy();
  });

  it('gh 미인증(버전은 있음): gh-unauth', async () => {
    const { exec } = makeExec((cmd, args) =>
      isGh(cmd) && argStr(args).startsWith('auth status') ? { throw: 'not logged in' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('gh-unauth');
  });
});

describe('J3 §2 dirty 차단(CX7)', () => {
  it('미커밋 변경이 있으면 push 전에 dirty로 차단', async () => {
    const { exec, calls } = makeExec((cmd, args) =>
      cmd === 'git' && argStr(args).startsWith('status') ? { stdout: ' M file.ts\n' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('dirty');
    // push가 실행되지 않았어야 한다(차단 후 중단).
    expect(calls.find((c) => c.cmd === 'git' && c.args[0] === 'push')).toBeUndefined();
  });
});

describe('J3 §2 no-origin(fork·다중 remote 자동 추측 금지 §7·CL9)', () => {
  it('origin remote 부재는 명시 에러', async () => {
    const { exec } = makeExec((cmd, args) => {
      const a = argStr(args);
      if (cmd === 'git' && a === 'remote get-url --push origin') return { throw: "error: No such remote 'origin'" };
      if (cmd === 'git' && a === 'remote') return { stdout: 'upstream\nfork' };
      return happyBehavior(cmd, args);
    });
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('no-origin');
  });
});

describe('J3 §2 정상 1클릭 PR', () => {
  it('push + pr create(--base 명시) + prUrl 커밋 + invalidate', async () => {
    const { exec, calls } = makeExec(happyBehavior);
    const { svc, daemonCalls, invalidate } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.prUrl).toBe(VALID_PR);

    // The branch's commit, pushed after the `--` separator (F6), and the
    // upstream `push -u` would have set.
    const push = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
    expect(push?.args).toEqual(PINNED_PUSH);
    expect(calls.filter((c) => c.cmd === 'git' && c.args[0] === 'config').map((c) => c.args)).toEqual([
      ['config', `branch.${INPUT.branch}.remote`, 'origin'],
      ['config', `branch.${INPUT.branch}.merge`, `refs/heads/${INPUT.branch}`],
    ]);

    // pr create에 --base가 실 값(main)으로 실렸는지.
    const create = calls.find((c) => isGh(c.cmd) && c.args[0] === 'pr' && c.args[1] === 'create');
    expect(create?.args).toContain('--base');
    const baseIdx = create!.args.indexOf('--base');
    expect(create!.args[baseIdx + 1]).toBe('main');
    // --head도 브랜치로 명시.
    expect(create!.args).toContain('--head');
    // A github.com origin's gh calls are not pinned (unchanged).
    expect(calls.some((c) => isGh(c.cmd) && c.args.includes('-R'))).toBe(false);

    // prUrl 데몬 커밋 + PrStatusCache invalidate.
    const upd = daemonCalls.find((c) => c.method === 'task.mission.update');
    expect(upd?.params.prUrl).toBe(VALID_PR);
    expect(invalidate).toHaveBeenCalledWith(INPUT.worktreePath, INPUT.branch);
  });

  it('F6 — repo view 실패면 base 추측 없이 명시 에러(pr create 안 함)', async () => {
    const { exec, calls } = makeExec((cmd, args) =>
      isGh(cmd) && argStr(args).startsWith('repo view') ? { throw: 'no default' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('pr-failed');
    expect(res.error).toContain('base');
    // base 미상이면 pr create를 시도하지 않는다(엉뚱한 base 방지).
    expect(calls.find((c) => isGh(c.cmd) && c.args[0] === 'pr' && c.args[1] === 'create')).toBeUndefined();
  });

  it('F6 — defaultBranchRef 빈 응답도 명시 에러', async () => {
    const { exec } = makeExec((cmd, args) =>
      isGh(cmd) && argStr(args).startsWith('repo view') ? { stdout: '' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('pr-failed');
  });
});

describe('J3 §2 멱등 재진입(CX5+G4)', () => {
  it('pr create 실패 → pr list로 기존 URL 회수 수렴', async () => {
    const { exec } = makeExec((cmd, args) => {
      const a = argStr(args);
      if (isGh(cmd) && a.startsWith('pr create')) return { throw: 'a pull request already exists' };
      if (isGh(cmd) && a.startsWith('pr list')) return { stdout: VALID_PR };
      return happyBehavior(cmd, args);
    });
    const { svc, daemonCalls } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.recovered).toBe(true);
    expect(res.prUrl).toBe(VALID_PR);
    // 회수 경로도 prUrl을 커밋한다.
    expect(daemonCalls.find((c) => c.method === 'task.mission.update')?.params.prUrl).toBe(VALID_PR);
  });

  it('pr create 실패 + 기존 PR도 없음 → pr-failed', async () => {
    const { exec } = makeExec((cmd, args) => {
      const a = argStr(args);
      if (isGh(cmd) && a.startsWith('pr create')) return { throw: 'boom' };
      if (isGh(cmd) && a.startsWith('pr list')) return { stdout: '' };
      return happyBehavior(cmd, args);
    });
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('pr-failed');
  });
});

describe('J3 §2 URL 검증(G5)', () => {
  it('pr create가 비-github URL을 뱉으면 회수 실패 시 pr-failed', async () => {
    const { exec } = makeExec((cmd, args) => {
      const a = argStr(args);
      if (isGh(cmd) && a.startsWith('pr create')) return { stdout: 'https://evil.example.com/pull/1' };
      if (isGh(cmd) && a.startsWith('pr list')) return { stdout: '' };
      return happyBehavior(cmd, args);
    });
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('pr-failed');
  });
});

describe('J3 §2 push 실패', () => {
  it('git push 실패는 push-failed', async () => {
    const { exec } = makeExec((cmd, args) =>
      cmd === 'git' && argStr(args).startsWith('push') ? { throw: 'permission denied' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('push-failed');
  });
});

describe('J3 §2 prUrl 커밋 실패(비치명)', () => {
  it('데몬 update 실패는 commitPending으로 표기(PR 자체는 성공)', async () => {
    const { exec } = makeExec(happyBehavior);
    const { svc } = makeService(exec, { daemonOk: false });
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.commitPending).toBe(true);
    expect(res.prUrl).toBe(VALID_PR);
  });
});

// ── GitLab: origin on a non-GitHub host opens a merge request with glab ──

const GL_ORIGIN = 'git@gitlab.example.com:group/sub/proj.git';
const GL_PROJECT = 'projects/group%2Fsub%2Fproj';
const GL_MR = 'https://gitlab.example.com/group/sub/proj/-/merge_requests/7';

function isGlab(cmd: string): boolean {
  return cmd === 'glab' || cmd === 'glab.exe';
}

/** ssh as task_pr spawns it: `ssh.exe` on win32, `ssh` elsewhere. */
function isSsh(cmd: string): boolean {
  return cmd === 'ssh' || cmd === 'ssh.exe';
}

/** glab api args after `api --hostname <host>`. */
function apiArgs(args: string[]): string[] {
  return args[0] === 'api' && args[1] === '--hostname' ? args.slice(3) : [];
}

/** The merge request POST (a GraphQL read is a `-X POST` too). */
function isMrPost(args: string[]): boolean {
  return apiArgs(args)[0] === '-X' && !args.includes('graphql');
}

function glHappy(cmd: string, args: string[]): { stdout: string } | { throw: string } {
  const a = argStr(args);
  if (cmd === 'git' && a === 'remote get-url --push origin') return { stdout: `${GL_ORIGIN}\n` };
  if (isGlab(cmd)) {
    if (a === '--version') return { stdout: 'glab 1.50.0' };
    const api = apiArgs(args);
    if (api[0] === 'user') return { stdout: JSON.stringify({ username: 'alice' }) };
    if (api.includes('graphql')) return { stdout: JSON.stringify({ data: { project: { repository: { rootRef: 'main' } } } }) };
    if (api[0] === '-X' && api[1] === 'POST') return { stdout: JSON.stringify({ iid: 7, web_url: GL_MR, source_project_id: 10, target_project_id: 10 }) };
    if (api[0]?.startsWith(`${GL_PROJECT}/merge_requests?`)) return { stdout: '[]' };
  }
  // gh (signed in to github.com) cannot read a GitLab repository.
  if (isGh(cmd) && args[0] === 'repo') return { throw: 'none of the git remotes configured for this repository point to a known GitHub host' };
  return happyBehavior(cmd, args);
}

function makeGlService(behavior: (cmd: string, args: string[]) => { stdout: string } | { throw: string }) {
  const { exec, calls } = makeExec(behavior);
  const daemonCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const daemon = {
    rpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
      daemonCalls.push({ method, params });
      return { ok: true };
    }),
  };
  const glab = new GlabPrService(Date.now, exec);
  const svc = new TaskPrService({ daemon, cache: { invalidate: vi.fn() }, exec, glab, scanGit: cleanScan });
  const posts = () => calls.filter((c) => isGlab(c.cmd) && isMrPost(c.args));
  return { svc, calls, daemonCalls, posts };
}

describe('task_pr on GitLab (glab)', () => {
  it('routes a GitLab origin to glab: pushes to origin, POSTs the MR, never runs gh', async () => {
    const { svc, calls, daemonCalls, posts } = makeGlService(glHappy);
    const res = await svc.createPr({ ...INPUT, body: '-starts with a dash' });
    expect(res).toEqual({ ok: true, prUrl: GL_MR, mrIid: 7 });
    expect(calls.some((c) => isGh(c.cmd))).toBe(false);
    expect(calls.find((c) => c.cmd === 'git' && c.args[0] === 'push')?.args).toEqual(PINNED_PUSH);
    const post = posts();
    expect(post).toHaveLength(1);
    expect(post[0].args.slice(0, 3)).toEqual(['api', '--hostname', 'gitlab.example.com']);
    expect(apiArgs(post[0].args)).toEqual([
      '-X', 'POST', `${GL_PROJECT}/merge_requests`, '--input', '-', '-H', 'Content-Type: application/json',
    ]);
    expect(JSON.parse(post[0].input ?? '')).toEqual({
      source_branch: INPUT.branch, target_branch: 'main', title: INPUT.title, description: '-starts with a dash',
    });
    expect(daemonCalls.find((c) => c.method === 'task.mission.update')?.params.prUrl).toBe(GL_MR);
  });

  it('keeps a GitHub origin on the gh path (no glab call)', async () => {
    const { svc, calls } = makeGlService((cmd, args) =>
      cmd === 'git' && argStr(args) === 'remote get-url --push origin' ? { stdout: 'https://github.com/acme/widget.git\n' } : happyBehavior(cmd, args),
    );
    const res = await svc.createPr(INPUT);
    expect(res).toEqual({ ok: true, prUrl: VALID_PR });
    expect(calls.some((c) => isGlab(c.cmd))).toBe(false);
  });

  it('returns the open MR for the branch instead of opening a second one', async () => {
    const { svc, posts } = makeGlService((cmd, args) => {
      const api = apiArgs(args);
      if (isGlab(cmd) && isMrPost(args)) return { throw: 'glab: Another open merge request already exists for this source branch: !7 (HTTP 409)' };
      if (isGlab(cmd) && api[0]?.startsWith(`${GL_PROJECT}/merge_requests?`)) {
        expect(api[0]).toContain('state=opened');
        expect(api[0]).toContain(`source_branch=${encodeURIComponent(INPUT.branch)}`);
        expect(api[0]).toContain('target_branch=main');
        return {
          stdout: JSON.stringify([
            { iid: 3, web_url: 'https://gitlab.example.com/fork/proj/-/merge_requests/3', source_project_id: 99, target_project_id: 10 },
            { iid: 7, web_url: GL_MR, source_project_id: 10, target_project_id: 10 },
          ]),
        };
      }
      return glHappy(cmd, args);
    });
    const res = await svc.createPr(INPUT);
    expect(res).toEqual({ ok: true, prUrl: GL_MR, recovered: true, mrIid: 7 });
    expect(posts()).toHaveLength(1);
  });

  it('a signed-out glab is gh-unauth, before anything is pushed', async () => {
    const { svc, calls } = makeGlService((cmd, args) =>
      isGlab(cmd) && apiArgs(args)[0] === 'user' ? { throw: 'glab: 401 Unauthorized' } : glHappy(cmd, args),
    );
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('gh-unauth');
    expect(res.error).toContain('glab auth login --hostname gitlab.example.com');
    expect(calls.find((c) => c.cmd === 'git' && c.args[0] === 'push')).toBeUndefined();
  });

  it('a network blip is a transient error, not a sign-out', async () => {
    const { svc, calls } = makeGlService((cmd, args) =>
      isGlab(cmd) && apiArgs(args)[0] === 'user'
        ? { throw: 'dial tcp: lookup gitlab.example.com: no such host' }
        : glHappy(cmd, args),
    );
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('error');
    expect(calls.find((c) => c.cmd === 'git' && c.args[0] === 'push')).toBeUndefined();
  });

  it('a missing glab is gh-missing (gh signed in elsewhere cannot read this repo)', async () => {
    const { svc, calls } = makeGlService((cmd, args) => {
      if (isGlab(cmd) && args[0] === '--version') return { throw: 'spawn glab ENOENT' };
      if (isGh(cmd) && args[0] === 'repo') return { throw: 'none of the git remotes configured for this repository point to a known GitHub host' };
      return glHappy(cmd, args);
    });
    const res = await svc.createPr(INPUT);
    expect(calls.find((c) => c.cmd === 'git' && c.args[0] === 'push')).toBeUndefined();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('gh-missing');
    expect(res.error).toContain('glab');
  });

  it('a failed create with no open MR is pr-failed; one glab answered 401 is gh-unauth', async () => {
    const failing = (stderr: string) => makeGlService((cmd, args) =>
      isGlab(cmd) && isMrPost(args) ? { throw: stderr } : glHappy(cmd, args),
    );
    const blip = await failing('Post "https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fproj/merge_requests": EOF').svc.createPr(INPUT);
    expect(blip.ok === false && blip.reason).toBe('pr-failed');
    const out = await failing('glab: 401 Unauthorized').svc.createPr(INPUT);
    expect(out.ok === false && out.reason).toBe('gh-unauth');
  });
});

describe('task_pr: a host glab refuses goes on to gh', () => {
  const glabMissing = (origin: string, gh: (cmd: string, args: string[]) => { stdout: string } | { throw: string } | null) =>
    makeGlService((cmd, args) => {
      if (cmd === 'git' && argStr(args) === 'remote get-url --push origin') return { stdout: `${origin}\n` };
      if (isGlab(cmd) && args[0] === '--version') return { throw: 'spawn glab ENOENT' };
      // The ssh config maps the alias `work` to github.com.
      if (isSsh(cmd) && argStr(args) === '-G work') return { stdout: 'user git\nhostname github.com\nport 22\n' };
      if (isGh(cmd)) return gh(cmd, args) ?? happyBehavior(cmd, args);
      return glHappy(cmd, args);
    });

  it('an ssh alias for GitHub (glab missing) opens its PR with gh', async () => {
    const { svc, calls } = glabMissing('git@work:acme/widget.git', () => null);
    expect(await svc.createPr(INPUT)).toEqual({ ok: true, prUrl: VALID_PR });
    // Every gh call names origin's repository, the alias resolved.
    expect(calls.find((c) => isGh(c.cmd) && c.args[0] === 'repo')?.args.slice(0, 3)).toEqual(['repo', 'view', 'github.com/acme/widget']);
    const create = calls.find((c) => isGh(c.cmd) && c.args[0] === 'pr' && c.args[1] === 'create');
    expect(create?.args.slice(0, 4)).toEqual(['pr', 'create', '-R', 'github.com/acme/widget']);
    expect(create?.args).toContain('main');
  });

  it('an alias ssh does not resolve to a real host answers the glab refusal', async () => {
    const { svc, calls } = glabMissing('git@nowhere:acme/widget.git', () => null);
    const res = await svc.createPr(INPUT);
    expect(res.ok === false && res.reason).toBe('gh-missing');
    expect(calls.some((c) => isGh(c.cmd))).toBe(false);
  });

  it('a GitLab origin with a GitHub mirror remote (glab missing) never reaches the mirror', async () => {
    const { svc, calls } = glabMissing(GL_ORIGIN, (_cmd, args) => {
      if (args[0] !== 'repo') return null;
      // Unpinned, gh would pick the github.com mirror; pinned to origin it cannot read it.
      return args[2] === 'gitlab.example.com/group/sub/proj' ? { throw: 'HTTP 404: Not Found' } : { stdout: 'main' };
    });
    const res = await svc.createPr(INPUT);
    expect(res.ok === false && res.reason).toBe('gh-missing');
    expect(res.ok === false && res.error).toContain('glab');
    expect(calls.filter((c) => c.cmd === 'git' && c.args[0] === 'push')).toHaveLength(0);
    expect(calls.find((c) => isGh(c.cmd) && c.args[0] === 'pr')).toBeUndefined();
  });

  it('GitHub Enterprise on its own domain (glab missing) reaches gh: the push and the PR create run', async () => {
    const { svc, calls } = glabMissing('git@code.acme.example:acme/widget.git', () => null);
    const res = await svc.createPr(INPUT);
    expect(calls.filter((c) => c.cmd === 'git' && c.args[0] === 'push')).toHaveLength(1);
    expect(calls.find((c) => isGh(c.cmd) && c.args[0] === 'pr' && c.args[1] === 'create')?.args.slice(2, 4)).toEqual(['-R', 'code.acme.example/acme/widget']);
    expect(res.ok).toBe(true);
  });

  it('a GitLab host with glab and gh both missing answers the glab refusal', async () => {
    const { svc, calls } = glabMissing(GL_ORIGIN, () => ({ throw: 'spawn gh ENOENT' }));
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('gh-missing');
    expect(res.error).toContain('glab');
    expect(calls.find((c) => c.cmd === 'git' && c.args[0] === 'push')).toBeUndefined();
  });

  it('a glab sign-out with gh signed out too answers the glab sign-out', async () => {
    const { svc } = makeGlService((cmd, args) => {
      if (isGlab(cmd) && apiArgs(args)[0] === 'user') return { throw: 'glab: 401 Unauthorized (HTTP 401)' };
      if (isGh(cmd) && args[0] === 'auth') return { throw: 'You are not logged into any GitHub hosts' };
      return glHappy(cmd, args);
    });
    const res = await svc.createPr(INPUT);
    expect(res.ok === false && res.error).toContain('glab auth login --hostname gitlab.example.com');
  });

  it('gh that got past the gate answers its own failure', async () => {
    const { svc } = glabMissing('git@work:acme/widget.git', (cmd, args) =>
      args[0] === 'pr' ? { throw: 'GraphQL: something went wrong' } : null,
    );
    const res = await svc.createPr(INPUT);
    expect(res.ok === false && res.reason).toBe('pr-failed');
    expect(res.ok === false && res.error).toContain('gh pr create failed');
  });
});

describe('task_pr: GitHub Enterprise on its own domain, a host gh is signed in to', () => {
  const GHE_PR = 'https://code.acme.example/acme/widget/pull/3';
  const ghe = (prCreate: string, prList = '') => makeGlService((cmd, args) => {
    const a = argStr(args);
    if (cmd === 'git' && a === 'remote get-url --push origin') return { stdout: 'git@code.acme.example:acme/widget.git\n' };
    if (isGh(cmd) && a.startsWith('pr create')) return { stdout: prCreate };
    if (isGh(cmd) && a.startsWith('pr list')) return { stdout: prList };
    return isGh(cmd) ? happyBehavior(cmd, args) : glHappy(cmd, args);
  });

  it('goes straight to gh and keeps the PR URL gh prints on that host', async () => {
    forge.hosts = { gh: new Set(['code.acme.example']), glab: new Map() };
    const { svc, calls, daemonCalls } = ghe(`Creating pull request\n${GHE_PR}`);
    expect(await svc.createPr(INPUT)).toEqual({ ok: true, prUrl: GHE_PR });
    expect(calls.some((c) => isGlab(c.cmd))).toBe(false);
    expect(daemonCalls[0]?.params.prUrl).toBe(GHE_PR);
    // Main's finding goes with it: the daemon does not read gh's config itself.
    expect(daemonCalls[0]?.params.prUrlGithubHost).toBe('code.acme.example');
  });

  it('names the host as the daemon reads it, an explicit :443 kept', async () => {
    const at443 = 'https://code.acme.example:443/acme/widget/pull/3';
    forge.hosts = { gh: new Set(['code.acme.example', 'code.acme.example:443']), glab: new Map() };
    const { svc, daemonCalls } = ghe(`Creating pull request\n${at443}`);
    expect(await svc.createPr(INPUT)).toEqual({ ok: true, prUrl: at443 });
    expect(daemonCalls[0]?.params.prUrlGithubHost).toBe('code.acme.example:443');
  });

  it('a github.com PR or a GitLab MR names no Enterprise host to the daemon', async () => {
    const gh = makeService(makeExec(happyBehavior).exec);
    expect(await gh.svc.createPr(INPUT)).toMatchObject({ ok: true });
    expect(gh.daemonCalls[0]?.params).not.toHaveProperty('prUrlGithubHost');
    const gl = makeGlService(glHappy);
    expect(await gl.svc.createPr(INPUT)).toMatchObject({ ok: true, mrIid: 7 });
    expect(gl.daemonCalls[0]?.params).not.toHaveProperty('prUrlGithubHost');
  });

  it('recovers an existing PR on that host', async () => {
    forge.hosts = { gh: new Set(['code.acme.example']), glab: new Map() };
    const { svc } = ghe('could not parse', GHE_PR);
    expect(await svc.createPr(INPUT)).toEqual({ ok: true, prUrl: GHE_PR, recovered: true });
  });

  it('a PR URL on a host gh is not signed in to is still refused', async () => {
    forge.hosts = { gh: new Set(['code.acme.example']), glab: new Map() };
    const { svc } = ghe('https://evil.example.com/acme/widget/pull/3');
    expect(await svc.createPr(INPUT)).toMatchObject({ ok: false, reason: 'pr-failed' });
  });
});

describe('task_pr: the glab sign-in hint', () => {
  it('names glab\'s host:port entry, so following it does not add a plain entry on 443', async () => {
    forge.hosts = { gh: new Set(), glab: new Map([['gitlab.example.com:8443', { name: 'gitlab.example.com:8443', subfolder: '' }]]) };
    const { svc, calls } = makeGlService((cmd, args) => {
      // The port entry reaches glab through GITLAB_HOST: no --hostname.
      if (isGlab(cmd) && args[0] === 'api' && args[1] === 'user') return { throw: 'glab: 401 Unauthorized (HTTP 401)' };
      return glHappy(cmd, args);
    });
    const res = await svc.createPr(INPUT);
    expect(res.ok === false && res.reason).toBe('gh-unauth');
    expect(res.ok === false && res.error).toContain('glab auth login --hostname gitlab.example.com:8443');
    expect(calls.some((c) => c.cmd === 'git' && c.args[0] === 'push')).toBe(false);
  });
});

describe('task_pr: the branch is a plain name before anything is pushed', () => {
  for (const branch of ['+wtask/x', '-wtask', 'a:b', 'x^', 'x~1', '@{-1}', 'refs/heads/main', 'refs/tags/v1']) {
    it(`refuses ${JSON.stringify(branch)} on both paths`, async () => {
      for (const make of [() => makeGlService(glHappy), () => makeGlService(happyBehavior)]) {
        const { svc, calls } = make();
        const res = await svc.createPr({ ...INPUT, branch });
        expect(res.ok === false && res.reason).toBe('error');
        expect(calls.find((c) => c.cmd === 'git' && c.args[0] === 'push')).toBeUndefined();
      }
    });
  }

  it('refuses a name git does not hand back unchanged', async () => {
    const { svc, calls } = makeGlService((cmd, args) =>
      cmd === 'git' && args[0] === 'check-ref-format' ? { throw: 'fatal: not a valid branch name' } : glHappy(cmd, args),
    );
    const res = await svc.createPr({ ...INPUT, branch: 'wtask/x.lock' });
    expect(res.ok === false && res.reason).toBe('error');
    expect(calls.find((c) => c.cmd === 'git' && c.args[0] === 'push')).toBeUndefined();
  });
});

describe('task_pr on GitLab: the rest of the contract', () => {
  it('an unreadable default branch is pr-failed, and no MR is opened', async () => {
    const { svc, posts } = makeGlService((cmd, args) =>
      isGlab(cmd) && apiArgs(args).includes('graphql') ? { stdout: JSON.stringify({ data: { project: null }, errors: [{ message: 'not found' }] }) } : glHappy(cmd, args),
    );
    const res = await svc.createPr(INPUT);
    expect(res.ok === false && res.reason).toBe('pr-failed');
    expect(res.ok === false && res.error).toContain('base branch');
    expect(posts()).toHaveLength(0);
  });

  it('builds the MR URL when web_url is missing or is not that MR\'s page', async () => {
    for (const web_url of [undefined, 'https://gitlab.example.com/group/sub/proj/-/merge_requests/8', 'javascript:alert(1)']) {
      const { svc } = makeGlService((cmd, args) =>
        isGlab(cmd) && isMrPost(args) ? { stdout: JSON.stringify({ iid: 7, web_url }) } : glHappy(cmd, args),
      );
      expect(await svc.createPr(INPUT)).toEqual({ ok: true, prUrl: GL_MR, mrIid: 7 });
    }
  });

  it('reads only glab\'s stderr for a sign-out: a 401 in the command line is not one', async () => {
    const { svc } = makeGlService((cmd, args) => {
      if (cmd === 'git' && argStr(args) === 'remote get-url --push origin') return { stdout: 'git@gitlab.example.com:team-401/proj.git\n' };
      if (isGlab(cmd) && isMrPost(args)) return { throw: 'Post "https://gitlab.example.com/api/v4/projects/team-401%2Fproj/merge_requests": EOF' };
      return glHappy(cmd, args);
    });
    // The title puts "401 Unauthorized" in the command line, so in err.message.
    const res = await svc.createPr({ ...INPUT, title: '401 Unauthorized page' });
    expect(res.ok === false && res.reason).toBe('pr-failed');
  });
});

describe('task_pr: the push goes where it was approved to', () => {
  const OTHER = 'git@gitlab.example.com:other/proj.git';
  /** origin's push URL reads `first` for `n` reads, then `later`. */
  const shifting = (base: (cmd: string, args: string[]) => { stdout: string } | { throw: string }, first: string, later: string, n: number) => {
    let reads = 0;
    return (cmd: string, args: string[]) => {
      if (cmd === 'git' && argStr(args) === 'remote get-url --push origin') {
        reads += 1;
        return { stdout: `${reads <= n ? first : later}\n` };
      }
      return base(cmd, args);
    };
  };

  it('refuses when origin\'s push URL changed right before the push, on both paths', async () => {
    for (const [base, first] of [[glHappy, GL_ORIGIN], [happyBehavior, 'https://github.com/acme/widget.git']] as const) {
      const { svc, calls } = makeGlService(shifting(base, first, OTHER, 1));
      const res = await svc.createPr(INPUT);
      expect(res.ok === false && res.error).toContain("origin's push URL changed");
      expect(calls.filter((c) => c.cmd === 'git' && c.args[0] === 'push')).toHaveLength(0);
    }
  });

  it('refuses when origin is not the push target the human approved', async () => {
    const { svc, calls } = makeGlService(glHappy);
    const res = await svc.createPr({ ...INPUT, pushTarget: 'gitlab.example.com/other/proj' });
    expect(res.ok === false && res.error).toContain('gitlab.example.com/other/proj → gitlab.example.com/group/sub/proj');
    expect(calls.filter((c) => c.cmd === 'git' && c.args[0] === 'push')).toHaveLength(0);
  });

  it('pushes when it still is the approved target', async () => {
    const { svc, calls } = makeGlService(glHappy);
    expect(await svc.createPr({ ...INPUT, pushTarget: 'gitlab.example.com/group/sub/proj' })).toEqual({ ok: true, prUrl: GL_MR, mrIid: 7 });
    expect(calls.filter((c) => c.cmd === 'git' && c.args[0] === 'push')).toHaveLength(1);
  });
});

describe('the Git page\'s push check runs before the task PR push', () => {
  // No git process outlives its command here: an auto gc or maintenance run
  // after a commit, or an fsmonitor daemon a runner's global config turns on,
  // would keep the temp repo open past the test (EBUSY on Windows).
  const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.fsmonitor=false',
    ...args,
  ], { cwd, encoding: 'utf8' }).trim();
  let root: string;
  // A git that just exited can still hold a handle in the repo for a moment on Windows.
  const removeRoot = () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  afterEach(() => { if (root) removeRoot(); });

  /** A real worktree whose task branch adds `file` on top of what origin has. */
  function repoWith(file: string, text: string): string {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-taskpr-secrets-')));
    const origin = path.join(root, 'origin.git');
    const repo = path.join(root, 'repo');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'checkout', '-q', '-b', INPUT.branch);
    fs.writeFileSync(path.join(repo, file), text);
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'work');
    return repo;
  }

  /** The fake git, except that rev-parse reads the real repository the check scans. */
  const realRevParse = (run: ReturnType<typeof makeExec>): PrExec => async (cmd, args, opts) =>
    (cmd === 'git' && args[0] === 'rev-parse'
      ? { stdout: execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8' }), stderr: '' }
      : run.exec(cmd, args, opts));
  const KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n';

  it('a branch carrying a key is refused with the Git page\'s words and never pushed; a clean one is pushed', async () => {
    const keyed = repoWith('deploy.pem', KEY);
    let run = makeExec(happyBehavior);
    let res = await makeService(realRevParse(run), { scanGit: (cwd) => spawnGitLines(cwd) }).svc.createPr({ ...INPUT, worktreePath: keyed });
    expect(res).toMatchObject({ ok: false, reason: 'secrets', error: expect.stringContaining('deploy.pem'), secrets: [expect.objectContaining({ path: 'deploy.pem' })] });
    expect(run.calls.some((c) => c.cmd === 'git' && c.args[0] === 'push')).toBe(false);

    removeRoot();
    const clean = repoWith('b.txt', 'b\n');
    run = makeExec(happyBehavior);
    res = await makeService(realRevParse(run), { scanGit: (cwd) => spawnGitLines(cwd) }).svc.createPr({ ...INPUT, worktreePath: clean });
    expect(res.ok).toBe(true);
    expect(run.calls.some((c) => c.cmd === 'git' && c.args[0] === 'push')).toBe(true);
  });

  it('a commit made while the check runs is not pushed: the push names the commit that was checked', async () => {
    const repo = repoWith('b.txt', 'b\n');
    const checked = git(repo, 'rev-parse', 'HEAD');
    // The agent commits a key while the check reads the branch.
    let committed = false;
    const scanGit = (cwd: string): GitLines => {
      const real = spawnGitLines(cwd);
      return async (args, onLine) => {
        if (!committed) {
          committed = true;
          fs.writeFileSync(path.join(repo, 'deploy.pem'), KEY);
          git(repo, 'add', '.');
          git(repo, 'commit', '-qm', 'late');
        }
        return real(args, onLine);
      };
    };
    const run = makeExec(happyBehavior);
    const res = await makeService(realRevParse(run), { scanGit }).svc.createPr({ ...INPUT, worktreePath: repo });
    expect(res.ok).toBe(true);
    expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(checked);
    expect(run.calls.find((c) => c.cmd === 'git' && c.args[0] === 'push')?.args).toEqual(['push', 'origin', '--', `${checked}:refs/heads/${INPUT.branch}`]);
  });
});

describe('execWithInput — a real child process', () => {
  // Reads stdin and prints how many characters arrived.
  const COUNT = 'let n=0;process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{n+=d.length});process.stdin.on("end",()=>process.stdout.write(String(n)))';
  const opts = { cwd: os.tmpdir(), timeout: 30_000, env: process.env, windowsHide: true };
  const text = 'x'.repeat(40_000);

  it('hands 40,000 characters to the child on stdin', async () => {
    const { stdout } = await execWithInput(process.execPath, ['-e', COUNT], { ...opts, input: text });
    expect(stdout).toBe('40000');
  });

  it('an empty input still closes stdin, so a child reading to EOF finishes (an empty squash body)', async () => {
    const { stdout } = await execWithInput(process.execPath, ['-e', COUNT], { ...opts, timeout: 10_000, input: '' });
    expect(stdout).toBe('0');
  });

  it('without input, leaves stdin to the child as before', async () => {
    const { stdout } = await execWithInput(process.execPath, ['-e', 'process.stdout.write("ok")'], opts);
    expect(stdout).toBe('ok');
  });

  it.runIf(process.platform === 'win32')('the same 40,000 characters on argv fail to spawn on Windows', async () => {
    await expect(execWithInput(process.execPath, ['-e', COUNT, text], opts)).rejects.toMatchObject({ code: 'ENAMETOOLONG' });
  });
});
