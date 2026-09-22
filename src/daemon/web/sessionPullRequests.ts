import { execFile } from 'node:child_process';
import { buildGitEnv, createGitRunner, gitArgv, type GitRunner } from './sessionDiff';

export interface PhonePullRequest { number: number; title: string; state: string; url: string; isDraft: boolean }
export interface PullRequestState { state: 'available' | 'unsupported' | 'unavailable'; items: PhonePullRequest[] }
export type PullRequestRunner = (repo: string, branch: string) => Promise<unknown>;

export function githubRepository(remote: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote.trim());
  return match?.[1] ?? null;
}

const runGh: PullRequestRunner = (repo, branch) => new Promise((resolve, reject) => {
  const env = buildGitEnv();
  // Only github.com is accepted. Never forward credentials to a host selected
  // by repository config, the phone, GH_HOST, or Git URL rewriting.
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.GH_HOST = 'github.com';
  env.GH_PROMPT_DISABLED = '1';
  execFile('gh', ['pr', 'list', '--repo', `github.com/${repo}`, '--head', branch, '--state', 'all', '--limit', '100',
    '--json', 'number,title,state,url,isDraft,headRefName,headRepository'],
  {env, timeout:8000, maxBuffer:128 * 1024, windowsHide:true}, (error, stdout) => {
    if (error) { reject(error); return; }
    try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
  });
});

export async function sessionPullRequests(cwd: string, git: GitRunner = createGitRunner(), gh: PullRequestRunner = runGh): Promise<PullRequestState> {
  const [remote, branch] = await Promise.all([
    git(gitArgv('remote', 'get-url', 'origin'), cwd),
    git(gitArgv('symbolic-ref', '--short', 'HEAD'), cwd),
  ]);
  if (!remote.ok || !branch.ok) return {state:'unavailable',items:[]};
  const repo = githubRepository(remote.stdout);
  if (!repo) return {state:'unsupported',items:[]};
  try {
    const rows = await gh(repo, branch.stdout.trim());
    if (!Array.isArray(rows) || rows.length > 100) throw new Error('invalid PR response');
    const items: PhonePullRequest[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.number) || row.number <= 0 ||
          typeof row.title !== 'string' || !['OPEN','CLOSED','MERGED'].includes(row.state) || typeof row.isDraft !== 'boolean' ||
          row.url !== `https://github.com/${repo}/pull/${row.number}`) throw new Error('invalid PR response');
      // --head matches a branch name across forks. Only this origin's head
      // repository and exact branch can identify this checkout's PRs.
      if (typeof row.headRefName !== 'string' ||
          (row.headRepository !== null && (typeof row.headRepository !== 'object' ||
           typeof row.headRepository?.nameWithOwner !== 'string'))) throw new Error('invalid PR head');
      if (row.headRefName !== branch.stdout.trim() || row.headRepository === null ||
          row.headRepository.nameWithOwner.toLowerCase() !== repo.toLowerCase()) continue;
      items.push({number:row.number,title:row.title.slice(0,1000),state:row.state,url:row.url,isDraft:row.isDraft});
    }
    // A full bounded page of other forks is not proof that this head has no PR.
    if (rows.length === 100 && items.length === 0) return {state:'unavailable',items:[]};
    return {state:'available',items:items.slice(0,10)};
  } catch { return {state:'unavailable',items:[]}; }
}
