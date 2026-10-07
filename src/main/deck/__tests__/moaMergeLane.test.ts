import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mapLaneFacts } from '../../github/GhPrReviewService';
import type { PrLaneFacts } from '../../../shared/prReview';
import {
  LANE_PREDICATES,
  OWNER_APPROVED_PREDICATES,
  evaluateMergeLane,
  isWindowsPath,
  notReleasePr,
  notWindowsPath,
  releasePathReason,
  requiredChecksGreen,
  type MergeLaneContext,
} from '../moaMergeLane';

// Recorded GraphQL answers to LANE_PR_QUERY (2026-10-07), contributor logins
// replaced: #1858 merged by the owner; #1829 open from a fork with the
// needs-windows-verify label and a Windows path. Neither repo branch requires
// a check today (every isRequired is false).
const FIXTURES = path.join(__dirname, '../../github/__tests__/fixtures/moaMergeLane');
const load = (name: string): PrLaneFacts => {
  const facts = mapLaneFacts(JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')));
  if (!facts) throw new Error(`fixture ${name} did not map`);
  return facts;
};

const MERGED = load('lane-pr1858.json');
const FORK = load('lane-pr1829.json');

/** #1858 as if it were still open, with `validate` and `Baseline (ubuntu-22.04)` required. */
function openWithRequired(overrides: Partial<PrLaneFacts> = {}): PrLaneFacts {
  return {
    ...MERGED,
    state: 'OPEN',
    mergedAt: null,
    mergeCommitOid: null,
    checks: MERGED.checks.map((c) => ({ ...c, isRequired: c.name === 'validate' || c.name === 'Baseline (ubuntu-22.04)' })),
    ...overrides,
  };
}

const ctx = (facts: PrLaneFacts, over: Partial<MergeLaneContext> = {}): MergeLaneContext => ({
  expectHead: facts.headRefOid,
  trustedAuthors: ['openwong2kim'],
  askerBranches: [facts.headRefName],
  ...over,
});

describe('merge lane predicates on recorded fixtures', () => {
  it('passes every predicate for a trusted, bound, green PR', () => {
    const facts = openWithRequired();
    expect(evaluateMergeLane(facts, ctx(facts))).toEqual({ ok: true, failures: [] });
  });

  it('an EMPTY required set blocks (the repo as it is today)', () => {
    const facts = { ...MERGED, state: 'OPEN' };
    expect(facts.checks.length).toBeGreaterThan(0);
    expect(facts.checks.every((c) => c.isRequired === false)).toBe(true);
    expect(requiredChecksGreen(facts, facts.headRefOid)).toEqual({ ok: false, reason: 'no-required-checks' });
  });

  it('required green but a non-required check pending still passes', () => {
    const facts = openWithRequired();
    facts.checks = facts.checks.map((c) => (c.name === 'bench' ? { ...c, bucket: 'pending' } : c));
    expect(requiredChecksGreen(facts, facts.headRefOid)).toEqual({ ok: true });
  });

  it('a required check pending, failing or skipped blocks', () => {
    for (const bucket of ['pending', 'fail', 'skipping'] as const) {
      const facts = openWithRequired();
      facts.checks = facts.checks.map((c) => (c.name === 'validate' ? { ...c, bucket } : c));
      expect(requiredChecksGreen(facts, facts.headRefOid).ok).toBe(false);
    }
  });

  it('checks read on another commit, or a truncated list, block', () => {
    expect(requiredChecksGreen(openWithRequired({ checksHeadOid: 'f'.repeat(40) }), MERGED.headRefOid)).toEqual({ ok: false, reason: 'checks-not-on-head' });
    expect(requiredChecksGreen(openWithRequired({ checksTruncated: true }), MERGED.headRefOid)).toEqual({ ok: false, reason: 'checks-truncated' });
  });

  it('a moved head refuses', () => {
    const facts = openWithRequired();
    const v = evaluateMergeLane(facts, ctx(facts, { expectHead: 'a'.repeat(40) }));
    expect(v.ok).toBe(false);
    expect(v.failures).toContainEqual({ predicate: 'head-unchanged', reason: 'head-moved' });
    // The required checks were read on the actual head, not the expected one.
    expect(v.failures).toContainEqual({ predicate: 'required-checks-green', reason: 'checks-not-on-head' });
  });

  it('a CHANGELOG-only PR is a release: refused', () => {
    const facts = openWithRequired({ files: ['CHANGELOG.md'] });
    expect(notReleasePr(facts)).toEqual({ ok: false, reason: 'changelog' });
    expect(evaluateMergeLane(facts, ctx(facts)).failures).toEqual([{ predicate: 'not-release-pr', reason: 'changelog' }]);
  });

  it('a changelog.d fragment is not a release', () => {
    expect(MERGED.files).toContain('changelog.d/1825.md');
    expect(notReleasePr(MERGED)).toEqual({ ok: true });
  });

  it('release paths are classified from the file list', () => {
    expect(releasePathReason('package.json')).toBe('package-manifest');
    expect(releasePathReason('package-lock.json')).toBe('package-manifest');
    expect(releasePathReason('.github/workflows/release.yml')).toBe('ci-config');
    expect(releasePathReason('scripts/collect-changelog.mjs')).toBe('release-script');
    expect(releasePathReason('scripts/gen-api-reference.mjs')).toBe('release-script');
    expect(releasePathReason('forge.config.ts')).toBe('packaging');
    expect(releasePathReason('THIRD_PARTY_NOTICES')).toBe('license');
    expect(releasePathReason('src/shared/prReview.ts')).toBeNull();
    expect(releasePathReason('docs/package.json.md')).toBeNull();
    expect(releasePathReason('scripts/sub/package.json')).toBe('package-manifest');
    expect(releasePathReason('patches/@xterm+xterm+6.0.0.patch')).toBe('dependency-patch');
    expect(releasePathReason('build/entitlements.mac.plist')).toBe('build-config');
  });

  it('a Windows path refuses (the fork fixture touches winSnapshotNative.ts)', () => {
    expect(notWindowsPath(FORK)).toEqual({ ok: false, reason: 'windows-path' });
    expect(notWindowsPath(MERGED)).toEqual({ ok: true });
    for (const p of [
      'src/main/pty/winSnapshotNative.ts', 'src/shared/wslDistro.ts', 'src/daemon/__tests__/win32Probe.test.ts',
      'src/shared/conptyWindows.ts', 'src/main/squirrel.ts', 'src/main/pty/shell-hooks/pwsh.ps1', 'install.ps1',
      'chocolatey/wmux.nuspec', 'native/computer-use-windows/src/Core/X.cs', 'scripts/setup.bat',
    ]) expect(isWindowsPath(p), p).toBe(true);
    for (const p of ['src/main/window/windowState.ts', 'src/renderer/Twin.tsx', 'src/shared/moaAsk.ts']) expect(isWindowsPath(p), p).toBe(false);
  });

  it('truncated files block both file predicates', () => {
    const facts = openWithRequired({ filesTruncated: true });
    expect(notReleasePr(facts)).toEqual({ ok: false, reason: 'files-truncated' });
    expect(notWindowsPath(facts)).toEqual({ ok: false, reason: 'files-truncated' });
  });

  it('an external author, the needs-windows-verify label and a fork branch each refuse', () => {
    const v = evaluateMergeLane(FORK, ctx(FORK));
    expect(v.ok).toBe(false);
    expect(v.failures.map((f) => f.predicate)).toEqual([
      'required-checks-green', 'not-windows-path', 'no-needs-windows-verify-label', 'author-trusted', 'pr-branch-bound-to-asker',
    ]);
    expect(v.failures).toContainEqual({ predicate: 'author-trusted', reason: 'external-author' });
    expect(v.failures).toContainEqual({ predicate: 'pr-branch-bound-to-asker', reason: 'cross-repository' });
  });

  it('an external author alone refuses', () => {
    const facts = openWithRequired({ author: 'external-contributor' });
    expect(evaluateMergeLane(facts, ctx(facts)).failures).toEqual([{ predicate: 'author-trusted', reason: 'external-author' }]);
  });

  it('a head branch not bound to the asker refuses', () => {
    const facts = openWithRequired();
    expect(evaluateMergeLane(facts, ctx(facts, { askerBranches: ['wtask/other'] })).failures)
      .toEqual([{ predicate: 'pr-branch-bound-to-asker', reason: 'branch-not-bound' }]);
  });

  it('an owner-approved merge re-checks only the head', () => {
    expect(OWNER_APPROVED_PREDICATES).toEqual(['head-unchanged']);
    expect(evaluateMergeLane(FORK, ctx(FORK), OWNER_APPROVED_PREDICATES)).toEqual({ ok: true, failures: [] });
    expect(evaluateMergeLane(FORK, ctx(FORK, { expectHead: 'b'.repeat(40) }), OWNER_APPROVED_PREDICATES).ok).toBe(false);
    expect(LANE_PREDICATES).toHaveLength(7);
  });
});
