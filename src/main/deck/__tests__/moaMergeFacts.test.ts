import { describe, it, expect } from 'vitest';
import type { PrLaneFacts } from '../../../shared/prReview';
import { buildMergeFacts, laneChecksSummary, type MergeFactsExtras } from '../moaMergeFacts';

const HEAD = 'a'.repeat(40);
const check = (name: string, bucket: PrLaneFacts['checks'][number]['bucket'], isRequired: boolean) => ({ name, workflow: '', bucket, link: '', isRequired });
const LANE: PrLaneFacts = {
  number: 42, state: 'OPEN', isDraft: false, isCrossRepository: false,
  headRefOid: HEAD, headRefName: 'feat/x', baseRefName: 'main', author: 'octocat', mergeStateStatus: 'CLEAN',
  mergedAt: null, mergeCommitOid: null, labels: [], labelsTruncated: false, files: ['src/a.ts'], filesTruncated: false,
  checksHeadOid: HEAD,
  checks: [check('validate', 'pass', true), check('lint', 'pass', false), check('docs', 'skipping', false)],
  checksTruncated: false,
};
const EXTRAS: MergeFactsExtras = { headRefOid: HEAD, title: '  Add   x ', mergeable: 'MERGEABLE', squashAllowed: true, login: 'octocat' };

describe('buildMergeFacts', () => {
  it('fills every PrMergeFacts field from the lane read and the extras', () => {
    expect(buildMergeFacts(LANE, EXTRAS)).toEqual({
      number: 42, title: '  Add   x ', state: 'OPEN', isDraft: false,
      headRefOid: HEAD, headRefName: 'feat/x', baseRefName: 'main',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', block: null, squashAllowed: true,
      checks: { overall: 'success', counts: { total: 3, passed: 2, failed: 0, pending: 0, skipped: 1 }, requiredFailing: [], requiredPending: [] },
      methods: ['squash'], subject: 'Add x (#42)', body: '', identity: { login: 'octocat' },
    });
  });

  it('block comes from mergeBlock on the same read', () => {
    expect(buildMergeFacts(LANE, { ...EXTRAS, mergeable: 'CONFLICTING' })?.block).toBe('conflicts');
    const failing = { ...LANE, checks: [check('validate', 'fail', true), check('e2e', 'pending', true)] };
    const f = buildMergeFacts(failing, EXTRAS);
    expect(f?.block).toBe('checks-failing');
    expect(f?.checks).toMatchObject({ overall: 'failure', requiredFailing: ['validate'], requiredPending: ['e2e'] });
  });

  it('a missing mergeStateStatus reads UNKNOWN', () => {
    const rest: PrLaneFacts = { ...LANE };
    delete rest.mergeStateStatus;
    expect(buildMergeFacts(rest, EXTRAS)).toMatchObject({ mergeStateStatus: 'UNKNOWN', block: 'unknown' });
  });

  it('extras read on another head give no facts', () => {
    expect(buildMergeFacts(LANE, { ...EXTRAS, headRefOid: 'b'.repeat(40) })).toBeNull();
  });
});

describe('laneChecksSummary', () => {
  it('omits the required lists when the rollup was truncated', () => {
    const s = laneChecksSummary({ ...LANE, checksTruncated: true });
    expect(s).not.toHaveProperty('requiredFailing');
    expect(s).not.toHaveProperty('requiredPending');
  });

  it('no checks reads none', () => {
    expect(laneChecksSummary({ ...LANE, checks: [] })).toMatchObject({ overall: 'none', counts: { total: 0 } });
  });
});
