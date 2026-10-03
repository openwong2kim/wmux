import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { isDaemonModeActive, subscribeDaemonMode } from '../../daemon/daemonMode';
import { getChatV2Bridge } from './bridge';
import { ChatV2Controller, forgetKnownBinding, knownBinding, onKnownBindings, setKnownBinding, type ChatV2ControllerState, type KnownBinding } from './controller';
import { forgetDrafts } from './Composer';

const UNAVAILABLE: ChatV2ControllerState = { phase: 'unavailable', view: null, error: null, hasEarlier: false };
const LOADING: ChatV2ControllerState = { phase: 'loading', view: null, error: null, hasEarlier: false };

/** Runs `onConnect` whenever the app (re)connects to the daemon. */
function useOnDaemonConnect(onConnect: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let connected = isDaemonModeActive();
    return subscribeDaemonMode(() => {
      const now = isDaemonModeActive();
      if (now && !connected) onConnect();
      connected = now;
    });
  }, [onConnect, enabled]);
}

/** The pane's chat-v2 connection while `active`; disposed (unsubscribed) otherwise. */
export function useChatV2(paneId: string, active: boolean): { state: ChatV2ControllerState; controller: ChatV2Controller | null; retry: () => void } {
  const [controller, setController] = useState<ChatV2Controller | null>(null);
  const [state, setState] = useState<ChatV2ControllerState>(LOADING);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return;
    const bridge = getChatV2Bridge();
    if (!bridge) { setState(UNAVAILABLE); return; }
    const next = new ChatV2Controller(bridge, paneId);
    const off = next.subscribe(setState);
    setController(next);
    setState(next.current);
    void next.start().catch(() => setState(UNAVAILABLE));
    return () => {
      off();
      next.dispose();
      setController(null);
    };
  }, [paneId, active, attempt]);
  // A new daemon connection has none of our subscriptions: subscribe and snapshot again.
  const reconnect = useCallback(() => { void controller?.reload(); }, [controller]);
  useOnDaemonConnect(reconnect, active && !!controller);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, controller, retry };
}

/**
 * What the pane's chat-v2 host says about it, for picking the view: a binding,
 * `null` (none), `false` (no chat-v2 host), or undefined (not known yet). Asked
 * whenever `enabled` turns on and on every daemon (re)connect; a failed ask
 * keeps the previous answer. An open chat-v2 view keeps it current.
 */
export function usePaneChatV2Binding(paneId: string | undefined, enabled: boolean): KnownBinding | undefined {
  const binding = useSyncExternalStore(onKnownBindings, () => (paneId ? knownBinding(paneId) : undefined));
  const [asked, setAsked] = useState(0);
  const askAgain = useCallback(() => setAsked((n) => n + 1), []);
  useOnDaemonConnect(askAgain, enabled && !!paneId);
  useEffect(() => {
    if (!enabled || !paneId) return;
    const bridge = getChatV2Bridge();
    if (!bridge) return;
    let cancelled = false;
    bridge.call('bindingForPane', { paneId }).then(
      (result) => {
        if (cancelled) return;
        if (result.ok) setKnownBinding(paneId, result.binding);
        else if (result.error.code === 'not-implemented') setKnownBinding(paneId, false);
      },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, [paneId, enabled, asked]);
  return binding;
}

/** Drop what the renderer remembers about a pane that closed. */
export function forgetChatV2Pane(paneId: string): void {
  forgetKnownBinding(paneId);
  forgetDrafts(paneId);
}
