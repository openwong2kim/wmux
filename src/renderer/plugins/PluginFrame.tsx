import { useEffect, useRef, useState } from 'react';
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
  className,
}: {
  pluginName: string;
  entry: string;
  forwardEvents?: boolean;
  className?: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  // Bumped every time a fresh port is handed to the frame. Zero means no
  // bridge yet, so the poll effect has nowhere to deliver events.
  const [bridgeEpoch, setBridgeEpoch] = useState(0);
  // Fix: scope events.poll to the active workspace so plugins cannot observe
  // other workspaces' lifecycle events (TODOS: "Unscoped plugin events.poll").
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);

  // ── Bridge: port lifetime, request forwarding, palette commands ──────────
  useEffect(() => {
    const iframe = frameRef.current;
    if (!iframe) return;
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

    const onLoad = () => {
      portRef.current?.close();
      unregisterFrame?.();
      const channel = new MessageChannel();
      const port = channel.port1;
      portRef.current = port;
      port.onmessage = (e: MessageEvent) => {
        const req = parseBridgeRequest(e.data);
        if (!req || disposed) return;
        window.electronAPI.plugins
          // #922: the workspace the host is showing rides alongside the
          // request, never inside it, so main can tell what this plugin IS
          // from what it ASKED for. Read at request time on purpose — making
          // it a dependency of this effect would tear the port down on every
          // workspace switch, which is exactly what #928 fixed.
          .rpc(pluginName, req.method, req.params, useStore.getState().activeWorkspaceId)
          .then((raw) => {
            const resp = raw as { ok?: boolean; result?: unknown; error?: string } | null;
            if (resp && resp.ok === true) {
              respondOn(port, { v: PLUGIN_BRIDGE_VERSION, id: req.id, kind: 'response', result: resp.result });
            } else {
              respondOn(port, {
                v: PLUGIN_BRIDGE_VERSION,
                id: req.id,
                kind: 'response',
                error: { code: 'rpc-rejected', message: resp?.error ?? 'request rejected' },
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
      iframe.contentWindow?.postMessage({ v: PLUGIN_BRIDGE_VERSION, kind: 'init' }, '*', [channel.port2]);

      // Palette command delivery (kind:'command' envelopes) + queued flush.
      unregisterFrame = registerFrame(pluginName, (command) => {
        post({ v: PLUGIN_BRIDGE_VERSION, id: null, kind: 'command', command });
      });

      setBridgeEpoch((n) => n + 1);
    };

    iframe.addEventListener('load', onLoad);
    return () => {
      disposed = true;
      iframe.removeEventListener('load', onLoad);
      unregisterFrame?.();
      unregisterFrame = null;
      portRef.current?.close();
      portRef.current = null;
      // Back to "no bridge". Without this the invariant only holds until the
      // first teardown: a pluginName/entry change nulls the port but leaves
      // the epoch at >= 1, so the poll effect restarts immediately and spends
      // the window before the new `load` posting into a null port — events
      // dropped, silently, with nothing to notice it.
      setBridgeEpoch(0);
    };
  }, [pluginName, entry]);

  // ── Event forwarding: re-subscribes when the active workspace changes ────
  useEffect(() => {
    if (!forwardEvents || bridgeEpoch === 0) return;
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
