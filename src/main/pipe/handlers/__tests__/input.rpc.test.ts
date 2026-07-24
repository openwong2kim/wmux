import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc, decideTerminalOmittedTarget } from '../input.rpc';
import type { RoleBindingResolver } from '../input.rpc';
import type { PTYManager } from '../../../pty/PTYManager';
import type { RoleBinding } from '../../../../shared/orchestratorRole';

// Mock the renderer bridge so we can drive input.findOwnerWorkspace (the
// ownership oracle assertWorkspaceOwnsPty consults) and input.readScreen (the
// viewport read) without a real BrowserWindow.
const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const fakeWindow = {} as BrowserWindow;
const fakePty = {} as PTYManager;

function setup(): RpcRouter {
  const router = new RpcRouter();
  registerInputRpc(router, fakePty, () => fakeWindow);
  return router;
}

// Regression guard for issue #163: input.readScreen was the lone terminal-IO
// handler missing assertWorkspaceOwnsPty, letting a caller that names another
// workspace + a foreign ptyId read that workspace's viewport.
describe('input.readScreen — cross-workspace ownership (issue #163)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an explicit-ptyId read owned by a different workspace, before any viewport read', async () => {
    sendToRendererMock.mockImplementation((_w: unknown, method: string) => {
      if (method === 'input.findOwnerWorkspace') {
        // The ptyId genuinely belongs to the victim ws (the crux of the bug).
        return Promise.resolve({ workspaceId: 'ws-victim' });
      }
      return Promise.resolve({ ptyId: 'daemon-victim', text: 'SECRET' });
    });

    const res = await setup().dispatch({
      id: '1',
      method: 'input.readScreen',
      params: { workspaceId: 'ws-attacker', ptyId: 'daemon-victim' },
    });

    expect(res.ok).toBe(false);
    // The ownership check ran...
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      'input.findOwnerWorkspace',
      { ptyId: 'daemon-victim' },
    );
    // ...and the viewport read never happened (assert-before-read).
    expect(sendToRendererMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'input.readScreen',
      expect.anything(),
    );
  });

  it('allows a read when the caller workspace owns the ptyId', async () => {
    sendToRendererMock.mockImplementation(
      (_w: unknown, method: string, params?: { ptyId?: string }) => {
        if (method === 'input.findOwnerWorkspace') return Promise.resolve({ workspaceId: 'ws-A' });
        return Promise.resolve({ ptyId: params?.ptyId ?? 'daemon-A', text: 'mine' });
      },
    );

    const res = await setup().dispatch({
      id: '2',
      method: 'input.readScreen',
      params: { workspaceId: 'ws-A', ptyId: 'daemon-A' },
    });

    expect(res.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      'input.readScreen',
      expect.objectContaining({ ptyId: 'daemon-A' }),
    );
  });

  it('skips the ownership check for internal callers that pass no workspaceId (CLI/UI)', async () => {
    sendToRendererMock.mockImplementation(
      (_w: unknown, method: string, params?: { ptyId?: string }) => {
        if (method === 'input.findOwnerWorkspace') {
          return Promise.reject(new Error('findOwnerWorkspace must not be called for internal callers'));
        }
        return Promise.resolve({ ptyId: params?.ptyId ?? 'daemon-A', text: 'cli' });
      },
    );

    const res = await setup().dispatch({
      id: '3',
      method: 'input.readScreen',
      params: { ptyId: 'daemon-A' },
    });

    expect(res.ok).toBe(true);
    expect(sendToRendererMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'input.findOwnerWorkspace',
      expect.anything(),
    );
  });

  it('reads the caller workspace active pane when ptyId is omitted, independent of UI focus', async () => {
    // Regression guard (PR review): the renderer scopes the active-pane lookup
    // to params.workspaceId, so a legit caller naming its own ws must read its
    // own active pane even when the user's UI focus is on another workspace.
    // Resolving via a workspaceId-less resolveActivePtyId would read the
    // UI-focused pane and wrongly reject this caller.
    sendToRendererMock.mockImplementation((_w: unknown, method: string) => {
      if (method === 'input.readScreen') return Promise.resolve({ ptyId: 'daemon-self', text: 'mine' });
      if (method === 'input.findOwnerWorkspace') return Promise.resolve({ workspaceId: 'ws-self' });
      return Promise.resolve(null);
    });

    const res = await setup().dispatch({
      id: '4',
      method: 'input.readScreen',
      params: { workspaceId: 'ws-self' },
    });

    expect(res.ok).toBe(true);
    // the read forwarded workspaceId so the renderer scopes the lookup to it,
    // not to a focus-based default.
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      'input.readScreen',
      expect.objectContaining({ workspaceId: 'ws-self' }),
    );
  });
});

