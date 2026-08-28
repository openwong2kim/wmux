import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Regression tests for the CDP session lifecycle in PlaywrightEngine.
 *
 * Background: The engine opens browser-level CDP sessions for Target discovery
 * (auto-attach, Target.getTargets, Target.attachToTarget). Each session lives
 * inside Playwright's internal connection map until detach() is called. Prior
 * to this test, four session-creation sites in the engine never detached,
 * which accumulated across every browser MCP call and leaked memory even at
 * idle (the sessions stayed subscribed to Target domain events).
 *
 * These tests exercise the connect/disconnect contract — the hottest leak
 * path, triggered on every reconnect and on engine teardown.
 */

const mockSendRpc = vi.fn();
// NOTE: path is relative to THIS test file. PlaywrightEngine.ts lives one
// directory up and imports '../wmux-client' (= src/mcp/wmux-client), so from
// src/mcp/playwright/__tests__/ the same module is '../../wmux-client'. The
// previous '../wmux-client' resolved to a non-existent module and silently
// failed to mock sendRpc — only unnoticed because earlier tests never drove a
// code path that called it.
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

const mockConnectOverCDP = vi.fn();
// B0: the engine loads playwright through the lazyPlaywright seam (separate
// runtime chunk in the bundle), so the mock moves to that seam — a raw
// require() of playwright-core would bypass vi.mock entirely.
vi.mock('../lazyPlaywright', () => ({
  loadPlaywright: () => ({
    chromium: {
      connectOverCDP: (...args: unknown[]) => mockConnectOverCDP(...args),
    },
    // Mirror the seam's real surface: state.ts reads devices[name] for
    // emulation, and an absent key here would greenlight a broken path.
    devices: {},
  }),
}));

// Import after mocks are declared.
import {
  PlaywrightEngine,
  isElectronShellUrl,
  WORKSPACE_SCOPE_UNRESOLVED_CODE,
} from '../PlaywrightEngine';
import {
  EXTERNAL_BACKEND_UNSUPPORTED_CODE,
  EXTERNAL_BACKEND_UNSUPPORTED_MESSAGE,
} from '../../../shared/browserBackend';

/*
 * Regression tests for app-shell URL detection.
 *
 * Background: getPage() picks the "first page whose URL is not the Electron
 * shell" as the page to drive. In packaged builds the main window is loaded
 * via loadFile() of the bundled renderer, producing a file:// URL ending in
 * `.../renderer/main_window/index.html`. The original isElectronShellUrl()
 * only excluded http://localhost, http://127.0.0.1, devtools://, chrome:// —
 * so the packaged file:// shell slipped through and was returned instead of
 * the real <webview> page. Dev builds (Vite dev server on http://localhost)
 * were unaffected, which is why the bug only reproduced in production.
 */
describe('isElectronShellUrl', () => {
  it('treats the dev-server shell origins as the shell', () => {
    expect(isElectronShellUrl('http://localhost:5173/')).toBe(true);
    expect(isElectronShellUrl('http://127.0.0.1:5173/index.html')).toBe(true);
    expect(isElectronShellUrl('devtools://devtools/bundled/inspector.html')).toBe(true);
    expect(isElectronShellUrl('chrome://gpu/')).toBe(true);
  });

  it('treats the packaged file:// renderer entry as the shell', () => {
    // Windows asar-packed path with a percent-encoded directory.
    expect(
      isElectronShellUrl(
        'file:///C:/Program%20Files/wmux/resources/app.asar/.vite/renderer/main_window/index.html',
      ),
    ).toBe(true);
    // POSIX asar-packed path.
    expect(
      isElectronShellUrl('file:///opt/wmux/resources/app.asar/.vite/renderer/main_window/index.html'),
    ).toBe(true);
    // Unpacked (asar disabled) packaged path.
    expect(
      isElectronShellUrl('file:///opt/wmux/resources/app/.vite/renderer/main_window/index.html'),
    ).toBe(true);
    // Tolerate a trailing query/hash appended by the renderer.
    expect(
      isElectronShellUrl('file:///x/.vite/renderer/main_window/index.html?foo=1#bar'),
    ).toBe(true);
    // Case-insensitive (Windows filesystems are case-insensitive).
    expect(
      isElectronShellUrl('file:///X/.vite/renderer/main_window/INDEX.HTML'),
    ).toBe(true);
  });

  it('does NOT misclassify a user project that merely ends in main_window/index.html', () => {
    // The key false-positive risk: a user opening their OWN project's
    // main_window/index.html as the page being browsed. Without the
    // `.vite/renderer/` qualifier this would be dropped as the app shell.
    expect(isElectronShellUrl('file:///C:/myproj/main_window/index.html')).toBe(false);
    expect(isElectronShellUrl('file:///home/user/app/src/main_window/index.html')).toBe(false);
    // Even a renderer/main_window/index.html without the `.vite` segment is a
    // user page, not wmux's build output.
    expect(isElectronShellUrl('file:///home/user/renderer/main_window/index.html')).toBe(false);
  });

  it('does NOT exclude other legitimate user-opened file:// pages', () => {
    expect(isElectronShellUrl('file:///home/user/report.html')).toBe(false);
    expect(isElectronShellUrl('file:///C:/docs/index.html')).toBe(false);
    expect(isElectronShellUrl('file:///some/other_window/index.html')).toBe(false);
    // A directory URL (trailing slash) is not the shell entry file.
    expect(isElectronShellUrl('file:///x/.vite/renderer/main_window/')).toBe(false);
  });

  it('does NOT exclude real remote page URLs', () => {
    // A remote page that coincidentally mirrors the shell path is still a page.
    expect(
      isElectronShellUrl('https://example.com/.vite/renderer/main_window/index.html'),
    ).toBe(false);
    expect(isElectronShellUrl('https://example.com/')).toBe(false);
    expect(isElectronShellUrl('about:blank')).toBe(false);
  });
});

interface FakeSession {
  send: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
}

function makeFakeSession(): FakeSession {
  return {
    send: vi.fn().mockResolvedValue({ targetInfos: [] }),
    detach: vi.fn().mockResolvedValue(undefined),
  };
}

