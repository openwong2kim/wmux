import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Which pages the engine intercepts dialogs and file choosers on. The rule is
 * ownership: only a tab the agent opened. A tab the user lent, the user's own
 * tab (reachable for writes under the 'all' policy) and anything resolved for a
 * read keep Playwright's default handling, so a person's own upload or dialog
 * is never taken from them.
 */

const mockSendRpc = vi.fn();
vi.mock('../../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));
vi.mock('../../lazyPlaywright', () => ({
  loadPlaywright: () => ({ chromium: { connectOverCDP: vi.fn() }, devices: {} }),
}));
vi.mock('../../pageCapture', () => ({ attachPageCapture: vi.fn() }));
vi.mock('../../ua-emulation', () => ({ reassertUserAgentEmulation: vi.fn(async () => undefined) }));

import { PlaywrightEngine } from '../../PlaywrightEngine';
import { __resetSurfaceRoutingForTesting } from '../../surfaceRouting';
import { effectTagOf } from '../../resultTrailer';

function makePage(targetId: string) {
  const session = {
    send: vi.fn(async () => ({ targetInfo: { targetId } })),
    detach: vi.fn(async () => undefined),
  };
  const on = vi.fn();
  return {
    on,
    off: vi.fn(),
    once: vi.fn(),
    url: () => 'https://somewhere.test/',
    mainFrame: () => ({}),
    evaluate: vi.fn(() => new Promise(() => {})),
    context: () => ({ newCDPSession: vi.fn(async () => session) }),
    events: () => on.mock.calls.map((c) => c[0] as string),
    emit: (event: string, arg: unknown) => {
      for (const [name, fn] of on.mock.calls) if (name === event) (fn as (a: unknown) => void)(arg);
    },
  };
}

function engineWith(page: unknown, info: Record<string, unknown>) {
  (PlaywrightEngine as unknown as { instance: PlaywrightEngine | null }).instance = null;
  __resetSurfaceRoutingForTesting();
  const engine = PlaywrightEngine.getInstance();
  const priv = engine as unknown as {
    getPage: () => Promise<unknown>;
    cacheShellUrl: (i: Record<string, unknown>) => void;
  };
  priv.getPage = vi.fn(async () => page);
  priv.cacheShellUrl(info);
  return engine;
}

const LIVE = (scope: 'agent' | 'all') => ({
  workspaceBackend: 'chrome',
  liveWriteScope: scope,
  targets: [
    { surfaceId: 'agent-tab', targetId: 'agent-tab', owner: 'agent' },
    { surfaceId: 'lent-tab', targetId: 'lent-tab', owner: 'borrowed' },
  ],
});

beforeEach(() => {
  mockSendRpc.mockReset();
});

describe('modal interception follows tab ownership', () => {
  it('an agent-owned live tab gets the dialog and filechooser listeners on a write', async () => {
    const page = makePage('agent-tab');
    const engine = engineWith(page, LIVE('agent'));
    mockSendRpc.mockResolvedValue(LIVE('agent'));
    await engine.getPageForScope({ workspaceId: 'ws-1', surfaceId: 'agent-tab' }, { intent: 'write' });
    expect(page.events()).toEqual(expect.arrayContaining(['dialog', 'filechooser']));
  });

  it('a lent tab gets neither', async () => {
    const page = makePage('lent-tab');
    const engine = engineWith(page, LIVE('agent'));
    mockSendRpc.mockResolvedValue(LIVE('agent'));
    await engine.getPageForScope({ workspaceId: 'ws-1', surfaceId: 'lent-tab' }, { intent: 'write' });
    expect(page.events()).not.toContain('dialog');
    expect(page.events()).not.toContain('filechooser');
  });

  it('under the all-tabs policy (the tab may be the user’s) neither is attached', async () => {
    const page = makePage('user-tab');
    const engine = engineWith(page, LIVE('all'));
    mockSendRpc.mockResolvedValue(LIVE('all'));
    await engine.getPageForScope({ workspaceId: 'ws-1', surfaceId: 'user-tab' }, { intent: 'write' });
    expect(page.events()).not.toContain('dialog');
    expect(page.events()).not.toContain('filechooser');
  });

  it('a read lookup never attaches anything', async () => {
    const page = makePage('agent-tab');
    const engine = engineWith(page, LIVE('agent'));
    mockSendRpc.mockResolvedValue(LIVE('agent'));
    await engine.getPageForScope({ workspaceId: 'ws-1', surfaceId: 'agent-tab' });
    expect(page.events()).not.toContain('dialog');
  });

  it('builtin (every target is wmux’s own) is intercepted on a write', async () => {
    const page = makePage('guest');
    const engine = engineWith(page, { workspaceBackend: 'builtin' });
    await engine.getPageForScope({ workspaceId: 'ws-1', surfaceId: 'guest' }, { intent: 'write' });
    expect(page.events()).toEqual(expect.arrayContaining(['dialog', 'filechooser']));
  });

  it('a pending modal refuses other writes, but not the answering tools', async () => {
    const page = makePage('guest');
    const engine = engineWith(page, { workspaceBackend: 'builtin' });
    const scope = { workspaceId: 'ws-1', surfaceId: 'guest' };
    await engine.getPageForScope(scope, { intent: 'write' });
    page.emit('dialog', {
      type: () => 'alert',
      message: () => 'boom',
      defaultValue: () => '',
      accept: vi.fn(),
      dismiss: vi.fn(),
    });

    const refusal = await engine.getPageForScope(scope, { intent: 'write' }).catch((e) => e);
    expect(effectTagOf(refusal)?.code).toBe('dialog_blocked');
    await expect(
      engine.getPageForScope(scope, { intent: 'write', answersModal: true }),
    ).resolves.toBe(page);
    // Reads are not refused here; the [modal] block explains what they hit.
    await expect(engine.getPageForScope(scope)).resolves.toBe(page);
  });
});
