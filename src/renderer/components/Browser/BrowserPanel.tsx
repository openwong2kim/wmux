import { useRef, useState, useEffect, useCallback } from 'react';
import BrowserToolbar from './BrowserToolbar';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import {
  BROWSER_NAVIGATE_EVENT,
  isSafeBrowserUrl,
  type BrowserNavigateDetail,
} from '../../utils/browserPane';

// The <webview> intrinsic comes from @types/react's built-in
// WebViewHTMLAttributes — with the automatic JSX runtime (React.JSX
// namespace) a local `declare global { namespace JSX }` augmentation is dead
// code, so none is declared here.

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface BrowserPanelProps {
  surfaceId: string;
  initialUrl: string;
  partition: string;
  /** Focused surface (drives F12 devtools + toolbar active state). */
  isActive: boolean;
  /** Rendered (display:flex) regardless of focus. The terminal+browser split
   *  shows both sides at once, so visibility is decoupled from `isActive`.
   *  Defaults to `isActive` (stacked/tab case: only the active tab renders). */
  visible?: boolean;
  /** Hidden because another pane in THIS pane tree is zoomed (#517). Computed
   *  by PaneContainer from the actual render tree — the global zoomedPaneId
   *  cannot distinguish a zoom in a different, still-visible workspace tree
   *  (codex P2). */
  isZoomHidden?: boolean;
  /** True when a full-pane overlay (active diff/editor surface) covers this
   *  browser in the terminal+browser split (#517, codex P3): the panel stays
   *  rendered underneath, but the user cannot see it. */
  occluded?: boolean;
  /** Whether the owning workspace is the visible one (#517). The pane-local
   *  `visible` flag cannot see hidden workspaces — exactly the case
   *  lightweight mode exists for. Defaults true for callers that don't
   *  thread it (fail open: never throttle on missing signal). */
  isWorkspaceVisible?: boolean;
  onClose: () => void;
}

/**
 * Effective visibility (#517): pane-local shown ∧ workspace visible ∧ window
 * shown ∧ not hidden behind another pane's zoom. Exported for unit tests.
 */
