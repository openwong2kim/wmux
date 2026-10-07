import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GhPrReviewService, LANE_PR_QUERY, mapLaneFacts, mapReviewHead } from '../GhPrReviewService';
import { GhRateBreaker } from '../ghRateBreaker';

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

  it('asks for and reads mergeStateStatus; a fixture without it leaves it out', () => {
    expect(LANE_PR_QUERY).toMatch(/\bmergeStateStatus\b/);
    const raw = read('lane-pr1858.json') as { data: { repository: { pullRequest: Record<string, unknown> } } };
    expect(mapLaneFacts(raw)).not.toHaveProperty('mergeStateStatus');
    raw.data.repository.pullRequest.mergeStateStatus = 'CLEAN';
    expect(mapLaneFacts(raw)?.mergeStateStatus).toBe('CLEAN');
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
    expect(mapReviewHead({ number: 1, headRefOid: 'a'.repeat(40), mergedAt: null, mergeCommit: null, author: null })).toMatchObject({ mergedAt: null, mergeCommitOid: null, author: null });
  });
});

describe('GhPrReviewService.laneFacts', () => {
  it('reads fresh on every call (no TTL cache) and maps the answer', async () => {
    const answer = JSON.stringify(read('lane-pr1858.json'));
    const exec = vi.fn(async () => ({ stdout: answer }));
    const svc = new GhPrReviewService(() => 1_000, exec as never, new GhRateBreaker(() => 1_000));
    const a = await svc.laneFacts('/repo', 'github.com/openwong2kim/wmux', 1858);
    const b = await svc.laneFacts('/repo', 'github.com/openwong2kim/wmux', 1858);
    expect(a.ok && a.value.headRefOid).toBe('995e9d9a3124628f51c0a3989bf2eced7ea2f97c');
    expect(b.ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
    const args = (exec.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(args).toContain('number=1858');
  });

  it('a non-PR answer is an error, never facts', async () => {
    const exec = vi.fn(async () => ({ stdout: JSON.stringify({ data: { repository: { pullRequest: null } } }) }));
    const svc = new GhPrReviewService(() => 1_000, exec as never, new GhRateBreaker(() => 1_000));
    const r = await svc.laneFacts('/repo', 'github.com/openwong2kim/wmux', 1);
    expect(r.ok).toBe(false);
  });
});
