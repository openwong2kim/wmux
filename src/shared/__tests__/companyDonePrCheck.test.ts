import { describe, expect, it } from 'vitest';
import {
  DONE_PR_CHECK_MAX,
  companyDonePrDecision,
  donePrRefs,
  donePrVerdict,
  tooManyDonePrs,
  withDonePrEvidence,
  type DonePrFacts,
  type DonePrRef,
} from '../companyDonePrCheck';
import { EVIDENCE_MAX_ITEMS } from '../completionEvidence';
import type { PrCheck, PrCheckBucket } from '../prReview';
import type { EvidenceItem } from '../types';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const E2E = 'first-run e2e (macos-15)';

const ref = (number: number, repo = 'app'): DonePrRef => ({
  url: `https://github.com/acme/${repo}/pull/${number}`, host: 'github.com', owner: 'acme', repo, number,
});
const PR = ref(12);

const check = (name: string, bucket: PrCheckBucket, over: Partial<PrCheck> = {}): PrCheck => ({
  name, workflow: 'CI', bucket, link: '', ...over,
});

/** An open PR ready to merge: both required checks (one from the base
 *  branch's rules only) green on the head, no threads. */
function facts(over: Partial<DonePrFacts> = {}): DonePrFacts {
  return {
    state: 'OPEN',
    isDraft: false,
    merged: false,
    mergeCommitOid: null,
    headRefOid: HEAD,
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    checksHeadOid: HEAD,
    checks: [check('build', 'pass', { isRequired: true }), check(E2E, 'pass')],
    checksTruncated: false,
    threads: { total: 0, read: 0, unresolved: 0 },
    baseRequired: ['build', E2E],
    baseRequiredUnread: [],
    ...over,
  };
}

const reasonOf = (f: DonePrFacts): string => {
  const v = donePrVerdict(PR, f);
  if (v.kind !== 'block') throw new Error(`expected a block, got ${v.kind}`);
  return v.reason;
};

