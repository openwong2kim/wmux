// ─── Moa's merge lane — the predicates a merge must pass (pure) ──────────────
//
// A lane-only evaluator, separate from prReview.mergeBlock (which stays the Git
// page's rule and still runs inside GhPrReviewService.merge). Before ANY merge
// execution — the first try and every retry or replay — the executor:
//   1. reads PrLaneFacts fresh (MergeLaneFactsReader: LANE_PR_QUERY, no cache);
//   2. runs evaluateMergeLane on them (every predicate for a 'moa-auto'
//      effect; head-unchanged only for one the owner approved);
//   3. calls GhPrReviewService.merge with expectHead, which re-reads the head,
//      applies mergeBlock and passes --match-head-commit.
// A stored verdict is never a reason to merge. Every predicate fails closed:
// a list that may be incomplete (truncated files, checks or labels) blocks.
//
// Decided from the changed-files list, never from a title or labels alone:
//   not-release-pr   package.json / package-lock.json (a version bump and a
//                    dependency change are indistinguishable by path, and both
//                    go to the owner), CHANGELOG.md (changelog.d/ fragments are
//                    fine), .github/, release and notice scripts, packaging.
//   not-windows-path path tokens naming Windows (win32, windows, wsl, conpty,
//                    squirrel, pwsh, …), Windows-only trees and extensions.
// Path tokens split on separators AND camelCase, so `winSnapshotNative.ts`
// counts; an Electron `auxiliaryWindows.ts` also counts — over-firing only
// sends a merge to the owner.

import type { PrLaneFacts } from '../../shared/prReview';

export type LanePredicate =
  | 'head-unchanged'
  | 'required-checks-green'
  | 'not-release-pr'
  | 'not-windows-path'
  | 'no-needs-windows-verify-label'
  | 'author-trusted'
  | 'pr-branch-bound-to-asker';

/** Evaluation order, and every predicate a 'moa-auto' merge must pass. */
export const LANE_PREDICATES: readonly LanePredicate[] = [
  'head-unchanged',
  'required-checks-green',
  'not-release-pr',
  'not-windows-path',
  'no-needs-windows-verify-label',
  'author-trusted',
  'pr-branch-bound-to-asker',
];

/** What an owner-approved merge re-checks (mergeBlock runs inside merge()). */
export const OWNER_APPROVED_PREDICATES: readonly LanePredicate[] = ['head-unchanged'];

export const NEEDS_WINDOWS_VERIFY_LABEL = 'needs-windows-verify';

export interface LaneFailure {
  predicate: LanePredicate;
  /** A short kebab-case code. */
  reason: string;
}

export type LaneCheck = { ok: true } | { ok: false; reason: string };

export interface MergeLaneContext {
  /** The head the decision was about. */
  expectHead: string;
  /** Lowercase logins allowed without the owner: MoaConfig.trustedAuthors plus
   *  the owner's own login, read by main. */
  trustedAuthors: readonly string[];
  /** Branches bound to the asker, read by main: the branch checked out in the
   *  asker's cwd and the branches of its task ledger rows. */
  askerBranches: readonly string[];
}

export interface LaneVerdict {
  ok: boolean;
  /** Every failed predicate, in LANE_PREDICATES order. */
  failures: LaneFailure[];
}

/** The gh I/O half (built later). Must read fresh: never a cached answer. */
export interface MergeLaneFactsReader {
  readFresh(repoPath: string, repoKey: string, prNumber: number): Promise<PrLaneFacts>;
}

const pass: LaneCheck = { ok: true };
const fail = (reason: string): LaneCheck => ({ ok: false, reason });

export function headUnchanged(facts: PrLaneFacts, expectHead: string): LaneCheck {
  return facts.headRefOid === expectHead ? pass : fail('head-moved');
}

/**
 * Every check the base branch requires is green on `headSha`. An EMPTY
 * required set blocks: no protection means nothing proves the PR is safe.
 * `pass` only; a skipped required check blocks too.
 */
export function requiredChecksGreen(facts: PrLaneFacts, headSha: string): LaneCheck {
  if (facts.headRefOid !== headSha || facts.checksHeadOid !== headSha) return fail('checks-not-on-head');
  if (facts.checksTruncated) return fail('checks-truncated');
  const required = facts.checks.filter((c) => c.isRequired === true);
  if (required.length === 0) return fail('no-required-checks');
  const notGreen = required.find((c) => c.bucket !== 'pass');
  if (!notGreen) return pass;
  return fail(notGreen.bucket === 'pending' ? 'required-check-pending' : `required-check-${notGreen.bucket}`);
}

