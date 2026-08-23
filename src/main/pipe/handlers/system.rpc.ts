import { app } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { ALL_RPC_METHODS, type PaneMetadataCapabilities } from '../../../shared/rpc';
import { WMUX_EVENT_TYPES, RING_CAPACITY } from '../../../shared/events';
import { eventBus } from '../../events/EventBus';

/**
 * Shape returned by system.identify.
 */
interface SystemIdentity {
  app: string;
  version: string;
  platform: NodeJS.Platform;
  electronVersion: string;
}

export function registerSystemRpc(router: RpcRouter): void {
  /**
   * system.identify — returns static information about the running WinMux instance.
   * No renderer round-trip needed; answered entirely from Main.
   */
  router.register('system.identify', (_params): Promise<SystemIdentity> => {
    return Promise.resolve({
      app: 'wmux',
      version: app.getVersion(),
      platform: process.platform,
      electronVersion: process.versions.electron ?? 'unknown',
    });
  });

  /**
   * system.capabilities — returns the full list of registered RPC method names
   * plus a feature flag map so external tooling can detect optional surfaces
   * (pane metadata, future event bus, etc.) without inferring from method names.
   */
  router.register('system.capabilities', (_params) => {
    // M0-f: features.paneMetadata is now an object describing the M0 surface
    // (optimisticConcurrency + supported mergeModes). v2.8.x clients that
    // wrote `if (caps.features.paneMetadata)` keep working because a non-null
    // object is truthy. v2.9.0+ clients can feature-detect by reading the
    // fields directly.
    // Advertise only methods actually registered on THIS router. Control-pipe-only
    // RPCs (daemon.* / lanlink.*) are dispatched by the daemon pipe and are never
    // registered here, so listing the full static ALL_RPC_METHODS would advertise
    // methods a wire caller can't invoke (they'd get unknown-method). Filtering to
    // the registered set keeps capabilities honest (codex review).
    const registered = new Set(router.getRegisteredMethods());
    const paneMetadata: PaneMetadataCapabilities = {
      optimisticConcurrency: true,
      mergeModes: ['merge', 'replace', 'replaceShared'],
    };
    return Promise.resolve({
      methods: ALL_RPC_METHODS.filter((m) => registered.has(m)),
      features: {
        paneMetadata,
        // #977 — a boolean, not an object: unlike paneMetadata there are no
        // sub-modes to negotiate. Its presence tells a client that panes can be
        // off-layout-but-alive, that list rows carry `stashed`, and that
        // `includeStashed` and PANE_STASHED exist.
        paneStash: true,
        events: {
          types: WMUX_EVENT_TYPES,
          maxRingSize: RING_CAPACITY,
          // Stable for the lifetime of this main-process run. Clients that
          // see bootId change between calls must drop all cached state —
          // pane ids, pty ids, and event cursors are all invalidated.
          bootId: eventBus.bootId,
        },
      },
    });
  });
}
