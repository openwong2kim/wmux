// #2398 (owner decision §6-6) — a raw terminal write to a pane whose shell
// has not started starts it (surface.ensurePty, in the renderer) and then
// writes; a read never starts it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import type { PTYManager } from '../../../pty/PTYManager';
import { WSL_RPC_TIMEOUT_MS } from '../../../../shared/wsl';
import { MCP_WRITE_DEADLINE_MS, TERMINAL_START_BUDGET_MS, TERMINAL_WRITE_DELIVERY_BUDGET_MS, terminalStartWindowMs, terminalWriteClientTimeoutMs } from '../../../../shared/terminalWriteBudget';
import { mintCommanderToken, __resetCommanderTrustForTesting } from '../../../deck/commanderTrust';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const fakeWindow = {} as BrowserWindow;
const DEFERRED_READ = { ptyId: '', text: '', deferred: true, deferredSurfaceId: 'surf-blank' };

function setup(): { router: RpcRouter; writeMock: ReturnType<typeof vi.fn> } {
  const writeMock = vi.fn();
  const pty = { get: vi.fn(() => ({ id: 'x' })), write: writeMock } as unknown as PTYManager;
  const router = new RpcRouter();
  registerInputRpc(router, pty, () => fakeWindow);
  return { router, writeMock };
}

/** The renderer: the caller's active pane has not started; ensurePty starts it. */
function renderer(ensure: () => unknown = () => ({ ptyId: 'pty-started' })): void {
  sendToRendererMock.mockImplementation((_w: unknown, method: string, params?: { ptyId?: string }) => {
    if (method === 'input.readScreen') return Promise.resolve(params?.ptyId ? { ptyId: params.ptyId, text: '' } : DEFERRED_READ);
    if (method === 'surface.ensurePty') return Promise.resolve(ensure());
    if (method === 'input.findOwnerWorkspace') return Promise.resolve({ workspaceId: 'ws-ext' });
    return Promise.resolve(null);
  });
}

const ensureCalls = () => sendToRendererMock.mock.calls.filter((c: unknown[]) => c[1] === 'surface.ensurePty');