function makeFakeBrowser(sessions: FakeSession[]) {
  return {
    isConnected: vi.fn().mockReturnValue(true),
    newBrowserCDPSession: vi.fn().mockImplementation(async () => {
      const s = makeFakeSession();
      sessions.push(s);
      return s;
    }),
    contexts: vi.fn().mockReturnValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('PlaywrightEngine CDP session lifecycle', () => {
  beforeEach(() => {
    // Reset the singleton so each test gets a clean engine.
    (PlaywrightEngine as unknown as { instance: PlaywrightEngine | null }).instance = null;
    mockSendRpc.mockReset();
    mockConnectOverCDP.mockReset();
  });

  it('detaches the auto-attach session on disconnect', async () => {
    const sessions: FakeSession[] = [];
    const browser = makeFakeBrowser(sessions);
    mockConnectOverCDP.mockResolvedValue(browser);

    const engine = PlaywrightEngine.getInstance();
    await engine.connect(9222);

    // connect() creates exactly one browser-level session for setAutoAttach.
    expect(sessions).toHaveLength(1);
    expect(sessions[0].send).toHaveBeenCalledWith(
      'Target.setAutoAttach',
      expect.objectContaining({ autoAttach: true }),
    );
    // The session must survive until disconnect — detach has NOT been called yet.
    expect(sessions[0].detach).not.toHaveBeenCalled();

    await engine.disconnect();

    // After disconnect, the auto-attach session must be detached so it
    // doesn't remain pinned inside Playwright's internal session map.
    expect(sessions[0].detach).toHaveBeenCalledTimes(1);
  });

  it('detaches the prior auto-attach session when reconnecting to a new CDP port', async () => {
    const sessions: FakeSession[] = [];
    mockConnectOverCDP.mockImplementation(async () => makeFakeBrowser(sessions));

    const engine = PlaywrightEngine.getInstance();
    await engine.connect(9222);
    expect(sessions).toHaveLength(1);

    // Reconnect to a different port — connect() must call disconnect() first,
    // which must detach the prior auto-attach session before creating a new one.
    await engine.connect(9333);

    expect(sessions).toHaveLength(2);
    expect(sessions[0].detach).toHaveBeenCalledTimes(1);
    // The new session is still live.
    expect(sessions[1].detach).not.toHaveBeenCalled();
  });

  it('does not throw if the auto-attach session is already gone on disconnect', async () => {
    const sessions: FakeSession[] = [];
    const browser = makeFakeBrowser(sessions);
    mockConnectOverCDP.mockResolvedValue(browser);

    const engine = PlaywrightEngine.getInstance();
    await engine.connect(9222);

    // Simulate a session that errors on detach (e.g. the remote end already
    // closed). disconnect() must still complete successfully — best-effort.
    sessions[0].detach.mockRejectedValueOnce(new Error('Session closed'));

    await expect(engine.disconnect()).resolves.toBeUndefined();
    expect(sessions[0].detach).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['omitted', undefined],
    ['zero', 0],
    ['above the maximum TCP port', 65_536],
    ['fractional', 9222.5],
  ])('fails clearly without retrying when cdpPort is %s', async (_label, cdpPort) => {
    mockSendRpc.mockResolvedValue(
      cdpPort === undefined ? { targets: [] } : { cdpPort, targets: [] },
    );

    const engine = PlaywrightEngine.getInstance();

    await expect(engine.ensureConnected('ws-caller')).rejects.toThrow(
      'browser.cdp.info did not disclose a usable CDP endpoint to this caller',
    );
    expect(mockSendRpc).toHaveBeenCalledTimes(1);
    expect(mockSendRpc).toHaveBeenCalledWith('browser.cdp.info', { workspaceId: 'ws-caller' });
    expect(mockConnectOverCDP).not.toHaveBeenCalled();
  });

  it('propagates unavailable attach info without entering a second page-discovery retry', async () => {
    const sessions: FakeSession[] = [];
    mockConnectOverCDP.mockResolvedValue(makeFakeBrowser(sessions));
    mockSendRpc
      .mockResolvedValueOnce({ cdpPort: 9222, targets: [] })
      .mockResolvedValueOnce({ targets: [] });

    const engine = PlaywrightEngine.getInstance();
    const internals = engine as unknown as {
      _getPageImpl(ctx: {
        key: string;
        surfaceId: string;
        callerHasNoSurface: boolean;
        workspaceId: string;
      }): Promise<unknown>;
      findViaTargetDomain(): Promise<unknown>;
      findViaJsonEndpoint(): Promise<unknown>;
    };
    vi.spyOn(internals, 'findViaTargetDomain').mockResolvedValue(null);
    vi.spyOn(internals, 'findViaJsonEndpoint').mockResolvedValue(null);

    await expect(internals._getPageImpl({
      key: 'ws:ws-caller:surf:surface-caller',
      surfaceId: 'surface-caller',
      callerHasNoSurface: false,
      workspaceId: 'ws-caller',
    })).rejects.toThrow(
      'browser.cdp.info did not disclose a usable CDP endpoint to this caller',
    );
    expect(mockSendRpc).toHaveBeenCalledTimes(2);
    expect(mockConnectOverCDP).toHaveBeenCalledTimes(1);
  });
});

/*
 * Tests for the runtime shell-URL hardening (Option B + reorder).
 *
 * The engine learns the app shell's real URL from the browser.cdp.info RPC
 * (`shellUrl`) and uses an exact-match against it to recognize the shell —
 * instead of guessing from build-path shape. The static isElectronShellUrl()
 * heuristic remains as a defense-in-depth fallback for when the runtime URL
 * isn't available yet. getPage() also tries positive targetId matching before
 * the negative "first non-shell page" filter so it never returns the shell.
 */

// Minimal access to the engine's private shell-URL surface for unit testing.
interface ShellUrlInternals {
  shellUrl: string | null;
  cacheShellUrl(info: { cdpPort: number; shellUrl?: string; targets: unknown[] }): void;
  isShellPage(url: string): boolean;
  matchPinnedPage(pages: FakePage[], targetId: string, url: string): Promise<FakePage | null>;
  getPage(surfaceId?: string, workspaceId?: string): Promise<FakePage | null>;
}
function priv(engine: PlaywrightEngine): ShellUrlInternals {
  return engine as unknown as ShellUrlInternals;
}

interface FakePage {
  url: ReturnType<typeof vi.fn>;
  context: ReturnType<typeof vi.fn>;
}

describe('PlaywrightEngine runtime shell-URL handling (B)', () => {
  beforeEach(() => {
    (PlaywrightEngine as unknown as { instance: PlaywrightEngine | null }).instance = null;
    mockSendRpc.mockReset();
    mockConnectOverCDP.mockReset();
  });

  it('caches shellUrl from cdp.info and exact-matches it as the shell', () => {
    const engine = PlaywrightEngine.getInstance();
    priv(engine).cacheShellUrl({ cdpPort: 1, shellUrl: 'https://app.internal/shell', targets: [] });

    expect(priv(engine).shellUrl).toBe('https://app.internal/shell');
    expect(priv(engine).isShellPage('https://app.internal/shell')).toBe(true);
    // A different page (the real webview) is NOT the shell.
    expect(priv(engine).isShellPage('https://example.com/page')).toBe(false);
  });

  it('ignores empty/missing shellUrl so a known-good value is not clobbered', () => {
    const engine = PlaywrightEngine.getInstance();
    const good = 'file:///real/.vite/renderer/main_window/index.html';
    priv(engine).cacheShellUrl({ cdpPort: 1, shellUrl: good, targets: [] });
    priv(engine).cacheShellUrl({ cdpPort: 1, targets: [] });            // missing
    priv(engine).cacheShellUrl({ cdpPort: 1, shellUrl: '', targets: [] }); // empty

    expect(priv(engine).shellUrl).toBe(good);
  });

  it('falls back to the static heuristic when no runtime shellUrl is known', () => {
    const engine = PlaywrightEngine.getInstance();
    expect(priv(engine).shellUrl).toBeNull();

    // Heuristic still catches the packaged + dev shell shapes...
    expect(priv(engine).isShellPage('file:///x/.vite/renderer/main_window/index.html')).toBe(true);
    expect(priv(engine).isShellPage('http://localhost:5173/')).toBe(true);
    // ...but does not over-exclude a user-opened file:// page.
    expect(priv(engine).isShellPage('file:///home/user/main_window/index.html')).toBe(false);
  });

  it('exact-match excludes only the shell, even for a dev-server shell URL', () => {
    const engine = PlaywrightEngine.getInstance();
    priv(engine).cacheShellUrl({ cdpPort: 1, shellUrl: 'http://localhost:5173/', targets: [] });

    expect(priv(engine).isShellPage('http://localhost:5173/')).toBe(true);
    // A real remote webview is reachable.
    expect(priv(engine).isShellPage('https://example.com/')).toBe(false);
  });

  it('requires targetId proof even when only one page has the pinned URL', async () => {
    let reportedTargetId = 'wc-foreign';
    const session = {
      send: vi.fn().mockImplementation((method: string) =>
        method === 'Target.getTargetInfo'
          ? Promise.resolve({ targetInfo: { targetId: reportedTargetId } })
          : Promise.resolve({}),
      ),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
      newCDPSession: vi.fn().mockResolvedValue(session),
    };
    const onlySameUrlPage: FakePage = {
      url: vi.fn().mockReturnValue('https://same.example/'),
      context: vi.fn().mockReturnValue(context),
    };
    const engine = PlaywrightEngine.getInstance();

    await expect(priv(engine).matchPinnedPage(
      [onlySameUrlPage],
      'wc-owned',
      'https://same.example/',
    )).resolves.toBeNull();

    reportedTargetId = 'wc-owned';
    await expect(priv(engine).matchPinnedPage(
      [onlySameUrlPage],
      'wc-owned',
      'https://same.example/',
    )).resolves.toBe(onlySameUrlPage);
    expect(session.detach).toHaveBeenCalledTimes(2);
  });

  it('getPageForScope refuses a hand-built empty workspace before discovery', async () => {
    const engine = PlaywrightEngine.getInstance();

    await expect(engine.getPageForScope({
      workspaceId: '',
      surfaceId: 'surface-pinned',
    })).rejects.toThrow(WORKSPACE_SCOPE_UNRESOLVED_CODE);
    expect(mockSendRpc).not.toHaveBeenCalled();
  });

  it('clears the cached shellUrl on disconnect', async () => {
    const sessions: FakeSession[] = [];
    mockConnectOverCDP.mockResolvedValue(makeFakeBrowser(sessions));

    const engine = PlaywrightEngine.getInstance();
    await engine.connect(9222);
    priv(engine).cacheShellUrl({ cdpPort: 9222, shellUrl: 'file:///x/.vite/renderer/main_window/index.html', targets: [] });
    expect(priv(engine).shellUrl).not.toBeNull();

    await engine.disconnect();
    expect(priv(engine).shellUrl).toBeNull();
  });

  it('getPage returns the guest webview, not the exact-match app shell', async () => {
    const shellUrl = 'file:///app/.vite/renderer/main_window/index.html';

    const makePage = (u: string): FakePage => {
      const page: FakePage = {
        url: vi.fn().mockReturnValue(u),
        context: vi.fn(),
      };
      return page;
    };
    const shellPage = makePage(shellUrl);
    const webviewPage = makePage('https://example.com/');

    // The caller's own registered guest, as Target.getTargets sees it.
    const session = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === 'Target.getTargets') {
          return Promise.resolve({
            targetInfos: [
              { targetId: 'wc-1', type: 'page', title: '', url: 'https://example.com/', attached: true },
            ],
          });
        }
        if (method === 'Target.getTargetInfo') {
          return Promise.resolve({ targetInfo: { targetId: 'wc-1' } });
        }
        return Promise.resolve({});
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    // A context whose pages() exposes both the shell and the webview.
    const ctx = {
      pages: vi.fn().mockReturnValue([shellPage, webviewPage]),
      newCDPSession: vi.fn().mockImplementation(async () => session),
    };
    shellPage.context.mockReturnValue(ctx);
    webviewPage.context.mockReturnValue(ctx);

    const browser = {
      isConnected: vi.fn().mockReturnValue(true),
      newBrowserCDPSession: vi.fn().mockImplementation(async () => session),
      contexts: vi.fn().mockReturnValue([ctx]),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockConnectOverCDP.mockResolvedValue(browser);

    // cdp.info advertises the shell URL alongside the caller's own guest, so
    // discovery must resolve the guest and never hand back the exact-match
    // shell page that shares the context.
    mockSendRpc.mockImplementation((method: string, params?: unknown) => {
      if (method === 'browser.cdp.info') {
        const ws = (params as { workspaceId?: string } | undefined)?.workspaceId;
        return Promise.resolve({
          cdpPort: 9222,
          shellUrl,
          ...(ws && { targetsScoped: true }),
          targets: [{ surfaceId: 'surf-A', targetId: 'wc-1', workspaceId: 'ws-A' }],
        });
      }
      return Promise.resolve({});
    });

    const engine = PlaywrightEngine.getInstance();
    (engine as unknown as { setWorkspaceIdResolver(r: () => Promise<string>): void })
      .setWorkspaceIdResolver(async () => 'ws-A');
    await engine.connect(9222);

    const page = await priv(engine).getPage();
    expect(page).toBe(webviewPage);
    // The shell URL was learned from cdp.info during discovery.
    expect(priv(engine).shellUrl).toBe(shellUrl);
  });

  it('strict surface targeting rejects a legacy main that returns a foreign or untagged explicit target', async () => {
    const shellUrl = 'file:///app/.vite/renderer/main_window/index.html';
    const otherGuest: FakePage = {
      url: vi.fn().mockReturnValue('https://other-guest.example/'),
      context: vi.fn(),
    };
    const ctx = {
      pages: vi.fn().mockReturnValue([otherGuest]),
      newCDPSession: vi.fn().mockImplementation(async () => makeFakeSession()),
    };
    otherGuest.context.mockReturnValue(ctx);
    const browser = {
      isConnected: vi.fn().mockReturnValue(true),
      newBrowserCDPSession: vi.fn().mockImplementation(async () => makeFakeSession()),
      contexts: vi.fn().mockReturnValue([ctx]),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockConnectOverCDP.mockResolvedValue(browser);
    // Simulate a legacy main that ignores the workspaceId filter and returns
    // the explicitly requested target from another workspace. The engine must
    // verify the ownership tag itself rather than trust the requested id.
    let targetWorkspaceId: string | undefined = 'ws-other';
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.cdp.info') {
        return Promise.resolve({
          cdpPort: 9222,
          shellUrl,
          targets: [{
            surfaceId: 'surface-pinned',
            targetId: 'wc-foreign',
            ...(targetWorkspaceId && { workspaceId: targetWorkspaceId }),
          }],
        });
      }
      return Promise.resolve({});
    });

    const engine = PlaywrightEngine.getInstance();
    await engine.connect(9222);

    // The tool layer resolves identity before acquiring its lease and supplies
    // the exact same id to getPage (#695). No engine resolver is wired here:
    // this proves the pre-resolved identity is sufficient and is forwarded to
    // every discovery request for the explicit surface.
    const scope = { workspaceId: 'ws-caller', surfaceId: 'surface-pinned' };
    await expect(engine.getPageForScope(scope)).rejects.toThrow(
      /requested browser surface is not owned by the calling workspace/,
    );

    // An untagged legacy response is equally unprovable and must also refuse.
    targetWorkspaceId = undefined;
    await expect(engine.getPageForScope(scope)).rejects.toThrow(
      /does not tag the requested browser target with a workspace/,
    );

    const infoCalls = mockSendRpc.mock.calls.filter(([method]) => method === 'browser.cdp.info');
    expect(infoCalls.length).toBeGreaterThan(0);
    expect(infoCalls.every(([, params]) =>
      (params as { workspaceId?: string } | undefined)?.workspaceId === 'ws-caller'
    )).toBe(true);
  }, 20_000);
});

