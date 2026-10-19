import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mapLaneFacts } from '../../github/GhPrReviewService';
import type { PrLaneFacts } from '../../../shared/prReview';
import {
  LANE_PREDICATES,
  OWNER_APPROVED_PREDICATES,
  evaluateMergeLane,
  gateDefinitionPathReason,
  gateDefinitionUnchanged,
  isWindowsPath,
  notReleasePr,
  notWindowsPath,
  releasePathReason,
  requiredChecksGreen,
  verdictEvidenceCheck,
  type LaneEvidenceRow,
  type MergeLaneContext,
} from '../moaMergeLane';
import type { PrVerdictRecord } from '../../../shared/prVerdict';

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

const verdict = (facts: PrLaneFacts, over: Partial<PrVerdictRecord> & { workspaceId?: string } = {}): PrVerdictRecord => {
  const { workspaceId = 'ws-verifier', ...rest } = over;
  return {
    version: 1, repoKey: 'github.com/openwong2kim/wmux', prNumber: facts.number, headSha: facts.headRefOid, verdict: 'pass',
    principal: { workspaceId, ptyId: `pty-${workspaceId}`, agent: 'claude' }, summary: 'all checks passed', at: 1, ...rest,
  };
};

/** A non-author PASS at the head and the asker's workspace as the author, unless overridden. */
const ctx = (facts: PrLaneFacts, over: Partial<MergeLaneContext> = {}): MergeLaneContext => ({
  expectHead: facts.headRefOid,
  trustedAuthors: ['openwong2kim'],
  askerBranches: [facts.headRefName],
  verdicts: [verdict(facts)],
  authorWorkspaces: ['ws-author'],
  ...over,
} as MergeLaneContext);

describe('merge lane predicates on recorded fixtures', () => {
  it('passes every predicate for a trusted, bound, green, independently verified PR', () => {
    const facts = openWithRequired();
    expect(evaluateMergeLane(facts, ctx(facts))).toEqual({
      ok: true, failures: [], verifiedBy: { workspaceId: 'ws-verifier', agent: 'claude', headSha: facts.headRefOid },
    });
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
      'src/main/pty/winSnapshotNative.ts', 'src/shared/wslDistro.ts', 'src/daemon/__tests__/win32Probe.os.test.ts',
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
    expect(LANE_PREDICATES).toHaveLength(9);
  });
});

describe('verifier-pass-at-head', () => {
  const facts = openWithRequired();
  const reasons = (over: Partial<MergeLaneContext>) => evaluateMergeLane(facts, ctx(facts, over)).failures
    .filter((f) => f.predicate === 'verifier-pass-at-head').map((f) => f.reason);

  it('passes on a non-author PASS at the exact head', () => {
    expect(reasons({})).toEqual([]);
  });

  it('no verdict at all blocks', () => {
    expect(reasons({ verdicts: [] })).toEqual(['no-verdict']);
  });

  it('verdicts only on another head block as stale', () => {
    expect(reasons({ verdicts: [verdict(facts, { headSha: 'b'.repeat(40) })] })).toEqual(['verdict-stale-head']);
    // The PR moved after the decision: a PASS on the decided head no longer counts.
    const moved = { ...facts, headRefOid: 'c'.repeat(40) };
    expect(evaluateMergeLane(moved, ctx(facts)).failures.map((f) => f.reason)).toContain('verdict-stale-head');
  });

  it('any FAIL at the head blocks, even when the same principal later passed it', () => {
    expect(reasons({ verdicts: [verdict(facts), verdict(facts, { workspaceId: 'ws-other', verdict: 'fail' })] })).toEqual(['verdict-fail']);
    expect(reasons({ verdicts: [verdict(facts, { verdict: 'fail', at: 1 }), verdict(facts, { verdict: 'pass', at: 2 })] })).toEqual(['verdict-fail']);
  });

  it('a PASS only from an author workspace is self-verified', () => {
    expect(reasons({ verdicts: [verdict(facts, { workspaceId: 'ws-author' })] })).toEqual(['self-verified']);
    expect(reasons({ verdicts: [verdict(facts, { workspaceId: 'ws-task' })], authorWorkspaces: ['ws-author', 'ws-task'] })).toEqual(['self-verified']);
  });

  it('an unreadable store or unknown authors block', () => {
    expect(reasons({ verdicts: null })).toEqual(['verdicts-unreadable']);
    expect(reasons({ authorWorkspaces: null })).toEqual(['author-unknown']);
  });

  it('a verdict for another PR number does not count', () => {
    expect(reasons({ verdicts: [verdict(facts, { prNumber: facts.number + 1 })] })).toEqual(['no-verdict']);
  });

  it('an owner-approved merge is not gated by it', () => {
    expect(evaluateMergeLane(facts, ctx(facts, { verdicts: null, authorWorkspaces: null }), OWNER_APPROVED_PREDICATES)).toEqual({ ok: true, failures: [] });
    expect(OWNER_APPROVED_PREDICATES).not.toContain('verifier-pass-at-head');
  });
});