describe('a raw write to a pane that has not started (#2398)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('input.send to the active pane starts it once, then writes to the new pty', async () => {
    renderer();
    const { router, writeMock } = setup();
    const res = await router.dispatch({ id: '1', method: 'input.send', params: { text: 'echo hi', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(true);
    expect(ensureCalls()).toHaveLength(1);
    expect(ensureCalls()[0][2]).toEqual({ surfaceId: 'surf-blank', workspaceId: 'ws-ext' });
    // A WSL create may take its whole budget: the ask must not time out first.
    expect((ensureCalls()[0][3] as { timeoutMs: number }).timeoutMs).toBeGreaterThan(WSL_RPC_TIMEOUT_MS);
    expect(writeMock).toHaveBeenCalledWith('pty-started', expect.any(String));
    expect(writeMock.mock.calls.every(([id]) => id === 'pty-started')).toBe(true);
  });

  it('input.sendKey to the active pane starts it once, then sends the key', async () => {
    renderer();
    const { router, writeMock } = setup();
    const res = await router.dispatch({ id: '2', method: 'input.sendKey', params: { key: 'ctrl+l', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(true);
    expect(ensureCalls()).toHaveLength(1);
    expect(writeMock).toHaveBeenCalledWith('pty-started', '\x0c');
  });

  it('input.send with a surfaceId (a pane name that has not started) starts that surface', async () => {
    renderer();
    const { router, writeMock } = setup();
    const res = await router.dispatch({ id: '3', method: 'input.send', params: { text: 'x', surfaceId: 'surf-named', workspaceId: 'ws-ext', senderPtyId: 'pty-self' } });
    expect(res.ok).toBe(true);
    expect(ensureCalls()[0][2]).toEqual({ surfaceId: 'surf-named', workspaceId: 'ws-ext' });
    expect(writeMock).toHaveBeenCalledWith('pty-started', expect.any(String));
  });

  it('a surfaceId without the caller workspace is refused before anything starts', async () => {
    renderer();
    const { router, writeMock } = setup();
    const res = await router.dispatch({ id: '4', method: 'input.send', params: { text: 'x', surfaceId: 'surf-named' } });
    expect(res.ok).toBe(false);
    expect(ensureCalls()).toHaveLength(0);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('a refused start writes nothing and says why', async () => {
    renderer(() => ({ error: 'the terminal could not start: session cap reached' }));
    const { router, writeMock } = setup();
    const res = await router.dispatch({ id: '5', method: 'input.send', params: { text: 'x', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain('session cap reached');
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('terminal.readEvents on it reads nothing and starts nothing', async () => {
    renderer();
    const { router } = setup();
    const res = await router.dispatch({ id: '6', method: 'terminal.readEvents', params: { workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain('has not started yet');
    expect(ensureCalls()).toHaveLength(0);
  });

  // Review item 4 — on the surface path too: the active pane, or a named one.
  it('a stop key to a pane that has not started starts nothing and says there is nothing to stop', async () => {
    renderer();
    const { router, writeMock } = setup();
    const active = await router.dispatch({ id: '20', method: 'input.sendKey', params: { key: 'ctrl+c', workspaceId: 'ws-ext' } });
    const named = await router.dispatch({ id: '21', method: 'input.sendKey', params: { key: 'escape', surfaceId: 'surf-named', workspaceId: 'ws-ext' } });
    for (const res of [active, named]) {
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).toContain('nothing to stop');
    }
    expect(ensureCalls()).toHaveLength(0);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('input.readScreen passes the deferred report through and starts nothing', async () => {
    renderer();
    const { router } = setup();
    const res = await router.dispatch({ id: '7', method: 'input.readScreen', params: { workspaceId: 'ws-ext' } });
    expect(res).toMatchObject({ ok: true, result: DEFERRED_READ });
    expect(ensureCalls()).toHaveLength(0);
  });
});

// A daemon session main holds no writable pipe to (a hidden pane's session
// left suspended, or one whose pane is not mounted at all) cannot take a
// write: a raw write by ptyId attaches it first, after the access check,
// through the renderer, and is written only once the pipe is open.
describe('a raw write by ptyId to a session with no pipe (#2398)', () => {
  beforeEach(() => vi.clearAllMocks());

  /** A daemon client whose pipe opens when the renderer attaches the session. */
  function setupDaemon(opts: { pipeOpen: boolean; attachOpensPipe?: boolean; writeReturns?: boolean }) {
    let pipeOpen = opts.pipeOpen;
    const writeToSession = vi.fn(() => opts.writeReturns ?? pipeOpen);
    // The renderer reads a blank screen, so the guard asks the daemon: no dialog.
    const folderTrustState = vi.fn(async () => ({ state: 'clear' as const }));
    // No reattach opens a pipe while a write waits for one (#3073).
    const waitForSessionPipe = vi.fn(async () => pipeOpen);
    const dc = { isConnected: true, isSessionPipeWritable: vi.fn(() => pipeOpen), writeToSession, folderTrustState, waitForSessionPipe };
    const pty = { get: vi.fn(() => undefined), write: vi.fn() } as unknown as PTYManager;
    const router = new RpcRouter();
    registerInputRpc(router, pty, () => fakeWindow, () => dc as never);
    const attach = () => {
      if (opts.attachOpensPipe !== false) pipeOpen = true;
      return { ptyId: 'pty-suspended' };
    };
    return { router, writeToSession, attach };
  }

  it('attaches it through the renderer, after the ownership check, then sends the key', async () => {
    const { router, writeToSession, attach } = setupDaemon({ pipeOpen: false });
    renderer(attach);
    const res = await router.dispatch({ id: '8', method: 'input.sendKey', params: { key: 'ctrl+l', ptyId: 'pty-suspended', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(true);
    const methods = sendToRendererMock.mock.calls.map((c: unknown[]) => c[1]);
    expect(methods.indexOf('input.findOwnerWorkspace')).toBeLessThan(methods.indexOf('surface.ensurePty'));
    expect(ensureCalls()[0][2]).toEqual({ ptyId: 'pty-suspended', promote: true });
    expect(writeToSession).toHaveBeenCalledWith('pty-suspended', '\x0c');
  });

  it('a session with a live pipe is written as before, with no renderer start', async () => {
    const { router, writeToSession } = setupDaemon({ pipeOpen: true });
    renderer();
    const res = await router.dispatch({ id: '9', method: 'input.sendKey', params: { key: 'ctrl+l', ptyId: 'pty-live', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(true);
    expect(ensureCalls()).toHaveLength(0);
    expect(writeToSession).toHaveBeenCalledWith('pty-live', '\x0c');
  });

  // Review P2: the renderer answered without attaching (no pane mounted, no
  // mark), the pipe stayed shut, writeToSession returned false — and the tool
  // reported success for input that was dropped.
  it('a session still without a pipe after the attach is refused with nothing written', async () => {
    const { router, writeToSession, attach } = setupDaemon({ pipeOpen: false, attachOpensPipe: false });
    renderer(attach);
    const calls: Array<['input.send' | 'input.sendKey', Record<string, unknown>]> = [
      ['input.sendKey', { key: 'ctrl+l', ptyId: 'pty-suspended', workspaceId: 'ws-ext' }],
      ['input.send', { text: 'echo hi', ptyId: 'pty-suspended', workspaceId: 'ws-ext' }],
    ];
    for (const [method, params] of calls) {
      const res = await router.dispatch({ id: method, method, params });
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).toContain('nothing was written');
    }
    expect(writeToSession).not.toHaveBeenCalled();
  });

  // Review item 4 — ctrl+c / escape stop something running: a suspended
  // session runs nothing, so they never start (promote) it.
  it('a stop key to a suspended session with no pipe starts nothing and says there is nothing to stop', async () => {
    const { router, writeToSession } = setupDaemon({ pipeOpen: false });
    renderer(() => ({ notRunning: true }));
    for (const key of ['ctrl+c', 'escape']) {
      const res = await router.dispatch({ id: key, method: 'input.sendKey', params: { key, ptyId: 'pty-suspended', workspaceId: 'ws-ext' } });
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).toContain('nothing to stop');
    }
    expect(ensureCalls().map((c: unknown[]) => c[2])).toEqual([
      { ptyId: 'pty-suspended', promote: false },
      { ptyId: 'pty-suspended', promote: false },
    ]);
    expect(writeToSession).not.toHaveBeenCalled();
  });

  // Re-review P2: no pipe here is not "not running". After an app restart
  // the daemon keeps every session running, detached; a pane that never
  // mounts (a task workspace outside the multiview grid) never reattaches.
  // A commander's ctrl+c to that runaway worker was answered "not running"
  // and the worker kept going.
  it('a stop key to a live session with no pipe attaches it without promoting and delivers the key', async () => {
    const { router, writeToSession, attach } = setupDaemon({ pipeOpen: false });
    renderer(attach);
    for (const [key, seq] of [['ctrl+c', '\x03'], ['escape', '\x1b']] as const) {
      const res = await router.dispatch({ id: key, method: 'input.sendKey', params: { key, ptyId: 'pty-detached', workspaceId: 'ws-ext' } });
      expect(res.ok).toBe(true);
      expect(writeToSession).toHaveBeenCalledWith('pty-detached', seq);
    }
    expect(ensureCalls()[0][2]).toEqual({ ptyId: 'pty-detached', promote: false });
  });

  it('a stop key to a live session is still delivered', async () => {
    const { router, writeToSession } = setupDaemon({ pipeOpen: true });
    renderer();
    const res = await router.dispatch({ id: '19', method: 'input.sendKey', params: { key: 'ctrl+c', ptyId: 'pty-live', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(true);
    expect(writeToSession).toHaveBeenCalledWith('pty-live', '\x03');
  });

  it('a write no pipe takes is never answered as delivered', async () => {
    const { router } = setupDaemon({ pipeOpen: true, writeReturns: false });
    renderer();
    const key = await router.dispatch({ id: '10', method: 'input.sendKey', params: { key: 'ctrl+l', ptyId: 'pty-gone', workspaceId: 'ws-ext' } });
    expect(key.ok).toBe(false);
    expect(JSON.stringify(key)).toContain('not delivered');
    const text = await router.dispatch({ id: '11', method: 'input.send', params: { text: 'echo hi', ptyId: 'pty-gone', workspaceId: 'ws-ext' } });
    expect(text.ok).toBe(false);
    expect(JSON.stringify(text)).toContain('not delivered');
  });

  // Second-model P3-5: the text went in, then the pipe closed before the
  // submit's Enter. Answered "not delivered", a caller retried and typed the
  // text twice.
  it('a pipe that closes after the text went in says the text may be on the line', async () => {
    const { router, writeToSession } = setupDaemon({ pipeOpen: true });
    writeToSession.mockImplementationOnce(() => true).mockImplementation(() => false);
    renderer();
    const res = await router.dispatch({ id: '12', method: 'input.send', params: { text: 'echo hi', submit: true, ptyId: 'pty-closing', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(false);
    expect(writeToSession).toHaveBeenNthCalledWith(1, 'pty-closing', 'echo hi');
    expect(JSON.stringify(res)).toContain('may already be on its input line');
    expect(JSON.stringify(res)).toContain('not submitted');
    expect(JSON.stringify(res)).not.toContain('not delivered');
  });

  // Mac review P3-5: a raw write's text with a line break in it may have run
  // part of it already; "not submitted" would be false.
  it('a written text with a line break is not called unsubmitted', async () => {
    const { router, writeToSession } = setupDaemon({ pipeOpen: true });
    writeToSession.mockImplementationOnce(() => true).mockImplementation(() => false);
    renderer();
    const res = await router.dispatch({ id: '13', method: 'input.send', params: { text: 'echo a\recho b', raw: true, submit: true, ptyId: 'pty-closing', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain('may have been partly submitted');
    expect(JSON.stringify(res)).not.toContain('not submitted');
  });
});

// Review P2: the MCP client gave a write its 10 s default while main waited up
// to a WSL create's budget for the pane to start; main then wrote after the
// client had reported a timeout, and a retry ran the command twice.
describe('the start phase of a raw write has one budget (#2398)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('gives the start only the shared budget, and the client waits for it plus the delivery', async () => {
    renderer();
    const { router } = setup();
    await router.dispatch({ id: '12', method: 'input.send', params: { text: 'x', workspaceId: 'ws-ext' } });
    const startWait = (ensureCalls()[0][3] as { timeoutMs: number }).timeoutMs;
    expect(startWait).toBeLessThanOrEqual(TERMINAL_START_BUDGET_MS);
    expect(startWait).toBeGreaterThan(WSL_RPC_TIMEOUT_MS);
    expect(terminalWriteClientTimeoutMs()).toBeGreaterThanOrEqual(TERMINAL_START_BUDGET_MS + TERMINAL_WRITE_DELIVERY_BUDGET_MS);
  });

  it("a start that outlasts the budget writes nothing, so the caller's retry is the only write", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    renderer(() => {
      vi.setSystemTime(Date.now() + TERMINAL_START_BUDGET_MS + 1);
      return { ptyId: 'pty-started' };
    });
    const { router, writeMock } = setup();
    const res = await router.dispatch({ id: '13', method: 'input.send', params: { text: 'echo once', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain('nothing was written');
    expect(writeMock).not.toHaveBeenCalled();
  });

  // CodeRabbit: an MCP write's window is shorter than a WSL start can take.
  // Main only stops waiting: it says the pane may still be starting and that
  // nothing was written, cancels nothing, and the retry (which joins the
  // renderer's one start per pane, useRpcBridge.deferredPane.test.ts) writes
  // exactly once.
  it('a start that outlasts the window answers still starting, nothing written; the retry writes once', async () => {
    let started = false;
    sendToRendererMock.mockImplementation((_w: unknown, method: string, params?: { ptyId?: string }, opts?: { timeoutError?: Error }) => {
      if (method === 'input.readScreen') return Promise.resolve(params?.ptyId ? { ptyId: params.ptyId, text: '' } : DEFERRED_READ);
      // The renderer's start runs past main's window the first time (main's
      // own timer rejects with the error it passed), and is up by the retry.
      if (method === 'surface.ensurePty') return started ? Promise.resolve({ ptyId: 'pty-started' }) : Promise.reject(opts?.timeoutError);
      if (method === 'input.findOwnerWorkspace') return Promise.resolve({ workspaceId: 'ws-ext' });
      return Promise.resolve(null);
    });
    const { router, writeMock } = setup();
    const first = await router.dispatch({ id: '25', method: 'input.send', params: { text: 'echo once', workspaceId: 'ws-ext', clientTimeoutMs: MCP_WRITE_DEADLINE_MS } });
    expect(first.ok).toBe(false);
    const answer = JSON.stringify(first);
    expect(answer).toContain('may still be starting');
    expect(answer).toContain('nothing was written');
    expect(answer).toContain('sending it again is safe');
    expect(writeMock).not.toHaveBeenCalled();
    // Main asked for one start and nothing else: no cancel.
    expect(sendToRendererMock.mock.calls.map((c: unknown[]) => c[1]).filter((m: unknown) => m !== 'input.readScreen' && m !== 'input.findOwnerWorkspace')).toEqual(['surface.ensurePty']);
    started = true;
    const retry = await router.dispatch({ id: '26', method: 'input.send', params: { text: 'echo once', workspaceId: 'ws-ext', clientTimeoutMs: MCP_WRITE_DEADLINE_MS } });
    expect(retry.ok).toBe(true);
    expect(writeMock.mock.calls.filter(([, data]) => String(data).includes('echo once'))).toHaveLength(1);
  });
});

// Review P2: a commander's or bot's write to a named pane that has not started
// in one of its open task workspaces: authorized by the surface's owner under
// the same lanes as a pty, before anything starts.
describe('a raw write by surface follows the pty lanes (#2398)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => __resetCommanderTrustForTesting());

  /** The surface (and the pty it starts) live in `owner`. */
  function rendererOwning(owner: string) {
    sendToRendererMock.mockImplementation((_w: unknown, method: string, params?: { ptyId?: string }) => {
      if (method === 'surface.ensurePty') return Promise.resolve({ ptyId: 'pty-task' });
      if (method === 'input.findOwnerWorkspace') return Promise.resolve({ workspaceId: owner });
      if (method === 'input.readScreen') return Promise.resolve({ ptyId: params?.ptyId ?? '', text: '' });
      return Promise.resolve(null);
    });
  }

  function setupWithLedger(taskWorkspaces: string[]) {
    const writeMock = vi.fn();
    const pty = { get: vi.fn(() => ({ id: 'x' })), write: writeMock } as unknown as PTYManager;
    const router = new RpcRouter();
    const ledger = { list: () => taskWorkspaces.map((taskWorkspaceId) => ({ ownerWorkspaceId: 'ws-commander', taskWorkspaceId, status: 'working' })) };
    registerInputRpc(router, pty, () => fakeWindow, undefined, undefined, undefined, { getLedger: () => ledger as never });
    return { router, writeMock };
  }

  it('a commander starts a surface of its open task workspace, in that workspace, then writes', async () => {
    rendererOwning('ws-task');
    const { router, writeMock } = setupWithLedger(['ws-task']);
    const token = mintCommanderToken('ws-commander');
    const res = await router.dispatch({ id: '14', method: 'input.send', params: { text: 'run the tests', surfaceId: 'surf-task', workspaceId: 'ws-commander' }, commanderToken: token } as never);
    expect(res.ok).toBe(true);
    expect(ensureCalls()[0][2]).toEqual({ surfaceId: 'surf-task', workspaceId: 'ws-task' });
    expect(writeMock).toHaveBeenCalledWith('pty-task', expect.any(String));
  });

  // Review item 5 — the owner lane's text refusals depend only on the text:
  // a write they refuse never starts the pane first.
  it("a commander's raw or control-character write to a task surface is refused before anything starts", async () => {
    rendererOwning('ws-task');
    const { router, writeMock } = setupWithLedger(['ws-task']);
    const token = mintCommanderToken('ws-commander');
    const raw = await router.dispatch({ id: '16', method: 'input.send', params: { text: 'x', raw: true, surfaceId: 'surf-task', workspaceId: 'ws-commander' }, commanderToken: token } as never);
    expect(raw.ok).toBe(false);
    expect(JSON.stringify(raw)).toContain('raw writes are not allowed on a delegated task pane');
    const ctl = await router.dispatch({ id: '17', method: 'input.send', params: { text: 'a\x1bb', surfaceId: 'surf-task', workspaceId: 'ws-commander' }, commanderToken: token } as never);
    expect(ctl.ok).toBe(false);
    expect(JSON.stringify(ctl)).toContain('control characters are not allowed');
    expect(ensureCalls()).toHaveLength(0);
    expect(writeMock).not.toHaveBeenCalled();
  });

  // Review item 4 — a stop key to a task pane that never started has nothing
  // to stop; starting the worker's shell to deliver ctrl+c to it is backwards.
  it("a commander's stop key to a task surface that has not started starts nothing", async () => {
    rendererOwning('ws-task');
    const { router, writeMock } = setupWithLedger(['ws-task']);
    const token = mintCommanderToken('ws-commander');
    const res = await router.dispatch({ id: '18', method: 'input.sendKey', params: { key: 'ctrl+c', surfaceId: 'surf-task', workspaceId: 'ws-commander' }, commanderToken: token } as never);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain('nothing to stop');
    expect(ensureCalls()).toHaveLength(0);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('a surface of a workspace the caller has no lane to is refused before anything starts', async () => {
    rendererOwning('ws-other');
    const { router, writeMock } = setupWithLedger([]);
    const res = await router.dispatch({ id: '15', method: 'input.send', params: { text: 'x', surfaceId: 'surf-other', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain('Cross-workspace terminal access is not allowed');
    expect(ensureCalls()).toHaveLength(0);
    expect(writeMock).not.toHaveBeenCalled();
  });
});

// Review item 3 — main's start window was its own fixed budget, whatever the
// caller waited: a CLI on its generic 15 s deadline gave up, and main still
// wrote, so a retry typed it twice. The caller now sends its deadline and main
// starts only within what that deadline leaves after the delivery.
describe("the start window honors the caller's deadline (#2398)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('cuts the start budget to the deadline minus the delivery, and keeps the budget without one', () => {
    expect(terminalStartWindowMs(undefined, TERMINAL_WRITE_DELIVERY_BUDGET_MS)).toBe(TERMINAL_START_BUDGET_MS);
    expect(terminalStartWindowMs(Number.NaN, TERMINAL_WRITE_DELIVERY_BUDGET_MS)).toBe(TERMINAL_START_BUDGET_MS);
    expect(terminalStartWindowMs(15_000, TERMINAL_WRITE_DELIVERY_BUDGET_MS)).toBe(5_000);
    expect(terminalStartWindowMs(terminalWriteClientTimeoutMs(), TERMINAL_WRITE_DELIVERY_BUDGET_MS)).toBe(TERMINAL_START_BUDGET_MS);
    expect(terminalStartWindowMs(10 * TERMINAL_START_BUDGET_MS, TERMINAL_WRITE_DELIVERY_BUDGET_MS)).toBe(TERMINAL_START_BUDGET_MS);
  });

  it('asks the renderer to start only within the caller deadline', async () => {
    renderer();
    const { router } = setup();
    await router.dispatch({ id: '22', method: 'input.send', params: { text: 'x', workspaceId: 'ws-ext', clientTimeoutMs: 15_000 } });
    expect((ensureCalls()[0][3] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(5_000);
  });

  it('a start that outlasts the caller deadline writes nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    renderer(() => {
      vi.setSystemTime(Date.now() + 6_000);
      return { ptyId: 'pty-started' };
    });
    const { router, writeMock } = setup();
    const send = await router.dispatch({ id: '23', method: 'input.send', params: { text: 'echo once', workspaceId: 'ws-ext', clientTimeoutMs: 15_000 } });
    expect(send.ok).toBe(false);
    expect(JSON.stringify(send)).toContain('nothing was written');
    const key = await router.dispatch({ id: '24', method: 'input.sendKey', params: { key: 'enter', workspaceId: 'ws-ext', clientTimeoutMs: 15_000 } });
    expect(key.ok).toBe(false);
    expect(JSON.stringify(key)).toContain('nothing was written');
    expect(writeMock).not.toHaveBeenCalled();
  });
});

// #3073 — a pane being reattached has no pipe for a moment (the daemon
// replaced it; main's new one is not connected yet). A send landing there
// waited for nothing: it failed with "no open pipe", or a retry typed it twice.
describe('a send in a reattach gap waits for the new pipe (#3073)', () => {
  beforeEach(() => vi.clearAllMocks());

  /** Writes find no pipe until the reattach connects one, `reconnects` true. */
  function setupGap(reconnects: boolean) {
    let pipeOpen = false;
    const written: string[] = [];
    const writeToSession = vi.fn((_id: string, data: string) => {
      if (!pipeOpen) return false;
      written.push(data);
      return true;
    });
    const waitForSessionPipe = vi.fn(async () => {
      if (reconnects) pipeOpen = true;
      return pipeOpen;
    });
    const folderTrustState = vi.fn(async () => ({ state: 'clear' as const }));
    // The session is live (attached): the send does not start it.
    const dc = { isConnected: true, isSessionPipeWritable: vi.fn(() => true), writeToSession, waitForSessionPipe, folderTrustState };
    const pty = { get: vi.fn(() => undefined), write: vi.fn() } as unknown as PTYManager;
    const router = new RpcRouter();
    registerInputRpc(router, pty, () => fakeWindow, () => dc as never);
    return { router, written, waitForSessionPipe };
  }

  it('input.send writes the text and its Enter once the new pipe is up', async () => {
    const { router, written, waitForSessionPipe } = setupGap(true);
    renderer();
    const res = await router.dispatch({ id: 'g1', method: 'input.send', params: { text: 'echo hi', ptyId: 'pty-gap', workspaceId: 'ws-ext', submit: true } });
    expect(res.ok).toBe(true);
    expect(written).toEqual(['echo hi', '\r']);
    expect(waitForSessionPipe).toHaveBeenCalledTimes(1);
  });

  it('input.sendKey sends the key once the new pipe is up', async () => {
    const { router, written } = setupGap(true);
    renderer();
    const res = await router.dispatch({ id: 'g2', method: 'input.sendKey', params: { key: 'ctrl+l', ptyId: 'pty-gap', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(true);
    expect(written).toEqual(['\x0c']);
  });

  it('with no pipe by the bound, the send fails and nothing was written', async () => {
    const { router, written } = setupGap(false);
    renderer();
    const res = await router.dispatch({ id: 'g3', method: 'input.send', params: { text: 'echo hi', ptyId: 'pty-gap', workspaceId: 'ws-ext', submit: true } });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain('has no open pipe');
    expect(written).toEqual([]);
  });
});
