// A company task's done: main reads every GitHub PR the task names (gh
// stubbed) before the daemon sees the completed, refuses while one is not
// ready, and adds a verified inspection per PR to the evidence when all pass.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aRpc } from '../a2a.rpc';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';
import type { DaemonClient } from '../../../DaemonClient';
import type { GhPrReviewService } from '../../../github/GhPrReviewService';
import type { DonePrFacts } from '../../../../shared/companyDonePrCheck';
import type { PrReviewRead } from '../../../../shared/prReview';

const { sendToRendererMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

vi.mock('../../../../shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/constants')>()),
  getPidMapDir: () => '/tmp/wmux-test-pidmap',
}));

const fakeWindow = {} as BrowserWindow;
const worker = {
  execute: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn().mockReturnValue(true),
  isFull: false,
  stop: vi.fn(),
} as unknown as ClaudeWorker;

const HEAD = 'a'.repeat(40);
const PR_URL = 'https://github.com/acme/app/pull/12';
const E2E = 'first-run e2e (macos-15)';

const panes = [
  { id: 'pane-ceo', surfacePtyIds: ['pty-ceo'], companySeat: 'coordinator' },
  { id: 'pane-dev', surfacePtyIds: ['pty-dev'], companySeat: 'staff' },
];

const message = (id: string, role: 'user' | 'agent', parts: unknown[]) => ({ kind: 'message', messageId: id, role, parts });
const BRIEF = message('m1', 'user', [
  // The brief may cite PRs that are not this task's work.
  { kind: 'text', text: 'Fix the flaky test, like https://github.com/acme/app/pull/1 did.' },
  { kind: 'data', data: { kind: 'wmux.company.brief', v: 1, goal: 'g', scope: 's', acceptance: 'a', verify: 'v', report: 'r' } },
]);

function task(over: Record<string, unknown> = {}) {
  return {
    kind: 'task',
    id: 't1',
    history: [BRIEF],
    status: {
      state: 'input-required',
      timestamp: 'x',
      message: message('m2', 'agent', [{ kind: 'text', text: `Ready: ${PR_URL} at ${HEAD}, tests green.` }]),
    },
    artifacts: [],
    metadata: { updatedAt: 'x', from: { workspaceId: 'ws-home', paneId: 'pane-ceo' }, to: { workspaceId: 'ws-home', paneId: 'pane-dev' } },
    ...over,
  };
}

function facts(over: Partial<DonePrFacts> = {}): DonePrFacts {
  return {
    state: 'OPEN',
    isDraft: false,
    merged: false,
    mergeCommitOid: null,
    headRefOid: HEAD,
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    checksHeadOid: HEAD,
    checks: [{ name: 'build', workflow: 'CI', bucket: 'pass', link: '', isRequired: true }],
    checksTruncated: false,
    threads: { total: 0, read: 0, unresolved: 0 },
    baseRequired: ['build'],
    baseRequiredUnread: [],
    ...over,
  };
}

type DaemonCall = { method: string; params: Record<string, unknown> };

function setup(opts: {
  daemonTask?: unknown;
  rendererTask?: unknown;
  read?: PrReviewRead<DonePrFacts>;
} = {}) {
  const calls: DaemonCall[] = [];
  const donePrFacts = vi.fn<GhPrReviewService['donePrFacts']>(async () => opts.read ?? { ok: true, value: facts() });
  const dc = {
    rpc: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'a2a.task.query') {
        return opts.daemonTask === undefined
          ? { ok: true, tasks: [task()] }
          : opts.daemonTask === null
            ? { ok: false, error: 'a2a.task.query: task log unavailable' }
            : { ok: true, tasks: [opts.daemonTask] };
      }
      return { ok: true, task: { id: 't1', status: { state: params.status, timestamp: 'x' }, metadata: { updatedAt: 'x' } } };
    },
  } as unknown as DaemonClient;
  sendToRendererMock.mockImplementation(async (_w: unknown, method: string) => {
    if (method === 'pane.list') return panes;
    if (method === 'a2a.task.query') return { workspaceId: 'ws-home', tasks: opts.rendererTask ? [opts.rendererTask] : [] };
    if (method === 'a2a.task.update') return { ok: true, taskId: 't1' };
    return null;
  });
  const router = new RpcRouter();
  registerA2aRpc(router, () => fakeWindow, worker, {
    getDaemonClient: () => dc,
    prReview: { donePrFacts },
  });
  const updates = () => calls.filter((c) => c.method === 'a2a.task.update');
  return { router, calls, updates, donePrFacts };
}