/*
 * Auto-open workspace routing invariants (#190).
 *
 * When getPage() finds no CDP-discoverable page, Strategy 4 auto-opens a
 * browser surface via the browser.open RPC. The renderer (useRpcBridge.ts)
 * binds a workspace-less browser.open to store.activeWorkspaceId at
 * IPC-handling time, so auto-open must carry the calling session's workspaceId
 * (resolved via the strict resolver wired by src/mcp/index.ts) to pin the
 * surface to the right workspace, and must fail closed — issue no browser.open
 * at all — when identity cannot be resolved, rather than open in an
 * unspecified workspace.
 */

// Minimal access to the engine's auto-open surface. setWorkspaceIdResolver is
// public API; attemptAutoOpen is private and reached the same way the
// shell-URL tests reach their internals.
interface AutoOpenInternals {
  setWorkspaceIdResolver(resolver: () => Promise<string>): void;
  attemptAutoOpen(): Promise<{ surfaceId?: string } | null>;
}
function autoOpen(engine: PlaywrightEngine): AutoOpenInternals {
  return engine as unknown as AutoOpenInternals;
}

describe('PlaywrightEngine auto-open workspace routing (#190)', () => {
  beforeEach(() => {
    (PlaywrightEngine as unknown as { instance: PlaywrightEngine | null }).instance = null;
    mockSendRpc.mockReset();
    mockConnectOverCDP.mockReset();
  });

  it('sends browser.open with the workspaceId from the wired resolver', async () => {
    const engine = PlaywrightEngine.getInstance();
    autoOpen(engine).setWorkspaceIdResolver(async () => 'ws-caller-1');
    mockSendRpc.mockResolvedValue({ ok: true, surfaceId: 'surf-new' });

    // The reply's surfaceId comes back so the caller can pin the surface it
    // just asked for, without having to prove ownership of it afterwards.
    await expect(autoOpen(engine).attemptAutoOpen()).resolves.toEqual({ surfaceId: 'surf-new' });

    expect(mockSendRpc).toHaveBeenCalledWith('browser.open', { workspaceId: 'ws-caller-1' });
  });

  it('fails closed — no browser.open RPC — when the resolver throws', async () => {
    const engine = PlaywrightEngine.getInstance();
    autoOpen(engine).setWorkspaceIdResolver(async () => {
      throw new Error('Workspace identity unknown');
    });

    await expect(autoOpen(engine).attemptAutoOpen()).resolves.toBeNull();

    expect(mockSendRpc.mock.calls.filter((c) => c[0] === 'browser.open')).toHaveLength(0);
  });

  it('fails closed when the resolver returns an empty id', async () => {
    const engine = PlaywrightEngine.getInstance();
    autoOpen(engine).setWorkspaceIdResolver(async () => '');

    await expect(autoOpen(engine).attemptAutoOpen()).resolves.toBeNull();

    expect(mockSendRpc.mock.calls.filter((c) => c[0] === 'browser.open')).toHaveLength(0);
  });

  it('fails closed when no resolver is wired', async () => {
    const engine = PlaywrightEngine.getInstance();

    await expect(autoOpen(engine).attemptAutoOpen()).resolves.toBeNull();

    expect(mockSendRpc.mock.calls.filter((c) => c[0] === 'browser.open')).toHaveLength(0);
  });

  it('getPage never issues a workspace-less browser.open when identity is unavailable', async () => {
    // No page exists anywhere and no resolver is wired. The misrouting shape is
    // browser.open carrying no workspaceId — the renderer then falls back to
    // the UI-active workspace. getPage now refuses at scope resolution (it can
    // no longer select a page unscoped either), so no browser.open is issued.
    const sessions: FakeSession[] = [];
    mockConnectOverCDP.mockImplementation(async () => makeFakeBrowser(sessions));
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.cdp.info') {
        return Promise.resolve({ cdpPort: 59222, targets: [] });
      }
      return Promise.resolve({});
    });

    const engine = PlaywrightEngine.getInstance();

    await expect(priv(engine).getPage()).rejects.toThrow(WORKSPACE_SCOPE_UNRESOLVED_CODE);
    const browserOpenCalls = mockSendRpc.mock.calls.filter((c) => c[0] === 'browser.open');
    expect(browserOpenCalls).toHaveLength(0);
  }, 15_000);

  it('getPage auto-opens with the session workspaceId, then returns the new webview', async () => {
    // Full loop: no page on the first pass, so Strategy 4 auto-opens. The
    // browser.open must carry the wired session id; after it lands, the webview
    // surfaces and getPage returns it. This is the only test that exercises the
    // id flowing through _getPageImpl -> attemptAutoOpen -> browser.open and on
    // to a returned page, so a regression that dropped the id would fail here.
    const shellUrl = 'file:///app/.vite/renderer/main_window/index.html';
    let opened = false;

    const webviewPage: FakePage = {
      url: vi.fn().mockReturnValue('https://example.com/'),
      context: vi.fn(),
    };
    // The just-opened guest registers a workspace-tagged CDP target, which is
    // what lets the post-open re-resolve pin it (mirrors a real main — the
    // engine can no longer fall back to an unscoped "any page" selection).
    const openedSession = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === 'Target.getTargets') {
          return Promise.resolve({
            targetInfos: opened
              ? [{ targetId: 'wc-new', type: 'page', title: '', url: 'https://example.com/', attached: true }]
              : [],
          });
        }
        if (method === 'Target.getTargetInfo') {
          return Promise.resolve({ targetInfo: { targetId: 'wc-new' } });
        }
        return Promise.resolve({});
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const ctx = {
      pages: vi.fn().mockImplementation(() => (opened ? [webviewPage] : [])),
      newCDPSession: vi.fn().mockImplementation(async () => openedSession),
    };
    webviewPage.context.mockReturnValue(ctx);

    const browser = {
      isConnected: vi.fn().mockReturnValue(true),
      newBrowserCDPSession: vi.fn().mockImplementation(async () => openedSession),
      contexts: vi.fn().mockImplementation(() => (opened ? [ctx] : [])),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockConnectOverCDP.mockResolvedValue(browser);
    mockSendRpc.mockImplementation((method: string, params?: unknown) => {
      if (method === 'browser.cdp.info') {
        const ws = (params as { workspaceId?: string } | undefined)?.workspaceId;
        return Promise.resolve({
          cdpPort: 9222,
          shellUrl,
          ...(ws && { targetsScoped: true }),
          targets: opened
            ? [{ surfaceId: 'surf-new', targetId: 'wc-new', workspaceId: 'ws-caller-1' }]
            : [],
        });
      }
      if (method === 'browser.open') {
        opened = true;
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({});
    });

    const engine = PlaywrightEngine.getInstance();
    autoOpen(engine).setWorkspaceIdResolver(async () => 'ws-caller-1');

    const page = await priv(engine).getPage();

    expect(page).toBe(webviewPage);
    expect(mockSendRpc).toHaveBeenCalledWith('browser.open', { workspaceId: 'ws-caller-1' });
  }, 15_000);

  it('auto-open still returns a page against a main too old to tag targets', async () => {
    // The one legacy case this PR keeps functional: a main that ignores the
    // scope request and reports NO live targets at all is unambiguous — nothing
    // exists to cross into — so we auto-open our own surface.
    //
    // Re-deriving the surface afterwards did not work here. The just-opened
    // target carries no workspaceId, so resolveCallerSurface() found nothing
    // tagged and THREW; the throw was swallowed by the auto-open catch,
    // callerHasNoSurface stayed true, discovery stayed skipped, and getPage()
    // returned null. The panel opened and its page was unreachable — the
    // exception documented as "still functional" was not. The surfaceId now
    // comes from browser.open's own reply, which needs no tagging.
    const shellUrl = 'file:///app/.vite/renderer/main_window/index.html';
    let opened = false;

    const webviewPage: FakePage = {
      url: vi.fn().mockReturnValue('https://example.com/'),
      context: vi.fn(),
    };
    const openedSession = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === 'Target.getTargets') {
          return Promise.resolve({
            targetInfos: opened
              ? [{ targetId: 'wc-legacy', type: 'page', title: '', url: 'https://example.com/', attached: true }]
              : [],
          });
        }
        if (method === 'Target.getTargetInfo') {
          return Promise.resolve({ targetInfo: { targetId: 'wc-legacy' } });
        }
        return Promise.resolve({});
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const ctx = {
      pages: vi.fn().mockImplementation(() => (opened ? [webviewPage] : [])),
      newCDPSession: vi.fn().mockImplementation(async () => openedSession),
    };
    webviewPage.context.mockReturnValue(ctx);

    mockConnectOverCDP.mockResolvedValue({
      isConnected: vi.fn().mockReturnValue(true),
      newBrowserCDPSession: vi.fn().mockImplementation(async () => openedSession),
      contexts: vi.fn().mockImplementation(() => (opened ? [ctx] : [])),
      close: vi.fn().mockResolvedValue(undefined),
    });
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.cdp.info') {
        // No `targetsScoped`, and the opened target carries no workspaceId —
        // this main does not tag anything.
        return Promise.resolve({
          cdpPort: 9222,
          shellUrl,
          targets: opened ? [{ surfaceId: 'surf-legacy', targetId: 'wc-legacy' }] : [],
        });
      }
      if (method === 'browser.open') {
        opened = true;
        return Promise.resolve({ ok: true, surfaceId: 'surf-legacy' });
      }
      return Promise.resolve({});
    });

    const engine = PlaywrightEngine.getInstance();
    autoOpen(engine).setWorkspaceIdResolver(async () => 'ws-caller-1');

    await expect(priv(engine).getPage()).resolves.toBe(webviewPage);
    expect(mockSendRpc).toHaveBeenCalledWith('browser.open', { workspaceId: 'ws-caller-1' });
  }, 15_000);

  it('auto-open refuses a target that is explicitly tagged to another workspace', async () => {
    const shellUrl = 'file:///app/.vite/renderer/main_window/index.html';
    let opened = false;

    const session = {
      send: vi.fn().mockImplementation((method: string) =>
        method === 'Target.getTargets'
          ? Promise.resolve({
              targetInfos: opened
                ? [{ targetId: 'wc-foreign', type: 'page', title: '', url: 'https://example.com/', attached: true }]
                : [],
            })
          : Promise.resolve({}),
      ),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
      pages: vi.fn().mockReturnValue([]),
      newCDPSession: vi.fn().mockResolvedValue(session),
    };
    mockConnectOverCDP.mockResolvedValue({
      isConnected: vi.fn().mockReturnValue(true),
      newBrowserCDPSession: vi.fn().mockResolvedValue(session),
      contexts: vi.fn().mockReturnValue([context]),
      close: vi.fn().mockResolvedValue(undefined),
    });
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.cdp.info') {
        return Promise.resolve({
          cdpPort: 9222,
          shellUrl,
          targets: opened
            ? [{ surfaceId: 'surf-new', targetId: 'wc-foreign', workspaceId: 'ws-other' }]
            : [],
        });
      }
      if (method === 'browser.open') {
        opened = true;
        return Promise.resolve({ ok: true, surfaceId: 'surf-new' });
      }
      return Promise.resolve({});
    });

    const engine = PlaywrightEngine.getInstance();
    autoOpen(engine).setWorkspaceIdResolver(async () => 'ws-caller-1');

    await expect(priv(engine).getPage()).rejects.toThrow(
      /requested browser surface is not owned by the calling workspace/,
    );
  }, 15_000);
});