/** Release, CI and dependency paths: [reason, test]. Paths are repo-relative. */
const RELEASE_PATHS: ReadonlyArray<[string, (p: string) => boolean]> = [
  ['package-manifest', (p) => p === 'package.json' || p === 'package-lock.json'],
  ['changelog', (p) => p === 'CHANGELOG.md'],
  ['ci-config', (p) => p.startsWith('.github/')],
  ['release-script', (p) => /^scripts\/(?:collect-changelog|gen-api-reference|generate-notices|release[^/]*)\.[cm]?[jt]s$/.test(p)],
  ['packaging', (p) => p === 'forge.config.ts' || p.startsWith('chocolatey/') || p === 'install.ps1'],
  ['license', (p) => p === 'LICENSE' || p === 'THIRD_PARTY_NOTICES' || p === 'license-allowlist.json'],
];

/** The release reason a changed path falls under, or null. */
export function releasePathReason(path: string): string | null {
  for (const [reason, test] of RELEASE_PATHS) if (test(path)) return reason;
  return null;
}

export function notReleasePr(facts: PrLaneFacts): LaneCheck {
  if (facts.filesTruncated) return fail('files-truncated');
  if (facts.files.length === 0) return fail('no-files');
  for (const p of facts.files) {
    const reason = releasePathReason(p);
    if (reason) return fail(reason);
  }
  return pass;
}

const WINDOWS_TOKENS: ReadonlySet<string> = new Set([
  'win', 'win32', 'win64', 'windows', 'wsl', 'conpty', 'winpty', 'squirrel', 'pwsh', 'powershell',
  'winget', 'chocolatey', 'choco', 'nsis', 'msi', 'msix', 'appx',
]);
const WINDOWS_EXTENSIONS = /\.(?:ps1|psm1|psd1|bat|cmd|nsi|nuspec|msi|reg)$/i;
const WINDOWS_TREES = ['native/computer-use-windows/', 'chocolatey/'];

/** Lowercase tokens of a path, split on separators and camelCase. */
export function pathTokens(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s/\\._-]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

export function isWindowsPath(path: string): boolean {
  if (WINDOWS_TREES.some((t) => path.startsWith(t)) || path === 'install.ps1') return true;
  if (WINDOWS_EXTENSIONS.test(path)) return true;
  return pathTokens(path).some((t) => WINDOWS_TOKENS.has(t));
}

export function notWindowsPath(facts: PrLaneFacts): LaneCheck {
  if (facts.filesTruncated) return fail('files-truncated');
  return facts.files.some(isWindowsPath) ? fail('windows-path') : pass;
}

export function noNeedsWindowsVerifyLabel(facts: PrLaneFacts): LaneCheck {
  if (facts.labelsTruncated) return fail('labels-truncated');
  return facts.labels.some((l) => l.toLowerCase() === NEEDS_WINDOWS_VERIFY_LABEL) ? fail('needs-windows-verify') : pass;
}

export function authorTrusted(facts: PrLaneFacts, trustedAuthors: readonly string[]): LaneCheck {
  if (!facts.author) return fail('no-author');
  return trustedAuthors.includes(facts.author.toLowerCase()) ? pass : fail('external-author');
}

/** The head branch is one bound to the asker, and lives in this repo (a fork's
 *  branch can carry any name). */
export function prBranchBoundToAsker(facts: PrLaneFacts, askerBranches: readonly string[]): LaneCheck {
  if (facts.isCrossRepository) return fail('cross-repository');
  if (!facts.headRefName) return fail('no-head-branch');
  return askerBranches.includes(facts.headRefName) ? pass : fail('branch-not-bound');
}

function runPredicate(p: LanePredicate, facts: PrLaneFacts, ctx: MergeLaneContext): LaneCheck {
  switch (p) {
    case 'head-unchanged': return headUnchanged(facts, ctx.expectHead);
    case 'required-checks-green': return requiredChecksGreen(facts, ctx.expectHead);
    case 'not-release-pr': return notReleasePr(facts);
    case 'not-windows-path': return notWindowsPath(facts);
    case 'no-needs-windows-verify-label': return noNeedsWindowsVerifyLabel(facts);
    case 'author-trusted': return authorTrusted(facts, ctx.trustedAuthors);
    case 'pr-branch-bound-to-asker': return prBranchBoundToAsker(facts, ctx.askerBranches);
  }
}

/** Run `predicates` (default: all) on one fresh read. Pure. */
export function evaluateMergeLane(
  facts: PrLaneFacts,
  ctx: MergeLaneContext,
  predicates: readonly LanePredicate[] = LANE_PREDICATES,
): LaneVerdict {
  const failures: LaneFailure[] = [];
  for (const p of LANE_PREDICATES) {
    if (!predicates.includes(p)) continue;
    const r = runPredicate(p, facts, ctx);
    if (!r.ok) failures.push({ predicate: p, reason: r.reason });
  }
  return { ok: failures.length === 0, failures };
}
