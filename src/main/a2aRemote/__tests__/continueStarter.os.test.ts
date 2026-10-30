// The app's part of starting a conversation this PC received: the order of
// the steps, what each failing step takes back, the pane's launch line and
// its mode, the pane's hooks naming another file, and a lost `started`
// answer. Every collaborator is a fake; no git, daemon or renderer runs.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { firstRunEnvForAgent } from '../../../shared/agentFirstRun';
import { deliberateSleep } from '../../../test-utils/waitFor';
import { A2A_CONTINUE_EVENT, A2A_CONTINUE_RPC, type A2aContinueClaimV1 } from '../../../shared/a2aContinue';
import { CONTINUE_CLAIM_TIMEOUT_MS, CONTINUE_PLACE_TIMEOUT_MS, ContinueStarter, continueLaunchLine, type ContinueStarterDeps } from '../continueStarter';
import type { ContinueWorktreeMade } from '../continueWorktree';

const HOST = '11111111-1111-4111-8111-111111111111';
const CID = 'ct-9a1c2b3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const SID = '0f1e2d3c-4b5a-4697-8877-665544332211';
const PLACED = `/home/b/.claude/projects/-wt-continue-${CID}-apps/${SID}.jsonl`;
const HEAD = 'a'.repeat(40);

const claim: A2aContinueClaimV1 = {
  hostId: HOST, hostName: 'HOME-A', continueId: CID, sessionId: SID, agent: 'claude', repoPath: '/repo',
  origin: 'github.com/acme/widget', branch: 'feat', head: HEAD, sub: 'apps', permissionMode: 'acceptEdits',
};
const made: ContinueWorktreeMade = { repoPath: '/repo', continueId: CID, branch: 'feat', head: HEAD, oldTip: null };

const SHORT: Record<string, string> = Object.fromEntries(Object.entries(A2A_CONTINUE_RPC).map(([k, v]) => [v, k]));

interface Over {
  claim?: () => unknown;
  worktree?: () => unknown;
  place?: () => unknown;
  render?: () => unknown;
  binding?: () => unknown;
  started?: () => unknown;
  state?: () => unknown;
  failed?: () => unknown;
  realpath?: (p: string) => Promise<string | null>;
  rendererReady?: () => Promise<boolean>;
  close?: () => unknown;
  retryMs?: number;
}

