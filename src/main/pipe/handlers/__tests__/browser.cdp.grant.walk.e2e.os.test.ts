/**
 * browser.cdp.grant against a REAL process tree: main walks the connection's
 * peer process up to a pane shell's pid-map anchor and grants only when that
 * pane is the one the caller's claim names. Two pane shells, each with a
 * child; the claim is minted for the first child by main's own walk
 * (a2a.resolve.identity), then presented from each place.
 *
 * The stand-ins: the renderer's answer to "which workspace owns this pty",
 * and a launcher whose relay grant is recorded rather than minted.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aRpc } from '../a2a.rpc';
import { registerBrowserRpc } from '../browser.rpc';
import { setPaneOfPeer } from '../peerPidShadow';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';
import { __resetWorkspaceClaimTrustForTesting } from '../../../workspace/workspaceClaimTrust';
import { setRelayAdmission } from '../../../browser-session/ChromeLauncher';
import { processStartTime } from '../../../../shared/processStartTime';
import { WMUX_CLI_CLIENT_NAME } from '../../../../shared/rpc';

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

const WS = 'ws-walked';
const PANES = ['pty-one', 'pty-two'] as const;

function makeRouter() {
  const router = new RpcRouter();
  registerA2aRpc(router, () => ({}) as BrowserWindow, {
    execute: vi.fn(), cancel: vi.fn(), isFull: false, stop: vi.fn(),
  } as unknown as ClaudeWorker);
  const launcher = {
    endpoint: vi.fn(async () => ({ piped: true as const })),
    relayGrant: vi.fn(async () => ({ endpoint: 'ws+unix:/tmp/x.sock:/devtools/browser/relay', headers: { Authorization: 'Bearer t' }, proofKey: 'k' })),
    narrowedFor: vi.fn(() => true),
    cdpInfoTargets: vi.fn(async () => []),
    dispose: vi.fn(),
  };
  registerBrowserRpc(
    router,
    () => null,
    {
      getTarget: vi.fn(() => null),
      listTargets: vi.fn(() => []),
      getCdpPort: vi.fn(() => 18800),
      waitForTarget: vi.fn(),
      ensureAwake: vi.fn(async () => null),
      setCaptureCleanup: vi.fn(),
      setCaptureAttach: vi.fn(),
    } as never,
    { get: () => 'chrome', set: vi.fn() } as never,
    undefined,
    undefined,
    {
      profileFor: vi.fn(() => 'work'),
      hasPaneBindings: vi.fn(() => false),
      isPaneBound: vi.fn(() => false),
      forProfile: vi.fn(() => launcher),
      ownerOfSurface: vi.fn(() => null),
      disposeAll: vi.fn(),
    } as never,
  );
  return { router, launcher };
}

/** Pane shells (`sh`), each with a child (`node`): the child is the caller, the shell is the anchor. */
const shells: ChildProcess[] = [];
const children: number[] = [];

function childOf(parent: number): number {
  const out = execFileSync('ps', ['-o', 'pid=', '-o', 'ppid=', '-A'], { encoding: 'utf8' });
  for (const line of out.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (ppid === parent && pid) return pid;
  }
  return 0;
}

const from = (pid: number) => ({ externalWire: true as const, peerPid: pid, peerStartedAt: String(processStartTime(pid)) });

describe.skipIf(process.platform === 'win32')('browser.cdp.grant: the peer process walks to the claimed pane', () => {
  beforeAll(async () => {
    for (let i = 0; i < PANES.length; i++) {
      const shell = spawn('/bin/sh', ['-c', `"${process.execPath}" -e "setTimeout(() => {}, 60000)"; :`], { stdio: 'ignore' });
      shells.push(shell);
      let child = 0;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && child === 0) {
        child = childOf(shell.pid as number);
        if (child === 0) await new Promise((r) => setTimeout(r, 50));
      }
      expect(child).toBeGreaterThan(0);
      children.push(child);
    }
  });

  afterAll(() => {
    for (const pid of children) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
    for (const shell of shells) shell.kill();
    setPaneOfPeer(null);
    setRelayAdmission(null);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    __resetWorkspaceClaimTrustForTesting();
    dirRef.current = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pidmap-grant-'));
    shells.forEach((shell, i) => fs.writeFileSync(path.join(dirRef.current, String(shell.pid)), PANES[i]));
    sendToRendererMock.mockImplementation(async (_w: unknown, method: string, params: { ptyId?: string }) =>
      method === 'input.findOwnerWorkspace' && PANES.includes(params.ptyId as (typeof PANES)[number])
        ? { workspaceId: WS }
        : { workspaceId: null },
    );
    setRelayAdmission(() => null);
  });

  /** The pane claim main mints for the first pane's child, by its own walk. */
  async function claimForFirstPane(router: RpcRouter): Promise<string> {
    const identity = await router.dispatch(
      { id: 'id', method: 'a2a.resolve.identity', params: { callerPid: children[0] }, clientName: WMUX_CLI_CLIENT_NAME },
      from(children[0]),
    );
    const result = (identity as { result: { resolved: unknown; workspaceToken?: string } }).result;
    expect(result.resolved).toEqual({ workspaceId: WS, ptyId: PANES[0] });
    return result.workspaceToken as string;
  }

  const grant = (router: RpcRouter, token: string, dispatch: Parameters<RpcRouter['dispatch']>[1]) =>
    router.dispatch({ id: 'g', method: 'browser.cdp.grant', params: {}, clientName: WMUX_CLI_CLIENT_NAME, workspaceToken: token } as never, dispatch);

  it('grants to the process the claim was minted for', async () => {
    const { router, launcher } = makeRouter();
    const token = await claimForFirstPane(router);
    const answer = await grant(router, token, from(children[0]));
    expect(answer.ok).toBe(true);
    expect(launcher.relayGrant).toHaveBeenCalledWith({ workspaceId: WS, profile: 'work', ptyId: PANES[0], lane: 'pane-script' });
  });

  it('refuses the same claim from a process in another pane', async () => {
    const { router, launcher } = makeRouter();
    const token = await claimForFirstPane(router);
    const answer = await grant(router, token, from(children[1]));
    expect(answer.ok).toBe(false);
    expect((answer as { error: string }).error).toContain('does not run in the pane its claim names');
    expect(launcher.relayGrant).not.toHaveBeenCalled();
  });

  it('refuses the same claim from a process in no pane, and from a connection with no peer pid', async () => {
    const { router, launcher } = makeRouter();
    const token = await claimForFirstPane(router);
    const outside = await grant(router, token, from(process.pid));
    expect(outside.ok).toBe(false);
    expect((outside as { error: string }).error).toContain('could not trace this process');
    const noPeer = await grant(router, token, { externalWire: true });
    expect(noPeer.ok).toBe(false);
    expect((noPeer as { error: string }).error).toContain('could not trace this process');
    expect(launcher.relayGrant).not.toHaveBeenCalled();
  });
});
