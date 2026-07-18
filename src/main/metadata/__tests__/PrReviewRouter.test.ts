// Unit tests for the watermark-triggered review-feedback router. Fakes the gh
// provider + resolver + emit sink so the batch logic runs without subprocesses.

import { describe, it, expect } from 'vitest';
import { PrReviewRouter, sanitizeSnippet, type PrReviewEmit } from '../PrReviewRouter';
import type { PrStatus } from '../../../shared/types';
import type { PrComment } from '../../../shared/prSurface';

const CWD = 'D:/repo';

function pr(number = 42): PrStatus {
  return { number, state: 'open', checks: 'pending', url: `https://x/pull/${number}` };
}

function comment(createdAt: string, over: Partial<PrComment> = {}): PrComment {
  return {
    author: 'reviewer',
    body: 'please fix the null check',
    createdAt,
    url: 'https://x/c/1',
    kind: 'comment',
    reviewState: '',
    truncated: false,
    ...over,
  };
}

function mk(opts: {
  comments?: PrComment[];
  listOk?: boolean;
  resolve?: (ptyId: string) => string | null;
} = {}) {
  let comments = opts.comments ?? [];
  let now = 0;
  const emits: PrReviewEmit[] = [];
  const provider = {
    listPrs: async () =>
      opts.listOk === false
        ? ({ ok: false as const, error: 'x' })
        : ({
            ok: true as const,
            prs: [42, 43].map((number) => ({
              number, title: 't', state: 'open' as const, author: 'a',
              headRefName: 'b', updatedAt: `u${comments.length}`, url: `https://x/pull/${number}`,
              reviewDecision: '', checks: null,
            })),
          }),
    prDetail: async () => ({ ok: true as const, detail: { number: 42, comments } }),
  };
  const router = new PrReviewRouter(
    provider,
    opts.resolve ?? (() => 'ws-1'),
    (e) => emits.push(e),
    () => now,
  );
  return {
    router,
    emits,
    setComments: (c: PrComment[]) => { comments = c; },
    tick: (ms: number) => { now += ms; },
  };
}

