import { useEffect, useState, useSyncExternalStore } from 'react';
import { getChatV2Bridge } from './bridge';
import { ChatV2Controller, knownBinding, onKnownBindings, setKnownBinding, type ChatV2ControllerState, type KnownBinding } from './controller';

const UNAVAILABLE: ChatV2ControllerState = { phase: 'unavailable', view: null, error: null, hasEarlier: false };
const LOADING: ChatV2ControllerState = { phase: 'loading', view: null, error: null, hasEarlier: false };

/** The pane's chat-v2 connection while `active`; disposed (unsubscribed) otherwise. */
export function useChatV2(paneId: string, active: boolean): { state: ChatV2ControllerState; controller: ChatV2Controller | null } {
  const [controller, setController] = useState<ChatV2Controller | null>(null);
  const [state, setState] = useState<ChatV2ControllerState>(LOADING);
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
  }, [paneId, active]);
  return { state, controller };
}

/**
 * What the pane's chat-v2 host says about it, for picking the view: a binding,
 * `null` (none), `false` (no host answered), or undefined (not asked yet).
 * Asks once whenever `enabled` turns on; an open chat-v2 view keeps it current.
 */
export function usePaneChatV2Binding(paneId: string | undefined, enabled: boolean): KnownBinding | undefined {
  const binding = useSyncExternalStore(onKnownBindings, () => (paneId ? knownBinding(paneId) : undefined));
  useEffect(() => {
    if (!enabled || !paneId) return;
    const bridge = getChatV2Bridge();
    if (!bridge) { setKnownBinding(paneId, false); return; }
    let cancelled = false;
    bridge.call('bindingForPane', { paneId }).then(
      (result) => { if (!cancelled) setKnownBinding(paneId, result.ok ? result.binding : false); },
      () => { if (!cancelled) setKnownBinding(paneId, false); },
    );
    return () => { cancelled = true; };
  }, [paneId, enabled]);
  return binding;
}