describe('donePrVerdict', () => {
  it('passes an open PR whose required checks are green on its head', () => {
    expect(donePrVerdict(PR, facts())).toEqual({
      kind: 'pass',
      sha: HEAD,
      summary: 'wmux checked acme/app#12 at aaaaaaa: 2 required checks passed, 0 open review threads, GitHub CLEAN',
    });
  });

  it('passes a merged PR at its merge commit', () => {
    const v = donePrVerdict(PR, facts({ state: 'MERGED', merged: true, mergeCommitOid: MERGE, checks: [] }));
    expect(v).toEqual({ kind: 'pass', sha: MERGE, summary: 'wmux checked acme/app#12: merged as ccccccc' });
  });

  it('blocks on a required check that never ran on the head, though every check in the rollup passed', () => {
    // The base branch requires the e2e check; the branch predates it, so the rollup has no entry for it.
    const f = facts({ checks: [check('build', 'pass', { isRequired: true }), check('lint', 'pass')] });
    expect(reasonOf(f)).toBe(`required check '${E2E}' has not run on aaaaaaa`);
  });

  it('says so when the missing check may be among the checks it did not read', () => {
    const f = facts({ checks: [check('build', 'pass', { isRequired: true })], checksTruncated: true });
    expect(reasonOf(f)).toBe(`wmux read only part of the checks on aaaaaaa and required check '${E2E}' is not among them`);
  });

  it('counts a check the rollup marks required even when the base list misses it', () => {
    const f = facts({ baseRequired: [], checks: [check('build', 'fail', { isRequired: true }), check('lint', 'fail')] });
    expect(reasonOf(f)).toBe("'build' failed");
    expect(donePrVerdict(PR, facts({ baseRequired: [], checks: [check('lint', 'fail')] }))).toMatchObject({
      kind: 'pass', summary: expect.stringContaining('0 required checks passed'),
    });
  });

  it('blocks on a required check that is still running, failed or was cancelled', () => {
    expect(reasonOf(facts({ checks: [check('build', 'pending', { isRequired: true }), check(E2E, 'pass')] }))).toBe("'build' is still running");
    expect(reasonOf(facts({ checks: [check('build', 'pass'), check(E2E, 'fail')] }))).toBe(`'${E2E}' failed`);
    expect(reasonOf(facts({ checks: [check('build', 'pass'), check(E2E, 'cancel')] }))).toBe(`'${E2E}' failed`);
  });

  it('counts a skipped check as passed', () => {
    expect(donePrVerdict(PR, facts({ checks: [check('build', 'pass'), check(E2E, 'skipping')] })).kind).toBe('pass');
  });

  it('takes the newest run when a check ran more than once', () => {
    const older = { startedAt: '2026-10-30T10:00:00Z' };
    const newer = { startedAt: '2026-10-30T11:00:00Z' };
    const rerunPassed = [check(E2E, 'pass'), check('build', 'fail', older), check('build', 'pass', newer)];
    expect(donePrVerdict(PR, facts({ checks: rerunPassed })).kind).toBe('pass');
    const rerunFailed = [check(E2E, 'pass'), check('build', 'fail', newer), check('build', 'pass', older)];
    expect(reasonOf(facts({ checks: rerunFailed }))).toBe("'build' failed");
    // A rerun that has not started yet is the newest.
    const queued = [check(E2E, 'pass'), check('build', 'pass', older), check('build', 'pending')];
    expect(reasonOf(facts({ checks: queued }))).toBe("'build' is still running");
  });

  it('blocks a PR behind its base, with conflicts, or a draft', () => {
    expect(reasonOf(facts({ mergeStateStatus: 'BEHIND' }))).toBe('it is behind main; update the branch');
    expect(reasonOf(facts({ mergeStateStatus: 'DIRTY' }))).toBe('it has conflicts with main');
    expect(reasonOf(facts({ mergeable: 'CONFLICTING', mergeStateStatus: 'UNKNOWN' }))).toBe('it has conflicts with main');
    expect(reasonOf(facts({ isDraft: true, mergeStateStatus: 'DRAFT' }))).toBe('it is a draft');
  });

  it('blocks when the checks are for an older commit than the head', () => {
    expect(reasonOf(facts({ checksHeadOid: OLD }))).toBe('its checks are for an older commit than the head aaaaaaa');
  });

  it('blocks on open review threads, and on threads it could not read', () => {
    expect(reasonOf(facts({ threads: { total: 3, read: 3, unresolved: 2 } }))).toBe('2 review threads still open');
    expect(reasonOf(facts({ threads: { total: 1, read: 1, unresolved: 1 } }))).toBe('1 review thread still open');
    expect(reasonOf(facts({ threads: { total: 140, read: 100, unresolved: 0 } }))).toBe('it has 140 review threads and wmux read only 100');
    expect(reasonOf(facts({ threads: { total: null, read: 0, unresolved: 0 } }))).toBe('wmux could not count its review threads');
  });

  it('passes a BLOCKED PR that only waits on an approving review', () => {
    const v = donePrVerdict(PR, facts({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }));
    expect(v).toMatchObject({ kind: 'pass', summary: expect.stringMatching(/GitHub BLOCKED; waits on an approving review$/) });
  });

  it('blocks a BLOCKED PR waiting on review when the required list of the base branch could not be read', () => {
    const v = donePrVerdict(PR, facts({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', baseRequired: [], baseRequiredUnread: ['rulesets'] }));
    expect(v).toMatchObject({ kind: 'block', reason: expect.stringContaining('could not read the base branch') });
  });

  it('blocks a BLOCKED PR nothing it read explains, or one with changes requested', () => {
    expect(reasonOf(facts({ mergeStateStatus: 'BLOCKED' })))
      .toBe('GitHub blocks the merge for a reason wmux cannot see; check the branch rules');
    expect(reasonOf(facts({ mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED' })))
      .toMatch(/reason wmux cannot see/);
    expect(reasonOf(facts({ mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED' }))).toBe('a reviewer requested changes');
  });

  it('does not block on a merge state GitHub has not worked out yet', () => {
    expect(donePrVerdict(PR, facts({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })).kind).toBe('pass');
  });

  it('skips a PR closed without a merge', () => {
    expect(donePrVerdict(PR, facts({ state: 'CLOSED' }))).toEqual({ kind: 'skip' });
  });

  it('notes a base branch rule source it could not read', () => {
    const v = donePrVerdict(PR, facts({ baseRequiredUnread: ['branch protection', 'rulesets'] }));
    expect(v).toMatchObject({ kind: 'pass', summary: expect.stringMatching(/could not read the base branch's branch protection or rulesets$/) });
  });
});

describe('companyDonePrDecision', () => {
  it('passes with one verified inspection per PR, located at its URL', () => {
    const d = companyDonePrDecision([
      { pr: PR, read: 'ok', facts: facts() },
      { pr: ref(3, 'lib'), read: 'ok', facts: facts({ state: 'MERGED', merged: true, mergeCommitOid: MERGE }) },
    ]);
    expect(d).toEqual({
      kind: 'pass',
      items: [
        { kind: 'inspection', status: 'verified', summary: expect.stringContaining('acme/app#12 at aaaaaaa'), location: PR.url },
        { kind: 'inspection', status: 'verified', summary: 'wmux checked acme/lib#3: merged as ccccccc', location: 'https://github.com/acme/lib/pull/3' },
      ],
    });
  });

  it('names the first PR that blocks, its reason, and how many more did not pass', () => {
    const d = companyDonePrDecision([
      { pr: ref(1), read: 'ok', facts: facts() },
      { pr: ref(2), read: 'ok', facts: facts({ checks: [check('build', 'pass')] }) },
      { pr: ref(3), read: 'error', message: 'HTTP 502' },
    ]);
    expect(d).toEqual({
      kind: 'refuse',
      error: `a2a.task.update: wmux checked https://github.com/acme/app/pull/2 and it is not done yet: required check '${E2E}' has not run on aaaaaaa. `
        + 'Fix it, or the owner can mark the task done from their own lane. 1 more PR the task names did not pass either.',
    });
  });

  it('refuses when gh cannot read a PR, naming the URL and gh\'s error on one line', () => {
    const d = companyDonePrDecision([{ pr: PR, read: 'error', message: 'To get started with GitHub CLI, please run:\n  gh auth login' }]);
    expect(d).toEqual({
      kind: 'refuse',
      error: `a2a.task.update: wmux could not check ${PR.url} through gh: To get started with GitHub CLI, please run: gh auth login. `
        + 'Retry, or the owner can mark the task done from their own lane.',
    });
  });

  it('leaves out a PR closed without a merge, and refuses when every PR was', () => {
    const closed = facts({ state: 'CLOSED' });
    const some = companyDonePrDecision([{ pr: ref(1), read: 'ok', facts: closed }, { pr: ref(2), read: 'ok', facts: facts() }]);
    expect(some.kind === 'pass' && some.items.map((i) => (i as { location?: string }).location)).toEqual(['https://github.com/acme/app/pull/2']);
    const all = companyDonePrDecision([{ pr: ref(1), read: 'ok', facts: closed }, { pr: ref(2), read: 'ok', facts: closed }]);
    expect(all).toMatchObject({ kind: 'refuse', error: expect.stringContaining('every PR it names was closed without a merge') });
  });

  it('refuses a task that names more PRs than one done is checked against', () => {
    expect(tooManyDonePrs(DONE_PR_CHECK_MAX + 1)).toBe(
      'a2a.task.update: this task names 11 PRs and wmux checks at most 10 before it is marked done; the owner can mark the task done from their own lane.',
    );
  });
});

describe('donePrRefs', () => {
  const text = (t: string, id = 'm') => ({ kind: 'message', messageId: id, role: 'agent', parts: [{ kind: 'text', text: t }] });
  const brief = {
    kind: 'message', messageId: 'brief', role: 'user',
    parts: [{ kind: 'text', text: 'Like https://github.com/acme/app/pull/1 did.' }, { kind: 'data', data: { kind: 'wmux.company.brief', v: 1 } }],
  };
  const numbers = (refs: DonePrRef[]) => refs.map((r) => r.number);

  it('reads a URL out of punctuation and markdown', () => {
    const msg = 'See [#12](https://github.com/acme/app/pull/12), and **https://github.com/acme/app/pull/13**. '
      + 'Also (https://github.com/acme/app/pull/14). <https://github.com/acme/app/pull/15>; `https://github.com/acme/app/pull/16`! '
      + '"https://github.com/acme/app/pull/17": https://github.com/acme/app/pull/18?';
    expect(numbers(donePrRefs({ history: [brief], message: msg }))).toEqual([12, 13, 14, 15, 16, 17, 18]);
  });

  it('reads the PR out of a link into it: a tab, a comment, a query', () => {
    const msg = 'Files https://github.com/acme/app/pull/30/files, comment https://github.com/acme/app/pull/31#issuecomment-9 '
      + 'and checks https://github.com/acme/app/pull/32/checks?check_run_id=7.';
    const refs = donePrRefs({ history: [brief], message: msg });
    expect(numbers(refs)).toEqual([30, 31, 32]);
    expect(refs[0].url).toBe('https://github.com/acme/app/pull/30');
  });

  it('names a PR once, as first written, however often and however spelled', () => {
    const refs = donePrRefs({
      history: [brief, text('PR: https://github.com/acme/app/pull/12')],
      statusMessage: text('Ready: https://github.com/Acme/App/pull/12'),
      message: 'Done, https://github.com/acme/app/pull/12.',
    });
    expect(refs).toEqual([ref(12)]);
  });

  it('leaves out the brief, and reads every later message, the status message and data parts', () => {
    const refs = donePrRefs({
      history: [
        brief,
        text('Opened https://github.com/acme/app/pull/2'),
        { kind: 'message', messageId: 'd', role: 'agent', parts: [{ kind: 'data', data: { pr: 'https://github.com/acme/app/pull/3' } }] },
      ],
      statusMessage: text('Ready for review: https://github.com/acme/app/pull/4'),
    });
    expect(numbers(refs)).toEqual([2, 3, 4]);
  });

  it('reads the evidence summary and each item\'s summary, location and output', () => {
    const evidence = {
      summary: 'Shipped https://github.com/acme/app/pull/20',
      items: [
        { kind: 'inspection', status: 'verified', summary: 'Reviewed https://github.com/acme/app/pull/21', location: 'https://github.com/acme/app/pull/22' },
        { kind: 'command', status: 'passed', summary: 'merge', command: 'gh pr view 9', output: 'merged https://github.com/acme/app/pull/23' },
      ],
    };
    expect(numbers(donePrRefs({ history: [brief], evidence }))).toEqual([20, 21, 22, 23]);
  });

  it('reads the task\'s status evidence, a report from another PC included, after its status message, but not its command output', () => {
    const statusEvidence = {
      summary: 'Reported done on PC-B',
      items: [
        { kind: 'command', status: 'passed', summary: 'opened https://github.com/acme/app/pull/40', command: 'gh pr list', output: 'https://github.com/acme/app/pull/41' },
        { kind: 'inspection', status: 'verified', summary: 'live check', location: 'https://github.com/acme/app/pull/42' },
      ],
    };
    expect(numbers(donePrRefs({ history: [brief], statusEvidence }))).toEqual([40, 42]);
    const refs = donePrRefs({
      history: [brief, text('Opened https://github.com/acme/app/pull/2')],
      statusMessage: text('Report: https://github.com/acme/app/pull/3'),
      statusEvidence: { summary: 'https://github.com/acme/app/pull/40 and https://github.com/Acme/App/pull/2', items: [] },
      message: 'Done https://github.com/acme/app/pull/40, https://github.com/acme/app/pull/5',
      evidence: { summary: 'https://github.com/acme/app/pull/6', items: [] },
    });
    expect(numbers(refs)).toEqual([2, 3, 40, 5, 6]);
  });

  it('ignores GitLab merge requests and anything that is not a pull URL', () => {
    const msg = 'MR https://gitlab.com/acme/app/-/merge_requests/3, issue https://github.com/acme/app/issues/4, '
      + 'repo https://github.com/acme/app, http://github.com/acme/app/pull/5';
    expect(donePrRefs({ history: [brief], message: msg, evidence: 'not an object' })).toEqual([]);
  });

  it('reads nothing from a malformed message', () => {
    expect(donePrRefs({ history: [brief, 'https://github.com/acme/app/pull/2', { parts: 'x' }], statusMessage: null })).toEqual([]);
  });
});

describe('withDonePrEvidence', () => {
  const item: EvidenceItem = { kind: 'inspection', status: 'verified', summary: 'wmux checked acme/app#12', location: PR.url };
  const mine: EvidenceItem = { kind: 'command', status: 'passed', summary: 'tests', command: 'npm test' };

  it('adds wmux\'s items after the caller\'s', () => {
    const evidence = { summary: 'done', items: [mine], files: ['src/a.ts'] };
    expect(withDonePrEvidence(evidence, [item])).toEqual({ ok: true, evidence: { summary: 'done', items: [mine, item], files: ['src/a.ts'] } });
    expect(evidence.items).toEqual([mine]);
  });

  it('refuses when together they pass the item limit', () => {
    const full = { summary: 'done', items: Array.from({ length: EVIDENCE_MAX_ITEMS }, () => mine) };
    const res = withDonePrEvidence(full, [item]);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining(`the limit of ${EVIDENCE_MAX_ITEMS}`) });
    expect(withDonePrEvidence({ ...full, items: full.items.slice(1) }, [item]).ok).toBe(true);
  });
});
