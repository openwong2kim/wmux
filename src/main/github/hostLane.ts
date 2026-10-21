// The factory's PR / MR lane read by the remote's host: a GitHub key goes to
// gh (GhPrReviewService), every other host to glab (GlabPrService) — the
// split PrProvider makes for the Git page (isGithubHost). Callers: the bot
// reads (roles/index.ts), pr_verdict (prVerdictHost.ts) and the merge lane's
// ports (factory/laneGh.ts), the task gate's merged-branch evidence
// (factory/factoryWiring.ts), and the owner's login (mergeLaneHost.ts,
// factoryWiring.ts).

import type { PrLaneFacts, PrReviewRead } from '../../shared/prReview';
import { isGithubHost } from './PrProvider';
import { ghIssueService } from './GhIssueService';
import { ghPrReviewService } from './GhPrReviewService';
import { glabPrService } from './GlabPrService';

/** A repo key (`host/…`) whose host is not GitHub's, so glab serves it. */
export function isGitlabRepoKey(key: string): boolean {
  const host = key.split('/')[0] ?? '';
  return host.length > 0 && !isGithubHost(host);
}

/** The lane facts of PR (or MR iid) `n`, read fresh from the key's host. */
export function readLaneFacts(repoPath: string, key: string, n: number): Promise<PrReviewRead<PrLaneFacts>> {
  return isGitlabRepoKey(key) ? glabPrService.laneFacts(repoPath, key, n) : ghPrReviewService.laneFacts(repoPath, key, n);
}

/** PRs (MRs) merged from `branch` into `base`, read from the key's host. */
export function mergedOfBranch(cwd: string, key: string, branch: string, base: string): Promise<PrReviewRead<Array<{ pr: number; base: string; headSha: string; cross: boolean }>>> {
  return isGitlabRepoKey(key) ? glabPrService.mergedOfBranch(cwd, key, branch, base) : ghPrReviewService.mergedOfBranch(cwd, key, branch, base);
}

/** The repository's default branch, read from the key's host. */
export function defaultBranch(cwd: string, key: string): Promise<PrReviewRead<string>> {
  return isGitlabRepoKey(key) ? glabPrService.defaultBranch(cwd, key) : ghPrReviewService.defaultBranch(cwd, key);
}

/** The login the host's CLI signs in as on `host` now, lowercased, or null. */
export function signedInLogin(host: string, cwd: string): Promise<string | null> {
  return isGithubHost(host) ? ghIssueService.signedInLogin(host, cwd) : glabPrService.loginOnHost(host, cwd);
}
