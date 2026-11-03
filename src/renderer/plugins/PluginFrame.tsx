import { pluginFrameHandshake } from './pluginFrameHandshake';
import { isLight } from '../tailwindPalette';
import { useT } from '../hooks/useT';
import { subscribeAgentState } from './agentStateSubscription';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../stores';
import {
  PLUGIN_BRIDGE_VERSION,
  PLUGIN_PROTOCOL_SCHEME,
  parseBridgeRequest,
  type BridgeResponse,
} from '../../shared/pluginHost';
import { registerFrame } from './pluginFrameRegistry';
import { parseBridgeKey, pluginPageKeyRoute } from './pluginPageKey';
import { activeShortcutBindings } from '../utils/shortcutBindings';
import { findPane } from '../../shared/paneUtils';

// Cadence for the host-side events.poll forwarding loop (see below). The
// poll is an in-process ring read in main — cheap enough for 1 Hz per
// mounted frame.
const EVENT_POLL_INTERVAL_MS = 1000;

/**
 * Sandboxed plugin iframe + postMessage bridge (B-1 core).
 *
 * Security model:
 *   - `sandbox="allow-scripts"` ONLY — no allow-same-origin, so the frame
 *     runs with an opaque origin: no storage, no cookies, no reaching the
 *     parent document. Its sole channel to the host is the MessagePort
 *     delivered below.
 *   - The host stamps `pluginName` itself when forwarding requests; nothing
 *     in the envelope identifies the caller, so one plugin cannot
 *     impersonate another.
 *   - Inbound messages are validated by `parseBridgeRequest`; anything that
 *     doesn't match the frozen request shape is dropped silently.
 *   - Requests dispatch through main's RpcRouter with the plugin's
 *     clientName, so the Phase 2.2 permission stack (trust status,
 *     capability/path checks, approval prompts) applies to every call.
 *
 * Bridge handshake: main bootstraps a channel in the checked document. The
 * host accepts that document's port only after main confirms execution. A
 * later navigation cannot inherit the port through a WindowProxy transfer.
 *
 * Event forwarding (`forwardEvents`): the host polls `events.poll` THROUGH
 * the plugin's own RPC identity (so the events.subscribe capability and the
 * notifications.read gate apply unchanged) and pushes results to the frame
 * as `kind:'event'` envelopes. The cursor starts at the current ring head —
 * plugins see events from mount time, not a history replay. A rejected poll
 * stops the loop (the plugin didn't declare events.subscribe).
 *
 * Two effects, deliberately: the port is created once per iframe `load`, and
 * `load` does not fire again for a frame whose `src` never changed. So the
 * bridge effect may only depend on what identifies the frame. The poll must
 * re-subscribe when the user switches workspace (#719); when that dependency
 * lived on the single combined effect, the switch tore the port down with no
 * `load` left to rebuild it and every later plugin request went unanswered.
 * `bridgeEpoch` is how the poll effect waits for — and follows — the port.
 */
