import { useRef, useState, useEffect, useCallback } from 'react';
import BrowserToolbar from './BrowserToolbar';

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
  isActive: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BrowserPanel({ initialUrl, isActive, onClose }: BrowserPanelProps) {
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [pageTitle, setPageTitle] = useState('Browser');
  const [isReady, setIsReady] = useState(false);

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

    const onDomReady = () => {
      setIsReady(true);
      updateNavState();
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
      setPageTitle(e.title || 'Browser');
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
        style={{ backgroundColor: '#11111b', borderBottom: '1px solid #1e1e2e' }}
      >
        {isLoading && (
          <span className="w-1.5 h-1.5 rounded-full bg-[#89b4fa] animate-pulse shrink-0" />
        )}
        <span
          className="text-xs text-[#6c7086] truncate"
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
        onNavigate={handleNavigate}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        onOpenDevTools={handleOpenDevTools}
        onClose={onClose}
      />

      {/* WebView */}
      <div className="flex-1 relative overflow-hidden" style={{ backgroundColor: '#1e1e2e' }}>
        <webview
          ref={webviewRef as React.RefObject<Electron.WebviewTag>}
          src={initialUrl}
          partition="persist:browser"
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