describe('gate-definition-changed', () => {
  it('names each gate-definition path class', () => {
    expect(gateDefinitionPathReason('scripts/verify.sh')).toBe('verify-script');
    expect(gateDefinitionPathReason('package.json')).toBe('package-manifest');
    expect(gateDefinitionPathReason('relay/package.json')).toBe('package-manifest');
    expect(gateDefinitionPathReason('.npmrc')).toBe('npm-config');
    expect(gateDefinitionPathReason('relay/.npmrc')).toBe('npm-config');
    expect(gateDefinitionPathReason('wmux.json')).toBe('project-config');
    expect(gateDefinitionPathReason('vitest.config.ts')).toBe('test-config');
    expect(gateDefinitionPathReason('vitest.runtime.config.ts')).toBe('test-config');
    expect(gateDefinitionPathReason('.eslintrc.json')).toBe('lint-config');
    expect(gateDefinitionPathReason('eslint.config.mjs')).toBe('lint-config');
    expect(gateDefinitionPathReason('tsconfig.json')).toBe('ts-config');
    expect(gateDefinitionPathReason('tsconfig.mcp.json')).toBe('ts-config');
    expect(gateDefinitionPathReason('relay/tsconfig.json')).toBe('ts-config');
    for (const p of ['src/main/deck/moaMergeLane.ts', 'scripts/verify-wmux.sh', 'docs/package.json.md', 'src/vitest.ts']) {
      expect(gateDefinitionPathReason(p)).toBeNull();
    }
  });

  it('fails closed on a truncated or empty file list', () => {
    const facts = openWithRequired();
    expect(gateDefinitionUnchanged({ ...facts, filesTruncated: true })).toEqual({ ok: false, reason: 'files-truncated' });
    expect(gateDefinitionUnchanged({ ...facts, files: [] })).toEqual({ ok: false, reason: 'no-files' });
  });

  it('is a lane predicate with its own reason; package.json trips both it and not-release-pr', () => {
    const facts = openWithRequired({ files: ['src/a.ts', 'vitest.config.ts'] });
    expect(evaluateMergeLane(facts, ctx(facts)).failures).toEqual([{ predicate: 'gate-definition-changed', reason: 'test-config' }]);
    const pkg = openWithRequired({ files: ['package.json'] });
    expect(evaluateMergeLane(pkg, ctx(pkg)).failures).toEqual([
      { predicate: 'not-release-pr', reason: 'package-manifest' },
      { predicate: 'gate-definition-changed', reason: 'package-manifest' },
    ]);
  });

  it('an owner-approved merge does not run it', () => {
    const facts = openWithRequired({ files: ['scripts/verify.sh'] });
    expect(evaluateMergeLane(facts, ctx(facts), OWNER_APPROVED_PREDICATES).ok).toBe(true);
  });
});