export function computeEffectiveVisibility(input: {
  shown: boolean;
  isWorkspaceVisible: boolean;
  windowVisible: boolean;
  isZoomHidden?: boolean;
  occluded?: boolean;
}): boolean {
  const { shown, isWorkspaceVisible, windowVisible, isZoomHidden, occluded } = input;
  return shown && isWorkspaceVisible && windowVisible && !isZoomHidden && !occluded;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BrowserPanel({ surfaceId, initialUrl, partition, isActive, visible, isZoomHidden, isWorkspaceVisible, occluded, onClose }: BrowserPanelProps) {
  const t = useT();
  const updateBrowserUrl = useStore((s) => s.updateBrowserUrl);
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [pageTitle, setPageTitle] = useState(() => t('browser.title'));
  const [isReady, setIsReady] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [inspectInfo, setInspectInfo] = useState<string | null>(null);

  // Update nav state from webview
  const updateNavState = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    try {
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
    } catch {
      // Webview may not be ready yet
    }
  }, []);

  // Attach webview event listeners once ready
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    const onDomReady = async () => {
      setIsReady(true);
      updateNavState();

      // Register webview with main process for CDP debugging.
      // Must be awaited so that MCP tools querying browser.cdp.info
      // after dom-ready find the registered CDP target.
      try {
        const wcId = (wv as any).getWebContentsId?.();
        if (wcId && (window as any).electronAPI?.browser?.registerWebview) {
          await (window as any).electronAPI.browser.registerWebview(surfaceId, wcId);
          console.log(`[BrowserPanel] CDP target registered for surface=${surfaceId} wc=${wcId}`);
        }
      } catch (err) {
        console.warn('[BrowserPanel] Failed to register webview for CDP:', err);
      }
    };

    const onStartLoading = () => {
      setIsLoading(true);
    };

    const onStopLoading = () => {
      setIsLoading(false);
      updateNavState();
    };

    const onDidNavigate = (e: Electron.DidNavigateEvent) => {
      setCurrentUrl(e.url);
      // Persist the URL on the surface so a session restore reopens the page
      // the user last saw, not the one the surface was created with. Catches
      // toolbar, in-page and MCP/CDP-driven navigations alike.
      updateBrowserUrl(surfaceId, e.url);
      updateNavState();
    };

    const onDidNavigateInPage = (e: Electron.DidNavigateInPageEvent) => {
      setCurrentUrl(e.url);
      updateBrowserUrl(surfaceId, e.url);
      updateNavState();
    };

    const onTitleUpdated = (e: Electron.PageTitleUpdatedEvent) => {
      setPageTitle(e.title || t('browser.title'));
    };

    wv.addEventListener('dom-ready', onDomReady);
    wv.addEventListener('did-start-loading', onStartLoading);
    wv.addEventListener('did-stop-loading', onStopLoading);
    wv.addEventListener('did-navigate', onDidNavigate as EventListener);
    wv.addEventListener('did-navigate-in-page', onDidNavigateInPage as EventListener);
    wv.addEventListener('page-title-updated', onTitleUpdated as EventListener);

    return () => {
      wv.removeEventListener('dom-ready', onDomReady);
      wv.removeEventListener('did-start-loading', onStartLoading);
      wv.removeEventListener('did-stop-loading', onStopLoading);
      wv.removeEventListener('did-navigate', onDidNavigate as EventListener);
      wv.removeEventListener('did-navigate-in-page', onDidNavigateInPage as EventListener);
      wv.removeEventListener('page-title-updated', onTitleUpdated as EventListener);
    };
  }, [updateNavState, updateBrowserUrl, surfaceId]);

  // F12 opens DevTools for the webview
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F12') {
        e.preventDefault();
        handleOpenDevTools();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isActive]);

  // Pull DOM keyboard focus onto the webview when this surface is the active
  // one. useActivePaneFocus deliberately skips browser/editor surfaces (they
  // have no xterm to focus), so without this the keyboard focus stays on the
  // previously focused terminal / <body> and every keystroke in the page is
  // dropped — mouse works (Electron handles pointer natively) but typing does
  // nothing (#252, pre-existing since #75).
  //
  // Gated on `isActive` (focus), NOT `visible` (display): in a terminal+browser
  // split BOTH sides are visible but only one is active, and focus must follow
  // the active surface so the browser never steals focus from the terminal
  // side. `isReady` ensures the guest webContents exists before we focus it.
  // DOM focus is singular, so webview.focus() moves focus off the prior xterm.
  useEffect(() => {
    if (!isActive || !(visible ?? isActive) || !isReady) return;
    webviewRef.current?.focus();
  }, [isActive, visible, isReady]);

  // #517 lightweight mode: report this surface's EFFECTIVE visibility to main
  // so an invisible guest can be background-throttled. Window visibility rides
  // on the document Page Visibility API (fires on minimize/hide of the shell
  // window). Fires on mount, on every input change, and re-fires visible=true
  // is harmless (main dedupes).
  const [windowVisible, setWindowVisible] = useState(
    () => document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    const onVis = () => setWindowVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  const effectiveVisible = computeEffectiveVisibility({
    shown: visible ?? isActive,
    isWorkspaceVisible: isWorkspaceVisible ?? true,
    windowVisible,
    isZoomHidden,
    occluded,
  });
  useEffect(() => {
    try {
      (window as any).electronAPI?.browser?.setVisibility?.(surfaceId, effectiveVisible);
    } catch { /* best-effort — older mains lack the handler */ }
  }, [surfaceId, effectiveVisible]);

  const handleNavigate = useCallback((url: string) => {
    if (!isSafeBrowserUrl(url)) return;
    const wv = webviewRef.current;
    if (!wv) return;
    if (isReady) {
      wv.loadURL(url);
    } else {
      // If not ready yet, just update src attribute
      wv.setAttribute('src', url);
    }
    setCurrentUrl(url);
  }, [isReady]);

  // Imperative navigation channel for openUrlInBrowserPane (terminal link
  // clicks, sidebar port badges, browser.open RPC). The store's browserUrl is
  // written first by the helper — this event only moves the already-mounted
  // webview. No isActive gate: a background tab must navigate too.
  useEffect(() => {
    const onNavigateEvent = (e: Event) => {
      const detail = (e as CustomEvent<BrowserNavigateDetail>).detail;
      if (!detail || detail.surfaceId !== surfaceId) return;
      handleNavigate(detail.url);
    };
    document.addEventListener(BROWSER_NAVIGATE_EVENT, onNavigateEvent);
    return () => document.removeEventListener(BROWSER_NAVIGATE_EVENT, onNavigateEvent);
  }, [surfaceId, handleNavigate]);

  const handleBack = useCallback(() => {
    webviewRef.current?.goBack();
  }, []);

  const handleForward = useCallback(() => {
    webviewRef.current?.goForward();
  }, []);

  const handleRefresh = useCallback(() => {
    webviewRef.current?.reload();
  }, []);

  // Inspector: inject/remove highlight overlay into webview
  const injectInspector = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv || !isReady) return;
    // 이 오버레이/라벨은 게스트 웹뷰(임의의 외부 페이지) 내부에 주입된다.
    // wmux 테마 CSS 변수가 없는 문서라서 색은 의도적으로 자립 hex로 둔다
    // (테마 토큰 승격 대상 아님 — 외부 페이지 위 오버레이).
    wv.executeJavaScript(`
      (function() {
        if (window.__wmuxInspector) return;
        const overlay = document.createElement('div');
        overlay.id = '__wmux_inspector_overlay';
        overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #3b82f6;background:rgba(59,130,246,0.08);transition:all 0.05s;display:none;';
        document.body.appendChild(overlay);

        const label = document.createElement('div');
        label.id = '__wmux_inspector_label';
        label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#1e1e2e;color:#cdd6f4;font:11px/1.4 ui-monospace,monospace;padding:4px 8px;border-radius:4px;border:1px solid #3b82f6;max-width:420px;white-space:pre-wrap;display:none;';
        document.body.appendChild(label);

        function getSelector(el) {
          if (el.id) return '#' + CSS.escape(el.id);
          let sel = el.tagName.toLowerCase();
          if (el.className && typeof el.className === 'string') {
            const classes = el.className.trim().split(/\\s+/).filter(c => c.length > 0 && c.length < 40).slice(0, 3);
            if (classes.length) sel += '.' + classes.map(c => CSS.escape(c)).join('.');
          }
          return sel;
        }

        function buildContext(el) {
          const selector = getSelector(el);
          const tag = el.tagName.toLowerCase();
          const keep = ['type','name','placeholder','value','href','src','role','aria-label'];
          const attrs = keep
            .filter(k => el.hasAttribute(k))
            .map(k => {
              let v = el.getAttribute(k);
              if (v.length > 60) v = v.slice(0, 60) + '...';
              return k + '="' + v + '"';
            })
            .join(' ');
          const openTag = '<' + tag + (attrs ? ' ' + attrs : '') + '>';

          const lines = [];
          lines.push('[Inspector] ' + document.title + ' (' + location.href + ')');
          lines.push('selector: ' + selector);
          lines.push(openTag);
          return { text: lines.join('\\n'), selector: selector };
        }

        function onMove(e) {
          const el = document.elementFromPoint(e.clientX, e.clientY);
          if (!el || el === overlay || el === label || el.id?.startsWith('__wmux')) {
            overlay.style.display='none'; label.style.display='none'; return;
          }
          const r = el.getBoundingClientRect();
          overlay.style.left = r.left + 'px';
          overlay.style.top = r.top + 'px';
          overlay.style.width = r.width + 'px';
          overlay.style.height = r.height + 'px';
          overlay.style.display = 'block';

          const sel = getSelector(el);
          const tag = el.tagName.toLowerCase();
          label.textContent = sel + '  <' + tag + '>';
          label.style.display = 'block';
          let lx = e.clientX + 12, ly = e.clientY + 16;
          if (lx + 300 > window.innerWidth) lx = e.clientX - 300;
          if (ly + 80 > window.innerHeight) ly = e.clientY - 80;
          label.style.left = lx + 'px';
          label.style.top = ly + 'px';
        }

        function onClick(e) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          const el = document.elementFromPoint(e.clientX, e.clientY);
          if (!el || el === overlay || el === label || el.id?.startsWith('__wmux')) return;
          const ctx = buildContext(el);
          navigator.clipboard.writeText(ctx.text).catch(() => {});
          console.log('__wmux_inspect_result__' + JSON.stringify({ contextText: ctx.text, selector: ctx.selector }));
        }

        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('click', onClick, true);
        window.__wmuxInspector = { onMove, onClick, overlay, label };
      })();
    `).catch(() => {});
  }, [isReady]);

  const removeInspector = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv || !isReady) return;
    wv.executeJavaScript(`
      (function() {
        if (!window.__wmuxInspector) return;
        document.removeEventListener('mousemove', window.__wmuxInspector.onMove, true);
        document.removeEventListener('click', window.__wmuxInspector.onClick, true);
        window.__wmuxInspector.overlay.remove();
        window.__wmuxInspector.label.remove();
        delete window.__wmuxInspector;
      })();
    `).catch(() => {});
  }, [isReady]);

  const handleToggleInspect = useCallback(() => {
    setInspecting(prev => {
      if (!prev) {
        injectInspector();
      } else {
        removeInspector();
        setInspectInfo(null);
      }
      return !prev;
    });
  }, [injectInspector, removeInspector]);

  // Listen for inspector click results from webview console
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const onConsole = (e: Electron.ConsoleMessageEvent) => {
      if (e.message.startsWith('__wmux_inspect_result__')) {
        try {
          const data = JSON.parse(e.message.slice('__wmux_inspect_result__'.length));
          setInspectInfo(`Copied to clipboard — paste into Claude to describe this element`);
          setTimeout(() => setInspectInfo(null), 3000);
          // Auto-disable inspector after selection
          removeInspector();
          setInspecting(false);
        } catch { /* ignore */ }
      }
    };
    wv.addEventListener('console-message', onConsole as EventListener);
    return () => { wv.removeEventListener('console-message', onConsole as EventListener); };
  }, [removeInspector]);

  const handleOpenDevTools = useCallback(() => {
    try {
      webviewRef.current?.openDevTools();
    } catch {
      // May not be available in all contexts
    }
  }, []);

  return (
    <div
      className="flex flex-col h-full w-full overflow-hidden"
      // Clicking the toolbar / title strip / page chrome (anywhere in the
      // pane) pulls keyboard focus onto the webview. Clicking *inside* page
      // content already focuses the guest natively, but pane-switch clicks and
      // clicks on our own chrome do not — without this, keyboard input stays
      // dead after such a click (#252).
      onClick={() => webviewRef.current?.focus()}
      style={{
        position: 'absolute',
        inset: 0,
        display: (visible ?? isActive) ? 'flex' : 'none',
      }}
    >
      {/* Title bar strip showing page title */}
      <div
        className="flex items-center gap-2 px-3 py-0.5 shrink-0"
        style={{ backgroundColor: 'var(--bg-mantle)', borderBottom: '1px solid var(--bg-base)' }}
      >
        {isLoading && (
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse shrink-0" />
        )}
        <span
          className="text-xs text-[var(--text-subtle)] truncate"
          style={{ fontFamily: 'ui-monospace, monospace' }}
          title={pageTitle}
        >
          {pageTitle}
        </span>
      </div>

      {/* Toolbar */}
      <BrowserToolbar
        currentUrl={currentUrl}
        isLoading={isLoading}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        isActive={isActive}
        inspecting={inspecting}
        onNavigate={handleNavigate}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        onToggleInspect={handleToggleInspect}
        onOpenDevTools={handleOpenDevTools}
        onClose={onClose}
      />

      {/* Inspector toast */}
      {inspectInfo && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 text-xs shrink-0"
          style={{
            backgroundColor: 'var(--accent-blue)',
            color: 'var(--bg-base)',
            fontFamily: 'ui-monospace, monospace',
          }}
        >
          {inspectInfo}
        </div>
      )}
      {inspecting && !inspectInfo && (
        <div
          className="flex items-center gap-2 px-3 py-1 text-xs shrink-0"
          style={{
            backgroundColor: 'var(--bg-base)',
            color: 'var(--accent-blue)',
            borderBottom: '1px solid var(--accent-blue)',
            fontFamily: 'ui-monospace, monospace',
          }}
        >
          Inspector ON — hover to see elements, click to copy selector
        </div>
      )}

      {/* WebView */}
      <div className="flex-1 relative overflow-hidden" style={{ backgroundColor: 'var(--bg-base)' }}>
        <webview
          ref={webviewRef as React.RefObject<Electron.WebviewTag>}
          src={initialUrl}
          partition={partition}
          // Required for target=_blank / window.open to reach the main
          // process at all — without it the guest-view manager rejects the
          // popup before setWindowOpenHandler runs. The handler in
          // src/main/index.ts then denies the popup and loads http(s) URLs
          // in this same webview instead.
          // Must be a STRING despite the boolean typing: react-dom strips
          // boolean-valued non-data/aria attributes (setValueForAttribute),
          // so allowpopups={true} would silently never reach the DOM.
          allowpopups={'true' as unknown as boolean}
          data-surface-id={surfaceId}
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
          }}
        />
      </div>
    </div>
  );
}
