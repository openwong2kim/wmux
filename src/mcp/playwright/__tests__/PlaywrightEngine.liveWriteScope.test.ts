import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Live Chrome, agent window: the MCP-lane half of the write gate.
 *
 * This lane matters on its own because it does NOT go through main for most
 * writes — browser_fill, browser_select, browser_file_upload and friends drive
 * the resolved Playwright page over CDP directly — so a main-only gate would
 * leave the user's own tabs writable through the tools agents reach for most.
 *
 * Ownership is still main's answer, not this lane's: browser.cdp.info reports
 * the tabs the calling workspace opened plus the ones the user lent it, and a
 * resolved target absent from that list is one the agent may read and must not
 * drive.
 */

const mockSendRpc = vi.fn();
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));
vi.mock('../lazyPlaywright', () => ({
  loadPlaywright: () => ({ chromium: { connectOverCDP: vi.fn() }, devices: {} }),
}));
// Not under test, and both run AFTER page resolution on the allowed path.
vi.mock('../pageCapture', () => ({ attachPageCapture: vi.fn() }));
vi.mock('../ua-emulation', () => ({ reassertUserAgentEmulation: vi.fn(async () => undefined) }));

import { PlaywrightEngine } from '../PlaywrightEngine';
import { AGENT_WINDOW_SCOPE_CODE } from '../../../shared/liveWriteScope';
import { allowScopedRpcFallback } from '../browserScope';
import { __resetSurfaceRoutingForTesting } from '../surfaceRouting';

const SCOPE = { workspaceId: 'ws-1', surfaceId: 'agent-tab' } as const;

interface FakeSession {
  send: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
}

/** A Page whose CDP target id is `targetId`. `null` makes Target.getTargetInfo
 *  fail, which is the "cannot prove ownership" case. */
function makeFakePage(targetId: string | null) {
  const session: FakeSession = {
    send: vi.fn(async () =>
      targetId === null ? Promise.reject(new Error('target gone')) : { targetInfo: { targetId } },
    ),
    detach: vi.fn(async () => undefined),
  };
  const page = {
    session,
    url: () => 'https://somewhere.test/',
    on: vi.fn(),
    context: () => ({ newCDPSession: vi.fn(async () => session) }),
  };
  return page;
}

type EnginePrivate = {
  getPage: (surfaceId?: string, workspaceId?: string, noSurface?: boolean) => Promise<unknown>;
  cacheShellUrl: (info: Record<string, unknown>) => void;
  liveWriteScope: 'agent' | 'all' | undefined;
};

function engineWith(page: unknown, info: Record<string, unknown>) {
  (PlaywrightEngine as unknown as { instance: PlaywrightEngine | null }).instance = null;
  __resetSurfaceRoutingForTesting();
  const engine = PlaywrightEngine.getInstance();
  const priv = engine as unknown as EnginePrivate;
  // Page discovery itself is covered elsewhere; this file is about what happens
  // to a page that HAS resolved.
  priv.getPage = vi.fn(async () => page);
  priv.cacheShellUrl(info);
  return { engine, priv };
}

const LIVE_INFO = {
  workspaceBackend: 'chrome',
  wsEndpoint: 'ws://127.0.0.1:9333/devtools/browser/abc',
  liveWriteScope: 'agent',
  targets: [
    { surfaceId: 'agent-tab', targetId: 'agent-tab', owner: 'agent' },
    { surfaceId: 'lent-tab', targetId: 'lent-tab', owner: 'borrowed' },
  ],
};

beforeEach(() => {
  mockSendRpc.mockReset();
});