type Call = (method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>;

const starters: ContinueStarter[] = [];
afterEach(() => {
  for (const s of starters.splice(0)) s.stop();
});

function rig(over: Over = {}) {
  const order: string[] = [];
  let listener: ((e: { type?: unknown }) => void) | undefined;
  const rpc = vi.fn<Call>(async (method) => {
    order.push(SHORT[method] ?? method);
    switch (method) {
      case A2A_CONTINUE_RPC.work: return { received: [{ hostId: HOST, continueId: CID }] };
      case A2A_CONTINUE_RPC.claim: return over.claim ? over.claim() : { ok: true, claim };
      case A2A_CONTINUE_RPC.place: return over.place ? over.place() : { ok: true, transcriptPath: PLACED };
      case A2A_CONTINUE_RPC.binding: return over.binding ? over.binding() : { transcriptPath: PLACED };
      case A2A_CONTINUE_RPC.started: return over.started ? over.started() : { ok: true };
      case A2A_CONTINUE_RPC.state: return over.state ? over.state() : {};
      case A2A_CONTINUE_RPC.failed: return over.failed ? over.failed() : { ok: true };
      default: return { ok: true };
    }
  });
  const render = vi.fn<Call>(async (method) => {
    order.push(method);
    if (method === 'workspace.close') return over.close ? over.close() : { ok: true };
    return over.render ? over.render() : { workspaceId: 'ws-new', ptyId: 'pty-1', paneId: 'pane-new' };
  });
  const worktree = vi.fn(async () => {
    order.push('worktree');
    return over.worktree ? over.worktree() : { ok: true, worktreePath: `/wt/continue-${CID}`, cwd: `/wt/continue-${CID}/apps`, made };
  });
  const removed: ContinueWorktreeMade[] = [];
  const deps: ContinueStarterDeps = {
    daemonRpc: rpc,
    sendToRenderer: render,
    onDaemonEvent: (l) => {
      listener = l;
      return () => { listener = undefined; };
    },
    rendererReady: over.rendererReady ?? (async () => true),
    createWorktree: worktree as ContinueStarterDeps['createWorktree'],
    removeWorktree: async (m) => {
      order.push('removeWorktree');
      removed.push(m);
    },
    realpath: over.realpath ?? (async (p) => p),
    platform: 'darwin',
    backstopMs: 60_000,
    retryMs: over.retryMs ?? 60_000,
    bindWaitMs: 40,
    bindPollMs: 2,
    log: () => undefined,
  };
  const starter = new ContinueStarter(deps);
  starters.push(starter);
  const calls = (method: string): unknown[] => rpc.mock.calls.filter((c) => c[0] === method).map((c) => c[1]);
  const run = async (): Promise<void> => {
    starter.start();
    await starter.whenIdle();
  };
  return { starter, rpc, render, worktree, removed, order, calls, run, emit: (type: string) => listener?.({ type }) };
}

describe('starting a received conversation', () => {
  it('claims, makes the worktree, places the files, opens the pane, waits for its binding, then reports started', async () => {
    const r = rig();
    await r.run();
    expect(r.order).toEqual(['work', 'claim', 'worktree', 'place', 'fanout.spawnWorkspace', 'binding', 'started']);
    expect(r.worktree).toHaveBeenCalledWith({ repoPath: '/repo', origin: 'github.com/acme/widget', branch: 'feat', head: HEAD, sub: 'apps', continueId: CID });
    expect(r.calls(A2A_CONTINUE_RPC.place)).toEqual([{ hostId: HOST, continueId: CID, cwd: `/wt/continue-${CID}/apps` }]);
    expect(r.calls(A2A_CONTINUE_RPC.binding)).toEqual([{ ptyId: 'pty-1' }]);
    expect(r.calls(A2A_CONTINUE_RPC.started)).toEqual([{ hostId: HOST, continueId: CID }]);
    expect(r.calls(A2A_CONTINUE_RPC.failed)).toEqual([]);
  });

  it('opens the pane resuming the placed path in this PC\'s mode, never skipping permissions', async () => {
    const r = rig();
    await r.run();
    const params = r.render.mock.calls.find((c) => c[0] === 'fanout.spawnWorkspace')?.[1] ?? {};
    expect(params).toMatchObject({
      name: 'From HOME-A',
      cwd: `/wt/continue-${CID}/apps`,
      initialCommand: `claude --resume '${PLACED}' --permission-mode acceptEdits`,
      workerPermissionMode: 'acceptEdits',
    });
    const env = firstRunEnvForAgent('claude');
    if (Object.keys(env).length > 0) expect(params['env']).toEqual(env);
    expect(JSON.stringify(params)).not.toMatch(/bypassPermissions|dangerously-skip-permissions/);
    // Not a link: nothing names the pane as another PC's remote spawn.
    expect(params).not.toHaveProperty('remoteSpawnedBy');
  });

  it('passes `default` for manual, so Claude never takes the mode the transcript was written in', async () => {
    const r = rig({ claim: () => ({ ok: true, claim: { ...claim, permissionMode: 'manual' } }) });
    await r.run();
    const params = r.render.mock.calls.find((c) => c[0] === 'fanout.spawnWorkspace')?.[1] ?? {};
    expect(params['initialCommand']).toBe(`claude --resume '${PLACED}' --permission-mode default`);
  });

  it('refuses a mode that skips permission checks before it makes anything', async () => {
    const r = rig({ claim: () => ({ ok: true, claim: { ...claim, permissionMode: 'bypassPermissions' } }) });
    await r.run();
    expect(r.order).toEqual(['work', 'claim', 'failed']);
    expect(r.calls(A2A_CONTINUE_RPC.failed)).toEqual([{ hostId: HOST, continueId: CID, code: 'failed' }]);
  });

  it('reports the worktree\'s own code, with nothing to take back', async () => {
    const r = rig({ worktree: () => ({ ok: false, code: 'diverged', detail: 'x' }) });
    await r.run();
    expect(r.order).toEqual(['work', 'claim', 'worktree', 'failed']);
    expect(r.calls(A2A_CONTINUE_RPC.failed)).toEqual([{ hostId: HOST, continueId: CID, code: 'diverged' }]);
  });

  it('removes the worktree when the files cannot be placed, and reports the placer\'s code', async () => {
    const r = rig({ place: () => ({ ok: false, code: 'no-space', error: 'full' }) });
    await r.run();
    expect(r.order).toEqual(['work', 'claim', 'worktree', 'place', 'removeWorktree', 'failed']);
    expect(r.removed).toEqual([made]);
    expect(r.calls(A2A_CONTINUE_RPC.failed)).toEqual([{ hostId: HOST, continueId: CID, code: 'no-space' }]);
  });

  it('gives the claim, the place and the unplace more time than a plain daemon call', async () => {
    const r = rig({ render: () => ({ error: 'fanout.spawnWorkspace: PTY create failed' }) });
    await r.run();
    const optsOf = (method: string): unknown[] => r.rpc.mock.calls.filter((c) => c[0] === method).map((c) => c[2]);
    expect(optsOf(A2A_CONTINUE_RPC.claim)).toEqual([{ timeoutMs: CONTINUE_CLAIM_TIMEOUT_MS }]);
    expect(optsOf(A2A_CONTINUE_RPC.place)).toEqual([{ timeoutMs: CONTINUE_PLACE_TIMEOUT_MS }]);
    expect(optsOf(A2A_CONTINUE_RPC.unplace)).toEqual([{ timeoutMs: CONTINUE_PLACE_TIMEOUT_MS }]);
    // Longer than the daemon client's default 10 s.
    expect(Math.min(CONTINUE_CLAIM_TIMEOUT_MS, CONTINUE_PLACE_TIMEOUT_MS)).toBeGreaterThan(10_000);
  });

  it('asks the daemon to take back a place it did not answer', async () => {
    const r = rig({ place: () => { throw new Error('RPC timeout'); } });
    await r.run();
    expect(r.order).toEqual(['work', 'claim', 'worktree', 'place', 'unplace', 'removeWorktree', 'failed']);
  });

  it('takes back the files and the worktree when the workspace does not open', async () => {
    for (const render of [() => { throw new Error('renderer gone'); }, () => ({ error: 'fanout.spawnWorkspace: PTY create failed' })]) {
      const r = rig({ render });
      await r.run();
      expect(r.order).toEqual(['work', 'claim', 'worktree', 'place', 'fanout.spawnWorkspace', 'unplace', 'removeWorktree', 'failed']);
      r.starter.stop();
    }
  });

  it('takes everything down, last made first, when the pane resumed another file', async () => {
    const r = rig({ binding: () => ({ transcriptPath: `/home/b/.claude/projects/-elsewhere/${SID}.jsonl` }) });
    await r.run();
    expect(r.order).toEqual(['work', 'claim', 'worktree', 'place', 'fanout.spawnWorkspace', 'binding', 'workspace.close', 'unplace', 'removeWorktree', 'failed']);
    // Forced: the window refuses to close a workspace whose agent runs otherwise.
    expect(r.render.mock.calls.find((c) => c[0] === 'workspace.close')?.[1]).toEqual({ id: 'ws-new', force: true });
    expect(r.calls(A2A_CONTINUE_RPC.failed)).toEqual([{ hostId: HOST, continueId: CID, code: 'failed' }]);
    expect(r.calls(A2A_CONTINUE_RPC.started)).toEqual([]);
  });

  it('takes nothing back and reports nothing when the window does not close the workspace', async () => {
    const refusals = [
      () => ({ error: 'workspace.close: refusing to close a workspace whose agent is running; pass --force' }),
      () => { throw new Error('renderer gone'); },
    ];
    for (const close of refusals) {
      const r = rig({ binding: () => ({ transcriptPath: `/home/b/.claude/projects/-elsewhere/${SID}.jsonl` }), close });
      await r.run();
      expect(r.order.slice(-2)).toEqual(['binding', 'workspace.close']);
      expect(r.calls(A2A_CONTINUE_RPC.unplace)).toEqual([]);
      expect(r.removed).toEqual([]);
      expect(r.calls(A2A_CONTINUE_RPC.failed)).toEqual([]);
      r.starter.stop();
    }
  });

  it('compares the bound path by realpath', async () => {
    const r = rig({ binding: () => ({ transcriptPath: '/link/to/it.jsonl' }), realpath: async (p) => (p === '/link/to/it.jsonl' ? PLACED : p) });
    await r.run();
    expect(r.calls(A2A_CONTINUE_RPC.started)).toEqual([{ hostId: HOST, continueId: CID }]);
  });

  it('reports started when no hook binds the pane in time: the agent runs, unproven', async () => {
    const r = rig({ binding: () => ({ transcriptPath: null }) });
    await r.run();
    expect(r.calls(A2A_CONTINUE_RPC.binding).length).toBeGreaterThan(1);
    expect(r.calls(A2A_CONTINUE_RPC.started)).toEqual([{ hostId: HOST, continueId: CID }]);
    expect(r.order).not.toContain('workspace.close');
  });

  it('takes everything down when the daemon does not store the start', async () => {
    const r = rig({ started: () => ({ ok: false, error: 'this request is not starting' }) });
    await r.run();
    expect(r.order.slice(-5)).toEqual(['state', 'workspace.close', 'unplace', 'removeWorktree', 'failed']);
  });

  it('opens no pane once it stopped (a reconnect) during the start', async () => {
    let stopNow = (): void => undefined;
    const r = rig({ place: () => { stopNow(); return { ok: true, transcriptPath: PLACED }; } });
    stopNow = () => r.starter.stop();
    await r.run();
    expect(r.order).toEqual(['work', 'claim', 'worktree', 'place', 'unplace', 'removeWorktree', 'failed']);
  });
});

describe('a started the daemon did not store', () => {
  const notStored = () => ({ ok: false, error: 'the answer could not be stored' });

  it('keeps everything while the daemon still holds the start as starting, or as started', async () => {
    for (const state of [{ state: 'starting' }, { state: 'decided', code: 'started' }]) {
      const r = rig({ started: notStored, state: () => state });
      await r.run();
      expect(r.order.slice(-2)).toEqual(['started', 'state']);
      r.starter.stop();
    }
  });

  it('takes it down without reporting again when the daemon decided it otherwise', async () => {
    const r = rig({ started: notStored, state: () => ({ state: 'decided', code: 'unknown' }) });
    await r.run();
    expect(r.order.slice(-4)).toEqual(['state', 'workspace.close', 'unplace', 'removeWorktree']);
    expect(r.calls(A2A_CONTINUE_RPC.failed)).toEqual([]);
  });
});

describe('a lost started answer', () => {
  const lost = (): never => { throw new Error('RPC timeout'); };

  it('keeps a start the daemon stored', async () => {
    const r = rig({ started: lost, state: () => ({ state: 'decided', code: 'started' }) });
    await r.run();
    expect(r.order.slice(-2)).toEqual(['started', 'state']);
    expect(r.calls(A2A_CONTINUE_RPC.failed)).toEqual([]);
  });

  it('keeps one the daemon still holds as starting: the pane runs it, and the sweep settles it started', async () => {
    const r = rig({ started: lost, state: () => ({ state: 'starting' }) });
    await r.run();
    expect(r.order.slice(-2)).toEqual(['started', 'state']);
    expect(r.calls(A2A_CONTINUE_RPC.failed)).toEqual([]);
  });

  it('takes down one the daemon decided otherwise, without reporting again', async () => {
    const r = rig({ started: lost, state: () => ({ state: 'decided', code: 'unknown' }) });
    await r.run();
    expect(r.order.slice(-4)).toEqual(['state', 'workspace.close', 'unplace', 'removeWorktree']);
    expect(r.calls(A2A_CONTINUE_RPC.failed)).toEqual([]);
  });

  it('refuses one the daemon holds no record of first, then takes it down without a second report', async () => {
    const r = rig({ started: lost, state: () => ({}) });
    await r.run();
    expect(r.order.slice(-6)).toEqual(['started', 'state', 'failed', 'workspace.close', 'unplace', 'removeWorktree']);
    expect(r.calls(A2A_CONTINUE_RPC.failed)).toEqual([{ hostId: HOST, continueId: CID, code: 'failed' }]);
  });

  it('keeps one whose refusal the daemon did not take (it stored the start meanwhile)', async () => {
    const r = rig({ started: lost, state: () => ({}), failed: () => ({ ok: false, error: 'this request is not starting' }) });
    await r.run();
    expect(r.order).not.toContain('workspace.close');
  });

  it('keeps one it cannot ask about', async () => {
    const r = rig({ started: lost, state: lost });
    await r.run();
    expect(r.calls(A2A_CONTINUE_RPC.failed)).toEqual([]);
    expect(r.order).not.toContain('workspace.close');
  });
});

describe('a lost claim answer', () => {
  const lost = (): never => { throw new Error('RPC timeout'); };

  it('gives up a request the daemon claimed meanwhile, so the other PC resumes its copy', async () => {
    const r = rig({ claim: lost, state: () => ({ state: 'starting' }), retryMs: 1 });
    await r.run();
    expect(r.order).toEqual(['work', 'claim', 'state', 'failed']);
    expect(r.calls(A2A_CONTINUE_RPC.failed)).toEqual([{ hostId: HOST, continueId: CID, code: 'failed' }]);
    await deliberateSleep(20, 'a given-up request schedules no retry: nothing should run in this window');
    expect(r.calls(A2A_CONTINUE_RPC.work)).toHaveLength(1);
  });

  it('tries again one still received, and one it cannot ask about', async () => {
    for (const state of [() => ({ state: 'received' }), lost]) {
      let n = 0;
      const r = rig({ claim: () => (++n === 1 ? lost() : { ok: true, claim }), state, retryMs: 1 });
      await r.run();
      await vi.waitFor(() => expect(r.calls(A2A_CONTINUE_RPC.started)).toHaveLength(1), { timeout: 2_000 });
      expect(r.calls(A2A_CONTINUE_RPC.failed)).toEqual([]);
      r.starter.stop();
    }
  });
});

describe('what drives a start', () => {
  it('a claim refused with a code is settled; one without is tried again through the work list', async () => {
    const refused = rig({ claim: () => ({ ok: false, error: 'expired', code: 'expired' }), retryMs: 1 });
    await refused.run();
    await deliberateSleep(20, 'a settled refusal schedules no retry: nothing should run in this window');
    expect(refused.calls(A2A_CONTINUE_RPC.work)).toHaveLength(1);

    let n = 0;
    const later = rig({ claim: () => (++n === 1 ? { ok: false, error: 'the folder was not checked now, try again' } : { ok: true, claim }), retryMs: 1 });
    await later.run();
    await vi.waitFor(() => expect(later.calls(A2A_CONTINUE_RPC.started)).toHaveLength(1), { timeout: 2_000 });
    expect(later.calls(A2A_CONTINUE_RPC.work).length).toBeGreaterThan(1);
  });

  it('claims nothing while the window cannot open a workspace yet, and starts once it can', async () => {
    for (const notYet of [async () => false, async (): Promise<boolean> => { throw new Error('RPC timeout: workspace.current'); }]) {
      let ready = false;
      const r = rig({ rendererReady: () => (ready ? Promise.resolve(true) : notYet()), retryMs: 1 });
      await r.run();
      expect(r.calls(A2A_CONTINUE_RPC.claim)).toEqual([]);
      ready = true;
      await vi.waitFor(() => expect(r.calls(A2A_CONTINUE_RPC.started)).toHaveLength(1), { timeout: 2_000 });
      expect(r.calls(A2A_CONTINUE_RPC.claim)).toHaveLength(1);
      r.starter.stop();
    }
  });

  it('the daemon\'s continue broadcast reads the work again', async () => {
    const r = rig({ claim: () => ({ ok: false, error: 'expired', code: 'expired' }) });
    await r.run();
    r.emit('something.else');
    r.emit(A2A_CONTINUE_EVENT);
    await r.starter.whenIdle();
    expect(r.calls(A2A_CONTINUE_RPC.work)).toHaveLength(2);
  });
});

describe('continueLaunchLine', () => {
  it('quotes the path for the platform\'s default shell, and refuses one that cannot be typed', () => {
    expect(continueLaunchLine('claude', "/Users/o'b/.claude/projects/x/id.jsonl", 'auto', 'darwin'))
      .toBe("claude --resume '/Users/o'\\''b/.claude/projects/x/id.jsonl' --permission-mode auto");
    expect(continueLaunchLine('claude', "C:\\Users\\o'b\\.claude\\projects\\x\\id.jsonl", 'acceptEdits', 'win32'))
      .toBe("claude --resume 'C:\\Users\\o''b\\.claude\\projects\\x\\id.jsonl' --permission-mode acceptEdits");
    expect(continueLaunchLine('claude', 'relative/id.jsonl', 'auto', 'darwin')).toBeNull();
    expect(continueLaunchLine('claude', '/a\nb/id.jsonl', 'auto', 'darwin')).toBeNull();
    expect(continueLaunchLine('claude', '/a/id.jsonl', 'bypassPermissions' as never, 'darwin')).toBeNull();
  });
});
