// ─── DOGFOOD: end-to-end PR-CI feedback chain, real modules, production wiring ─
//
// This is NOT an isolated unit test — it boots the REAL singletons the feature
// uses in production and wires them exactly as `metadata.handler` + `deck.handler`
// do, then drives a single failing PrStatus through the whole chain:
//
//   PrCiRouter.note(failing)  →  eventBus.emit('pr.ci')  →  deck subscription
//     →  CommanderEventCoalescer.push('pr.ci_failed')  →  brain runTurn(prompt)
//
// The ONLY fakes are the leaf boundaries a test can't own: the workspace
// resolver (renderer round-trip) and the brain's runTurn (captures the prompt
// instead of spawning an SDK turn). Everything between — the real EventBus ring,
// the real coalescer state machine, the real per-workspace autonomy store — runs
// production code. Proves the mode gating (auto drives, assist reports, off
// silent) survives the full integration, not just the unit boundary.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eventBus } from '../../events/EventBus';
import { CommanderEventCoalescer } from '../CommanderEventCoalescer';
import { PrCiRouter } from '../../metadata/PrCiRouter';
import { PrReviewRouter } from '../../metadata/PrReviewRouter';
import { loadWorkspaceAutonomy, setWorkspaceMode, type AgentMode } from '../deckAutonomyStore';
import type { PrStatus } from '../../../shared/types';
import type { PrComment } from '../../../shared/prSurface';
import type { WmuxEvent } from '../../../shared/events';

const WS = 'ws-dogfood';
const PTY = 'ptyA';

const failingPr: PrStatus = {
  number: 494,
  state: 'open',
  checks: 'failing',
  url: 'https://github.com/openwong2kim/wmux/pull/494',
};

let dir: string;

/** Wire the real chain exactly like production, returning the capture points. */
function bootChain(autonomyDir: string) {
  const prompts: { ws: string; prompt: string }[] = [];

  // Real coalescer, wired like deck.handler (autonomy from the real store).
  const coalescer = new CommanderEventCoalescer({
    runTurn: async (ws, prompt) => {
      prompts.push({ ws, prompt });
      return { ok: true };
    },
    isBusy: () => false,
    getAutonomy: (ws) => loadWorkspaceAutonomy(ws, autonomyDir),
    debounceMs: 500,
    wakeBudget: 5,
  });

  // Real eventBus subscription, mirroring deck.handler's pr.* routing verbatim.
  const off = eventBus.subscribe((ev: WmuxEvent) => {
    if (ev.type === 'pr.ci') {
      coalescer.push({
        workspaceId: ev.workspaceId,
        ptyId: ev.ptyId,
        kind: 'pr.ci_failed',
        source: 'pr',
        agent: null,
        seq: ev.seq,
        ts: ev.ts,
        detail: { prNumber: ev.prNumber, url: ev.url },
      });
    }
    if (ev.type === 'pr.review') {
      coalescer.push({
        workspaceId: ev.workspaceId,
        ptyId: ev.ptyId,
        kind: 'pr.review_comment',
        source: 'pr',
        agent: null,
        seq: ev.seq,
        ts: ev.ts,
        detail: {
          prNumber: ev.prNumber,
          url: ev.url,
          count: ev.count,
          author: ev.author,
          snippet: ev.snippet,
        },
      });
    }
  });

  // Real PrCiRouter, wired like metadata.handler: resolver → WS, sink → eventBus.
  const router = new PrCiRouter(
    () => WS,
    (e) =>
      eventBus.emit({
        type: 'pr.ci',
        workspaceId: e.workspaceId,
        ptyId: e.ptyId,
        prNumber: e.prNumber,
        url: e.url,
        checks: 'failing',
      }),
  );

  return { prompts, coalescer, router, dispose: () => { off(); coalescer.dispose(); } };
}