/*
 * #554 — read-path workspace scoping.
 *
 * browser_snapshot / browser_evaluate / browser_extract_* take an OPTIONAL
 * surfaceId. When it is omitted (the common case), page selection must be
 * scoped to the CALLING session's workspace. Before this fix getPage() fell
 * back to "first non-shell page", which is workspace-blind: with two live
 * browser surfaces, an agent in workspace A could read workspace B's page.
 *
 * resolveCallerSurface() is the scoping primitive — it maps the caller's
 * resolved workspace to its own surfaceId from the workspace-tagged
 * browser.cdp.info target list, and reports 'none' (own workspace has no
 * surface) so the caller never falls through to another workspace's page.
 * When it cannot establish that mapping at all it throws — see the
 * fail-closed block below.
 */
interface ScopeInternals {
  setWorkspaceIdResolver(resolver: () => Promise<string>): void;
  resolveCallerSurface(): Promise<
    | { kind: 'surface'; surfaceId: string; workspaceId: string }
    | { kind: 'none'; workspaceId: string }
  >;
  resolveSelectionContext(
    explicitSurfaceId?: string,
  ): Promise<{ key: string; surfaceId?: string; callerHasNoSurface: boolean }>;
}
function scope(engine: PlaywrightEngine): ScopeInternals {
  return engine as unknown as ScopeInternals;
}

