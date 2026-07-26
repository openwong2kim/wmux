// PR surface provider contract — normalized types consumed by Git tab PR list and comments.
//
// Implementations: GhPrService (GitHub, gh CLI) + GlabPrService (GitLab, glab CLI).
// Provider selection uses origin remote hostname: github.com family → gh,
// all other hosts → glab (self-hosted GitLab is common, so not a hostname whitelist but
// "if not GitHub, ask glab" — missing glab or unauthenticated host degrades to fail-closed guidance).
import { git } from '../git/git';
import { hostCommandTarget, paneCommandIdentity, type PaneCommandTarget } from '../git/paneCommand';
import type { PrSummary, PrComment, PrDetail } from '../../shared/prSurface';

// Wire types live in shared/prSurface.ts (shared with renderer). Re-exported here to
// keep main-side consumer import surface in one place.
export type { PrSummary, PrComment, PrDetail };
export { PR_COMMENT_BODY_CAP } from '../../shared/prSurface';

export type PrGate =
  | { ok: true }
  | { ok: false; reason: 'cli-missing' | 'unauthenticated'; message: string };

export type PrListResult = { ok: true; prs: PrSummary[] } | { ok: false; error: string };
export type PrDetailResult = { ok: true; detail: PrDetail } | { ok: false; error: string };

/**
 * Repo → provider-cache identity, shared by every implementation.
 *
 * A repo is addressed two ways: the Deck PR panel passes only a `repoPath`
 * (github.handler), while the pane poller passes the pane's target
 * (PrReviewRouter). Both must land on ONE entry, or each spawns its own CLI
 * subprocess and keeps its own TTL window for the same repo. A bare path IS a
 * host location, so it goes through `hostCommandTarget` and the identity is
 * always computed by `locationIdentity` — there is no second normalizer here.
 */
export function repoCacheKey(repoPath: string, target?: PaneCommandTarget): string {
  return paneCommandIdentity(target ?? hostCommandTarget(repoPath));
}

/** Host-neutral provider contract. `host` is remote hostname — GitLab auth is
 *  per-host (`glab auth status --hostname`, self-hosted) so the gate needs it.
 *  gh implementation ignores it.
 *
 *  `target` is the pane the request belongs to, when there is one: it decides
 *  both where the CLI runs (host / WSL distro / MSYS) and the cache identity.
 *  Absent, the call is a host request for `repoPath`. */
export interface PrProvider {
  /** CLI presence and auth gate. Failures carry user guidance (fail-closed). */
  gate(repoPath: string, host: string, target?: PaneCommandTarget): Promise<PrGate>;
  /** force=true is manual refresh — skips the implementation's TTL cache. */
  listPrs(repoPath: string, force?: boolean, target?: PaneCommandTarget): Promise<PrListResult>;
  prDetail(
    repoPath: string,
    number: number,
    updatedAt: string,
    target?: PaneCommandTarget,
  ): Promise<PrDetailResult>;
}

/** PATH for gh/glab CLI exec — macOS GUI inherits launchd PATH without
 *  Homebrew paths (/opt/homebrew/bin, /usr/local/bin). Supplemented so execFile
 *  does not degrade to cli-missing when the binary exists. */
export function cliPath(): string {
  const base = process.env.PATH ?? '';
  if (process.platform !== 'darwin') return base;
  const extras = ['/opt/homebrew/bin', '/usr/local/bin'].filter(
    (p) => !base.split(':').includes(p),
  );
  return extras.length ? `${base}:${extras.join(':')}` : base;
}

/** origin remote URL → hostname. No remote or unparseable → null. Pure (for tests). */
export function parseRemoteHost(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  // https://host/o/r(.git) | git@host:o/r.git | ssh://git@host/o/r
  const m = trimmed.match(/^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/(?:[^@/]+@)?)([^/:]+)/i);
  const host = m?.[1]?.toLowerCase() ?? '';
  return host || null;
}

export function isGithubHost(host: string): boolean {
  return host === 'github.com' || host.endsWith('.github.com');
}

/** Origin hostname for repo — null when no remote. */
export async function detectRemoteHost(repoPath: string): Promise<string | null> {
  const r = await git(['remote', 'get-url', 'origin'], repoPath);
  if (r.code !== 0) return null;
  return parseRemoteHost(r.stdout);
}
