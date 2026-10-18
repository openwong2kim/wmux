import { useRef, useState, useEffect, useCallback } from 'react';
import BrowserToolbar from './BrowserToolbar';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { selectHelpRequestForSurface } from '../../stores/slices/browserHelpSlice';
import type { BrowserHelpOutcome } from '../../../shared/browserHelp';
import {
  BROWSER_NAVIGATE_EVENT,
  isSafeBrowserUrl,
  type BrowserNavigateDetail,
} from '../../utils/browserPane';
import { isPrivateBrowserPartition } from '../../../shared/privateBrowser';
import { isPrivateSessionReady, privateSessionReady } from '../../utils/privateSessionGate';
import { formatElementHandoff, parseElementRect, parseInspectedElement, ELEMENT_STYLE_KEYS, HANDOFF_NOTE_MAX, type InspectedElement } from '../../../shared/browserElementHandoff';
import { findWorkspaceSurfaceById } from '../../utils/paneTraversal';
import { findLeaf } from '../../../shared/paneUtils';
import { BROWSER_ZOOM_EVENT, stepPageZoom, type BrowserZoomDetail } from '../../../shared/browserZoom';
import { injectText } from '../AgentToolbar/inject';
import { IconX } from '../icons';

// The <webview> intrinsic comes from @types/react's built-in
// WebViewHTMLAttributes — with the automatic JSX runtime (React.JSX
// namespace) a local `declare global { namespace JSX }` augmentation is dead
// code, so none is declared here.

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface BrowserPanelProps {
  surfaceId: string;
  /** Owning workspace id — reported to main at CDP register time so the
   *  browser read tools can scope page selection to the caller's workspace
   *  and never return another workspace's page (#554). */
  workspaceId: string;
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

/** The hand-off's terminal as [paneId, surfaceId, ptyId, agentName], or null
 *  when this browser's pane shows no terminal with an agent in it. */
function resolveHandoffTarget(
  s: ReturnType<typeof useStore.getState>,
  workspaceId: string,
  surfaceId: string,
): [string, string, string, string] | null {
  const ws = s.workspaces.find((w) => w.id === workspaceId);
  const at = ws ? findWorkspaceSurfaceById(ws, surfaceId) : null;
  const leaf = ws && at && !at.stashed ? findLeaf(ws.rootPane, at.paneId) : null;
  if (!leaf) return null;
  const terminals = leaf.surfaces.filter((x) => !x.surfaceType || x.surfaceType === 'terminal');
  const shown = terminals.find((x) => x.id === leaf.activeSurfaceId) ?? terminals[0];
  const agent = shown?.ptyId ? s.surfaceAgent[shown.ptyId] : undefined;
  return shown && agent ? [leaf.id, shown.id, shown.ptyId, agent.name] : null;
}

export default function BrowserPanel({ surfaceId, workspaceId, initialUrl, partition, isActive, visible, isZoomHidden, isWorkspaceVisible, occluded, onClose }: BrowserPanelProps) {
  const t = useT();
  const updateBrowserUrl = useStore((s) => s.updateBrowserUrl);
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [pageTitle, setPageTitle] = useState(() => t('browser.title'));
  const [isReady, setIsReady] = useState(false);
  // #517 slice C — memory relief: when main decides this guest has been
  // invisible long enough, the <webview> is unmounted entirely (destroying the
  // guest renderer process and freeing its memory) and a placeholder renders
  // instead. `mountSrc` is the URL the webview (re)mounts with — captured at
  // restore time so the reload lands on the last page the user saw, and NOT
  // updated on ordinary navigations (a src prop change would reload the page).
  const [discarded, setDiscarded] = useState(false);
  const [mountSrc, setMountSrc] = useState(initialUrl);
  const currentUrlRef = useRef(initialUrl);
  // Mirrors `discarded` for the restore guard — a state-updater must stay
  // pure (no setMountSrc inside it; StrictMode double-invokes updaters), so
  // restoreFromDiscard reads/writes this ref and then sets state plainly
  // (Claude+GLM review).
  const discardedRef = useRef(false);
  // A private tab waits for an in-flight wipe of the private session (the last
  // private tab just closed) before its <webview> mounts — otherwise that wipe
  // would take this tab's cookies with it. Normal tabs never wait.
  const isPrivate = isPrivateBrowserPartition(partition);
  const [sessionReady, setSessionReady] = useState(() => !isPrivate || isPrivateSessionReady());
  useEffect(() => {
    if (sessionReady) return;
    let alive = true;
    void privateSessionReady().then(() => { if (alive) setSessionReady(true); });
    return () => { alive = false; };
  }, [sessionReady]);
  const [inspecting, setInspecting] = useState(false);
  // The element the user picked with the inspector, waiting to be handed to
  // the pane's agent (or copied), and the note going with it.
  const [handoff, setHandoff] = useState<InspectedElement | null>(null);
  const [handoffNote, setHandoffNote] = useState('');
  // Fresh per inspector session: only a result carrying it is accepted, and
  // only once, so a stale or unsolicited message cannot raise the bar outside
  // a pick. It does not make the result trustworthy — the script runs in the
  // page's world, so the page can read and rewrite what it reports; the bar
  // shows the result and everything in it is treated as page text.
  const inspectNonceRef = useRef('');

  // browser_request_help — the open ask for THIS surface, if any. The record is
  // the stored object (selectHelpRequestForSurface returns it as-is), so a bare
  // subscription re-renders only when the ask itself changes.
  const helpRequest = useStore((s) => selectHelpRequestForSurface(s, surfaceId));
  const removeBrowserHelpRequest = useStore((s) => s.removeBrowserHelpRequest);

  // Answer the ask. The optimistic local removal pairs with the authoritative
  // BROWSER_HELP_CLOSED push main emits from inside its own settle, and both are
  // idempotent — the highlight main put on the page is cleared there too, so the
  // bar never has to reach into the guest itself.
  const resolveHelp = useCallback((outcome: BrowserHelpOutcome) => {
    if (!helpRequest) return;
    void window.electronAPI.browserHelp?.resolve(helpRequest.requestId, outcome);
    removeBrowserHelpRequest(helpRequest.requestId);
  }, [helpRequest, removeBrowserHelpRequest]);

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

  // Keep a ref of the latest URL so a restore can remount on it without
  // making the effect below depend on currentUrl.
  useEffect(() => {
    currentUrlRef.current = currentUrl;
  }, [currentUrl]);

  const restoreFromDiscard = useCallback(() => {
    if (!discardedRef.current) return;
    discardedRef.current = false;
    setMountSrc(currentUrlRef.current);
    setDiscarded(false);
  }, []);

  // Discard/wake signals from main (#517 slice C). Discard unmounts the
  // webview (the 'destroyed' event unregisters the CDP target in main); wake
  // remounts it — dom-ready then re-registers and resolves main's waiters.
  useEffect(() => {
    const api = (window as any).electronAPI?.browser;
    const offDiscard = api?.onDiscarded?.((sid: string) => {
      if (sid !== surfaceId) return;
      discardedRef.current = true;
      setIsReady(false);
      setDiscarded(true);
    });
    const offWake = api?.onWake?.((sid: string) => {
      if (sid !== surfaceId) return;
      restoreFromDiscard();
    });
    return () => { offDiscard?.(); offWake?.(); };
  }, [surfaceId, restoreFromDiscard]);

  // Attach webview event listeners once ready. `discarded` is a dependency so
  // listeners re-attach on the fresh <webview> element after a restore.
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    // Register the guest's webContents with main for CDP. Idempotent for the
    // same guest (main treats a same-wcId call as a re-registration), so it is
    // safe to call from both did-attach and dom-ready.
    const registerForCdp = async (via: string) => {
      try {
        const wcId = (wv as any).getWebContentsId?.();
        if (wcId && (window as any).electronAPI?.browser?.registerWebview) {
          await (window as any).electronAPI.browser.registerWebview(surfaceId, wcId, workspaceId);
          console.log(`[BrowserPanel] CDP target registered (${via}) for surface=${surfaceId} wc=${wcId}`);
        }
      } catch (err) {
        console.warn('[BrowserPanel] Failed to register webview for CDP:', err);
      }
    };

    // did-attach fires as soon as the guest webContents exists — before the
    // page finishes loading. Registering here decouples CDP availability from
    // page load speed, which matters for the #517 wake path: a discarded pane
    // remounts and reloads, and on a slow or unreachable page dom-ready can
    // take longer than main's wake timeout, leaving automation with "no
    // webview target" (observed live on a machine with dead DNS).
    const onDidAttach = () => { void registerForCdp('did-attach'); };

    const onDomReady = async () => {
      setIsReady(true);
      updateNavState();
      // Re-register on dom-ready as well: the target list lookup by URL/title
      // only matches once the page has actually loaded.
      await registerForCdp('dom-ready');
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

    wv.addEventListener('did-attach', onDidAttach);
    wv.addEventListener('dom-ready', onDomReady);
    wv.addEventListener('did-start-loading', onStartLoading);
    wv.addEventListener('did-stop-loading', onStopLoading);
    wv.addEventListener('did-navigate', onDidNavigate as EventListener);
    wv.addEventListener('did-navigate-in-page', onDidNavigateInPage as EventListener);
    wv.addEventListener('page-title-updated', onTitleUpdated as EventListener);

    return () => {
      wv.removeEventListener('did-attach', onDidAttach);
      wv.removeEventListener('dom-ready', onDomReady);
      wv.removeEventListener('did-start-loading', onStartLoading);
      wv.removeEventListener('did-stop-loading', onStopLoading);
      wv.removeEventListener('did-navigate', onDidNavigate as EventListener);
      wv.removeEventListener('did-navigate-in-page', onDidNavigateInPage as EventListener);
      wv.removeEventListener('page-title-updated', onTitleUpdated as EventListener);
    };
  }, [updateNavState, updateBrowserUrl, surfaceId, workspaceId, discarded, sessionReady]);

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

  // A discarded pane that becomes visible again restores itself — the user
  // switched back to this workspace/pane and expects the page, not a stub.
  useEffect(() => {
    if (effectiveVisible) restoreFromDiscard();
  }, [effectiveVisible, restoreFromDiscard]);

  const handleNavigate = useCallback((url: string) => {
    if (!isSafeBrowserUrl(url)) return;
    if (!sessionReady) {
      // No webview yet: it mounts on the target URL once the session is ready.
      setMountSrc(url);
      setCurrentUrl(url);
      return;
    }
    if (discarded) {
      // Navigating a discarded pane restores it directly onto the target URL.
      discardedRef.current = false;
      setMountSrc(url);
      setCurrentUrl(url);
      setDiscarded(false);
      return;
    }
    const wv = webviewRef.current;
    if (!wv) return;
    if (isReady) {
      wv.loadURL(url);
    } else {
      // If not ready yet, just update src attribute
      wv.setAttribute('src', url);
    }
    setCurrentUrl(url);
  }, [isReady, discarded, sessionReady]);

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

  // Cmd/Ctrl + = / - / 0 while this pane's chrome has focus (useKeyboard);
  // inside the page main handles the same keys.
  useEffect(() => {
    const onZoomEvent = (e: Event) => {
      const detail = (e as CustomEvent<BrowserZoomDetail>).detail;
      const wv = webviewRef.current;
      if (!detail || detail.surfaceId !== surfaceId || !wv || !isReady) return;
      wv.setZoomFactor(stepPageZoom(wv.getZoomFactor(), detail.step));
    };
    document.addEventListener(BROWSER_ZOOM_EVENT, onZoomEvent);
    return () => document.removeEventListener(BROWSER_ZOOM_EVENT, onZoomEvent);
  }, [surfaceId, isReady]);

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
    const nonce = crypto.randomUUID();
    inspectNonceRef.current = nonce;
    // 이 오버레이/라벨은 게스트 웹뷰(임의의 외부 페이지) 내부에 주입된다.
    // wmux 테마 CSS 변수가 없는 문서라서 색은 의도적으로 자립 hex로 둔다
    // (테마 토큰 승격 대상 아님 — 외부 페이지 위 오버레이).
    wv.executeJavaScript(`
      (function() {
        // A leftover from a session whose removal never ran would keep
        // swallowing clicks under an old nonce: replace it.
        const prev = window.__wmuxInspector;
        if (prev) {
          document.removeEventListener('mousemove', prev.onMove, true);
          document.removeEventListener('click', prev.onClick, true);
          prev.overlay.remove();
          prev.label.remove();
          delete window.__wmuxInspector;
        }
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
          const text = (el.innerText || el.textContent || '').trim().slice(0, 400);
          // A few computed styles (the allow-list; the app re-checks every key)
          // and the element's box, which the app captures as a screenshot.
          const cs = getComputedStyle(el);
          const styles = {};
          for (const k of ${JSON.stringify(ELEMENT_STYLE_KEYS)}) styles[k] = String(cs.getPropertyValue(k) || '').slice(0, 200);
          const b = el.getBoundingClientRect();
          const rect = { x: b.left, y: b.top, width: b.width, height: b.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
          return { title: document.title, url: location.href, selector: selector, tag: openTag, text: text, styles: styles, rect: rect };
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
          // Kept so the app can measure it again right before its screenshot.
          window.__wmuxPicked = el;
          console.log('__wmux_inspect_result__' + ${JSON.stringify(nonce)} + ':' + JSON.stringify(buildContext(el)));
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
    if (!inspecting) {
      injectInspector();
    } else {
      removeInspector();
      inspectNonceRef.current = '';
    }
    setInspecting(!inspecting);
  }, [inspecting, injectInspector, removeInspector]);

  // Listen for inspector click results from webview console
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const onConsole = (e: Electron.ConsoleMessageEvent) => {
      const nonce = inspectNonceRef.current;
      const prefix = `__wmux_inspect_result__${nonce}:`;
      if (!nonce || !e.message.startsWith(prefix)) return;
      // One pick per inspector session; the nonce is spent either way.
      inspectNonceRef.current = '';
      removeInspector();
      setInspecting(false);
      let picked: InspectedElement | null = null;
      try { picked = parseInspectedElement(JSON.parse(e.message.slice(prefix.length))); } catch { /* not ours */ }
      if (!picked) return;
      setHandoffNote('');
      setHandoff(picked);
      // The element's screenshot, saved for the agent to open. Not for a
      // private tab: its pages are never written to disk.
      const wcId = (wv as unknown as { getWebContentsId?: () => number }).getWebContentsId?.();
      const capture = window.electronAPI?.browser?.captureElement;
      if (picked.rect && !isPrivate && wcId && capture) {
        const shotOf = picked;
        void (async () => {
          try {
            // The inspector's overlay goes first (removeInspector above runs
            // before this in the guest); wait two frames so it is off screen,
            // then measure the element again: the hand-off bar replacing the
            // inspector hint resized the view, which can move it.
            const rect = parseElementRect(await wv.executeJavaScript(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => {
              const el = window.__wmuxPicked;
              delete window.__wmuxPicked;
              if (!el || !el.isConnected) return r(null);
              const b = el.getBoundingClientRect();
              r({ x: b.left, y: b.top, width: b.width, height: b.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
            })))`));
            if (!rect) return;
            const ptyId = resolveHandoffTarget(useStore.getState(), workspaceId, surfaceId)?.[2];
            const file = await capture(wcId, rect, ptyId);
            if (file) setHandoff((cur) => (cur === shotOf ? { ...cur, screenshot: file } : cur));
          } catch { /* the hand-off goes without a screenshot */ }
        })();
      }
    };
    wv.addEventListener('console-message', onConsole as EventListener);
    return () => { wv.removeEventListener('console-message', onConsole as EventListener); };
  }, [removeInspector, discarded, sessionReady, isPrivate, workspaceId, surfaceId]);

  // The terminal the hand-off goes to: the one this browser's pane shows (its
  // focused terminal, else its first), and only while an agent runs in it —
  // the line is a prompt for the agent, never a command for a bare shell.
  // Resolved only while the bar is open, as a string key so the selector
  // re-renders this panel only when the answer changes.
  const handoffTargetKey = useStore((s) => {
    if (!handoff) return '';
    const target = resolveHandoffTarget(s, workspaceId, surfaceId);
    return target ? JSON.stringify(target) : '';
  });
  const handoffTarget = handoffTargetKey
    ? (JSON.parse(handoffTargetKey) as [string, string, string, string])
    : null;
  const closeHandoff = useCallback(() => {
    setHandoff(null);
    setHandoffNote('');
  }, []);
  const sendHandoff = useCallback(() => {
    if (!handoff || !handoffTarget) return;
    const [paneId, terminalSurfaceId, ptyId] = handoffTarget;
    void injectText(ptyId, formatElementHandoff(handoff, handoffNote), false);
    // Focus the terminal: the line sits there unsent until the user presses Enter.
    useStore.getState().setActiveSurface(paneId, terminalSurfaceId, workspaceId);
    closeHandoff();
  }, [handoff, handoffNote, handoffTarget, workspaceId, closeHandoff]);
  const copyHandoff = useCallback(() => {
    if (!handoff) return;
    void navigator.clipboard.writeText(formatElementHandoff(handoff, handoffNote)).catch(() => undefined);
    closeHandoff();
  }, [handoff, handoffNote, closeHandoff]);

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
      // Lets the zoom shortcut find the pane whose chrome has focus (useKeyboard).
      data-browser-panel={surfaceId}
      // Clicking the toolbar / title strip / page chrome (anywhere in the
      // pane) pulls keyboard focus onto the webview. Clicking *inside* page
      // content already focuses the guest natively, but pane-switch clicks and
      // clicks on our own chrome do not — without this, keyboard input stays
      // dead after such a click (#252). A click on one of our own controls
      // keeps its focus: the address bar took the click, then lost it to the
      // webview, so nothing typed there ever reached it.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('input, textarea, select, button, [contenteditable="true"]')) return;
        webviewRef.current?.focus();
      }}
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
        isPrivate={isPrivate}
        inspecting={inspecting}
        onNavigate={handleNavigate}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        onToggleInspect={handleToggleInspect}
        onOpenDevTools={handleOpenDevTools}
        onClose={onClose}
      />

      {/* browser_request_help — the agent hands one step to the human.
          FIRST of the event's two renditions (the Fleet inbox row is the
          second); DESIGN.md's attention grammar caps it there, so there is no
          titlebar chip and no modal. It sits in the inspector toast's slot for
          the same reason that band does: a transient, compact ~30px strip, not a
          36px chrome row — the terminals/page lose no lasting height. */}
      {helpRequest && (
        <div
          data-browser-help-bar
          role="status"
          aria-label={t('browser.help.barLabel')}
          className="flex items-center gap-2 px-3 shrink-0"
          style={{
            minHeight: 30,
            backgroundColor: 'var(--bg-surface)',
            borderBottom: '1px solid color-mix(in srgb, var(--text-main) 6%, transparent)',
          }}
        >
          {/* Red = needs input, the one status-dot vocabulary. Monochrome, and
              not an emoji. */}
          <span
            aria-hidden="true"
            className="shrink-0 rounded-full"
            style={{ width: 6, height: 6, backgroundColor: 'var(--accent-red)' }}
          />
          {/* Sans 13px: someone talking, not machine evidence. Rendered as a
              text child, so an agent-authored prompt is text and only text —
              never markup. */}
          <span
            data-browser-help-prompt
            className="flex-1 truncate"
            style={{ fontSize: 13, color: 'var(--text-main)' }}
            title={helpRequest.prompt}
          >
            {helpRequest.prompt}
          </span>
          {/* Secondary = raised neutral (DESIGN.md). */}
          <button
            type="button"
            data-browser-help-cancel
            onClick={() => resolveHelp('cancelled')}
            className="shrink-0 px-2.5 rounded-[5px] border transition-colors"
            style={{
              minHeight: 24,
              minWidth: 24,
              fontSize: 13,
              color: 'var(--text-sub)',
              backgroundColor: 'color-mix(in srgb, var(--text-main) 6%, transparent)',
              borderColor: 'color-mix(in srgb, var(--text-main) 10%, transparent)',
              boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--text-main) 6%, transparent)',
              transitionDuration: '120ms',
            }}
          >
            {t('browser.help.cancel')}
          </button>
          {/* The ONE solid warm fill on this surface — DESIGN.md "Primary
              action = solid warm fill". */}
          <button
            type="button"
            data-browser-help-done
            onClick={() => resolveHelp('continued')}
            className="shrink-0 px-2.5 rounded-[5px] font-semibold transition-colors"
            style={{
              minHeight: 24,
              minWidth: 24,
              fontSize: 13,
              color: 'var(--bg-base)',
              backgroundColor: 'var(--accent)',
              // --surface-highlight, NOT --text-main: this inset sits on a
              // saturated accent fill and models a light source above the
              // control, so a text-main mix would invert it on the light themes
              // and press a groove into the button (tokenDiscipline.test.ts).
              boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--surface-highlight) 22%, transparent)',
              transitionDuration: '120ms',
            }}
          >
            {t('browser.help.done')}
          </button>
        </div>
      )}
      {/* Inspector → agent hand-off. Same slot and grammar as the help bar
          above: a transient band, not a chrome row. The picked element is page
          text, rendered as text only. */}
      {handoff && (
        <div
          data-browser-handoff-bar
          role="group"
          aria-label={t('browser.handoff.barLabel')}
          className="flex flex-col gap-1.5 px-3 py-2 shrink-0"
          // The panel root hands every click to the webview; a click here must
          // keep the focus in the note.
          onClick={(e) => e.stopPropagation()}
          style={{
            backgroundColor: 'var(--bg-surface)',
            borderBottom: '1px solid color-mix(in srgb, var(--text-main) 6%, transparent)',
          }}
        >
          <div className="flex items-baseline gap-2 min-w-0" style={{ fontSize: 12 }}>
            <span
              data-browser-handoff-selector
              className="shrink-0 truncate max-w-[50%]"
              style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--text-main)' }}
              title={handoff.tag || handoff.selector}
            >
              {handoff.selector}
            </span>
            {handoff.text && (
              <span className="truncate min-w-0" style={{ color: 'var(--text-sub)' }} title={handoff.text}>
                {handoff.text}
              </span>
            )}
            {handoff.screenshot && (
              <span
                data-browser-handoff-shot
                className="shrink-0 ml-auto"
                style={{ fontSize: 11, color: 'var(--text-muted)' }}
                title={handoff.screenshot}
              >
                {t('browser.handoff.screenshot')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <input
              data-browser-handoff-note
              autoFocus
              value={handoffNote}
              maxLength={HANDOFF_NOTE_MAX}
              onChange={(e) => setHandoffNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (handoffTarget) sendHandoff(); else copyHandoff();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  closeHandoff();
                }
                e.stopPropagation();
              }}
              placeholder={t('browser.handoff.notePlaceholder')}
              aria-label={t('browser.handoff.notePlaceholder')}
              className="flex-1 min-w-0 rounded-[5px] px-2 outline-none"
              style={{
                minHeight: 26,
                fontSize: 13,
                color: 'var(--text-main)',
                backgroundColor: 'var(--bg-base)',
                border: '1px solid color-mix(in srgb, var(--text-main) 12%, transparent)',
              }}
            />
            <button
              type="button"
              data-browser-handoff-copy
              onClick={copyHandoff}
              className="shrink-0 px-2.5 rounded-[5px] border transition-colors"
              style={handoffTarget ? {
                minHeight: 24,
                fontSize: 13,
                color: 'var(--text-sub)',
                backgroundColor: 'color-mix(in srgb, var(--text-main) 6%, transparent)',
                borderColor: 'color-mix(in srgb, var(--text-main) 10%, transparent)',
                transitionDuration: '120ms',
              } : {
                minHeight: 24,
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--bg-base)',
                backgroundColor: 'var(--accent)',
                borderColor: 'transparent',
                transitionDuration: '120ms',
              }}
              title={handoffTarget ? undefined : t('browser.handoff.noTerminal')}
            >
              {t('browser.handoff.copy')}
            </button>
            {handoffTarget && (
              <button
                type="button"
                data-browser-handoff-send
                onClick={sendHandoff}
                className="shrink-0 px-2.5 rounded-[5px] font-semibold transition-colors truncate max-w-[45%]"
                style={{
                  minHeight: 24,
                  fontSize: 13,
                  color: 'var(--bg-base)',
                  backgroundColor: 'var(--accent)',
                  boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--surface-highlight) 22%, transparent)',
                  transitionDuration: '120ms',
                }}
                title={t('browser.handoff.sendHint')}
              >
                {t('browser.handoff.send', { name: handoffTarget[3] })}
              </button>
            )}
            <button
              type="button"
              data-browser-handoff-close
              onClick={closeHandoff}
              className="shrink-0 ui-icon-btn w-6 h-6 flex items-center justify-center"
              title={t('browser.handoff.close')}
              aria-label={t('browser.handoff.close')}
            >
              <IconX size={12} />
            </button>
          </div>
        </div>
      )}
      {inspecting && (
        <div
          data-browser-inspector-hint
          className="flex items-center gap-2 px-3 py-1 text-xs shrink-0"
          style={{
            backgroundColor: 'var(--bg-base)',
            color: 'var(--accent-blue)',
            borderBottom: '1px solid var(--accent-blue)',
          }}
        >
          {t('browser.inspector.hint')}
        </div>
      )}

      {/* WebView — or, when discarded (#517 slice C), a placeholder. The
          <webview> is unmounted entirely so the guest renderer process dies
          and its memory is reclaimed; remounting reloads mountSrc. */}
      <div className="flex-1 relative overflow-hidden" style={{ backgroundColor: 'var(--bg-base)' }}>
        {!sessionReady ? null : discarded ? (
        <button
          type="button"
          onClick={restoreFromDiscard}
          className="flex flex-col items-center justify-center gap-1.5 w-full h-full cursor-pointer"
          style={{ backgroundColor: 'var(--bg-base)', border: 'none' }}
        >
          <span className="text-xs text-[var(--text-subtle)]" style={{ fontFamily: 'ui-monospace, monospace' }}>
            {t('browser.discarded')}
          </span>
          <span className="text-xs text-[var(--text-muted)] truncate max-w-[80%]" style={{ fontFamily: 'ui-monospace, monospace' }}>
            {currentUrl}
          </span>
        </button>
        ) : (
        <webview
          ref={webviewRef as React.RefObject<Electron.WebviewTag>}
          src={mountSrc}
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
        )}
      </div>
    </div>
  );
}
