// ─── a2a.channel.* RPC handler ─────────────────────────────────────────
// Thin pass-throughs from the pipe RPC surface to the daemon. The daemon
// owns the canonical channel state (ChannelService in src/daemon/channels/,
// U3); the renderer reaches the daemon exclusively through these handlers,
// which exist so the renderer can talk to one RPC router and the enforcer
// can gate these methods against `a2a.channel.read` / `a2a.channel.send`
// capabilities (a permission contract that lives on the pipe, not on the
// daemon — see methodCapabilityMap.ts).
//
// Each handler is `(params) => daemonClient.rpc('channel.<method>', params)`
// — there is NO renderer-side validation, state caching, or projection
// here. The renderer's channelsSlice (U6) is responsible for re-validating
// the typed service result; this layer's only job is transport +
// capability enforcement.
//
// The Post path's `channel.message` event emission is owned by ChannelService
// (inside the daemon's per-channel critical section) — the bridge from
// daemon to main's EventBus is in `src/main/DaemonClient.ts` and the
// downstream EventBus-side projection is in `src/main/notification/
// DaemonNotificationRouter.ts` (which tees daemon-sourced `channel.message`
// broadcasts into the main-process `events.poll` EventBus). Handlers in
// this file MUST NOT emit events themselves; doing so would race the
// critical-section placement in ChannelService and break plan KTD3.

import type { RpcRouter } from '../RpcRouter';
import type { DaemonClient } from '../../DaemonClient';

export function registerA2aChannelRpc(router: RpcRouter, getDaemonClient: () => DaemonClient | null): void {
  // Read-only — capability 'a2a.channel.read'
  router.register('a2a.channel.list', (params) => {
    const dc = getDaemonClient();
    if (!dc) throw new Error('DaemonClient not connected');
    return dc.rpc('channel.list', params ?? {});
  });
  router.register('a2a.channel.get', (params) => {
    const dc = getDaemonClient();
    if (!dc) throw new Error('DaemonClient not connected');
    return dc.rpc('channel.get', params ?? {});
  });
  router.register('a2a.channel.getMessages', (params) => {
    const dc = getDaemonClient();
    if (!dc) throw new Error('DaemonClient not connected');
    return dc.rpc('channel.getMessages', params ?? {});
  });
  router.register('a2a.channel.getMembers', (params) => {
    const dc = getDaemonClient();
    if (!dc) throw new Error('DaemonClient not connected');
    return dc.rpc('channel.getMembers', params ?? {});
  });

  // Mutating — capability 'a2a.channel.send'
  router.register('a2a.channel.create', (params) => {
    const dc = getDaemonClient();
    if (!dc) throw new Error('DaemonClient not connected');
    return dc.rpc('channel.create', params ?? {});
  });
  router.register('a2a.channel.archive', (params) => {
    const dc = getDaemonClient();
    if (!dc) throw new Error('DaemonClient not connected');
    return dc.rpc('channel.archive', params ?? {});
  });
  router.register('a2a.channel.join', (params) => {
    const dc = getDaemonClient();
    if (!dc) throw new Error('DaemonClient not connected');
    return dc.rpc('channel.join', params ?? {});
  });
  router.register('a2a.channel.leave', (params) => {
    const dc = getDaemonClient();
    if (!dc) throw new Error('DaemonClient not connected');
    return dc.rpc('channel.leave', params ?? {});
  });
  router.register('a2a.channel.post', (params) => {
    const dc = getDaemonClient();
    if (!dc) throw new Error('DaemonClient not connected');
    return dc.rpc('channel.post', params ?? {});
  });
}
