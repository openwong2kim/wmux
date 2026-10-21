// pr.read / issue.read / ci.read / verdict.read / trustMetrics.read /
// plan.propose: who may call them (a bot with the tool, scoped to its own
// workspace's repo — Moa to any; the operator naming a workspace), and that
// every answer is bounded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RpcContext } from '../../../../shared/rpc';
import { DEFAULT_BOT_BUDGETS, type BotProfile, type BotRole } from '../../../../shared/bot';
import type { PrLaneFacts } from '../../../../shared/prReview';
import type { PrVerdictRecord } from '../../../../shared/prVerdict';
import { RoomWriter } from '../../../factory/roomWriter';
import { __resetGuestWorkspacesForTesting, expectGuestWorkspaces } from '../../../factory/guestWorkspaces';
import {
  FACTORY_READ_LIMITS,
  createHostSetupGate,
  handleCiRead,
  handleIssueRead,
  handlePlanPropose,
  handlePrRead,
  handleTrustMetricsRead,
  handleVerdictRead,
  mapCiRollup,
  type FactoryReadDeps,
} from '../factoryRead.rpc';

const SHA = 'a'.repeat(40);

function bot(id: string, role: BotRole, workspaceId: string, repoPath?: string, createdAt = 1): BotProfile {
  return {
    version: 1, id, workspaceId, role, name: role, engine: { kind: 'claude-sdk' }, triggers: [], budget: { ...DEFAULT_BOT_BUDGETS[role] },
    ...(repoPath ? { repo: { repoKey: 'x', repoPath } } : {}), enabled: true, createdAt, updatedAt: 1,
  };
}

const BOTS = [
  bot('bot-00000001', 'verifier', 'ws-a', '/repo/a'),
  bot('bot-00000002', 'triage', 'ws-a', '/repo/a'),
  bot('bot-00000003', 'lead', 'ws-b', '/repo/b'),
  bot('bot-00000004', 'moa', 'ws-hq'),
  bot('bot-00000005', 'maintainer', 'ws-a', '/repo/a'),
  bot('bot-00000006', 'lead', 'ws-a', '/repo/a'),
];

const ctxOf = (b: BotProfile): RpcContext => ({ origin: 'local', commanderWorkspace: b.workspaceId, bot: { workspaceId: b.workspaceId, botId: b.id, role: b.role } });
const OPERATOR: RpcContext = { origin: 'local', operator: true } as RpcContext;
const [VERIFIER, TRIAGE, LEAD_B, MOA, MAINTAINER] = BOTS;

const FACTS: PrLaneFacts = {
  number: 7, state: 'OPEN', isDraft: false, isCrossRepository: false, headRefOid: SHA, headRefName: 'wtask/x', baseRefName: 'main',
  author: 'owner', title: 'feat: x', mergedAt: null, mergeCommitOid: null, labels: ['a'], labelsTruncated: false,
  files: Array.from({ length: 150 }, (_, i) => `src/f${i}.ts`), filesTruncated: false, checksHeadOid: SHA,
  checks: [{ name: 'validate', workflow: 'ci', bucket: 'pass', link: '', isRequired: true }], checksTruncated: false,
};

