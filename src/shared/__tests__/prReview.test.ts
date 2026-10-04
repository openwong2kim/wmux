import { describe, expect, it } from 'vitest';
import {
  LOG_TAIL_MAX_BYTES,
  LOG_TAIL_MAX_LINES,
  cleanLogTail,
  commentAnchor,
  isCommitSha,
  mergeBlock,
  numberHunkLines,
  parseRunLink,
  squashSubject,
  whoActsNext,
  type PrCheck,
  type PrReviewHead,
} from '../prReview';

const head = (over: Partial<PrReviewHead> = {}): PrReviewHead => ({
  number: 7, title: 't', url: 'u', state: 'OPEN', isDraft: false, headRefOid: 'a'.repeat(40), headRefName: 'feat', baseRefName: 'main',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', ...over,
});
const check = (bucket: PrCheck['bucket']): PrCheck => ({ name: 'n', workflow: 'w', bucket, link: 'l' });

describe('mergeBlock', () => {
  it('a clean, open, green PR can merge', () => {
    expect(mergeBlock(head(), [check('pass'), check('skipping')])).toBeNull();
  });

  it('names each reason it cannot, in order of what to fix first', () => {
    expect(mergeBlock(head({ state: 'MERGED' }), [])).toBe('not-open');
    expect(mergeBlock(head({ isDraft: true }), [])).toBe('draft');
    expect(mergeBlock(head({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), [check('fail')])).toBe('conflicts');
    expect(mergeBlock(head(), [check('pass'), check('fail')])).toBe('checks-failing');
    expect(mergeBlock(head(), [check('cancel')])).toBe('checks-failing');
    expect(mergeBlock(head({ mergeStateStatus: 'UNSTABLE' }), [])).toBe('checks-failing');
    expect(mergeBlock(head(), [check('pending')])).toBe('checks-pending');
    expect(mergeBlock(head({ mergeStateStatus: 'BEHIND' }), [])).toBe('behind');
    expect(mergeBlock(head({ mergeStateStatus: 'BLOCKED' }), [])).toBe('blocked');
    expect(mergeBlock(head({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }), [])).toBe('unknown');
  });
});

describe('small rules', () => {
  it('the squash subject is "<title> (#n)" on one line', () => {
    expect(squashSubject('feat(git):  add\n x', 1770)).toBe('feat(git): add x (#1770)');
  });

  it('a commit SHA is 40 (or 64) lowercase hex characters', () => {
    expect(isCommitSha('a'.repeat(40))).toBe(true);
    expect(isCommitSha('a'.repeat(64))).toBe(true);
    expect(isCommitSha('A'.repeat(40))).toBe(false);
    expect(isCommitSha('abc')).toBe(false);
  });

  it('a GitHub Actions link gives its run and job; any other check none', () => {
    expect(parseRunLink('https://github.com/o/r/actions/runs/123/job/456')).toEqual({ runId: '123', jobId: '456' });
    expect(parseRunLink('https://github.com/o/r/actions/runs/123')).toEqual({ runId: '123' });
    expect(parseRunLink('https://github.com/o/r/actions/runs/123/job/456?pr=7')).toEqual({ runId: '123', jobId: '456' });
    expect(parseRunLink('https://coderabbit.ai/reviews/1')).toBeNull();
    expect(parseRunLink('javascript:alert(1)')).toBeNull();
  });
});

describe('log tail', () => {
  it('strips ANSI colours, cursor moves and other control characters, keeping tabs', () => {
    const raw = '\x1b[31mError\x1b[0m: boom\r\n\x1b]0;title\x07next\tline\x00\x08\n';
    expect(cleanLogTail(raw)).toEqual({ text: 'Error: boom\nnext\tline', truncated: false });
  });

  it('keeps only the last lines, and cuts a few huge lines to the byte cap', () => {
    const many = Array.from({ length: LOG_TAIL_MAX_LINES + 50 }, (_, i) => `line ${i}`).join('\n');
    const tail = cleanLogTail(many);
    expect(tail.truncated).toBe(true);
    expect(tail.text.split('\n')).toHaveLength(LOG_TAIL_MAX_LINES);
    expect(tail.text.split('\n').at(-1)).toBe(`line ${LOG_TAIL_MAX_LINES + 49}`);
    const huge = Array.from({ length: 20 }, (_, i) => `${i}:${'x'.repeat(4_000)}`).join('\n');
    const cut = cleanLogTail(huge);
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(LOG_TAIL_MAX_BYTES);
    // Cut at a line start, never mid-line.
    expect(cut.text.startsWith('1') || /^\d+:/.test(cut.text)).toBe(true);
  });
});

describe('diff lines and where a comment goes', () => {
  const lines = numberHunkLines({ oldStart: 10, newStart: 20, bodyLines: [' same', '-gone', '+added', '+more', ' tail', '\\ No newline at end of file'] });

  it('numbers old and new lines from the hunk header', () => {
    expect(lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['ctx', 10, 20], ['del', 11, undefined], ['add', undefined, 21], ['add', undefined, 22], ['ctx', 12, 23], ['meta', undefined, undefined],
    ]);
  });

  it('a removed line is commented on the old side, the rest on the new side, meta not at all', () => {
    expect(commentAnchor(lines[1])).toEqual({ line: 11, side: 'LEFT' });
    expect(commentAnchor(lines[2])).toEqual({ line: 21, side: 'RIGHT' });
    expect(commentAnchor(lines[0])).toEqual({ line: 20, side: 'RIGHT' });
    expect(commentAnchor(lines[5])).toBeNull();
  });
});

describe('who acts next', () => {
  it('you for a decision, input or a review; the owner while working or blocked; nobody when finished', () => {
    expect(whoActsNext({ state: 'needs-you', reason: 'decision' })).toEqual({ actor: 'you', reason: 'decision' });
    expect(whoActsNext({ state: 'review' })).toEqual({ actor: 'you', reason: 'review' });
    expect(whoActsNext({ state: 'running' })).toEqual({ actor: 'owner', working: true });
    expect(whoActsNext({ state: 'blocked', reason: 'ci-failing' })).toEqual({ actor: 'owner', reason: 'ci-failing', working: false });
    expect(whoActsNext({ state: 'done' })).toBeNull();
    expect(whoActsNext({ state: 'abandoned' })).toBeNull();
  });
});
