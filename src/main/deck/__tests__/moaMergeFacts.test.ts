import { describe, it, expect } from 'vitest';
import type { PrLaneFacts } from '../../../shared/prReview';
import { buildMergeFacts, laneChecksSummary, moaMergeSubject, ttlReader, type MergeFactsExtras } from '../moaMergeFacts';

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

  it('a truncated rollup blocks as checks-pending unless a stronger block applies (as the phone preview does)', () => {
    const truncated = { ...LANE, checksTruncated: true };
    expect(buildMergeFacts(truncated, EXTRAS)?.block).toBe('checks-pending');
    expect(buildMergeFacts({ ...truncated, mergeStateStatus: 'BEHIND' }, EXTRAS)?.block).toBe('checks-pending');
    expect(buildMergeFacts(truncated, { ...EXTRAS, mergeable: 'CONFLICTING' })?.block).toBe('conflicts');
    expect(buildMergeFacts({ ...truncated, checks: [check('validate', 'fail', true)] }, EXTRAS)?.block).toBe('checks-failing');
  });

  it('extras read on another head give no facts', () => {
    expect(buildMergeFacts(LANE, { ...EXTRAS, headRefOid: 'b'.repeat(40) })).toBeNull();
  });
});

describe('laneChecksSummary', () => {
  it('a truncated rollup vouches for no count: pending (or failure when one is seen), empty counts, no required lists', () => {
    expect(laneChecksSummary({ ...LANE, checksTruncated: true })).toEqual({ overall: 'pending', counts: {} });
    const failing = { ...LANE, checksTruncated: true, checks: [...LANE.checks, check('e2e', 'fail', false)] };
    expect(laneChecksSummary(failing)).toEqual({ overall: 'failure', counts: {} });
  });

  it('no checks reads none', () => {
    expect(laneChecksSummary({ ...LANE, checks: [] })).toMatchObject({ overall: 'none', counts: { total: 0 } });
  });
});

describe('moaMergeSubject', () => {
  it('collapses whitespace and falls back for an empty title: one subject for the card and the merge', () => {
    expect(moaMergeSubject('Fix  the   thing ', 7)).toBe('Fix the thing (#7)');
    expect(moaMergeSubject('', 7)).toBe('Pull request #7 (#7)');
    expect(moaMergeSubject('   ', 7)).toBe('Pull request #7 (#7)');
    expect(buildMergeFacts(LANE, { ...EXTRAS, title: '' })?.subject).toBe('Pull request #42 (#42)');
  });
});

describe('ttlReader', () => {
  it('reads once per key inside the TTL, again after it, and never keeps a null', async () => {
    let t = 0;
    const answers: Array<boolean | null> = [true, false, null, true];
    const read = async () => answers.shift() ?? null;
    const calls: string[] = [];
    const r = ttlReader(async (k: string) => { calls.push(k); return read(); }, (k) => k, 600_000, () => t);
    expect(await r('a')).toBe(true);
    t = 599_999;
    expect(await r('a')).toBe(true);
    t = 600_000;
    expect(await r('a')).toBe(false);
    t = 1_300_000;
    expect(await r('a')).toBeNull();
    expect(await r('a')).toBe(true);
    expect(calls).toHaveLength(4);
  });
});
