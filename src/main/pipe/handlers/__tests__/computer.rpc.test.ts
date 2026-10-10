import { describe, expect, it, vi } from 'vitest';
import type { RpcRouter } from '../../RpcRouter';
import type { RpcContext } from '../../../../shared/rpc';
import { ComputerError, parseComputerErrorMessage } from '../../../../shared/computer/errors';
import { ComputerService, type ComputerAgent, type HelperLike } from '../../../computer/ComputerService';
import type { AppInfo, AppState, WindowInfo } from '../../../../shared/computer/protocol';
import { registerComputerRpc } from '../computer.rpc';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

// Which workspace owns each pane right now, as main's resolver would answer.
const INSTANCE_1 = '11111111-2222-4333-8444-555555555555';
const INSTANCE_2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const PANES: Record<string, string> = { 'pty-a1': 'ws-a', 'pty-a2': 'ws-a', 'pty-b1': 'ws-b' };

const WORKSPACE_NAMES: Record<string, string> = { 'ws-a': 'api', 'ws-b': 'web "prod"\nX', 'ws-c': 'claimed' };

function setup(service: Partial<ComputerService>) {
  const handlers = new Map<string, Handler>();
  const router = { register: (method: string, handler: Handler) => handlers.set(method, handler) } as unknown as RpcRouter;
  const getService = vi.fn(() => service as ComputerService);
  registerComputerRpc(
    router,
    getService,
    async (ptyId) => {
      if (ptyId === 'pty-throws') throw new Error('renderer gone');
      return PANES[ptyId] ?? null;
    },
    (workspaceId) => WORKSPACE_NAMES[workspaceId],
  );
  const call = (method: string, params: Record<string, unknown>, ctx?: Partial<RpcContext>) =>
    handlers.get(method)!(params, ctx as RpcContext);
  return { handlers, call, getService };
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (err) {
    return parseComputerErrorMessage((err as Error).message);
  }
}