describe('PlaywrightEngine read-path workspace scoping (#554)', () => {
  const twoWorkspaceTargets = {
    cdpPort: 9222,
    targets: [
      { surfaceId: 'surf-A', targetId: 'wc-1', workspaceId: 'ws-A' },
      { surfaceId: 'surf-B', targetId: 'wc-2', workspaceId: 'ws-B' },
    ],
  };

  beforeEach(() => {
    (PlaywrightEngine as unknown as { instance: PlaywrightEngine | null }).instance = null;
    mockSendRpc.mockReset();
    mockConnectOverCDP.mockReset();
  });

  it("picks the caller's own surface, never another workspace's, when surfaceId is omitted", async () => {
    mockSendRpc.mockImplementation((method: string) =>
      method === 'browser.cdp.info' ? Promise.resolve(twoWorkspaceTargets) : Promise.resolve({}),
    );
    const engine = PlaywrightEngine.getInstance();
    scope(engine).setWorkspaceIdResolver(async () => 'ws-A');

    await expect(scope(engine).resolveCallerSurface()).resolves.toEqual({
      kind: 'surface',
      surfaceId: 'surf-A',
      workspaceId: 'ws-A',
    });
  });

  it("reports 'none' — not another workspace's surface — when the caller's workspace owns no surface", async () => {
    mockSendRpc.mockImplementation((method: string) =>
      method === 'browser.cdp.info' ? Promise.resolve(twoWorkspaceTargets) : Promise.resolve({}),
    );
    const engine = PlaywrightEngine.getInstance();
    scope(engine).setWorkspaceIdResolver(async () => 'ws-C-no-surface');

    await expect(scope(engine).resolveCallerSurface()).resolves.toEqual({
      kind: 'none',
      workspaceId: 'ws-C-no-surface',
    });
  });

  // The in-flight getPage lock, the auto-open latch, and the fast-fail latch
  // are all keyed by this context. A per-workspace key is what keeps a
  // concurrent call from another workspace from sharing the first caller's
  // in-flight page / auto-open / failure state (CodeRabbit #554).
  it('derives a DISTINCT selection-context key per workspace (isolates lock/latches)', async () => {
    mockSendRpc.mockImplementation((method: string) =>
      method === 'browser.cdp.info' ? Promise.resolve(twoWorkspaceTargets) : Promise.resolve({}),
    );
    const engine = PlaywrightEngine.getInstance();

    scope(engine).setWorkspaceIdResolver(async () => 'ws-A');
    const ctxA = await scope(engine).resolveSelectionContext();
    scope(engine).setWorkspaceIdResolver(async () => 'ws-B');
    const ctxB = await scope(engine).resolveSelectionContext();

    expect(ctxA.surfaceId).toBe('surf-A');
    expect(ctxB.surfaceId).toBe('surf-B');
    expect(ctxA.key).not.toBe(ctxB.key); // no shared lock/latch across workspaces
  });

  it('keys an explicit surfaceId separately from a resolved workspace', async () => {
    mockSendRpc.mockImplementation((method: string) =>
      method === 'browser.cdp.info' ? Promise.resolve(twoWorkspaceTargets) : Promise.resolve({}),
    );
    const engine = PlaywrightEngine.getInstance();
    scope(engine).setWorkspaceIdResolver(async () => 'ws-A');

    const explicit = await scope(engine).resolveSelectionContext('surf-B');
    const resolved = await scope(engine).resolveSelectionContext();
    expect(explicit).toEqual({ key: 'surf:surf-B', surfaceId: 'surf-B', callerHasNoSurface: false });
    expect(resolved.surfaceId).toBe('surf-A');
    expect(explicit.key).not.toBe(resolved.key);
  });

  it("keys 'no surface' by the caller's own workspace so its auto-open isn't blocked by another", async () => {
    mockSendRpc.mockImplementation((method: string) =>
      method === 'browser.cdp.info' ? Promise.resolve(twoWorkspaceTargets) : Promise.resolve({}),
    );
    const engine = PlaywrightEngine.getInstance();

    scope(engine).setWorkspaceIdResolver(async () => 'ws-C-no-surface');
    const ctxC = await scope(engine).resolveSelectionContext();
    scope(engine).setWorkspaceIdResolver(async () => 'ws-D-no-surface');
    const ctxD = await scope(engine).resolveSelectionContext();

    expect(ctxC.callerHasNoSurface).toBe(true);
    expect(ctxD.callerHasNoSurface).toBe(true);
    expect(ctxC.key).not.toBe(ctxD.key); // each surfaceless workspace auto-opens independently
  });
});

