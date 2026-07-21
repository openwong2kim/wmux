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
import { PlaywrightEngine, isElectronShellUrl } from '../PlaywrightEngine';

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

    // A context whose pages() exposes both the shell and the webview.
    const ctx = {
      pages: vi.fn().mockReturnValue([shellPage, webviewPage]),
      newCDPSession: vi.fn().mockImplementation(async () => makeFakeSession()),
    };
    shellPage.context.mockReturnValue(ctx);
    webviewPage.context.mockReturnValue(ctx);

    const browser = {
      isConnected: vi.fn().mockReturnValue(true),
      newBrowserCDPSession: vi.fn().mockImplementation(async () => makeFakeSession()),
      contexts: vi.fn().mockReturnValue([ctx]),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockConnectOverCDP.mockResolvedValue(browser);

    // cdp.info advertises the shell URL and no registered webview target, so
    // positive targetId matching yields nothing and the negative filter runs —
    // which must skip the exact-match shell page and pick the webview.
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.cdp.info') {
        return Promise.resolve({ cdpPort: 9222, shellUrl, targets: [] });
      }
      return Promise.resolve({});
    });

    const engine = PlaywrightEngine.getInstance();
    await engine.connect(9222);

    const page = await engine.getPage();
    expect(page).toBe(webviewPage);
    // The shell URL was learned from cdp.info during discovery.
    expect(priv(engine).shellUrl).toBe(shellUrl);
  });

  it('strict surface targeting (#517): explicit surfaceId never falls back to another guest', async () => {
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
    // cdp.info knows about NO target for the requested surface — the pinned
    // lookup fails, and the "first non-shell page" fallback must NOT hand
    // back the other guest (that would drive surface B while the caller — and
    // the automation lease — point at surface A).
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.cdp.info') {
        return Promise.resolve({ cdpPort: 9222, shellUrl, targets: [] });
      }
      return Promise.resolve({});
    });

    const engine = PlaywrightEngine.getInstance();
    await engine.connect(9222);

    const page = await engine.getPage('surface-pinned');
    expect(page).toBeNull();
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
  attemptAutoOpen(): Promise<boolean>;
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
    mockSendRpc.mockResolvedValue({});

    await expect(autoOpen(engine).attemptAutoOpen()).resolves.toBe(true);

    expect(mockSendRpc).toHaveBeenCalledWith('browser.open', { workspaceId: 'ws-caller-1' });
  });

  it('fails closed — no browser.open RPC — when the resolver throws', async () => {
    const engine = PlaywrightEngine.getInstance();
    autoOpen(engine).setWorkspaceIdResolver(async () => {
      throw new Error('Workspace identity unknown');
    });

    await expect(autoOpen(engine).attemptAutoOpen()).resolves.toBe(false);

    expect(mockSendRpc.mock.calls.filter((c) => c[0] === 'browser.open')).toHaveLength(0);
  });

  it('fails closed when the resolver returns an empty id', async () => {
    const engine = PlaywrightEngine.getInstance();
    autoOpen(engine).setWorkspaceIdResolver(async () => '');

    await expect(autoOpen(engine).attemptAutoOpen()).resolves.toBe(false);

    expect(mockSendRpc.mock.calls.filter((c) => c[0] === 'browser.open')).toHaveLength(0);
  });

  it('fails closed when no resolver is wired', async () => {
    const engine = PlaywrightEngine.getInstance();

    await expect(autoOpen(engine).attemptAutoOpen()).resolves.toBe(false);

    expect(mockSendRpc.mock.calls.filter((c) => c[0] === 'browser.open')).toHaveLength(0);
  });

  it('getPage never issues a workspace-less browser.open when identity is unavailable', async () => {
    // End-to-end through the page-discovery loop: no page exists anywhere and
    // no resolver is wired. The misrouting shape is browser.open carrying no
    // workspaceId — the renderer then falls back to the UI-active workspace.
    // The engine must skip auto-open entirely (fail closed) and give up.
    const sessions: FakeSession[] = [];
    mockConnectOverCDP.mockImplementation(async () => makeFakeBrowser(sessions));
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.cdp.info') {
        return Promise.resolve({ cdpPort: 59222, targets: [] });
      }
      return Promise.resolve({});
    });

    const engine = PlaywrightEngine.getInstance();
    const page = await engine.getPage();

    expect(page).toBeNull();
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
    const ctx = {
      pages: vi.fn().mockImplementation(() => (opened ? [webviewPage] : [])),
      newCDPSession: vi.fn().mockImplementation(async () => makeFakeSession()),
    };
    webviewPage.context.mockReturnValue(ctx);

    const browser = {
      isConnected: vi.fn().mockReturnValue(true),
      newBrowserCDPSession: vi.fn().mockImplementation(async () => makeFakeSession()),
      contexts: vi.fn().mockImplementation(() => (opened ? [ctx] : [])),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockConnectOverCDP.mockResolvedValue(browser);
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.cdp.info') {
        return Promise.resolve({ cdpPort: 9222, shellUrl, targets: [] });
      }
      if (method === 'browser.open') {
        opened = true;
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({});
    });

    const engine = PlaywrightEngine.getInstance();
    autoOpen(engine).setWorkspaceIdResolver(async () => 'ws-caller-1');

    const page = await engine.getPage();

    expect(page).toBe(webviewPage);
    expect(mockSendRpc).toHaveBeenCalledWith('browser.open', { workspaceId: 'ws-caller-1' });
  }, 15_000);
});