describe('PrReviewRouter — watermark batch routing', () => {
  it('first sighting arms silently — existing history never fires', async () => {
    const h = mk({ comments: [comment('2026-07-01T00:00:00Z'), comment('2026-07-02T00:00:00Z')] });
    await h.router.note('ptyA', CWD, pr());
    expect(h.emits).toHaveLength(0);
  });

  it('fires once per batch of strictly-new comments, with count + latest author/snippet', async () => {
    const h = mk({ comments: [comment('2026-07-01T00:00:00Z')] });
    await h.router.note('ptyA', CWD, pr()); // arm
    h.setComments([
      comment('2026-07-01T00:00:00Z'),
      comment('2026-07-03T00:00:00Z', { author: 'codex', body: 'old one' }),
      comment('2026-07-04T00:00:00Z', { author: 'glm', body: 'newest\nfeedback' }),
    ]);
    h.tick(60_000);
    await h.router.note('ptyA', CWD, pr());
    expect(h.emits).toEqual([{
      workspaceId: 'ws-1', ptyId: 'ptyA', prNumber: 42, url: 'https://x/pull/42',
      count: 2, author: 'glm', snippet: 'newest feedback',
    }]);
  });

  it('does not re-fire for the same comments (watermark advanced)', async () => {
    const h = mk({ comments: [comment('2026-07-01T00:00:00Z')] });
    await h.router.note('ptyA', CWD, pr()); // arm
    h.setComments([comment('2026-07-01T00:00:00Z'), comment('2026-07-02T00:00:00Z')]);
    h.tick(60_000);
    await h.router.note('ptyA', CWD, pr()); // fires
    h.tick(60_000);
    await h.router.note('ptyA', CWD, pr()); // same set — silent
    expect(h.emits).toHaveLength(1);
  });

  it('throttles provider checks to the interval', async () => {
    const h = mk({ comments: [comment('2026-07-01T00:00:00Z')] });
    await h.router.note('ptyA', CWD, pr()); // arm at t=0
    h.setComments([comment('2026-07-01T00:00:00Z'), comment('2026-07-02T00:00:00Z')]);
    h.tick(5_000); // within throttle
    await h.router.note('ptyA', CWD, pr());
    expect(h.emits).toHaveLength(0); // not checked yet
    h.tick(60_000);
    await h.router.note('ptyA', CWD, pr());
    expect(h.emits).toHaveLength(1);
  });

  it('a PR-number change resets the watermark (branch switch) and the new PR arms', async () => {
    const h = mk({ comments: [comment('2026-07-01T00:00:00Z')] });
    await h.router.note('ptyA', CWD, pr(42)); // arm for 42
    h.tick(60_000);
    await h.router.note('ptyA', CWD, pr(43)); // different PR — re-arms silently on 43's history
    expect(h.emits).toHaveLength(0);
    // …and a strictly-new comment on PR 43 now fires, proving 43 actually armed.
    h.setComments([comment('2026-07-01T00:00:00Z'), comment('2026-07-05T00:00:00Z')]);
    h.tick(60_000);
    await h.router.note('ptyA', CWD, pr(43));
    expect(h.emits).toHaveLength(1);
    expect(h.emits[0].prNumber).toBe(43);
  });

  it('an EMPTY initial history still arms — the first future comment fires', async () => {
    const h = mk({ comments: [] });
    await h.router.note('ptyA', CWD, pr()); // empty history — arms at ''
    h.setComments([comment('2026-07-02T00:00:00Z')]);
    h.tick(60_000);
    await h.router.note('ptyA', CWD, pr());
    expect(h.emits).toHaveLength(1);
  });

  it('watermark advances only after a successful emit — unresolved ws retries the batch', async () => {
    let resolveOk = false;
    const h = mk({ comments: [comment('2026-07-01T00:00:00Z')], resolve: () => (resolveOk ? 'ws-1' : null) });
    await h.router.note('ptyA', CWD, pr()); // arm
    h.setComments([comment('2026-07-01T00:00:00Z'), comment('2026-07-02T00:00:00Z')]);
    h.tick(60_000);
    await h.router.note('ptyA', CWD, pr()); // resolver down — batch NOT consumed
    expect(h.emits).toHaveLength(0);
    resolveOk = true;
    h.tick(60_000);
    await h.router.note('ptyA', CWD, pr()); // same batch re-fires
    expect(h.emits).toHaveLength(1);
  });

  it('no PR drops the pane state', async () => {
    const h = mk({ comments: [comment('2026-07-01T00:00:00Z')] });
    await h.router.note('ptyA', CWD, pr()); // arm
    await h.router.note('ptyA', CWD, null); // PR gone
    h.tick(60_000);
    await h.router.note('ptyA', CWD, pr()); // fresh state — arms silently again
    expect(h.emits).toHaveLength(0);
  });

  it('unresolved workspace drops the emit (isolation)', async () => {
    const h = mk({ comments: [comment('2026-07-01T00:00:00Z')], resolve: () => null });
    await h.router.note('ptyA', CWD, pr());
    h.setComments([comment('2026-07-01T00:00:00Z'), comment('2026-07-02T00:00:00Z')]);
    h.tick(60_000);
    await h.router.note('ptyA', CWD, pr());
    expect(h.emits).toHaveLength(0);
  });

  it('a failed list result is silent and does not advance the watermark', async () => {
    const h = mk({ comments: [comment('2026-07-01T00:00:00Z')], listOk: false });
    await h.router.note('ptyA', CWD, pr());
    expect(h.emits).toHaveLength(0);
  });
});

describe('sanitizeSnippet', () => {
  it('strips control chars + newlines and collapses whitespace', () => {
    expect(sanitizeSnippet('a[31m b\n\nc\td')).toBe('a [31m b c d');
  });
  it('caps long bodies with an ellipsis', () => {
    const s = sanitizeSnippet('x'.repeat(500));
    expect(s.length).toBeLessThanOrEqual(141);
    expect(s.endsWith('…')).toBe(true);
  });
});
