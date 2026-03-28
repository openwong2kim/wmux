import { useRef, useState, useEffect, useCallback } from 'react';
import BrowserToolbar from './BrowserToolbar';
import { useT } from '../../hooks/useT';

// ---------------------------------------------------------------------------
// URL safety check — only allow http: and https: schemes
// ---------------------------------------------------------------------------

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Declare the webview element for TypeScript
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<Electron.WebviewTag> & {
          src?: string;
          partition?: string;
          allowpopups?: string;
          disablewebsecurity?: string;
          preload?: string;
          useragent?: string;
          nodeintegration?: string;
          webpreferences?: string;
        },
        Electron.WebviewTag
      >;
    }
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface BrowserPanelProps {
  surfaceId: string;
  initialUrl: string;
  partition: string;
  isActive: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BrowserPanel({ surfaceId, initialUrl, partition, isActive, onClose }: BrowserPanelProps) {
  const t = useT();
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
      updateNavState();
    };

    const onDidNavigateInPage = (e: Electron.DidNavigateInPageEvent) => {
      setCurrentUrl(e.url);
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
  }, [updateNavState]);

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

  const handleNavigate = useCallback((url: string) => {
    if (!isSafeUrl(url)) return;
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

        function getOpenTag(el) {
          const tag = el.tagName.toLowerCase();
          let s = '<' + tag;
          for (const a of el.attributes) {
            if (a.name === 'style') continue;
            let v = a.value;
            if (v.length > 60) v = v.slice(0, 60) + '...';
            s += ' ' + a.name + '="' + v + '"';
            if (s.length > 200) { s += ' ...'; break; }
          }
          return s + '>';
        }

        function getSiblingsSummary(el) {
          const parent = el.parentElement;
          if (!parent) return '';
          const sibs = Array.from(parent.children)
            .filter(c => c !== el && !c.id?.startsWith('__wmux'))
            .slice(0, 3)
            .map(c => {
              const tag = c.tagName.toLowerCase();
              let text = (c.textContent || '').replace(/\\n/g, ' ').trim();
              if (text.length > 30) text = text.slice(0, 30) + '...';
              return tag + (text ? '"' + text + '"' : '');
            });
          return sibs.join(', ');
        }

        function buildContext(el) {
          const selector = getSelector(el);
          const openTag = getOpenTag(el);
          let text = (el.textContent || '').replace(/\\n/g, ' ').trim();
          if (text.length > 80) text = text.slice(0, 80) + '...';

          const parent = el.parentElement;
          const parentSel = parent ? getSelector(parent) : null;
          const sibs = getSiblingsSummary(el);

          const lines = [];
          lines.push('[Inspector] ' + document.title + ' (' + location.href + ')');
          lines.push('selector: ' + selector);
          lines.push(openTag);
          if (text) lines.push('text: "' + text + '"');
          if (parentSel) {
            let ctx = 'parent: ' + parentSel;
            if (sibs) ctx += ' > siblings: ' + sibs;
            lines.push(ctx);
          }
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
          const dims = Math.round(r.width) + ' x ' + Math.round(r.height);
          let text = (el.textContent || '').replace(/\\n/g, ' ').trim();
          if (text.length > 60) text = text.slice(0, 60) + '...';
          label.textContent = sel + '\\n' + dims + (text ? '\\n"' + text + '"' : '');
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
      style={{
        position: 'absolute',
        inset: 0,
        display: isActive ? 'flex' : 'none',
      }}
    >
      {/* Title bar strip showing page title */}
      <div
        className="flex items-center gap-2 px-3 py-0.5 shrink-0"
        style={{ backgroundColor: '#11111b', borderBottom: '1px solid var(--bg-base)' }}
      >
        {isLoading && (
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-blue)] animate-pulse shrink-0" />
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
            color: '#fff',
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
            backgroundColor: '#1e1e2e',
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