// Source-level invariant lock (issue #163, requested in the issue). All four
// terminal-IO RPC handlers must call assertWorkspaceOwnsPty before delegating
// to the renderer. input.readScreen was the one that silently skipped it; this
// pins parity so a future handler can't regress the same way. Keys off source
// text rather than behavior so it catches a NEW handler that forgets the check.
describe('input.rpc — assertWorkspaceOwnsPty parity (source invariant)', () => {
  const rawSrc = fs.readFileSync(path.join(__dirname, '..', 'input.rpc.ts'), 'utf-8');
  const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  // Slice a single router.register('name', ...) block, bounded by the next
  // router.register( (or end of file for the last one).
  function handlerBlock(method: string): string {
    const start = src.indexOf(`router.register('${method}'`);
    expect(start, `handler ${method} must exist`).toBeGreaterThan(0);
    const next = src.indexOf('router.register(', start + method.length + 20);
    return src.slice(start, next > start ? next : src.length);
  }

  for (const method of ['input.send', 'input.sendKey', 'input.readScreen', 'terminal.readEvents']) {
    it(`${method} calls assertWorkspaceOwnsPty`, () => {
      expect(handlerBlock(method)).toMatch(/assertWorkspaceOwnsPty\(/);
    });
  }
});

// P0 — terminal_send / terminal_send_key self-loop guard. A first-party agent
// (verified senderPtyId) that omits ptyId must be refused: "the active
// terminal" would loop into its own pane or, in a multi-pane workspace, a
// non-deterministic sibling that assertWorkspaceOwnsPty cannot catch (intra-ws).
// An explicit ptyId must NEVER be blocked; an external caller (no senderPtyId)
// keeps resolving its own pinned pane, scoped to its workspace.
describe('input.send / input.sendKey — omitted-target self-loop guard (P0)', () => {
  beforeEach(() => vi.clearAllMocks());

  function setupWithWrite(): { router: RpcRouter; writeMock: ReturnType<typeof vi.fn> } {
    const writeMock = vi.fn();
    const pty = { get: vi.fn(() => ({ id: 'x' })), write: writeMock } as unknown as PTYManager;
    const router = new RpcRouter();
    registerInputRpc(router, pty, () => fakeWindow);
    return { router, writeMock };
  }

  it('decideTerminalOmittedTarget rejects a first-party caller (senderPtyId present)', () => {
    const d = decideTerminalOmittedTarget('pty-self');
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/explicit ptyId/);
  });

  it('decideTerminalOmittedTarget allows an external caller (senderPtyId absent)', () => {
    expect(decideTerminalOmittedTarget('').allow).toBe(true);
  });

  it('rejects an omitted-ptyId send from a first-party caller, before resolving any pane or writing', async () => {
    const { router, writeMock } = setupWithWrite();
    const res = await router.dispatch({
      id: '1',
      method: 'input.send',
      params: { text: 'hi', workspaceId: 'ws-self', senderPtyId: 'pty-self' },
    });
    expect(res.ok).toBe(false);
    // Guard fired BEFORE active-pane resolution (no readScreen) and BEFORE write.
    expect(sendToRendererMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'input.readScreen',
      expect.anything(),
    );
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('NEVER blocks an explicit-ptyId send even when senderPtyId equals that ptyId', async () => {
    // The CRITICAL constraint: a legit explicit cross/self-pane send must write.
    // Explicit ptyId takes the early branch and never reaches the guard.
    const { router, writeMock } = setupWithWrite();
    sendToRendererMock.mockImplementation((_w: unknown, method: string) => {
      if (method === 'input.findOwnerWorkspace') return Promise.resolve({ workspaceId: 'ws-self' });
      return Promise.resolve(null);
    });
    const res = await router.dispatch({
      id: '2',
      method: 'input.send',
      params: { text: 'hi', ptyId: 'pty-self', workspaceId: 'ws-self', senderPtyId: 'pty-self' },
    });
    expect(res.ok).toBe(true);
    expect(writeMock).toHaveBeenCalledWith('pty-self', expect.any(String));
    // No active-pane resolution happened (explicit ptyId bypassed it).
    expect(sendToRendererMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'input.readScreen',
      expect.anything(),
    );
  });

  it('resolves the active pane scoped to the caller workspace for an external caller (no senderPtyId)', async () => {
    const { router, writeMock } = setupWithWrite();
    sendToRendererMock.mockImplementation((_w: unknown, method: string) => {
      if (method === 'input.readScreen') return Promise.resolve({ ptyId: 'pty-pinned', text: '' });
      if (method === 'input.findOwnerWorkspace') return Promise.resolve({ workspaceId: 'ws-ext' });
      return Promise.resolve(null);
    });
    const res = await router.dispatch({
      id: '3',
      method: 'input.send',
      params: { text: 'hi', workspaceId: 'ws-ext' },
    });
    expect(res.ok).toBe(true);
    // Active-pane lookup forwarded the caller workspaceId (scoped, not UI focus).
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      'input.readScreen',
      expect.objectContaining({ workspaceId: 'ws-ext' }),
    );
    expect(writeMock).toHaveBeenCalledWith('pty-pinned', expect.any(String));
  });

  it('input.sendKey parity — rejects an omitted-ptyId key send from a first-party caller', async () => {
    const { router, writeMock } = setupWithWrite();
    const res = await router.dispatch({
      id: '4',
      method: 'input.sendKey',
      params: { key: 'enter', workspaceId: 'ws-self', senderPtyId: 'pty-self' },
    });
    expect(res.ok).toBe(false);
    expect(sendToRendererMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'input.readScreen',
      expect.anything(),
    );
    expect(writeMock).not.toHaveBeenCalled();
  });
});

// submit=true must commit the text with a SEPARATE trailing-\r write, not a
// single fused `text\r` chunk. A fused chunk is read by a TUI editor (Claude
// Code / ink) as a multi-line paste and does not submit — the orchestrator
// dogfood bug where `terminal_send` text landed in the composer but Enter was
// never pressed. The two-write shape mirrors the terminal_send +
// terminal_send_key('enter') workaround that actually worked.
describe('input.send — submit sends text and Enter as two separate writes', () => {
  beforeEach(() => vi.clearAllMocks());

  function setupWithWrite(): { router: RpcRouter; writeMock: ReturnType<typeof vi.fn> } {
    const writeMock = vi.fn();
    const pty = { get: vi.fn(() => ({ id: 'x' })), write: writeMock } as unknown as PTYManager;
    const router = new RpcRouter();
    registerInputRpc(router, pty, () => fakeWindow);
    sendToRendererMock.mockImplementation((_w: unknown, method: string) => {
      if (method === 'input.findOwnerWorkspace') return Promise.resolve({ workspaceId: 'ws-self' });
      return Promise.resolve(null);
    });
    return { router, writeMock };
  }

  it('writes the text, then a lone \\r as a distinct write, in order', async () => {
    const { router, writeMock } = setupWithWrite();
    const res = await router.dispatch({
      id: '1',
      method: 'input.send',
      params: { text: 'make a calculator', ptyId: 'pty-a', workspaceId: 'ws-self', submit: true },
    });
    expect(res.ok).toBe(true);
    // Two writes: the text, then a bare carriage return (never fused).
    expect(writeMock.mock.calls).toEqual([
      ['pty-a', 'make a calculator'],
      ['pty-a', '\r'],
    ]);
  });

  it('does not fuse text and \\r into one chunk', async () => {
    const { router, writeMock } = setupWithWrite();
    await router.dispatch({
      id: '2',
      method: 'input.send',
      params: { text: 'hi', ptyId: 'pty-a', workspaceId: 'ws-self', submit: true },
    });
    // No single write carries both the text and the CR.
    for (const [, data] of writeMock.mock.calls) {
      expect(data).not.toBe('hi\r');
    }
  });

  it('submits only once when the text already ends in \\r', async () => {
    const { router, writeMock } = setupWithWrite();
    await router.dispatch({
      id: '3',
      method: 'input.send',
      params: { text: 'already\r', ptyId: 'pty-a', workspaceId: 'ws-self', submit: true },
    });
    expect(writeMock.mock.calls).toEqual([['pty-a', 'already\r']]);
  });

  it('writes a single chunk with no \\r when submit is not set', async () => {
    const { router, writeMock } = setupWithWrite();
    await router.dispatch({
      id: '4',
      method: 'input.send',
      params: { text: 'no submit', ptyId: 'pty-a', workspaceId: 'ws-self' },
    });
    expect(writeMock.mock.calls).toEqual([['pty-a', 'no submit']]);
  });
});

// D2 — role→model enforcement at the input.send chokepoint. A submit of a bare
// bound-agent launcher is transparently rewritten to carry the role's model;
// an explicit --model, an unbound pane, a non-submit, a multi-line paste, and a
// resolver miss all leave the text untouched (fail-open).
describe('input.send — role→model enforcement (D2)', () => {
  beforeEach(() => vi.clearAllMocks());

  function setupWithResolver(
    resolver: RoleBindingResolver,
  ): { router: RpcRouter; writeMock: ReturnType<typeof vi.fn> } {
    const writeMock = vi.fn();
    const pty = { get: vi.fn(() => ({ id: 'x' })), write: writeMock } as unknown as PTYManager;
    const router = new RpcRouter();
    registerInputRpc(router, pty, () => fakeWindow, undefined, resolver);
    sendToRendererMock.mockImplementation((_w: unknown, method: string) => {
      if (method === 'input.findOwnerWorkspace') return Promise.resolve({ workspaceId: 'ws-self' });
      return Promise.resolve(null);
    });
    return { router, writeMock };
  }

  const bind = (binding: RoleBinding | undefined): RoleBindingResolver => () => Promise.resolve(binding);

  it('rewrites a bare bound launcher on submit — the written text carries --model', async () => {
    const { router, writeMock } = setupWithResolver(bind({ agent: 'claude', model: 'haiku' }));
    const res = await router.dispatch({
      id: '1',
      method: 'input.send',
      params: { text: 'claude', ptyId: 'pty-a', workspaceId: 'ws-self', submit: true },
    });
    expect(res.ok).toBe(true);
    const payload = res.ok ? (res.result as { enforcedModel?: string }) : {};
    expect(payload.enforcedModel).toBe('haiku');
    expect(writeMock.mock.calls).toEqual([
      ['pty-a', 'claude --model haiku'],
      ['pty-a', '\r'],
    ]);
  });

  it('leaves an explicit --model untouched', async () => {
    const { router, writeMock } = setupWithResolver(bind({ agent: 'claude', model: 'haiku' }));
    await router.dispatch({
      id: '2',
      method: 'input.send',
      params: { text: 'claude --model opus', ptyId: 'pty-a', workspaceId: 'ws-self', submit: true },
    });
    expect(writeMock.mock.calls[0]).toEqual(['pty-a', 'claude --model opus']);
  });

  it('leaves an unbound pane untouched (resolver returns undefined)', async () => {
    const { router, writeMock } = setupWithResolver(bind(undefined));
    await router.dispatch({
      id: '3',
      method: 'input.send',
      params: { text: 'claude', ptyId: 'pty-a', workspaceId: 'ws-self', submit: true },
    });
    expect(writeMock.mock.calls[0]).toEqual(['pty-a', 'claude']);
  });

  it('does not rewrite when submit is not set', async () => {
    const { router, writeMock } = setupWithResolver(bind({ agent: 'claude', model: 'haiku' }));
    await router.dispatch({
      id: '4',
      method: 'input.send',
      params: { text: 'claude', ptyId: 'pty-a', workspaceId: 'ws-self' },
    });
    expect(writeMock.mock.calls).toEqual([['pty-a', 'claude']]);
  });

  it('does not rewrite multi-line text', async () => {
    const { router, writeMock } = setupWithResolver(bind({ agent: 'claude', model: 'haiku' }));
    await router.dispatch({
      id: '5',
      method: 'input.send',
      params: { text: 'claude\nsecond line', ptyId: 'pty-a', workspaceId: 'ws-self', submit: true },
    });
    expect(writeMock.mock.calls[0]).toEqual(['pty-a', 'claude\nsecond line']);
  });

  it('fails open when the resolver throws — the send still goes through', async () => {
    const throwing: RoleBindingResolver = () => Promise.reject(new Error('renderer race'));
    const { router, writeMock } = setupWithResolver(throwing);
    const res = await router.dispatch({
      id: '6',
      method: 'input.send',
      params: { text: 'claude', ptyId: 'pty-a', workspaceId: 'ws-self', submit: true },
    });
    expect(res.ok).toBe(true);
    expect(writeMock.mock.calls[0]).toEqual(['pty-a', 'claude']);
  });

  it('surfaces an advisory note for a bound agent with no model-flag grammar', async () => {
    const { router } = setupWithResolver(bind({ agent: 'gemini', model: 'flash' }));
    const res = await router.dispatch({
      id: '7',
      method: 'input.send',
      params: { text: 'gemini', ptyId: 'pty-a', workspaceId: 'ws-self', submit: true },
    });
    const note = res.ok ? (res.result as { note?: string }).note : undefined;
    expect(note).toMatch(/no known --model flag/);
  });

  // P2-2 — \r is a line terminator too, and a raw write is bytes, not a command.
  it('does not rewrite text containing a carriage return', async () => {
    const { router, writeMock } = setupWithResolver(bind({ agent: 'claude', model: 'haiku' }));
    await router.dispatch({
      id: '8',
      method: 'input.send',
      params: { text: 'claude\rsecond', ptyId: 'pty-a', workspaceId: 'ws-self', submit: true },
    });
    expect(writeMock.mock.calls[0]).toEqual(['pty-a', 'claude\rsecond']);
  });

  it('does not rewrite a raw:true write', async () => {
    const { router, writeMock } = setupWithResolver(bind({ agent: 'claude', model: 'haiku' }));
    await router.dispatch({
      id: '9',
      method: 'input.send',
      params: { text: 'claude', ptyId: 'pty-a', workspaceId: 'ws-self', submit: true, raw: true },
    });
    expect(writeMock.mock.calls[0]).toEqual(['pty-a', 'claude']);
  });

  // P2-5 — an args-only rewrite must not advertise a model that isn't running.
  it('reports enforcedModel only when the model flag was actually injected', async () => {
    const { router, writeMock } = setupWithResolver(
      bind({ agent: 'claude', model: 'haiku', args: '--foo' }),
    );
    const res = await router.dispatch({
      id: '10',
      method: 'input.send',
      params: {
        text: 'claude --model opus',
        ptyId: 'pty-a',
        workspaceId: 'ws-self',
        submit: true,
      },
    });
    expect(writeMock.mock.calls[0]).toEqual(['pty-a', 'claude --model opus --foo']);
    const payload = res.ok ? (res.result as { enforcedModel?: string }) : {};
    expect(payload.enforcedModel).toBeUndefined();
  });

  // P1-1 — the handler runs on EVERY submitted line in a bound pane.
  it('leaves a shell command in a bound pane byte-identical', async () => {
    const { router, writeMock } = setupWithResolver(
      bind({ agent: 'claude', model: 'haiku', args: '--dangerously-skip-permissions' }),
    );
    await router.dispatch({
      id: '11',
      method: 'input.send',
      params: { text: 'git commit -m "wip"', ptyId: 'pty-a', workspaceId: 'ws-self', submit: true },
    });
    expect(writeMock.mock.calls[0]).toEqual(['pty-a', 'git commit -m "wip"']);
  });

  // P2-1 — terminal_send is also how the orchestrator prompts a RUNNING agent.
  it('leaves a prose instruction starting with the launcher word alone', async () => {
    const { router, writeMock } = setupWithResolver(bind({ agent: 'claude', model: 'haiku' }));
    await router.dispatch({
      id: '12',
      method: 'input.send',
      params: {
        text: 'claude code is failing on windows',
        ptyId: 'pty-a',
        workspaceId: 'ws-self',
        submit: true,
      },
    });
    expect(writeMock.mock.calls[0]).toEqual(['pty-a', 'claude code is failing on windows']);
  });
});
