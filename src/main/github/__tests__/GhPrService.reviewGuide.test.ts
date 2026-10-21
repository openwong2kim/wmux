// The Git page's review guide marker is never trusted: only a PR Moa delivered
// from this computer had a trusted guide, and Moa is gone. A body or a label
// is anyone's to write.
import { describe, it, expect, vi } from 'vitest';
import { GhPrService } from '../GhPrService';
import { REVIEW_GUIDE_MARKER } from '../../../shared/prReviewGuide';

const URL = 'https://github.com/o/r/pull/9';

function svcFor(view: Record<string, unknown>) {
  const exec = vi.fn(async (_cmd: string, args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') return { stdout: JSON.stringify({ number: 9, url: URL, comments: [], reviews: [], ...view }) };
    if (args[0] === 'api' && args[1] === 'graphql') return { stdout: JSON.stringify({ data: { repository: { pullRequest: { comments: { nodes: [] }, reviews: { nodes: [] } } } } }) };
    return { stdout: '[]' };
  });
  return new GhPrService(() => 1000, exec as never);
}

const body = `Delivered by Moa\n\n${REVIEW_GUIDE_MARKER}\n### Review order\n1. **What you asked for** — x`;

describe('GhPrService review guide trust', () => {
  it('a body carrying the marker is unverified and gets no guide', async () => {
    const d = await svcFor({ body }).prDetail('/r', 9, 'T');
    expect(d.ok && d.detail.reviewGuide).toBeUndefined();
    expect(d.ok && d.detail.reviewGuideUnverified).toBe(true);
  });

  it('no marker: neither a guide nor a warning', async () => {
    const d = await svcFor({ body: 'plain' }).prDetail('/r', 9, 'T');
    expect(d.ok && d.detail.reviewGuide).toBeUndefined();
    expect(d.ok && d.detail.reviewGuideUnverified).toBeFalsy();
  });
});