export default function PluginFrame({
  pluginName,
  entry,
  forwardEvents = false,
  agentStateEvents = false,
  agentStateScope = 'workspace',
  railPage = false,
  className,
}: {
  pluginName: string;
  entry: string;
  forwardEvents?: boolean;
  agentStateEvents?: boolean;
  /** 'all': the page is approved for agent.state.read.all (main re-checks). */
  agentStateScope?: 'workspace' | 'all';
  railPage?: boolean;
  className?: string;
}) {
  const t = useT();
  const [blocked, setBlocked] = useState(false);
  useEffect(() => setBlocked(false), [pluginName, entry]);
  const [frameId] = useState(() => crypto.randomUUID());
  const frameName = `wmux-plugin-frame:${pluginName}:${frameId}`;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  // Read by the bridge's response path; a ref so the bridge effect keeps
  // depending only on what identifies the frame (see the note above).
  const agentStateScopeRef = useRef(agentStateScope);
  agentStateScopeRef.current = agentStateScope;
  // Monotonic across retirement and handoff, even when React batches both.
  // Readiness comes from portRef; generations must never repeat on reload.
  const [bridgeEpoch, setBridgeEpoch] = useState(0);
  // Fix: scope events.poll to the active workspace so plugins cannot observe
  // other workspaces' lifecycle events (TODOS: "Unscoped plugin events.poll").
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const scopeEpochRef = useRef(0);
  const [scopeEpoch, setScopeEpoch] = useState(0);
  useEffect(() => useStore.subscribe((state, previous) => {
    if (state.activeWorkspaceId !== previous.activeWorkspaceId) {
      scopeEpochRef.current += 1;
      setScopeEpoch(scopeEpochRef.current);
    }
  }), []);

  // Theme tokens are copied explicitly: sandboxed frames cannot read parent CSS.
  useEffect(() => {
    if (!bridgeEpoch || !portRef.current) return;
    const sendTheme = () => {
      const style = getComputedStyle(document.documentElement);
      const variables: Record<string, string> = {};
      for (const name of ['--bg-base', '--bg-mantle', '--bg-surface', '--text-main', '--text-sub', '--text-muted', '--accent', '--accent-red', '--accent-green', '--accent-yellow', '--selection', '--font-ui']) {
        const value = style.getPropertyValue(name).trim();
        if (value) variables[name] = value;
      }
      portRef.current?.postMessage({ v: PLUGIN_BRIDGE_VERSION, kind: 'theme', variables, colorScheme: isLight(variables['--bg-base'] || '#000000') ? 'light' : 'dark' });
    };
    sendTheme();
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, [bridgeEpoch]);

  // ── Bridge: port lifetime, request forwarding, palette commands ──────────
  useEffect(() => {
    const iframe = frameRef.current;
    if (!iframe || blocked) return;
    let disposed = false;
    let unregisterFrame: (() => void) | null = null;

    /**
     * Unsolicited traffic (palette commands, forwarded events) goes to
     * whatever port is CURRENT — that is the document on screen.
     */
    const post = (msg: unknown) => {
      try {
        portRef.current?.postMessage(msg);
      } catch {
        /* port may be closed mid-flight during unmount */
      }
    };
    /**
     * A response goes back to the port the REQUEST came in on, not the current
     * one. An rpc started before a reload resolves after it, and answering on
     * the new port hands the fresh document a response to an id it never sent.
     * Closed ports throw, which is the correct outcome: the asker is gone.
     */
    const respondOn = (port: MessagePort, msg: BridgeResponse) => {
      try {
        port.postMessage(msg);
      } catch {
        /* the document that asked is gone; nothing to deliver to */
      }
    };

    const handshake = pluginFrameHandshake(iframe, pluginName, frameName);
    let navigationEpoch = 0;
    const dropBridge = () => {
      navigationEpoch++;
      handshake.cancel();
      portRef.current?.close();
      portRef.current = null;
      unregisterFrame?.();
      unregisterFrame = null;
      setBridgeEpoch((n) => n + 1);
    };
    const unsubscribeNavigation = window.electronAPI.plugins.onFrameNavigation((name) => {
      if (name === frameName) dropBridge();
    });
    const onLoad = async () => {
      dropBridge();
      const epoch = navigationEpoch;
      const port = await handshake.request();
      if (disposed || epoch !== navigationEpoch) { port?.close(); return; }
      if (!port) { setBlocked(true); return; }
      portRef.current = port;
      port.onmessage = (e: MessageEvent) => {
        // A page's own toggle shortcut, handed back from inside the frame
        // (pluginPageKey.ts). Pages only: a sidebar or status-bar frame has
        // no page to toggle.
        const key = railPage ? parseBridgeKey(e.data) : null;
        if (key) {
          if (disposed || portRef.current !== port) return;
          const state = useStore.getState();
          const route = pluginPageKeyRoute(key, activeShortcutBindings(), state.appRoute);
          if (route) state.setAppRoute(route);
          return;
        }
        const req = parseBridgeRequest(e.data);
        if (!req || disposed || portRef.current !== port) return;
        const requestWorkspace = useStore.getState().activeWorkspaceId;
        const requestEpoch = scopeEpochRef.current;
        window.electronAPI.plugins
          // #922: the workspace the host is showing rides alongside the
          // request, never inside it, so main can tell what this plugin IS
          // from what it ASKED for. Read at request time on purpose — making
          // it a dependency of this effect would tear the port down on every
          // workspace switch, which is exactly what #928 fixed. `railPage` is
          // this component's own prop (which kind of frame it mounted), so an
          // always-mounted sidebar or status-bar frame never reads as a page.
          .rpc(pluginName, req.method, req.params, useStore.getState().activeWorkspaceId, railPage)
          .then((raw) => {
            if (req.method === 'agent.state' && (disposed || portRef.current !== port
              || scopeEpochRef.current !== requestEpoch || useStore.getState().activeWorkspaceId !== requestWorkspace)) {
              respondOn(port, { v: PLUGIN_BRIDGE_VERSION, id: req.id, kind: 'response', error: { code: 'scope-changed', message: 'The workspace changed. Read again.' } });
              return;
            }
            const resp = raw as { ok?: boolean; result?: unknown; error?: string; retryable?: boolean } | null;
            if (resp && resp.ok === true) {
              respondOn(port, { v: PLUGIN_BRIDGE_VERSION, id: req.id, kind: 'response', result: resp.result });
              const state = useStore.getState();
              // An all-workspaces page may have switched the workspace itself
              // (to the focused pane's). Then the pane's owner, not the
              // unchanged workspace, is what says the focus landed.
              const landed = (scopeEpochRef.current === requestEpoch && state.activeWorkspaceId === requestWorkspace)
                || (agentStateScopeRef.current === 'all' && typeof req.params?.id === 'string'
                  && state.workspaces.some((w) => w.id === state.activeWorkspaceId && findPane(w.rootPane, req.params?.id as string) !== null));
              if (railPage && req.method === 'pane.focus' && portRef.current === port && !disposed
                && landed && state.appRoute === `plugin:${pluginName}`
                && (resp.result as { ok?: boolean } | null)?.ok === true) state.setAppRoute('workspaces');

            } else {
              respondOn(port, {
                v: PLUGIN_BRIDGE_VERSION,
                id: req.id,
                kind: 'response',
                error: { code: 'rpc-rejected', message: resp?.error ?? 'request rejected', ...(resp?.retryable === true ? { retryable: true } : {}) },
              });
            }
          })
          .catch((err: unknown) => {
            respondOn(port, {
              v: PLUGIN_BRIDGE_VERSION,
              id: req.id,
              kind: 'response',
              error: { code: 'bridge-error', message: err instanceof Error ? err.message : String(err) },
            });
          });
      };
      port.start();

      // Palette command delivery (kind:'command' envelopes) + queued flush.
      unregisterFrame = registerFrame(pluginName, (command) => {
        post({ v: PLUGIN_BRIDGE_VERSION, id: null, kind: 'command', command });
      });

      setBridgeEpoch((n) => n + 1);
    };

    iframe.addEventListener('load', onLoad);
    return () => {
      disposed = true;
      unsubscribeNavigation();
      handshake.dispose();
      navigationEpoch++;
      iframe.removeEventListener('load', onLoad);
      unregisterFrame?.();
      unregisterFrame = null;
      portRef.current?.close();
      portRef.current = null;
      // Invalidate subscriptions even if a new load is batched with cleanup.
      setBridgeEpoch((n) => n + 1);
    };
  }, [pluginName, entry, railPage, frameName, blocked]);

  // ── Event forwarding: re-subscribes when the active workspace changes ────
  useEffect(() => {
    if (!forwardEvents || !portRef.current) return;
    let cursor: number | null = null; // null until the head is established
    let inFlight = false;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stopEventLoop = () => {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    timer = setInterval(() => {
      if (stopped || inFlight) return;
      inFlight = true;
      window.electronAPI.plugins
        .rpc(
          pluginName,
          'events.poll',
          cursor === null
            ? { workspaceId: activeWorkspaceId }
            : { cursor, workspaceId: activeWorkspaceId },
          // Same value the params carry here (this effect re-runs on a
          // workspace switch), passed on the host channel as well so every
          // plugin-host dispatch states the host's binding, not just the
          // methods that read it today.
          activeWorkspaceId,
        )
        .then((raw) => {
          const resp = raw as { ok?: boolean; result?: { events?: unknown[]; nextCursor?: number } } | null;
          if (!resp || resp.ok !== true || !resp.result) {
            // Rejected (capability missing) or malformed — stop polling.
            stopEventLoop();
            return;
          }
          const head = typeof resp.result.nextCursor === 'number' ? resp.result.nextCursor : 0;
          if (cursor === null) {
            // First poll establishes the head; its (historical) events
            // are discarded so plugins start at "now".
            cursor = head;
            return;
          }
          cursor = head;
          if (stopped) return;
          for (const event of resp.result.events ?? []) {
            try {
              portRef.current?.postMessage({ v: PLUGIN_BRIDGE_VERSION, id: null, kind: 'event', event });
            } catch {
              /* port may be closed mid-flight during unmount */
            }
          }
        })
        .catch(() => stopEventLoop())
        .finally(() => { inFlight = false; });
    }, EVENT_POLL_INTERVAL_MS);

    return stopEventLoop;
  }, [pluginName, forwardEvents, activeWorkspaceId, bridgeEpoch]);

  useEffect(() => {
    const port = portRef.current;
    if (!agentStateEvents || agentStateScope === 'all' || !railPage || bridgeEpoch === 0 || !port) return;
    return subscribeAgentState({
      workspaceId: activeWorkspaceId,
      read: () => window.electronAPI.plugins.rpc(pluginName, 'agent.state', {}, activeWorkspaceId),
      post: (event) => { try { port.postMessage(event); } catch { /* closed during teardown */ } },
      isCurrent: () => scopeEpochRef.current === scopeEpoch && portRef.current === port && useStore.getState().activeWorkspaceId === activeWorkspaceId
        && useStore.getState().appRoute === `plugin:${pluginName}`,
    });
  }, [pluginName, agentStateEvents, agentStateScope, railPage, activeWorkspaceId, bridgeEpoch, scopeEpoch]);

  // Every local workspace in one stream. It does not restart on a workspace
  // switch (that would wipe the page between two identical answers); the
  // binding is read at each call instead, and main checks the grant each time.
  useEffect(() => {
    const port = portRef.current;
    if (!agentStateEvents || agentStateScope !== 'all' || !railPage || bridgeEpoch === 0 || !port) return;
    return subscribeAgentState({
      scope: 'all',
      workspaceId: () => useStore.getState().activeWorkspaceId ?? undefined,
      read: () => window.electronAPI.plugins.rpc(pluginName, 'agent.state.all', {}, useStore.getState().activeWorkspaceId),
      post: (event) => { try { port.postMessage(event); } catch { /* closed during teardown */ } },
      isCurrent: () => portRef.current === port && useStore.getState().appRoute === `plugin:${pluginName}`,
    });
  }, [pluginName, agentStateEvents, agentStateScope, railPage, bridgeEpoch]);

  if (blocked) return <div role="status" className="p-4 text-[13px] text-[var(--text-sub)]">{t('plugins.page.frameUnavailable')}</div>;
  return (
    <iframe
      key={frameName}
      ref={frameRef}
      name={frameName}
      src={`${PLUGIN_PROTOCOL_SCHEME}://${pluginName}/${entry}`}
      sandbox="allow-scripts"
      className={className}
      title={`plugin:${pluginName}`}
      style={{ border: 'none', width: '100%', height: '100%', background: 'transparent' }}
    />
  );
}