beforeEach(() => {
  eventBus.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-prci-dogfood-'));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function drive(mode: AgentMode) {
  await setWorkspaceMode(WS, mode, dir);
  const chain = bootChain(dir);
  // First the pane is green (arm), then the poll observes red — the real edge.
  await chain.router.note(PTY, { ...failingPr, checks: 'passing' });
  await chain.router.note(PTY, failingPr);
  await vi.advanceTimersByTimeAsync(600);
  await Promise.resolve();
  await Promise.resolve();
  return chain;
}

describe('DOGFOOD — PR-CI feedback full chain (real modules)', () => {
  it('auto: a red PR wakes the brain with a fix instruction + PR pointer', async () => {
    const chain = await drive('auto');
    expect(chain.prompts).toHaveLength(1);
    const { ws, prompt } = chain.prompts[0];
    expect(ws).toBe(WS);
    expect(prompt).toContain('kind=ci-failed');
    expect(prompt).toContain('PR #494');
    expect(prompt).toContain('https://github.com/openwong2kim/wmux/pull/494');
    expect(prompt).toContain('you MAY send ONE instruction');
    chain.dispose();
  });

  it('assist: a red PR wakes the brain but frames it report-only', async () => {
    const chain = await drive('assist');
    expect(chain.prompts).toHaveLength(1);
    expect(chain.prompts[0].prompt).toContain('report only');
    expect(chain.prompts[0].prompt).not.toContain('you MAY send ONE instruction');
    chain.dispose();
  });

  it('off: a red PR is consumed silently — no brain wake', async () => {
    const chain = await drive('off');
    expect(chain.prompts).toHaveLength(0);
    chain.dispose();
  });

  it('review slice: a fresh reviewer comment wakes the auto brain through the real bus', async () => {
    await setWorkspaceMode(WS, 'auto', dir);
    const chain = bootChain(dir);

    // Real PrReviewRouter, wired like metadata.handler: fake gh provider only.
    const mkComment = (createdAt: string, body: string): PrComment => ({
      author: 'codex-reviewer', body, createdAt, url: 'https://x/c/1',
      kind: 'comment', reviewState: '', truncated: false,
    });
    let comments: PrComment[] = [mkComment('2026-07-01T00:00:00Z', 'old history')];
    let clock = 0;
    const reviewRouter = new PrReviewRouter(
      {
        listPrs: async () => ({
          ok: true as const,
          prs: [{
            number: 494, title: 't', state: 'open' as const, author: 'a',
            headRefName: 'b', updatedAt: `u${comments.length}`,
            url: failingPr.url, reviewDecision: '', checks: null, mergeable: '',
          }],
        }),
        prDetail: async () => ({ ok: true as const, detail: { number: 494, comments } }),
      },
      () => WS,
      (e) =>
        eventBus.emit({
          type: 'pr.review',
          workspaceId: e.workspaceId,
          ptyId: e.ptyId,
          prNumber: e.prNumber,
          url: e.url,
          count: e.count,
          author: e.author,
          snippet: e.snippet,
        }),
      () => clock,
    );

    await reviewRouter.note(PTY, 'D:/repo', failingPr); // arms on existing history
    comments = [...comments, mkComment('2026-07-02T00:00:00Z', 'please rename this')];
    clock += 60_000;
    await reviewRouter.note(PTY, 'D:/repo', failingPr); // fresh comment — fires
    await vi.advanceTimersByTimeAsync(600);
    await Promise.resolve();
    await Promise.resolve();

    expect(chain.prompts).toHaveLength(1);
    const p = chain.prompts[0].prompt;
    expect(p).toContain('kind=review');
    expect(p).toContain('from codex-reviewer');
    expect(p).toContain('"please rename this"');
    expect(p).toContain('address the review feedback');
    chain.dispose();
  });

  it('edge-trigger holds across the real bus: a PR that stays red wakes once', async () => {
    await setWorkspaceMode(WS, 'auto', dir);
    const chain = bootChain(dir);
    await chain.router.note(PTY, { ...failingPr, checks: 'passing' });
    await chain.router.note(PTY, failingPr); // red — fires
    await chain.router.note(PTY, failingPr); // still red — must NOT re-fire
    await chain.router.note(PTY, failingPr);
    await vi.advanceTimersByTimeAsync(600);
    await Promise.resolve();
    await Promise.resolve();
    expect(chain.prompts).toHaveLength(1);
    chain.dispose();
  });
});