describe('computer.rpc', () => {
  it('registers exactly the computer.* methods', () => {
    const { handlers, getService } = setup({});
    expect([...handlers.keys()].sort()).toEqual([
      'computer.act',
      'computer.capabilities',
      'computer.getAppState',
      'computer.listApps',
      'computer.listWindows',
    ]);
    // Nothing is constructed until a call arrives.
    expect(getService).not.toHaveBeenCalled();
  });

  it('keys identity on the caller pane or process, so agents of one kind never share grants', async () => {
    const getAppState = vi.fn(async () => ({}));
    const { call } = setup({ getAppState } as never);
    const as = (identity: Record<string, string>, ctx: Partial<RpcContext> = {}) =>
      call('computer.getAppState', { app: 'Notepad', workspaceId: 'ws-forged', ...identity }, { clientName: 'claude-code', ...ctx });
    await as({ senderPtyId: 'pty-a1' });
    await as({ senderPtyId: 'pty-a2' }); // split pane of the same workspace
    await as({ senderPtyId: 'pty-b1' }); // another workspace
    await as({ senderPtyId: 'pty-a1' }, { workspaceClaim: { kind: 'bound', workspaceId: 'ws-a' } });
    await as({}, { commanderWorkspace: 'ws-a' });
    await as({ callerInstance: INSTANCE_1 }); // two processes with no pane
    await as({ callerInstance: INSTANCE_2 });
    await as({ callerInstance: INSTANCE_1 }, { workspaceClaim: { kind: 'bound', workspaceId: 'ws-c' } });
    const agents = getAppState.mock.calls.map((c) => (c as unknown[])[0] as ComputerAgent);
    const keys = agents.map((a) => a.key);
    expect(keys.slice(0, 5)).toEqual([
      'claude-code @ ws-a/pty-a1',
      'claude-code @ ws-a/pty-a2',
      'claude-code @ ws-b/pty-b1',
      'claude-code @ ws-a/pty-a1',
      'claude-code @ ws-a/commander',
    ]);
    expect(keys[5]).toMatch(/^claude-code \(no pane\) #[0-9a-f]{12}$/);
    expect(keys[6]).toMatch(/^claude-code \(no pane\) #[0-9a-f]{12}$/);
    expect(keys[5]).not.toBe(keys[6]);
    // The key never carries the raw instance id another agent could present.
    expect(keys[5]).not.toContain(INSTANCE_1.slice(0, 8));
    expect(keys[7]).toMatch(/^claude-code @ ws-c #[0-9a-f]{12}$/);
    // What the person sees: the client name and the workspace by its name, no ids.
    expect(agents.map((a) => a.label)).toEqual([
      'claude-code in workspace "api"',
      'claude-code in workspace "api"',
      // A workspace name cannot close the quotes or break the line.
      "claude-code in workspace \"web 'prod' X\"",
      'claude-code in workspace "api"',
      'claude-code orchestrating workspace "api"',
      'claude-code (outside wmux panes)',
      'claude-code (outside wmux panes)',
      'claude-code in workspace "claimed"',
    ]);
  });

  it('refuses a caller it cannot pin to a pane or process instead of sharing an identity', async () => {
    const getAppState = vi.fn(async () => ({}));
    const { call } = setup({ getAppState } as never);
    const codeOf = async (params: Record<string, unknown>, ctx: Partial<RpcContext> = { clientName: 'c' }) =>
      (await errorOf(call('computer.getAppState', { app: 'x', ...params }, ctx)))?.code;
    expect(await codeOf({ senderPtyId: 'pty-unknown' })).toBe('invalid_argument');
    expect(await codeOf({ senderPtyId: 'pty-throws' })).toBe('invalid_argument');
    expect(await codeOf({})).toBe('invalid_argument');
    expect(await codeOf({ callerInstance: 'not-a-uuid' })).toBe('invalid_argument');
    expect(await codeOf({ senderPtyId: 'pty-b1' }, { clientName: 'c', workspaceClaim: { kind: 'bound', workspaceId: 'ws-a' } }))
      .toBe('invalid_argument');
    expect(await codeOf({ callerInstance: INSTANCE_1 }, { clientName: 'c', hostedWorkspace: 'ws-a' })).toBe('invalid_argument');
    expect(getAppState).not.toHaveBeenCalled();
  });

  it('lists apps without pane resolution', async () => {
    const listApps = vi.fn(async () => ({ apps: [] }));
    const { call } = setup({ listApps } as never);
    await call('computer.listApps', { senderPtyId: 'pty-unknown' }, { clientName: 'c' });
    expect(listApps).toHaveBeenCalled();
  });

  it('passes listWindows the caller identity when it sends one, and an empty key otherwise', async () => {
    const listWindows = vi.fn(async () => ({ windows: [] }));
    const { call } = setup({ listWindows } as never);
    await call('computer.listWindows', { senderPtyId: 'pty-a1', app: 'Notepad' }, { clientName: 'claude-code' });
    await call('computer.listWindows', {}, { clientName: 'claude-code' });
    const calls = listWindows.mock.calls as unknown as Array<[ComputerAgent, string | undefined]>;
    expect(calls[0]).toEqual([expect.objectContaining({ key: 'claude-code @ ws-a/pty-a1' }), 'Notepad']);
    // No identity: an empty key, for which the service blanks every title.
    expect(calls[1][0].key).toBe('');
    // A malformed identity is refused, not treated as no identity.
    expect((await errorOf(call('computer.listWindows', { senderPtyId: 7 }, { clientName: 'claude-code' })))?.code).toBe('invalid_argument');
    expect((await errorOf(call('computer.getAppState', { app: 'x', callerInstance: {} }, { clientName: 'claude-code' })))?.code).toBe('invalid_argument');
    // A pane that does not resolve is refused, not silently demoted.
    expect((await errorOf(call('computer.listWindows', { senderPtyId: 'pty-gone' }, { clientName: 'claude-code' })))?.code).toBe('invalid_argument');
  });

  it('refuses an anonymous caller and a stale workspace claim', async () => {
    const { call } = setup({ getAppState: vi.fn() } as never);
    expect((await errorOf(call('computer.getAppState', { app: 'x' }, {})))?.code).toBe('invalid_argument');
    expect((await errorOf(call('computer.getAppState', { app: 'x' }, {
      clientName: 'c',
      workspaceClaim: { kind: 'stale' },
    })))?.code).toBe('invalid_argument');
  });

  it('only accepts control actions on computer.act', async () => {
    const control = vi.fn(async () => ({ method: 'synthetic', verification: 'unverified' }));
    const { call } = setup({ control } as never);
    expect((await errorOf(call('computer.act', { action: 'getAppState', senderPtyId: 'pty-a1' }, { clientName: 'c' })))?.code).toBe('invalid_argument');
    await call('computer.act', { action: 'click', snapshotId: 's1', index: 2, senderPtyId: 'pty-a1' }, { clientName: 'c' });
    expect(control).toHaveBeenCalledWith(
      { key: 'c @ ws-a/pty-a1', label: 'c in workspace "api"' },
      { action: 'click', snapshotId: 's1', index: 2 },
    );
  });

  it('checks the shape of control params at the pipe: unknown fields and wrong types never reach the service', async () => {
    const control = vi.fn(async () => ({ method: 'accessibility', verification: 'verified' }));
    const { call } = setup({ control } as never);
    const act = (params: Record<string, unknown>) =>
      errorOf(call('computer.act', { action: 'click', snapshotId: 's1', senderPtyId: 'pty-a1', ...params }, { clientName: 'c' }));
    for (const bad of [
      { index: 1, workspaceId: 'ws-forged' },
      { index: '3' },
      { index: -1 },
      { index: 1, button: 'back' },
      { index: 1, modifiers: 'ctrl' },
      { x: 'NaN', y: 2 },
      { index: 1, clickCount: Infinity },
      { snapshotId: 7, index: 1 },
      { index: 1, constructor: 'x' },
      { index: 1, toString: 'x' },
    ]) {
      expect((await act(bad))?.code, JSON.stringify(bad)).toBe('invalid_argument');
    }
    expect(control).not.toHaveBeenCalled();
    expect(await act({ index: 1, button: 'right', clickCount: 2, modifiers: ['ctrl'] })).toBeNull();
    expect(control).toHaveBeenCalledWith(expect.anything(), {
      action: 'click', snapshotId: 's1', index: 1, button: 'right', clickCount: 2, modifiers: ['ctrl'],
    });
  });

  it('routes openApp on computer.act to the service by selector, with the caller identity', async () => {
    const control = vi.fn();
    const openApp = vi.fn(async () => ({ app: { id: 'com.apple.TextEdit' }, window: null }));
    const { call } = setup({ control, openApp } as never);
    await call('computer.act', { action: 'openApp', app: 'TextEdit', senderPtyId: 'pty-a1' }, { clientName: 'c' });
    expect(openApp).toHaveBeenCalledWith({ key: 'c @ ws-a/pty-a1', label: 'c in workspace "api"' }, { app: 'TextEdit' });
    expect(control).not.toHaveBeenCalled();
    expect((await errorOf(call('computer.act', { action: 'openApp', senderPtyId: 'pty-a1' }, { clientName: 'c' })))?.code).toBe('invalid_argument');
    expect(openApp).toHaveBeenCalledTimes(1);
  });

  it('encodes service errors as [code] message and wraps unknown ones as internal', async () => {
    const { call } = setup({
      listApps: vi.fn(async () => { throw new ComputerError('permission_missing', 'accessibility'); }),
      capabilities: vi.fn(async () => { throw new Error('boom'); }),
    } as never);
    expect(await errorOf(call('computer.listApps', {}, { clientName: 'c' }))).toEqual({ code: 'permission_missing', message: 'accessibility' });
    expect(await errorOf(call('computer.capabilities', {}, { clientName: 'c' }))).toEqual({ code: 'internal', message: 'boom' });
  });
});

// End to end through the real ComputerService: the review's repro S3 (pane B
// acting on pane A's snapshot with no prompt) must not reproduce.
describe('computer.rpc with the real service', () => {
  const notepad: AppInfo = { id: 'c:\\windows\\notepad.exe', name: 'Notepad', pid: 10, path: 'C:\\Windows\\notepad.exe' };
  const notepadWindow: WindowInfo = { id: 'w1', appId: notepad.id, pid: 10, title: 'notes', bounds: { x: 0, y: 0, width: 100, height: 100 } };

  function realSetup() {
    let seq = 0;
    const helper: HelperLike = {
      request: (async (method: string) => {
        if (method === 'resolveTarget') return { app: notepad, window: notepadWindow };
        if (method === 'getAppState') {
          const state: AppState = { snapshotId: `s${++seq}`, app: notepad, window: notepadWindow, tree: '0 window', screenshotStatus: { status: 'skipped' } };
          return state;
        }
        return { method: 'synthetic', verification: 'unverified' };
      }) as HelperLike['request'],
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    const prompts: Array<{ key: string; label: string }> = [];
    const service = new ComputerService({
      isEnabled: () => true,
      askPerApp: () => true,
      createHelper: () => helper,
      requestConsent: async ({ agent }) => {
        prompts.push(agent);
        return 'approved';
      },
      stopKey: { arm: () => true, release: () => undefined },
      blockContext: () => ({}),
    });
    const { call } = setup(service);
    return { call, prompts };
  }

  it('two panes of one client name share no consent, snapshot or input lock', async () => {
    const { call, prompts } = realSetup();
    const ctx = { clientName: 'claude-code' };
    const a = (await call('computer.getAppState', { app: 'Notepad', senderPtyId: 'pty-a1' }, ctx)) as AppState;
    expect(prompts).toHaveLength(1);
    // Pane B (same client name, same workspace, another pane) is asked for itself.
    const b = (await call('computer.getAppState', { app: 'Notepad', senderPtyId: 'pty-a2' }, ctx)) as AppState;
    expect(prompts).toHaveLength(2);
    expect(prompts[0].key).not.toBe(prompts[1].key);
    // B cannot act on A's snapshot.
    expect((await errorOf(call('computer.act', { action: 'click', snapshotId: a.snapshotId, index: 1, senderPtyId: 'pty-a2' }, ctx)))?.code)
      .toBe('snapshot_unknown');
    // A drives; B is held off by A's lock, and told who holds it by name only.
    await call('computer.act', { action: 'click', snapshotId: a.snapshotId, index: 1, senderPtyId: 'pty-a1' }, ctx);
    const busy = await errorOf(call('computer.act', { action: 'click', snapshotId: b.snapshotId, index: 1, senderPtyId: 'pty-a2' }, ctx));
    expect(busy).toEqual({ code: 'input_busy', message: 'claude-code in workspace "api" is using the desktop' });
  });
});