const MY_ITEM = { kind: 'command', status: 'passed', summary: 'tests pass', command: 'npm test' };
const done = (over: Record<string, unknown> = {}) => ({
  taskId: 't1',
  workspaceId: 'ws-home',
  status: 'completed',
  senderPtyId: 'pty-ceo',
  evidence: { summary: 'Checked the report', items: [MY_ITEM] },
  ...over,
});
const errorOf = (res: unknown): string | undefined => (res as { result?: { error?: string } }).result?.error;

describe('a2a.task.update — a company task is done only once wmux has checked its PRs', () => {
  beforeEach(() => sendToRendererMock.mockReset());

  it('forwards the coordinator\'s done with a verified inspection of each passing PR after its own items', async () => {
    const { router, updates, donePrFacts } = setup();
    const res = await router.dispatch({ id: 'd1', method: 'a2a.task.update', params: done() });
    expect(errorOf(res)).toBeUndefined();
    // The PR the seat reported, never the one the brief cites.
    expect(donePrFacts).toHaveBeenCalledTimes(1);
    expect(donePrFacts).toHaveBeenCalledWith(expect.any(String), 'github.com/acme/app', 12);
    const inspection = {
      kind: 'inspection',
      status: 'verified',
      summary: 'wmux checked acme/app#12 at aaaaaaa: 1 required check passed, 0 open review threads, GitHub CLEAN',
      location: PR_URL,
    };
    expect(updates()).toHaveLength(1);
    expect(updates()[0].params.evidence).toEqual({ summary: 'Checked the report', items: [MY_ITEM, inspection] });
    const rendered = sendToRendererMock.mock.calls.find((c) => c[1] === 'a2a.task.update')?.[2] as Record<string, unknown>;
    expect(rendered.evidence).toEqual({ summary: 'Checked the report', items: [MY_ITEM, inspection] });
  });

  it('refuses while a PR is not ready and never calls the daemon\'s update', async () => {
    // The E2E case: the base branch requires a check that never ran on this head.
    const { router, updates } = setup({ read: { ok: true, value: facts({ baseRequired: ['build', E2E] }) } });
    const res = await router.dispatch({ id: 'd2', method: 'a2a.task.update', params: done() });
    expect(errorOf(res)).toBe(
      `a2a.task.update: wmux checked ${PR_URL} and it is not done yet: required check '${E2E}' has not run on aaaaaaa. `
      + 'Fix it, or the owner can mark the task done from their own lane.',
    );
    expect(updates()).toHaveLength(0);
    expect(sendToRendererMock.mock.calls.some((c) => c[1] === 'a2a.task.update')).toBe(false);
  });

  it('refuses when gh cannot read a PR, naming it and gh\'s error', async () => {
    const { router, updates } = setup({ read: { ok: false, code: 'error', message: 'gh: Could not resolve to a PullRequest' } });
    const res = await router.dispatch({ id: 'd3', method: 'a2a.task.update', params: done() });
    expect(errorOf(res)).toMatch(/^a2a\.task\.update: wmux could not check https:\/\/github\.com\/acme\/app\/pull\/12 through gh: gh: Could not resolve to a PullRequest\./);
    expect(updates()).toHaveLength(0);
    const limited = setup({ read: { ok: false, code: 'rate-limited', message: 'GitHub rate limit', retryAt: 1 } });
    expect(errorOf(await limited.router.dispatch({ id: 'd3b', method: 'a2a.task.update', params: done() }))).toContain('through gh: GitHub rate limit');
    expect(limited.updates()).toHaveLength(0);
  });

  it('refuses a read gh has not answered in time, so the done never lands after the caller gave up', async () => {
    vi.useFakeTimers();
    try {
      const { router, updates, donePrFacts } = setup();
      donePrFacts.mockImplementation(() => new Promise(() => undefined));
      const pending = router.dispatch({ id: 'd3c', method: 'a2a.task.update', params: done() });
      await vi.advanceTimersByTimeAsync(7_000);
      expect(errorOf(await pending)).toContain('through gh: no answer within 7 s');
      expect(updates()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the owner\'s own lane skips the check', async () => {
    const { router, calls, updates, donePrFacts } = setup({ read: { ok: true, value: facts({ isDraft: true }) } });
    const res = await router.dispatch({ id: 'd4', method: 'a2a.task.update', params: done({ senderPtyId: undefined }) }, { operator: true });
    expect(errorOf(res)).toBeUndefined();
    expect(donePrFacts).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'a2a.task.query')).toBe(false);
    expect(updates()[0].params.evidence).toEqual({ summary: 'Checked the report', items: [MY_ITEM] });
  });

  it('a staff seat\'s done goes to the daemon unchecked (it refuses that done itself)', async () => {
    const { router, calls, updates, donePrFacts } = setup();
    await router.dispatch({ id: 'd5', method: 'a2a.task.update', params: done({ senderPtyId: 'pty-dev' }) });
    expect(donePrFacts).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'a2a.task.query')).toBe(false);
    expect(updates()[0].params.callerCompanySeat).toBe('staff');
  });

  it('a task that is not a company task is left as it was', async () => {
    const plain = task({ history: [message('m1', 'user', [{ kind: 'text', text: 'Review this.' }])] });
    const { router, updates, donePrFacts } = setup({ daemonTask: plain });
    await router.dispatch({ id: 'd6', method: 'a2a.task.update', params: done() });
    expect(donePrFacts).not.toHaveBeenCalled();
    expect(updates()[0].params.evidence).toEqual({ summary: 'Checked the report', items: [MY_ITEM] });
  });

  it('checks a PR named only in a reply, which the renderer history holds and the daemon copy does not', async () => {
    const quiet = { state: 'input-required', timestamp: 'x', message: message('m2', 'agent', [{ kind: 'text', text: 'Ready, see my reply.' }]) };
    const reply = message('m3', 'agent', [{ kind: 'text', text: `PR: ${PR_URL}` }]);
    const { router, updates, donePrFacts } = setup({
      daemonTask: task({ status: quiet }),
      rendererTask: task({ status: quiet, history: [BRIEF, reply] }),
    });
    await router.dispatch({ id: 'd6b', method: 'a2a.task.update', params: done() });
    expect(donePrFacts).toHaveBeenCalledWith(expect.any(String), 'github.com/acme/app', 12);
    expect((updates()[0].params.evidence as { items: unknown[] }).items).toHaveLength(2);
  });

  it('reads the task from the renderer when the daemon does not have it', async () => {
    const { router, updates, donePrFacts } = setup({ daemonTask: null, rendererTask: task() });
    await router.dispatch({ id: 'd7', method: 'a2a.task.update', params: done() });
    expect(donePrFacts).toHaveBeenCalledWith(expect.any(String), 'github.com/acme/app', 12);
    expect((updates()[0].params.evidence as { items: unknown[] }).items).toHaveLength(2);
  });

  it('refuses the CEO\'s done when wmux can read the task from nowhere', async () => {
    const { router, updates, donePrFacts } = setup({ daemonTask: null });
    expect(errorOf(await router.dispatch({ id: 'd7b', method: 'a2a.task.update', params: done() }))).toContain('could not read task t1');
    expect(donePrFacts).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
  });

  it('refuses a PR on a host gh does not serve, before any read', async () => {
    const { router, updates, donePrFacts } = setup();
    const res = await router.dispatch({ id: 'd7c', method: 'a2a.task.update', params: done({ message: 'Also https://code.example.org/acme/app/pull/3' }) });
    expect(errorOf(res)).toContain('https://code.example.org/acme/app/pull/3 is on neither');
    expect(donePrFacts).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
  });

  it('checks a PR named only in the done call, and none for a task that names no PR', async () => {
    const quiet = task({ status: { state: 'input-required', timestamp: 'x' } });
    const named = setup({ daemonTask: quiet });
    await named.router.dispatch({
      id: 'd8',
      method: 'a2a.task.update',
      params: done({ evidence: { summary: 'Merged', items: [{ ...MY_ITEM, output: 'https://github.com/acme/app/pull/40' }] } }),
    });
    expect(named.donePrFacts).toHaveBeenCalledWith(expect.any(String), 'github.com/acme/app', 40);
    const none = setup({ daemonTask: quiet });
    await none.router.dispatch({ id: 'd9', method: 'a2a.task.update', params: done() });
    expect(none.donePrFacts).not.toHaveBeenCalled();
    expect(none.updates()[0].params.evidence).toEqual({ summary: 'Checked the report', items: [MY_ITEM] });
  });

  it('leaves a done without evidence to the daemon\'s evidence gate, reading nothing', async () => {
    const { router, calls, donePrFacts } = setup();
    await router.dispatch({ id: 'd10', method: 'a2a.task.update', params: done({ evidence: undefined }) });
    expect(donePrFacts).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'a2a.task.query')).toBe(false);
  });

  it('refuses a task that names more PRs than one done is checked against, before any gh read', async () => {
    const urls = Array.from({ length: 11 }, (_, i) => `https://github.com/acme/app/pull/${100 + i}`).join(' ');
    const { router, updates, donePrFacts } = setup();
    const res = await router.dispatch({ id: 'd11', method: 'a2a.task.update', params: done({ message: `Shipped ${urls}` }) });
    expect(errorOf(res)).toContain('this task names 12 PRs and wmux checks at most 10');
    expect(donePrFacts).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
  });
});