describe('verifier-pass-at-head with botVerdictsOnly (evidence binding)', () => {
  const facts = openWithRequired();
  const head = facts.headRefOid;
  const botVerdict = (over: Partial<PrVerdictRecord> = {}): PrVerdictRecord => ({
    ...verdict(facts),
    version: 2,
    principal: { workspaceId: 'ws-verifier', botId: 'bot-verifier', agent: 'claude' },
    evidence: { taskId: 'task-1', gateHeadSha: head },
    ...over,
  });
  const GATE = { exitCode: 0, tail: '', at: 1, command: 'bash scripts/verify.sh', recordedBy: 'system' as const, headSha: head };
  const row = (over: Partial<LaneEvidenceRow> = {}): LaneEvidenceRow => ({
    taskId: 'task-1',
    origin: { kind: 'bot', botId: 'bot-verifier' },
    preset: 'verify',
    checkout: { sha: head, detached: true },
    gate: GATE,
    ...over,
  });
  const rows = (r: LaneEvidenceRow = row()) => new Map([[r.taskId, r]]);
  const botCtx = (over: Partial<MergeLaneContext> = {}) => ctx(facts, { botVerdictsOnly: true, verdicts: [botVerdict()], evidenceRows: rows(), ...over });
  const reasonOf = (c: MergeLaneContext) => evaluateMergeLane(facts, c).failures.find((f) => f.predicate === 'verifier-pass-at-head')?.reason;

  it('a bot PASS backed by its own verify task gate at the head counts', () => {
    expect(evaluateMergeLane(facts, botCtx())).toEqual({
      ok: true, failures: [],
      verifiedBy: { workspaceId: 'ws-verifier', agent: 'claude', headSha: head, botId: 'bot-verifier', taskId: 'task-1' },
    });
  });

  it('off (default): a pane PASS without evidence still counts, as in stage 2', () => {
    expect(evaluateMergeLane(facts, ctx(facts)).ok).toBe(true);
    expect(evaluateMergeLane(facts, ctx(facts, { botVerdictsOnly: false })).ok).toBe(true);
  });

  it('on: a PASS without evidence does not count', () => {
    expect(reasonOf(botCtx({ verdicts: [verdict(facts)] }))).toBe('verdict-no-evidence');
  });

  it('on: unreadable evidence rows refuse', () => {
    expect(reasonOf(botCtx({ evidenceRows: null }))).toBe('evidence-unreadable');
    expect(reasonOf(botCtx({ evidenceRows: undefined }))).toBe('evidence-unreadable');
  });

  it('on: every mismatch between the verdict and its task row refuses', () => {
    const cases: Array<[string, MergeLaneContext]> = [
      ['missing row', botCtx({ evidenceRows: new Map() })],
      ['human origin', botCtx({ evidenceRows: rows(row({ origin: { kind: 'human' } })) })],
      ['another bot', botCtx({ evidenceRows: rows(row({ origin: { kind: 'bot', botId: 'bot-lead' } })) })],
      ['no botId on the verdict', botCtx({ verdicts: [botVerdict({ principal: { workspaceId: 'ws-verifier', ptyId: 'pty-1', agent: 'claude' } })] })],
      ['not the verify preset', botCtx({ evidenceRows: rows(row({ preset: 'repro' })) })],
      ['branch checkout', botCtx({ evidenceRows: rows(row({ checkout: { sha: head, detached: false } })) })],
      ['no checkout', botCtx({ evidenceRows: rows(row({ checkout: null })) })],
      ['checkout at another sha', botCtx({ evidenceRows: rows(row({ checkout: { sha: 'c'.repeat(40), detached: true } })) })],
      ['evidence names another gate head', botCtx({ verdicts: [botVerdict({ evidence: { taskId: 'task-1', gateHeadSha: 'c'.repeat(40) } })] })],
      ['gate ran on another head', botCtx({ evidenceRows: rows(row({ gate: { ...GATE, headSha: 'c'.repeat(40) } })) })],
      ['gate without a head', botCtx({ evidenceRows: rows(row({ gate: { ...GATE, headSha: undefined } })) })],
      ['no gate', botCtx({ evidenceRows: rows(row({ gate: null })) })],
      ['gate not system-recorded', botCtx({ evidenceRows: rows(row({ gate: { ...GATE, recordedBy: 'worker' } })) })],
    ];
    for (const [name, c] of cases) expect(reasonOf(c), name).toBe('evidence-mismatch');
  });

  it('on: a skipped gate is not a pass, even with exit 0', () => {
    const skipped = row({ gate: { exitCode: 0, tail: '', at: 1, command: 'none', recordedBy: 'system', skipped: 'no_gate_command', headSha: head } });
    expect(reasonOf(botCtx({ evidenceRows: rows(skipped) }))).toBe('gate-skipped');
    expect(verdictEvidenceCheck(botVerdict(), rows(skipped))).toBe('gate-skipped');
  });

  it('on: a failing or killed gate refuses', () => {
    expect(reasonOf(botCtx({ evidenceRows: rows(row({ gate: { ...GATE, exitCode: 1 } })) }))).toBe('gate-failed');
    expect(reasonOf(botCtx({ evidenceRows: rows(row({ gate: { ...GATE, exitCode: null } })) }))).toBe('gate-failed');
  });

  it('on: any valid bot PASS is enough; a FAIL from anyone still blocks', () => {
    const bad = botVerdict({ evidence: { taskId: 'task-x', gateHeadSha: head } });
    expect(evaluateMergeLane(facts, botCtx({ verdicts: [bad, botVerdict()] })).ok).toBe(true);
    expect(reasonOf(botCtx({ verdicts: [botVerdict(), verdict(facts, { verdict: 'fail', workspaceId: 'ws-human' })] }))).toBe('verdict-fail');
  });

  it('on: an author bot workspace is still self-verified', () => {
    expect(reasonOf(botCtx({ authorWorkspaces: ['ws-verifier'] }))).toBe('self-verified');
  });

  it('with author bots known, a bot PASS is judged by bot: a verifier sharing the lead\'s workspace counts; an author bot does not', () => {
    expect(evaluateMergeLane(facts, botCtx({ authorWorkspaces: ['ws-verifier'], authorBots: ['bot-lead'] })).ok).toBe(true);
    expect(reasonOf(botCtx({ authorWorkspaces: [], authorBots: ['bot-verifier'] }))).toBe('self-verified');
  });

  it('with author bots known, a pane PASS (no bot) is still judged by workspace', () => {
    const paneOnly = ctx(facts, { verdicts: [verdict(facts, { workspaceId: 'ws-author' })], authorBots: ['bot-lead'] });
    expect(evaluateMergeLane(facts, paneOnly).failures.find((f) => f.predicate === 'verifier-pass-at-head')?.reason).toBe('self-verified');
  });
});