/*
 * Fail-closed page selection when the caller cannot be scoped.
 *
 * resolveCallerSurface used to answer { kind: 'unscoped' } whenever identity
 * could not be established, and an unscoped selection reaches ANY workspace's
 * live guest: findViaTargetDomain falls back to `cdp.info.targets[0]` and
 * _getPageImpl falls back to "the first non-shell page in any context". Every
 * sibling on the same identity miss already refuses — browser_open /
 * browser_close throw from requireWorkspaceId, browser_tabs answers
 * BROWSER_TABS_WORKSPACE_UNRESOLVED, engine auto-open issues no RPC — so page
 * selection was the one path that stayed open.
 *
 * This matters without any spoofing: a sandboxed Codex legitimately cannot
 * resolve its own identity (src/mcp/index.ts lookupPidMapWorkspace), so a
 * well-behaved agent reached another workspace's browser under normal
 * conditions. The refusal now carries WORKSPACE_SCOPE_UNRESOLVED plus the
 * specific reason, so the caller can tell WHY rather than seeing a silent miss.
 */
describe('PlaywrightEngine fail-closed page selection (unresolvable caller)', () => {
  beforeEach(() => {
    (PlaywrightEngine as unknown as { instance: PlaywrightEngine | null }).instance = null;
    mockSendRpc.mockReset();
    mockConnectOverCDP.mockReset();
  });

  const liveForeignTargets = {
    cdpPort: 9222,
    targets: [{ surfaceId: 'surf-victim', targetId: 'wc-victim', workspaceId: 'ws-victim' }],
  };

  it('refuses instead of returning ANOTHER workspace\'s live page when identity is unresolvable', async () => {
    // The reachable shape (src/mcp/index.ts:846 wires requireWorkspaceId, which
    // THROWS on a miss): a sandboxed agent whose process-tree walk is blocked.
    // ws-victim owns the only live guest; the caller must not get it.
    const victimPage: FakePage = {
      url: vi.fn().mockReturnValue('https://victim.example/secret'),
      context: vi.fn(),
    };
    const victimCtx = {
      pages: vi.fn().mockReturnValue([victimPage]),
      newCDPSession: vi.fn().mockImplementation(async () => makeFakeSession()),
    };
    victimPage.context.mockReturnValue(victimCtx);
    mockConnectOverCDP.mockResolvedValue({
      isConnected: vi.fn().mockReturnValue(true),
      newBrowserCDPSession: vi.fn().mockImplementation(async () => makeFakeSession()),
      contexts: vi.fn().mockReturnValue([victimCtx]),
      close: vi.fn().mockResolvedValue(undefined),
    });
    mockSendRpc.mockImplementation((method: string) =>
      method === 'browser.cdp.info' ? Promise.resolve(liveForeignTargets) : Promise.resolve({}),
    );

    const engine = PlaywrightEngine.getInstance();
    scope(engine).setWorkspaceIdResolver(async () => {
      throw new Error('Workspace identity unknown.');
    });

    await expect(priv(engine).getPage()).rejects.toThrow(WORKSPACE_SCOPE_UNRESOLVED_CODE);
    // The refusal happens before any page selection: no CDP connection is made,
    // so the foreign page is never even a candidate.
    expect(mockConnectOverCDP).not.toHaveBeenCalled();
    expect(victimCtx.pages).not.toHaveBeenCalled();
    // And nothing was opened in an unspecified workspace either.
    expect(mockSendRpc.mock.calls.filter((c) => c[0] === 'browser.open')).toHaveLength(0);
  });

  it('names the specific reason for each unresolvable path (observable refusal)', async () => {
    mockSendRpc.mockImplementation((method: string) =>
      method === 'browser.cdp.info' ? Promise.resolve(liveForeignTargets) : Promise.resolve({}),
    );
    const engine = PlaywrightEngine.getInstance();

    // No resolver wired.
    await expect(scope(engine).resolveCallerSurface()).rejects.toThrow(/no workspace resolver wired/);

    // Resolver throws (sandboxed walk / server-walk failed) — the underlying
    // message rides along so the caller can act on it.
    scope(engine).setWorkspaceIdResolver(async () => {
      throw new Error('Workspace identity unknown.');
    });
    await expect(scope(engine).resolveCallerSurface()).rejects.toThrow(
      /workspace identity unresolved: Workspace identity unknown\./,
    );

    // Resolver returns an empty id.
    scope(engine).setWorkspaceIdResolver(async () => '');
    await expect(scope(engine).resolveCallerSurface()).rejects.toThrow(/empty id/);

    // Every refusal carries the stable code, not just prose.
    await expect(scope(engine).resolveCallerSurface()).rejects.toThrow(
      WORKSPACE_SCOPE_UNRESOLVED_CODE,
    );
  });

  it('refuses when browser.cdp.info itself fails (cannot prove ownership of anything)', async () => {
    mockSendRpc.mockImplementation((method: string) =>
      method === 'browser.cdp.info'
        ? Promise.reject(new Error('pipe closed'))
        : Promise.resolve({}),
    );
    const engine = PlaywrightEngine.getInstance();
    scope(engine).setWorkspaceIdResolver(async () => 'ws-A');

    await expect(scope(engine).resolveCallerSurface()).rejects.toThrow(
      /browser\.cdp\.info unavailable: pipe closed/,
    );
  });

  it('refuses when a main too old to tag targets returns live untagged targets', async () => {
    // Legacy main (pre-#580/#554): no targetsScoped flag and no workspaceId on
    // the targets, so no client-side filter can decide whose guest this is.
    mockSendRpc.mockImplementation((method: string) =>
      method === 'browser.cdp.info'
        ? Promise.resolve({ cdpPort: 9222, targets: [{ surfaceId: 'surf-A', targetId: 'wc-1' }] })
        : Promise.resolve({}),
    );
    const engine = PlaywrightEngine.getInstance();
    scope(engine).setWorkspaceIdResolver(async () => 'ws-A');

    await expect(scope(engine).resolveCallerSurface()).rejects.toThrow(
      /does not tag browser targets with a workspace/,
    );
  });

  it("still reports 'none' for a legacy main with NO live targets (nothing to cross into)", async () => {
    // The case the old leniency actually protected: a single-workspace setup
    // where no guest exists anywhere. There is nothing to select wrongly, so
    // this stays functional — the caller auto-opens its OWN surface.
    mockSendRpc.mockImplementation((method: string) =>
      method === 'browser.cdp.info'
        ? Promise.resolve({ cdpPort: 9222, targets: [] })
        : Promise.resolve({}),
    );
    const engine = PlaywrightEngine.getInstance();
    scope(engine).setWorkspaceIdResolver(async () => 'ws-A');

    await expect(scope(engine).resolveCallerSurface()).resolves.toEqual({
      kind: 'none',
      workspaceId: 'ws-A',
    });
  });
});

