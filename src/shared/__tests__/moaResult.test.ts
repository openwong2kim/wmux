import { describe, expect, it } from 'vitest';
import { resultFromEvidence, resultFromTask, resultFromWorkLink } from '../moaResult';

describe('moa task result', () => {
  it('reads the A2A completion evidence: summary, verified of all checks, files', () => {
    expect(resultFromEvidence({
      summary: 'Added subtract() to math.js',
      items: [
        { kind: 'command', status: 'passed', command: 'npm test', summary: 'tests pass' },
        { kind: 'inspection', status: 'unverified', summary: 'closing words' },
      ],
      files: ['src/math.js'],
    })).toEqual({ summary: 'Added subtract() to math.js', verified: 1, checks: 2, files: ['src/math.js'] });
    expect(resultFromEvidence(undefined)).toBeNull();
    // A full task carries it on status.evidence.
    expect(resultFromTask({ id: 't1', status: { state: 'completed', evidence: { summary: 'ok', items: [] } } }))
      .toEqual({ summary: 'ok', verified: 0, checks: 0 });
  });

  it('prefers the work link\'s durable result, read loosely; none means null', () => {
    expect(resultFromWorkLink({ result: { summary: 'done', verifiedItemCount: 2, itemCount: 3 } }))
      .toEqual({ summary: 'done', verified: 2, checks: 3 });
    expect(resultFromWorkLink({ id: 'l1' })).toBeNull();
  });
});
