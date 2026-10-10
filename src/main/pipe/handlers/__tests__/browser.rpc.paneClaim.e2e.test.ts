/**
 * A pane agent's browser call, end to end on a REAL process tree: main walks
 * the caller's actual parent chain (the live `ps` snapshot, not a stub), finds
 * the pane shell's pid-map anchor, mints a pane claim, and a browser call that
 * carries that claim is scoped to the walked workspace and pane.
 *
 * The only stand-in is the renderer's answer to "which workspace owns this
 * pty" — there is no renderer in a unit test.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aRpc } from '../a2a.rpc';
import { registerBrowserRpc } from '../browser.rpc';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';
import { __resetWorkspaceClaimTrustForTesting } from '../../../workspace/workspaceClaimTrust';

const { sendToRendererMock, dirRef } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
  dirRef: { current: '' as string },
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
  session: { fromPartition: vi.fn(() => ({})) },
  webContents: { fromId: vi.fn(() => null) },
}));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('../../../../shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/constants')>()),
  getPidMapDir: () => dirRef.current,
}));

const WALKED_WS = 'ws-walked';
const WALKED_PTY = 'pty-walked';

function makeWorker(): ClaudeWorker {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockReturnValue(true),
    isFull: false,
    stop: vi.fn(),
  } as unknown as ClaudeWorker;
}

function makeRouter(): { router: RpcRouter; getTarget: ReturnType<typeof vi.fn> } {
  const router = new RpcRouter();
  registerA2aRpc(router, () => ({}) as BrowserWindow, makeWorker());
  const getTarget = vi.fn(() => null);
  registerBrowserRpc(
    router,
    () => null,
    {
      getTarget,
      listTargets: vi.fn(() => []),
      getCdpPort: vi.fn(() => 18800),
      waitForTarget: vi.fn(),
      ensureAwake: vi.fn(async () => null),
      setCaptureCleanup: vi.fn(),
      setCaptureAttach: vi.fn(),
      withAutomationLease: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
      acquireRpcLease: vi.fn(() => 'lease-1'),
      renewRpcLease: vi.fn(() => true),
      releaseRpcLease: vi.fn(() => true),
    } as never,
  );
  return { router, getTarget };
}

// A pane shell (`sh`) with an agent-like child (`node`) under it: the child is
// the caller, the shell is the pid-map anchor. `; :` keeps sh from exec-ing
// into node, so the shell really is the parent.
let shell: ChildProcess | undefined;
let agentPid = 0;

describe.skipIf(process.platform === 'win32')('pane claim from a real process-tree walk', () => {
  beforeAll(async () => {
    shell = spawn('/bin/sh', ['-c', `"${process.execPath}" -e "setTimeout(() => {}, 60000)"; :`], {
      stdio: 'ignore',
    });
    // The child exists once `ps` lists a process whose parent is the shell.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && agentPid === 0) {
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync('ps', ['-o', 'pid=', '-o', 'ppid=', '-A'], { encoding: 'utf8' });
      for (const line of out.split('\n')) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (ppid === shell.pid && pid) agentPid = pid;
      }
      if (agentPid === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(agentPid).toBeGreaterThan(0);
  });

  afterAll(() => {
    if (agentPid) {
      try {
        process.kill(agentPid);
      } catch {
        /* already gone */
      }
    }
    shell?.kill();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    __resetWorkspaceClaimTrustForTesting();
    dirRef.current = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pidmap-e2e-'));
    fs.writeFileSync(path.join(dirRef.current, String(shell?.pid)), WALKED_PTY);
    sendToRendererMock.mockImplementation(async (_w: unknown, method: string, params: { ptyId?: string }) =>
      method === 'input.findOwnerWorkspace' && params.ptyId === WALKED_PTY
        ? { workspaceId: WALKED_WS }
        : { workspaceId: null },
    );
  });

  it('walks to the pane, mints a pane claim, and a browser call carrying it is accepted', async () => {
    const { router, getTarget } = makeRouter();

    const identity = await router.dispatch(
      { id: 'id-1', method: 'a2a.resolve.identity', params: { callerPid: agentPid }, clientName: 'claude-code' },
      { externalWire: true },
    );
    expect(identity.ok).toBe(true);
    const result = (identity as { result: { resolved: unknown; workspaceToken?: string } }).result;
    expect(result.resolved).toEqual({ workspaceId: WALKED_WS, ptyId: WALKED_PTY });
    expect(typeof result.workspaceToken).toBe('string');

    // A repeat walk of the same pane reuses the live claim.
    const again = await router.dispatch(
      { id: 'id-2', method: 'a2a.resolve.identity', params: { callerPid: agentPid }, clientName: 'claude-code' },
      { externalWire: true },
    );
    expect((again as { result: { workspaceToken?: string } }).result.workspaceToken).toBe(result.workspaceToken);

    const call = await router.dispatch(
      {
        id: 'b-1',
        method: 'browser.evaluate',
        params: { expression: '1 + 1', workspaceId: WALKED_WS },
        clientName: 'claude-code',
        workspaceToken: result.workspaceToken,
      },
      { externalWire: true },
    );
    // Accepted by the scope table: the lookup ran in the walked workspace (no
    // surface is open, so the handler then reports that, not a refusal).
    if (!call.ok) expect(call.error).not.toContain('BROWSER_SCOPE_REFUSED');
    expect(getTarget).toHaveBeenCalledWith(undefined, WALKED_WS);
  });

  it('refuses an external MCP that names a workspace but holds no claim', async () => {
    const { router, getTarget } = makeRouter();

    const call = await router.dispatch(
      {
        id: 'b-2',
        method: 'browser.evaluate',
        params: { expression: '1 + 1', workspaceId: WALKED_WS },
        clientName: 'some-external-mcp',
      },
      { externalWire: true },
    );

    expect(call.ok).toBe(false);
    if (!call.ok) expect(call.error).toContain('BROWSER_SCOPE_REFUSED');
    expect(getTarget).not.toHaveBeenCalled();
  });
});