function deps(over: Partial<FactoryReadDeps> = {}): FactoryReadDeps & { roomsDir: string } {
  const roomsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp6-read-'));
  const writer = new RoomWriter({ dir: roomsDir });
  return {
    roomsDir,
    bots: () => ({ listEnabled: () => BOTS, get: (id) => BOTS.find((b) => b.id === id) ?? null }),
    repoKeyOf: async (p) => (p === '/repo/a' ? 'github.com/o/a' : p === '/repo/b' ? 'github.com/o/b' : null),
    readPr: vi.fn(async () => ({ ok: true as const, value: FACTS })),
    listIssues: async () => ({
      ok: true as const,
      issues: Array.from({ length: 40 }, (_, i) => ({ number: i + 1, title: `issue ${i}`, state: 'open' as const, author: 'u', labels: [{ name: 'bug' }], assignees: [], updatedAt: '', url: '', comments: 0 })),
    }),
    issueDetail: async (_p, n) => ({
      ok: true as const,
      detail: {
        number: n, title: 't', state: 'open' as const, stateReason: '', author: 'u', body: 'b'.repeat(9000), bodyTruncated: false, labels: [{ name: 'bug' }],
        assignees: [], createdAt: '', closedAt: '', url: 'u',
        comments: Array.from({ length: 15 }, (_, i) => ({ author: 'c', body: `${i}`.repeat(2000), createdAt: '', url: '', truncated: false })),
      },
    }),
    ciRollup: async () => ({ branch: 'main', headSha: SHA, committedAt: null, state: 'FAILURE', checks: [{ name: 'validate', state: 'FAILURE' }, { name: 'lint', state: 'SUCCESS' }], checksTotal: 2 }),
    verdicts: async () => Array.from({ length: 25 }, (_, i) => ({
      version: 2, repoKey: 'github.com/o/a', prNumber: 7, headSha: SHA, verdict: 'pass', summary: `v${i}`, at: i,
      principal: { workspaceId: 'ws-a', botId: 'bot-00000001', agent: 'bot:verifier' }, evidence: { taskId: `t${i}`, gateHeadSha: SHA },
    } as PrVerdictRecord)),
    trust: async (_p, since, now) => ({
      ok: true as const, ref: 'origin/main', unattributedCommits: 0,
      analysis: { since, now, totals: { merged: 4, revertPrs: 0, reverted: 1, revertRate: 0.25, eligible7d: 2, survived7d: 2, survivalRate7d: 1, medianTimeToRevertHours: 3 }, reverted: [], revertPrs: [] },
    }),
    rooms: () => writer,
    postKey: () => 'wake:w-1:1',
    guestWake: () => false,
    now: () => 1_000_000,
    ...over,
  };
}