/**
 * #580 Option 1: the engine now asks main to scope browser.cdp.info to its own
 * workspace, and reads the `targetsScoped` flag so an empty list means "I own
 * none" rather than "legacy main." The #554 block above still covers the
 * legacy/unscoped-response path (a main that ignores the param), which must
 * keep working; these cover the scoped-response path a current main returns.
 */
describe('PlaywrightEngine read-path workspace scoping — scoped cdp.info (#580)', () => {
  beforeEach(() => {
    (PlaywrightEngine as unknown as { instance: PlaywrightEngine | null }).instance = null;
    mockSendRpc.mockReset();
    mockConnectOverCDP.mockReset();
  });

  // A main honoring the param returns ONLY the caller's targets + the flag.
  const scopedCdpInfo = (callerWs: string) => ({
    cdpPort: 9222,
    targetsScoped: true,
    targets:
      callerWs === 'ws-A'
        ? [{ surfaceId: 'surf-A', targetId: 'wc-1', workspaceId: 'ws-A' }]
        : [],
  });

  it('passes the resolved workspaceId to browser.cdp.info', async () => {
    mockSendRpc.mockImplementation((method: string, params?: unknown) =>
      method === 'browser.cdp.info'
        ? Promise.resolve(scopedCdpInfo((params as { workspaceId: string }).workspaceId))
        : Promise.resolve({}),
    );
    const engine = PlaywrightEngine.getInstance();
    scope(engine).setWorkspaceIdResolver(async () => 'ws-A');

    await scope(engine).resolveCallerSurface();
    expect(mockSendRpc).toHaveBeenCalledWith('browser.cdp.info', { workspaceId: 'ws-A' });
  });

  it('reports its own surface from a scoped response', async () => {
    mockSendRpc.mockImplementation((method: string, params?: unknown) =>
      method === 'browser.cdp.info'
        ? Promise.resolve(scopedCdpInfo((params as { workspaceId: string }).workspaceId))
        : Promise.resolve({}),
    );
    const engine = PlaywrightEngine.getInstance();
    scope(engine).setWorkspaceIdResolver(async () => 'ws-A');

    await expect(scope(engine).resolveCallerSurface()).resolves.toEqual({
      kind: 'surface',
      surfaceId: 'surf-A',
      workspaceId: 'ws-A',
    });
  });

  it("reads an EMPTY scoped response as 'none', not 'unscoped' (the targetsScoped disambiguation)", async () => {
    mockSendRpc.mockImplementation((method: string, params?: unknown) =>
      method === 'browser.cdp.info'
        ? Promise.resolve(scopedCdpInfo((params as { workspaceId: string }).workspaceId))
        : Promise.resolve({}),
    );
    const engine = PlaywrightEngine.getInstance();
    // ws-B owns nothing; a scoped empty list must fail closed to 'none' so the
    // caller never falls through to another workspace's page — the whole point
    // of the flag, since without it an empty list is ambiguous with legacy.
    scope(engine).setWorkspaceIdResolver(async () => 'ws-B');

    await expect(scope(engine).resolveCallerSurface()).resolves.toEqual({
      kind: 'none',
      workspaceId: 'ws-B',
    });
  });

  it('an empty scoped response routes getPage to auto-open the CALLER\'s own browser, scoping its queries', async () => {
    // Under scoping, a caller that owns no live target must NOT fall through to
    // another workspace's guest — it auto-opens its own. This asserts the two
    // isolation-critical calls getPage makes on that path: it queries
    // cdp.info scoped to itself, and opens in its OWN workspace. (The auto-open
    // -> returned-page mechanics are covered independently by the #554 auto-open
    // test; here the empty scoped response keeps the caller on the self-open
    // branch rather than a foreign page.)
    const shellUrl = 'file:///app/.vite/renderer/main_window/index.html';
    let opened = false;

    const browser = {
      isConnected: vi.fn().mockReturnValue(true),
      newBrowserCDPSession: vi.fn().mockImplementation(async () => makeFakeSession()),
      contexts: vi.fn().mockReturnValue([]),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockConnectOverCDP.mockResolvedValue(browser);
    mockSendRpc.mockImplementation((method: string, params?: unknown) => {
      if (method === 'browser.cdp.info') {
        const ws = (params as { workspaceId?: string } | undefined)?.workspaceId;
        // Honor the scope request: caller owns nothing → empty + flag, both
        // before and after the open (so it never resolves a foreign page).
        return Promise.resolve({ cdpPort: 9222, shellUrl, ...(ws && { targetsScoped: true }), targets: [] });
      }
      if (method === 'browser.open') {
        opened = true;
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({});
    });

    const engine = PlaywrightEngine.getInstance();
    autoOpen(engine).setWorkspaceIdResolver(async () => 'ws-B');

    await priv(engine).getPage();

    // Opened in the caller's OWN workspace — the isolation guarantee.
    expect(mockSendRpc).toHaveBeenCalledWith('browser.open', { workspaceId: 'ws-B' });
    // And it asked main to scope the target list to the caller.
    expect(mockSendRpc).toHaveBeenCalledWith('browser.cdp.info', { workspaceId: 'ws-B' });
    expect(opened).toBe(true);
  }, 15_000);
});

/*
 * #517 — external browser backend contract.
 *
 * When a workspace's backend is 'external', agent opens are delegated to the OS
 * default browser and the workspace owns NO builtin webview target. A page
 * resolution miss is therefore permanent — retrying/auto-opening can never
 * conjure a target — so getPage() must fail immediately with the shared
 * EXTERNAL_BACKEND_UNSUPPORTED contract error rather than looping. The marker
 * rides on browser.cdp.info (workspaceBackend), so builtin (and older mains
 * that omit the field) stay byte-identical: the guard fires only on an explicit
 * 'external' + zero-scoped-targets combination.
 */
describe('PlaywrightEngine external backend contract (#517)', () => {
  beforeEach(() => {
    (PlaywrightEngine as unknown as { instance: PlaywrightEngine | null }).instance = null;
    mockSendRpc.mockReset();
    mockConnectOverCDP.mockReset();
  });

  it('throws the shared contract error on external backend + zero scoped targets, without any retry/connect', async () => {
    // Scoped response: caller owns nothing AND the backend is external.
    mockSendRpc.mockImplementation((method: string) =>
      method === 'browser.cdp.info'
        ? Promise.resolve({
            cdpPort: 9222,
            targetsScoped: true,
            workspaceBackend: 'external',
            targets: [],
          })
        : Promise.resolve({}),
    );

    const engine = PlaywrightEngine.getInstance();
    scope(engine).setWorkspaceIdResolver(async () => 'ws-external');

    await expect(priv(engine).getPage()).rejects.toThrow(EXTERNAL_BACKEND_UNSUPPORTED_CODE);
    // Same prose as the shared constant — no forked message.
    await expect(priv(engine).getPage()).rejects.toThrow(EXTERNAL_BACKEND_UNSUPPORTED_MESSAGE);

    // No retry/auto-open/connect loop was entered: the throw happens before
    // _getPageImpl, so the CDP browser is never connected and no browser.open
    // is ever issued. This is the "skip the pointless retry loops" guarantee.
    expect(mockConnectOverCDP).not.toHaveBeenCalled();
    expect(mockSendRpc.mock.calls.filter((c) => c[0] === 'browser.open')).toHaveLength(0);
  });

  it('does NOT throw for builtin backend + zero scoped targets (existing generic behavior)', async () => {
    // Same shape as the external case but backend is builtin — the generic
    // "no page" path must be preserved: auto-open its own, retry, then null.
    let opened = false;
    const browser = {
      isConnected: vi.fn().mockReturnValue(true),
      newBrowserCDPSession: vi.fn().mockImplementation(async () => makeFakeSession()),
      contexts: vi.fn().mockReturnValue([]),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockConnectOverCDP.mockResolvedValue(browser);
    mockSendRpc.mockImplementation((method: string, params?: unknown) => {
      if (method === 'browser.cdp.info') {
        const ws = (params as { workspaceId?: string } | undefined)?.workspaceId;
        return Promise.resolve({
          cdpPort: 9222,
          shellUrl: 'file:///app/.vite/renderer/main_window/index.html',
          ...(ws && { targetsScoped: true }),
          workspaceBackend: 'builtin',
          targets: [],
        });
      }
      if (method === 'browser.open') {
        opened = true;
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({});
    });

    const engine = PlaywrightEngine.getInstance();
    scope(engine).setWorkspaceIdResolver(async () => 'ws-builtin');

    // Resolves to null (no page ever appears) — never throws the contract error.
    await expect(priv(engine).getPage()).resolves.toBeNull();
    // The builtin generic path still auto-opened in the caller's own workspace.
    expect(opened).toBe(true);
    expect(mockSendRpc).toHaveBeenCalledWith('browser.open', { workspaceId: 'ws-builtin' });
  }, 15_000);

  it('resolves normally in external mixed mode when the caller owns a live builtin target', async () => {
    // External backend globally, but this workspace has a manually-opened
    // builtin pane (a live scoped target). resolveCallerSurface returns
    // kind:'surface', so callerHasNoSurface is false and the contract guard is
    // skipped — the page resolves like any builtin surface.
    const webviewPage: FakePage = {
      url: vi.fn().mockReturnValue('https://example.com/'),
      context: vi.fn(),
    };
    const targetSession = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === 'Target.getTargets') {
          return Promise.resolve({
            targetInfos: [
              { targetId: 'wc-1', type: 'page', title: '', url: 'https://example.com/', attached: true },
            ],
          });
        }
        if (method === 'Target.getTargetInfo') {
          return Promise.resolve({ targetInfo: { targetId: 'wc-1' } });
        }
        return Promise.resolve({});
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const ctx = {
      pages: vi.fn().mockReturnValue([webviewPage]),
      newCDPSession: vi.fn().mockResolvedValue(targetSession),
    };
    webviewPage.context.mockReturnValue(ctx);

    const browser = {
      isConnected: vi.fn().mockReturnValue(true),
      newBrowserCDPSession: vi.fn().mockResolvedValue(targetSession),
      contexts: vi.fn().mockReturnValue([ctx]),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockConnectOverCDP.mockResolvedValue(browser);
    mockSendRpc.mockImplementation((method: string) =>
      method === 'browser.cdp.info'
        ? Promise.resolve({
            cdpPort: 9222,
            targetsScoped: true,
            workspaceBackend: 'external',
            targets: [{ surfaceId: 'surf-A', targetId: 'wc-1', workspaceId: 'ws-A' }],
          })
        : Promise.resolve({}),
    );

    const engine = PlaywrightEngine.getInstance();
    scope(engine).setWorkspaceIdResolver(async () => 'ws-A');

    const page = await priv(engine).getPage();
    expect(page).toBe(webviewPage);
    // No auto-open — the live builtin target was used.
    expect(mockSendRpc.mock.calls.filter((c) => c[0] === 'browser.open')).toHaveLength(0);
  }, 15_000);
});


// ── Phase 2: 'chrome' backend marker behavior ──────────────────────────────
describe('PlaywrightEngine chrome backend (Phase 2)', () => {
  beforeEach(() => {
    (PlaywrightEngine as unknown as { instance: PlaywrightEngine | null }).instance = null;
    mockSendRpc.mockReset();
    mockConnectOverCDP.mockReset();
  });

  it('does not take the external short-circuit and clears any stale shellUrl', async () => {
    mockSendRpc.mockImplementation((method: string) =>
      method === 'browser.cdp.info'
        ? Promise.resolve({
            cdpPort: 18901,
            // A stale shellUrl from a pre-flip builtin response must be dropped
            // by the chrome marker even if a buggy main were to send one.
            targetsScoped: true,
            workspaceBackend: 'chrome',
            targets: [],
          })
        : Promise.resolve({}),
    );
    mockConnectOverCDP.mockRejectedValue(new Error('no chrome in unit test'));

    const engine = PlaywrightEngine.getInstance();
    scope(engine).setWorkspaceIdResolver(async () => 'ws-chrome');

    // Must NOT reject with the external contract error; the connect attempt
    // proves the short-circuit was not taken.
    const page = await priv(engine).getPage().catch((e: Error) => e);
    expect(String(page)).not.toContain('EXTERNAL_BACKEND_UNSUPPORTED');
    expect(mockConnectOverCDP).toHaveBeenCalled();
  });

  it('isShellPage is a no-op under the chrome marker (localhost pages selectable)', async () => {
    mockSendRpc.mockImplementation((method: string) =>
      method === 'browser.cdp.info'
        ? Promise.resolve({ cdpPort: 18901, workspaceBackend: 'chrome', targets: [] })
        : Promise.resolve({}),
    );
    const engine = PlaywrightEngine.getInstance();
    // Feed the marker through the single ingest funnel.
    (engine as unknown as { cacheShellUrl: (i: unknown) => void }).cacheShellUrl({
      workspaceBackend: 'chrome',
      targets: [],
    });
    const isShell = (engine as unknown as { isShellPage: (u: string) => boolean }).isShellPage;
    expect(isShell.call(engine, 'http://localhost:5173/')).toBe(false);
    expect(isShell.call(engine, 'chrome://gpu/')).toBe(false);
  });
});
