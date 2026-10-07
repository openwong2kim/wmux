import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mapLaneFacts, mapReviewHead } from '../GhPrReviewService';

// Recorded answers (2026-10-07): LANE_PR_QUERY for #1858 (merged) and #1829
// (open, from a fork; contributor login replaced), and `gh pr view 1858 --json
// …,author,mergedAt,mergeCommit`.
const FIXTURES = path.join(__dirname, 'fixtures/moaMergeLane');
const read = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

/** The fixture's parts the tests below edit. */
interface MutablePr {
  isCrossRepository?: boolean;
  files: { totalCount?: number };
  labels: { totalCount?: number };
  commits: { nodes: Array<{ commit: { statusCheckRollup: { contexts: { nodes: Array<Record<string, unknown>> } } | null } }> };
}
const readPr = (name: string): { raw: unknown; pr: MutablePr } => {
  const raw = read(name) as { data: { repository: { pullRequest: MutablePr } } };
  return { raw, pr: raw.data.repository.pullRequest };
};

describe('mapLaneFacts', () => {
  it('maps a merged PR: the squash commit is evidence, the head stays the branch head', () => {
    const f = mapLaneFacts(read('lane-pr1858.json'));
    expect(f).toMatchObject({
      number: 1858,
      state: 'MERGED',
      isCrossRepository: false,
      headRefOid: '995e9d9a3124628f51c0a3989bf2eced7ea2f97c',
      headRefName: 'fix/daemon-ring-geometry-1825',
      author: 'openwong2kim',
      mergedAt: '2026-10-07T09:28:40Z',
      mergeCommitOid: '6d286bee3eaa2c21d8b3ba54dd5a56f9526fa8b5',
      labels: [],
      labelsTruncated: false,
      filesTruncated: false,
      checksHeadOid: '995e9d9a3124628f51c0a3989bf2eced7ea2f97c',
      checksTruncated: false,
    });
    expect(f?.files).toHaveLength(17);
    expect(f?.checks).toHaveLength(10);
    expect(f?.checks.find((c) => c.name === 'validate')).toMatchObject({ bucket: 'pass', isRequired: false, runId: expect.any(String) });
    expect(f?.checks.find((c) => c.name === 'bench-confirm')).toMatchObject({ bucket: 'skipping', isRequired: false });
  });

  it('maps an open fork PR with a label and a StatusContext check', () => {
    const f = mapLaneFacts(read('lane-pr1829.json'));
    expect(f).toMatchObject({ state: 'OPEN', isCrossRepository: true, author: 'external-contributor', labels: ['needs-windows-verify'], mergedAt: null, mergeCommitOid: null });
    expect(f?.checks.find((c) => c.name === 'CodeRabbit')).toMatchObject({ bucket: 'pass', isRequired: false });
  });

  it('reads isRequired per node and fails closed on counts', () => {
    const { raw, pr } = readPr('lane-pr1858.json');
    const rollup = pr.commits.nodes[0].commit.statusCheckRollup;
    if (!rollup) throw new Error('fixture has no rollup');
    rollup.contexts.nodes[0].isRequired = true;
    pr.files.totalCount = 300;
    delete pr.labels.totalCount;
    const f = mapLaneFacts(raw);
    expect(f?.checks[0]).toMatchObject({ name: 'validate', isRequired: true });
    expect(f?.filesTruncated).toBe(true);
    expect(f?.labelsTruncated).toBe(true);
  });

  it('no rollup at all is no checks, not a truncated list; a fork flag that is missing reads as a fork', () => {
    const { raw, pr } = readPr('lane-pr1858.json');
    pr.commits.nodes[0].commit.statusCheckRollup = null;
    delete pr.isCrossRepository;
    const f = mapLaneFacts(raw);
    expect(f).toMatchObject({ checks: [], checksTruncated: false, isCrossRepository: true });
  });

  it('is null for anything that is not a PR', () => {
    expect(mapLaneFacts(null)).toBeNull();
    expect(mapLaneFacts({ data: { repository: { pullRequest: null } } })).toBeNull();
  });
});

describe('mapReviewHead: author and merge evidence', () => {
  it('reads author, mergedAt and the merge commit when asked for', () => {
    expect(mapReviewHead(read('view-pr1858.json'))).toMatchObject({
      number: 1858,
      state: 'MERGED',
      headRefOid: '995e9d9a3124628f51c0a3989bf2eced7ea2f97c',
      author: 'openwong2kim',
      mergedAt: '2026-10-07T09:28:40Z',
      mergeCommitOid: '6d286bee3eaa2c21d8b3ba54dd5a56f9526fa8b5',
    });
  });

  it('leaves them out when the read did not ask (the Git page\'s fields)', () => {
    const head = mapReviewHead({ number: 1, headRefOid: 'a'.repeat(40), state: 'OPEN' });
    expect(head).not.toHaveProperty('author');
    expect(head).not.toHaveProperty('mergedAt');
    expect(head).not.toHaveProperty('mergeCommitOid');
    expect(mapReviewHead({ number: 1, headRefOid: 'a'.repeat(40), mergedAt: null, mergeCommit: null })).toMatchObject({ mergedAt: null, mergeCommitOid: null });
  });
});