describe('role reads — who may call', () => {
  it('a caller that is neither a bot nor the operator is refused', async () => {
    expect(await handlePrRead({ prNumber: 7 }, { origin: 'local' }, deps())).toMatchObject({ ok: false, code: 'not_bot' });
    expect(await handlePrRead({ prNumber: 7 }, undefined, deps())).toMatchObject({ ok: false, code: 'not_bot' });
  });

  it('every bot holds every read, whatever its role tag', async () => {
    for (const r of [
      await handleIssueRead({}, ctxOf(VERIFIER), deps()),
      await handleCiRead({}, ctxOf(VERIFIER), deps()),
      await handleTrustMetricsRead({}, ctxOf(LEAD_B), deps()),
      await handleVerdictRead({ prNumber: 7 }, ctxOf(MAINTAINER), deps()),
    ]) {
      expect(r).not.toMatchObject({ code: 'surface' });
    }
  });

  it('a bot reads its own workspace\'s repository; another workspace is a Coordinator\'s (Moa) read', async () => {
    const d = deps();
    expect(await handlePrRead({ prNumber: 7 }, ctxOf(VERIFIER), d)).toMatchObject({ ok: true, repoKey: 'github.com/o/a', workspaceId: 'ws-a' });
    expect(d.readPr).toHaveBeenCalledWith('/repo/a', 'github.com/o/a', 7);
    expect(await handlePrRead({ prNumber: 7, workspaceId: 'ws-b' }, ctxOf(VERIFIER), d)).toMatchObject({ ok: false, code: 'cross_workspace' });
    expect(await handlePrRead({ prNumber: 7, workspaceId: 'ws-b' }, ctxOf(MOA), d)).toMatchObject({ ok: true, repoKey: 'github.com/o/b' });
    // Moa's own workspace has no repo: it names one.
    expect(await handlePrRead({ prNumber: 7 }, ctxOf(MOA), d)).toMatchObject({ ok: false, code: 'no_repo' });
  });

  it('the Coordinator read is the live profile\'s template, not the role tag', async () => {
    const promoted = BOTS.map((b) => (b.id === VERIFIER.id ? { ...b, template: 'coordinator' as const } : b.id === MOA.id ? { ...b, template: 'developer' as const } : b));
    const d = deps({ bots: () => ({ listEnabled: () => promoted, get: (id) => promoted.find((b) => b.id === id) ?? null }) });
    expect(await handlePrRead({ prNumber: 7, workspaceId: 'ws-b' }, ctxOf(VERIFIER), d)).toMatchObject({ ok: true, repoKey: 'github.com/o/b' });
    expect(await handlePrRead({ prNumber: 7, workspaceId: 'ws-b' }, ctxOf(MOA), d)).toMatchObject({ ok: false, code: 'cross_workspace' });
    for (const read of [handleIssueRead, handleCiRead, handleTrustMetricsRead]) {
      expect(await read({ workspaceId: 'ws-b' }, ctxOf(TRIAGE), deps())).toMatchObject({ ok: false, code: 'cross_workspace' });
    }
  });

  it('the repository comes from a bot profile, never from params', async () => {
    const d = deps();
    expect(await handlePrRead({ prNumber: 7, repoPath: '/etc', repoKey: 'github.com/evil/x' }, ctxOf(VERIFIER), d)).toMatchObject({ ok: true, repoKey: 'github.com/o/a' });
    expect(d.readPr).toHaveBeenCalledWith('/repo/a', 'github.com/o/a', 7);
  });

  it('a bot that is not running (unknown, disabled, other workspace) is refused', async () => {
    const ghost: RpcContext = { origin: 'local', bot: { workspaceId: 'ws-a', botId: 'bot-0000ffff', role: 'verifier' } };
    expect(await handlePrRead({ prNumber: 7 }, ghost, deps())).toMatchObject({ ok: false, code: 'not_attributed' });
    const moved: RpcContext = { origin: 'local', bot: { workspaceId: 'ws-z', botId: VERIFIER.id, role: 'verifier' } };
    expect(await handlePrRead({ prNumber: 7 }, moved, deps())).toMatchObject({ ok: false, code: 'not_attributed' });
  });

  it('the operator names the workspace', async () => {
    expect(await handlePrRead({ prNumber: 7 }, OPERATOR, deps())).toMatchObject({ ok: false, code: 'invalid' });
    expect(await handlePrRead({ prNumber: 7, workspaceId: 'ws-a' }, OPERATOR, deps())).toMatchObject({ ok: true });
    expect(await handlePrRead({ prNumber: 7, workspaceId: 'ws-nobots' }, OPERATOR, deps())).toMatchObject({ ok: false, code: 'no_repo' });
  });

  it('invalid numbers are refused before anything is read', async () => {
    const d = deps();
    for (const prNumber of [0, -1, 1.5, '7', undefined]) {
      expect(await handlePrRead({ prNumber }, ctxOf(VERIFIER), d)).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(d.readPr).not.toHaveBeenCalled();
  });
});

describe('role reads — bounded answers', () => {
  it('pr.read caps files and reports truncation', async () => {
    const r = (await handlePrRead({ prNumber: 7 }, ctxOf(VERIFIER), deps())) as { pr: { files: string[]; filesTruncated: boolean; checks: unknown[] } };
    expect(r.pr.files).toHaveLength(FACTORY_READ_LIMITS.PR_FILES);
    expect(r.pr.filesTruncated).toBe(true);
    expect(r.pr.checks).toEqual([{ name: 'validate', bucket: 'pass', required: true }]);
  });

  it('a gh failure is a refusal (rate limits named)', async () => {
    const d = deps({ readPr: async () => ({ ok: false, code: 'rate-limited', message: 'slow down', retryAt: 1 }) });
    expect(await handlePrRead({ prNumber: 7 }, ctxOf(VERIFIER), d)).toMatchObject({ ok: false, code: 'rate_limited' });
  });

  it('issue.read lists at most 30 and cuts one issue\'s body and comments', async () => {
    const list = (await handleIssueRead({}, ctxOf(TRIAGE), deps())) as { issues: unknown[]; truncated: boolean };
    expect(list.issues).toHaveLength(FACTORY_READ_LIMITS.ISSUE_LIST);
    expect(list.truncated).toBe(true);
    const one = (await handleIssueRead({ issueNumber: 3 }, ctxOf(TRIAGE), deps())) as { issue: { body: string; bodyTruncated: boolean; comments: Array<{ body: string }>; commentsTruncated: boolean } };
    expect(one.issue.body.length).toBeLessThanOrEqual(FACTORY_READ_LIMITS.ISSUE_BODY + 1);
    expect(one.issue.bodyTruncated).toBe(true);
    expect(one.issue.comments).toHaveLength(FACTORY_READ_LIMITS.ISSUE_COMMENTS);
    expect(one.issue.comments[0].body.length).toBeLessThanOrEqual(FACTORY_READ_LIMITS.ISSUE_COMMENT_BODY + 1);
  });

  it('ci.read lists the failing checks of main', async () => {
    const r = await handleCiRead({ workspaceId: 'ws-a' }, ctxOf(MOA), deps());
    expect(r).toMatchObject({ ok: true, ci: { branch: 'main', state: 'FAILURE', failing: ['validate'] } });
  });

  it('verdict.read returns the newest 20', async () => {
    const r = (await handleVerdictRead({ prNumber: 7 }, ctxOf(VERIFIER), deps())) as { verdicts: Array<{ summary: string }>; truncated: boolean };
    expect(r.verdicts).toHaveLength(FACTORY_READ_LIMITS.VERDICTS);
    expect(r.verdicts[0].summary).toBe('v24');
    expect(r.truncated).toBe(true);
  });

  it('trustMetrics.read: totals over the asked window, bounded days', async () => {
    const trust = vi.fn(deps().trust);
    const r = await handleTrustMetricsRead({ workspaceId: 'ws-a', sinceDays: 14 }, ctxOf(MOA), deps({ trust }));
    expect(r).toMatchObject({ ok: true, sinceDays: 14, totals: { merged: 4, revertRate: 0.25 } });
    expect(trust).toHaveBeenCalledWith('/repo/a', 1_000_000 - 14 * 86_400_000, 1_000_000);
    expect(await handleTrustMetricsRead({ workspaceId: 'ws-a', sinceDays: 400 }, ctxOf(MOA), deps())).toMatchObject({ ok: false, code: 'invalid' });
    const shallow = deps({ trust: async () => ({ ok: false, code: 'shallow', message: 'shallow clone' }) });
    expect(await handleTrustMetricsRead({ workspaceId: 'ws-a' }, ctxOf(MOA), shallow)).toMatchObject({ ok: false, code: 'shallow' });
  });

  it('maps the default-branch GraphQL answer', () => {
    const raw = { data: { repository: { defaultBranchRef: { name: 'main', target: { oid: SHA, committedDate: 'd', statusCheckRollup: { state: 'FAILURE', contexts: { totalCount: 2, nodes: [
      { __typename: 'CheckRun', name: 'validate', conclusion: 'FAILURE', status: 'COMPLETED' },
      { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' },
    ] } } } } } } };
    expect(mapCiRollup(raw)).toEqual({ branch: 'main', headSha: SHA, committedAt: 'd', state: 'FAILURE', checks: [{ name: 'validate', state: 'FAILURE' }, { name: 'ci/legacy', state: 'SUCCESS' }], checksTotal: 2 });
    expect(mapCiRollup({ data: {} })).toBeNull();
  });
});

describe('GitLab host gate', () => {
  const GL = 'gitlab.example.com/group/sub/proj';
  const glDeps = (over: Partial<FactoryReadDeps> = {}) => deps({ repoKeyOf: async (p) => (p === '/repo/a' ? GL : 'github.com/o/b'), ...over });

  it('asks the owner once per host while glab cannot read it, and every read gets one clear refusal', async () => {
    const gate = vi.fn(async () => ({ ok: false as const, reason: 'unauthenticated' as const, message: 'GitLab CLI is not authenticated for gitlab.example.com' }));
    const ask = vi.fn();
    const d = glDeps({ hostReady: createHostSetupGate({ gate, ask }) });
    const answers = [
      await handlePrRead({ prNumber: 7 }, ctxOf(VERIFIER), d),
      await handleIssueRead({}, ctxOf(TRIAGE), d),
      await handleCiRead({}, ctxOf(MAINTAINER), d),
      await handlePrRead({ prNumber: 8 }, ctxOf(VERIFIER), d),
    ];
    for (const a of answers) {
      expect(a).toMatchObject({ ok: false, code: 'host_not_connected' });
      expect((a as { message: string }).message).toContain('gitlab.example.com');
    }
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith('ws-a', 'gitlab.example.com', 'GitLab CLI is not authenticated for gitlab.example.com');
    expect(d.readPr).not.toHaveBeenCalled();
    // A GitHub repository never asks glab.
    expect(await handlePrRead({ prNumber: 7, workspaceId: 'ws-b' }, ctxOf(MOA), d)).toMatchObject({ ok: true, repoKey: 'github.com/o/b' });
    expect(gate).toHaveBeenCalledTimes(4);
  });

  it('reads once glab is connected, and asks again only after it breaks again', async () => {
    let ok = false;
    const gate = vi.fn(async () => (ok ? { ok: true as const } : { ok: false as const, reason: 'cli-missing' as const, message: 'GitLab CLI (glab) is not installed' }));
    const ask = vi.fn();
    const ready = createHostSetupGate({ gate, ask });
    const scope = { repoPath: '/repo/a', repoKey: GL, workspaceId: 'ws-a' };
    expect((await ready(scope))?.message).toContain('not connected');
    expect(await ready({ ...scope, workspaceId: 'ws-b' })).toMatchObject({ code: 'host_not_connected' });
    expect(ask).toHaveBeenCalledTimes(1);
    ok = true;
    expect(await ready(scope)).toBeNull();
    const d = glDeps({ hostReady: ready });
    expect(await handlePrRead({ prNumber: 7 }, ctxOf(VERIFIER), d)).toMatchObject({ ok: true, repoKey: GL });
    expect(d.readPr).toHaveBeenCalledWith('/repo/a', GL, 7);
    ok = false;
    expect((await ready(scope))?.message).toContain('not connected');
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('a host not reached just now (or a gate that throws) is a transient read_failed: no card, nothing kept', async () => {
    const ask = vi.fn();
    let blip = true;
    const ready = createHostSetupGate({
      gate: async () => (blip ? { ok: false as const, reason: 'unreachable' as const, message: 'GitLab on gitlab.example.com could not be reached just now' } : { ok: false as const, reason: 'unauthenticated' as const, message: 'signed out' }),
      ask,
    });
    const scope = { repoPath: '/repo/a', repoKey: GL, workspaceId: 'ws-a' };
    expect(await ready(scope)).toMatchObject({ code: 'read_failed', message: expect.stringContaining('could not be reached') });
    expect(await handlePrRead({ prNumber: 7 }, ctxOf(VERIFIER), glDeps({ hostReady: ready }))).toMatchObject({ ok: false, code: 'read_failed' });
    expect(ask).not.toHaveBeenCalled();
    blip = false;
    expect(await ready(scope)).toMatchObject({ code: 'host_not_connected' });
    expect(ask).toHaveBeenCalledTimes(1);
    const thrown = createHostSetupGate({ gate: async () => { throw new Error('spawn failed'); }, ask });
    expect(await thrown(scope)).toMatchObject({ code: 'read_failed' });
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe('plan.propose', () => {
  const ITEM = { workspaceId: 'ws-b', title: 'Fix the flaky test', size: 'S', why: 'it fails one run in five' };

  it('a Coordinator plans across workspaces: one open plan card in a plan thread of its room', async () => {
    const d = deps();
    const r = await handlePlanPropose({ title: 'Plan for Monday', items: [ITEM, { ...ITEM, workspaceId: 'ws-a', size: 'M' }], body: 'Two items.' }, ctxOf(MOA), d);
    expect(r).toMatchObject({ ok: true, card: { kind: 'plan', state: 'open', workspaceId: 'ws-hq', actor: { kind: 'bot', botId: MOA.id } } });
    const card = (r as { card: { threadId: string; body: string } }).card;
    expect(card.threadId).toMatch(/^plan:p-/);
    expect(card.body).toContain('1. **Fix the flaky test** — workspace `ws-b`, size S.');
    expect(card.body).toContain('Two items.');
    // Same wake key: the same card, not a second one.
    expect(await handlePlanPropose({ title: 'Plan for Monday', items: [ITEM] }, ctxOf(MOA), d)).toMatchObject({ duplicate: true });
  });

  it('a wake not known clean proposes no plan', async () => {
    for (const g of [true, 'unknown'] as const) {
      const d = deps({ guestWake: () => g });
      expect(await handlePlanPropose({ title: 'Plan', items: [ITEM] }, ctxOf(MOA), d)).toMatchObject({ ok: false, code: 'not_authorized', message: expect.stringContaining('external guest') });
      expect((d.rooms() as RoomWriter).read('ws-hq', { guests: true }).cards).toHaveLength(0);
    }
  });

  it('a newer plan supersedes the bot\'s older plan still open; another bot\'s stays open', async () => {
    let key = 0;
    const d = deps({ postKey: () => `wake:w-${++key}:1` });
    const writer = d.rooms() as RoomWriter;
    const first = (await handlePlanPropose({ title: 'Plan one', items: [ITEM] }, ctxOf(MOA), d)) as { card: { id: string } };
    const other = writer.append({ workspaceId: 'ws-hq', threadId: 'plan:p-other', kind: 'plan', actor: { kind: 'bot', workspaceId: 'ws-hq', botId: 'bot-0000beef' }, title: 'Not mine', state: 'open' })!;
    const second = (await handlePlanPropose({ title: 'Plan two', items: [ITEM] }, ctxOf(MOA), d)) as { card: { id: string; state: string } };
    expect(second.card.state).toBe('open');
    expect(writer.get('ws-hq', first.card.id)?.state).toBe('resolved');
    expect(writer.get('ws-hq', other.id)?.state).toBe('open');
    expect(writer.get('ws-hq', second.card.id)?.state).toBe('open');
    // The bot's older plan stamped guest-sourced is closed by a newer one too.
    const stamped = writer.append({ workspaceId: 'ws-hq', threadId: 'plan:p-g', kind: 'plan', actor: { kind: 'bot', workspaceId: 'ws-hq', botId: MOA.id }, title: 'Older', state: 'open', origin: 'guest' })!;
    await handlePlanPropose({ title: 'Plan three', items: [ITEM] }, ctxOf(MOA), d);
    expect(writer.get('ws-hq', stamped.id)?.state).toBe('resolved');
  });

  it('needs the live, enabled bot behind the binding', async () => {
    const ghost: RpcContext = { origin: 'local', bot: { workspaceId: 'ws-hq', botId: 'bot-0000ffff', role: 'moa' } };
    expect(await handlePlanPropose({ title: 't', items: [ITEM] }, ghost, deps())).toMatchObject({ ok: false, code: 'not_attributed' });
    const moved: RpcContext = { origin: 'local', bot: { workspaceId: 'ws-a', botId: MOA.id, role: 'moa' } };
    expect(await handlePlanPropose({ title: 't', items: [ITEM] }, moved, deps())).toMatchObject({ ok: false, code: 'not_attributed' });
    const disabled = BOTS.map((b) => (b.id === MOA.id ? { ...b, enabled: false } : b));
    const d = deps({ bots: () => ({ listEnabled: () => disabled.filter((b) => b.enabled), get: (id) => disabled.find((b) => b.id === id) ?? null }) });
    expect(await handlePlanPropose({ title: 't', items: [ITEM] }, ctxOf(MOA), d)).toMatchObject({ ok: false, code: 'not_attributed' });
  });

  it('any bot plans for its own workspace; items in another workspace are a Coordinator\'s', async () => {
    const lead = BOTS[5]; // a lead in ws-a
    const own = await handlePlanPropose({ title: 'Plan', items: [{ ...ITEM, workspaceId: 'ws-a' }] }, ctxOf(lead), deps());
    expect(own).toMatchObject({ ok: true, card: { kind: 'plan', workspaceId: 'ws-a', actor: { kind: 'bot', botId: lead.id } } });
    expect(await handlePlanPropose({ title: 'Plan', items: [ITEM] }, ctxOf(lead), deps())).toMatchObject({ ok: false, code: 'cross_workspace' });
  });

  it('a Coordinator plans nothing into a guest workspace (here: a workspace that cannot be told)', async () => {
    expectGuestWorkspaces();
    try {
      expect(await handlePlanPropose({ title: 'Plan', items: [ITEM] }, ctxOf(MOA), deps())).toMatchObject({ ok: false, code: 'cross_workspace', message: expect.stringContaining('guest workspace') });
    } finally {
      __resetGuestWorkspacesForTesting();
    }
  });

  it('refuses the operator, malformed items and a workspace with no lead', async () => {
    expect(await handlePlanPropose({ title: 't', items: [ITEM] }, OPERATOR, deps())).toMatchObject({ ok: false, code: 'surface' });
    for (const items of [[], [{ ...ITEM, size: 'XL' }], [{ ...ITEM, why: '' }], [{ ...ITEM, workspaceId: '../x' }], Array.from({ length: 11 }, () => ITEM), 'x']) {
      expect(await handlePlanPropose({ title: 't', items }, ctxOf(MOA), deps())).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(await handlePlanPropose({ title: 't', items: [{ ...ITEM, workspaceId: 'ws-hq' }] }, ctxOf(MOA), deps())).toMatchObject({ ok: false, code: 'no_lead' });
    expect(await handlePlanPropose({ items: [ITEM] }, ctxOf(MOA), deps())).toMatchObject({ ok: false, code: 'invalid' });
    expect(await handlePlanPropose({ title: 't', items: [ITEM] }, ctxOf(MOA), deps({ rooms: () => null }))).toMatchObject({ ok: false, code: 'not_started' });
  });
});
