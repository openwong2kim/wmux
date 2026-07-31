import { useEffect, useRef } from 'react';
import { useStore } from '../stores';
import {
  PLUGIN_BRIDGE_VERSION,
  PLUGIN_PROTOCOL_SCHEME,
  parseBridgeRequest,
  type BridgeResponse,
} from '../../shared/pluginHost';
import { registerFrame } from './pluginFrameRegistry';

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
 * Bridge handshake: on iframe `load`, the host creates a MessageChannel and
 * posts `{ v: 1, kind: 'init' }` with port2 transferred. targetOrigin is
 * `'*'` by necessity — a sandboxed frame's origin is opaque ("null") and
 * unmatchable; the port transfer is still point-to-point to this frame.
 *
 * Event forwarding (`forwardEvents`): the host polls `events.poll` THROUGH
 * the plugin's own RPC identity (so the events.subscribe capability and the
 * notifications.read gate apply unchanged) and pushes results to the frame
 * as `kind:'event'` envelopes. The cursor starts at the current ring head —
 * plugins see events from mount time, not a history replay. A rejected poll
 * stops the loop (the plugin didn't declare events.subscribe).
 */
export default function PluginFrame({
  pluginName,
  entry,
  forwardEvents = false,
  className,
}: {
  pluginName: string;
  entry: string;
  forwardEvents?: boolean;
  className?: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Fix: scope events.poll to the active workspace so plugins cannot observe
  // other workspaces' lifecycle events (TODOS: "Unscoped plugin events.poll").
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    const iframe = frameRef.current;
    if (!iframe) return;
    let port: MessagePort | null = null;
    let disposed = false;
    let unregisterFrame: (() => void) | null = null;
    let eventTimer: ReturnType<typeof setInterval> | null = null;

    const post = (msg: unknown) => {
      try {
        port?.postMessage(msg);
      } catch {
        /* port may be closed mid-flight during unmount */
      }
    };
    const respond = (msg: BridgeResponse) => post(msg);

    const stopEventLoop = () => {
      if (eventTimer !== null) {
        clearInterval(eventTimer);
        eventTimer = null;
      }
    };

    const startEventLoop = () => {
      stopEventLoop();
      let cursor: number | null = null; // null until the head is established
      let inFlight = false;
      eventTimer = setInterval(() => {
        if (disposed || inFlight) return;
        inFlight = true;
        window.electronAPI.plugins
          .rpc(pluginName, 'events.poll', cursor === null
            ? { workspaceId: activeWorkspaceId }
            : { cursor, workspaceId: activeWorkspaceId })
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
            for (const event of resp.result.events ?? []) {
              post({ v: PLUGIN_BRIDGE_VERSION, id: null, kind: 'event', event });
            }
          })
          .catch(() => stopEventLoop())
          .finally(() => { inFlight = false; });
      }, EVENT_POLL_INTERVAL_MS);
    };

    const onLoad = () => {
      port?.close();
      unregisterFrame?.();
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (e: MessageEvent) => {
        const req = parseBridgeRequest(e.data);
        if (!req || disposed) return;
        window.electronAPI.plugins
          .rpc(pluginName, req.method, req.params)
          .then((raw) => {
            const resp = raw as { ok?: boolean; result?: unknown; error?: string } | null;
            if (resp && resp.ok === true) {
              respond({ v: PLUGIN_BRIDGE_VERSION, id: req.id, kind: 'response', result: resp.result });
            } else {
              respond({
                v: PLUGIN_BRIDGE_VERSION,
                id: req.id,
                kind: 'response',
                error: { code: 'rpc-rejected', message: resp?.error ?? 'request rejected' },
              });
            }
          })
          .catch((err: unknown) => {
            respond({
              v: PLUGIN_BRIDGE_VERSION,
              id: req.id,
              kind: 'response',
              error: { code: 'bridge-error', message: err instanceof Error ? err.message : String(err) },
            });
          });
      };
      iframe.contentWindow?.postMessage({ v: PLUGIN_BRIDGE_VERSION, kind: 'init' }, '*', [channel.port2]);

      // Palette command delivery (kind:'command' envelopes) + queued flush.
      unregisterFrame = registerFrame(pluginName, (command) => {
        post({ v: PLUGIN_BRIDGE_VERSION, id: null, kind: 'command', command });
      });

      if (forwardEvents) startEventLoop();
    };

    iframe.addEventListener('load', onLoad);
    return () => {
      disposed = true;
      stopEventLoop();
      iframe.removeEventListener('load', onLoad);
      unregisterFrame?.();
      unregisterFrame = null;
      port?.close();
      port = null;
    };
  }, [pluginName, entry, forwardEvents, activeWorkspaceId]);

  return (
    <iframe
      ref={frameRef}
      src={`${PLUGIN_PROTOCOL_SCHEME}://${pluginName}/${entry}`}
      sandbox="allow-scripts"
      className={className}
      title={`plugin:${pluginName}`}
      style={{ border: 'none', width: '100%', height: '100%', background: 'transparent' }}
    />
  );
}
