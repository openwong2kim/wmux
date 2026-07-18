// Unit tests for the edge-triggered PR-CI feedback router. Fakes the workspace
// resolver + emit sink so the transition logic is exercised without Electron.

import { describe, it, expect, vi } from 'vitest';
import { PrCiRouter, type PrCiEmit } from '../PrCiRouter';
import type { PrStatus } from '../../../shared/types';

function pr(checks: PrStatus['checks'], over: Partial<PrStatus> = {}): PrStatus {
  return { number: 42, state: 'open', checks, url: 'https://github.com/o/r/pull/42', ...over };
}

function mk(resolve: (ptyId: string) => string | null = () => 'ws-1') {
  const emits: PrCiEmit[] = [];
  const router = new PrCiRouter(resolve, (e) => emits.push(e));
  return { router, emits };
}

describe('PrCiRouter — edge-triggered CI failure', () => {
  it('fires once on passing → failing', async () => {
    const { router, emits } = mk();
    await router.note('ptyA', pr('passing'));
    await router.note('ptyA', pr('failing'));
    expect(emits).toEqual([
      { workspaceId: 'ws-1', ptyId: 'ptyA', prNumber: 42, url: 'https://github.com/o/r/pull/42' },
    ]);
  });

  it('does NOT re-fire while it stays red', async () => {
    const { router, emits } = mk();
    await router.note('ptyA', pr('failing'));
    await router.note('ptyA', pr('failing'));
    await router.note('ptyA', pr('failing'));
    expect(emits).toHaveLength(1);
  });

  it('re-arms after leaving failing, then fires again on regression', async () => {
    const { router, emits } = mk();
    await router.note('ptyA', pr('failing'));   // fire
    await router.note('ptyA', pr('pending'));   // re-arm
    await router.note('ptyA', pr('failing'));   // fire again
    expect(emits).toHaveLength(2);
  });

  it('first observation already red still fires (none → failing)', async () => {
    const { router, emits } = mk();
    await router.note('ptyA', pr('failing'));
    expect(emits).toHaveLength(1);
  });

  it('a null PR (no PR / gh absent) re-arms without firing', async () => {
    const { router, emits } = mk();
    await router.note('ptyA', pr('failing'));   // fire
    await router.note('ptyA', null);            // re-arm, no fire
    await router.note('ptyA', pr('failing'));   // fire again
    expect(emits).toHaveLength(2);
  });

  it('drops the event when the workspace cannot be resolved (isolation)', async () => {
    const { router, emits } = mk(() => null);
    await router.note('ptyA', pr('failing'));
    expect(emits).toHaveLength(0);
  });

  it('fires again when the pane jumps from failing PR A straight to failing PR B', async () => {
    const { router, emits } = mk();
    await router.note('ptyA', pr('failing', { number: 1 }));
    await router.note('ptyA', pr('failing', { number: 2 }));
    expect(emits.map((e) => e.prNumber)).toEqual([1, 2]);
  });

  it('a transient resolve failure retries on the next tick instead of eating the red', async () => {
    let fail = true;
    const emits: PrCiEmit[] = [];
    const router = new PrCiRouter(
      () => (fail ? null : 'ws-1'),
      (e) => emits.push(e),
    );
    await router.note('ptyA', pr('failing')); // resolver down — state restored
    expect(emits).toHaveLength(0);
    fail = false;
    await router.note('ptyA', pr('failing')); // same red, next tick — retried edge fires
    expect(emits).toHaveLength(1);
    await router.note('ptyA', pr('failing')); // still red — no re-fire after success
    expect(emits).toHaveLength(1);
  });

  it('tracks each pane independently', async () => {
    const { router, emits } = mk((ptyId) => (ptyId === 'ptyA' ? 'ws-A' : 'ws-B'));
    await router.note('ptyA', pr('failing', { number: 1 }));
    await router.note('ptyB', pr('failing', { number: 2 }));
    expect(emits.map((e) => e.workspaceId).sort()).toEqual(['ws-A', 'ws-B']);
  });

  it('forget() clears the memory so a later red re-fires', async () => {
    const { router, emits } = mk();
    await router.note('ptyA', pr('failing'));
    router.forget('ptyA');
    await router.note('ptyA', pr('failing'));
    expect(emits).toHaveLength(2);
  });

  it('never throws when the resolver rejects', async () => {
    const emits: PrCiEmit[] = [];
    const router = new PrCiRouter(
      () => Promise.reject(new Error('boom')),
      (e) => emits.push(e),
    );
    await expect(router.note('ptyA', pr('failing'))).resolves.toBeUndefined();
    expect(emits).toHaveLength(0);
  });
});