describe('getPageForScope write intent on Live Chrome', () => {
  it('refuses a write to a tab main does not list as the workspace own', async () => {
    const page = makeFakePage('user-tab');
    const { engine } = engineWith(page, LIVE_INFO);
    mockSendRpc.mockResolvedValue(LIVE_INFO);

    await expect(
      engine.getPageForScope({ ...SCOPE, surfaceId: 'user-tab' }, { intent: 'write' }),
    ).rejects.toThrow(AGENT_WINDOW_SCOPE_CODE);
  });

  it('the refusal names the tab and the way out', async () => {
    const page = makeFakePage('user-tab');
    const { engine } = engineWith(page, LIVE_INFO);
    mockSendRpc.mockResolvedValue(LIVE_INFO);

    await expect(
      engine.getPageForScope({ ...SCOPE, surfaceId: 'user-tab' }, { intent: 'write' }),
    ).rejects.toThrow('borrow it first: browser_tabs action:"borrow" surfaceId:"user-tab"');
  });

  it('allows a write to a tab the workspace opened', async () => {
    const page = makeFakePage('agent-tab');
    const { engine } = engineWith(page, LIVE_INFO);
    mockSendRpc.mockResolvedValue(LIVE_INFO);

    await expect(engine.getPageForScope(SCOPE, { intent: 'write' })).resolves.toBe(page);
  });

  it('allows a write to a tab the user lent the workspace', async () => {
    const page = makeFakePage('lent-tab');
    const { engine } = engineWith(page, LIVE_INFO);
    mockSendRpc.mockResolvedValue(LIVE_INFO);

    await expect(
      engine.getPageForScope({ ...SCOPE, surfaceId: 'lent-tab' }, { intent: 'write' }),
    ).resolves.toBe(page);
  });

  it('a READ of the user own tab is untouched, and costs no extra round trip', async () => {
    const page = makeFakePage('user-tab');
    const { engine } = engineWith(page, LIVE_INFO);
    mockSendRpc.mockResolvedValue(LIVE_INFO);

    // The default intent is 'read', which is what keeps every existing call site
    // byte-identical.
    await expect(
      engine.getPageForScope({ ...SCOPE, surfaceId: 'user-tab' }),
    ).resolves.toBe(page);
    expect(mockSendRpc).not.toHaveBeenCalled();
  });

  it("the operator opt-out ('all') writes anywhere again", async () => {
    const page = makeFakePage('user-tab');
    const info = { ...LIVE_INFO, liveWriteScope: 'all' };
    const { engine } = engineWith(page, info);
    mockSendRpc.mockResolvedValue(info);

    await expect(
      engine.getPageForScope({ ...SCOPE, surfaceId: 'user-tab' }, { intent: 'write' }),
    ).resolves.toBe(page);
  });

  it('a live policy switched to "all" since the cache is honoured from the fresh answer', async () => {
    const page = makeFakePage('user-tab');
    const { engine } = engineWith(page, LIVE_INFO);
    // Cached 'agent'; main now reports 'all'. The response in hand wins.
    mockSendRpc.mockResolvedValue({ ...LIVE_INFO, liveWriteScope: 'all' });

    await expect(
      engine.getPageForScope({ ...SCOPE, surfaceId: 'user-tab' }, { intent: 'write' }),
    ).resolves.toBe(page);
  });

  it('a builtin or dedicated backend has no policy, so writes are not gated', async () => {
    const page = makeFakePage('whatever');
    const { engine, priv } = engineWith(page, { workspaceBackend: 'chrome', targets: [] });
    expect(priv.liveWriteScope).toBeUndefined();

    await expect(engine.getPageForScope(SCOPE, { intent: 'write' })).resolves.toBe(page);
    expect(mockSendRpc).not.toHaveBeenCalled();
  });

  it('refuses when ownership cannot be PROVEN: the page will not report its target', async () => {
    const page = makeFakePage(null);
    const { engine } = engineWith(page, LIVE_INFO);
    mockSendRpc.mockResolvedValue(LIVE_INFO);

    // An ownership check that cannot be made is not a check.
    await expect(engine.getPageForScope(SCOPE, { intent: 'write' })).rejects.toThrow(
      AGENT_WINDOW_SCOPE_CODE,
    );
  });

  it('refuses when main cannot be reached for the answer', async () => {
    const page = makeFakePage('agent-tab');
    const { engine } = engineWith(page, LIVE_INFO);
    mockSendRpc.mockRejectedValue(new Error('pipe closed'));

    await expect(engine.getPageForScope(SCOPE, { intent: 'write' })).rejects.toThrow(
      AGENT_WINDOW_SCOPE_CODE,
    );
  });

  it('asks main scoped to the CALLING workspace', async () => {
    const page = makeFakePage('agent-tab');
    const { engine } = engineWith(page, LIVE_INFO);
    mockSendRpc.mockResolvedValue(LIVE_INFO);

    await engine.getPageForScope(SCOPE, { intent: 'write' });

    expect(mockSendRpc).toHaveBeenCalledWith('browser.cdp.info', { workspaceId: 'ws-1' });
  });

  it('the refusal is NOT converted into an RPC fallback', async () => {
    // allowScopedRpcFallback turns a page-discovery miss into "use the RPC lane".
    // This refusal is not a discovery miss: the page was found and this workspace
    // may not write to it, so swallowing it would hide the one sentence that
    // says how to fix it.
    const page = makeFakePage('user-tab');
    const { engine } = engineWith(page, LIVE_INFO);
    mockSendRpc.mockResolvedValue(LIVE_INFO);

    await expect(
      engine
        .getPageForScope({ ...SCOPE, surfaceId: 'user-tab' }, { intent: 'write' })
        .catch(allowScopedRpcFallback),
    ).rejects.toThrow(AGENT_WINDOW_SCOPE_CODE);
  });
});
