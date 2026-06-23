// ─── Renderer-side channel catalog hydration ─────────────────────────────
//
// The renderer's channel mirror (`channelsSlice.channels` / `channelMembers`)
// was previously populated ONLY by local optimistic creates and message
// events — there was no path that read the daemon's authoritative catalog.
// That left the sidebar empty on a fresh launch even when the daemon had
// persisted channels on disk, and made channels created by OTHER clients
// (MCP agents via `channel_create`) invisible to the human in the UI. This
// hook closes that gap: it calls `a2a.channel.list` + `a2a.channel.getMembers`
// and dispatches the result into `setChannels`.
//
// Identity: channels are decoupled from in-app Company mode. The "self"
// workspace is the Company CEO workspace when Company mode is active, else
// the active workspace — so channels hydrate (and stay visible) without a
// company. Reads ride the `rpc` bridge (the pipe RpcRouter); the main-side
// `a2a.channel.*` read handler accepts a caller-supplied workspace for a
// no-senderPtyId renderer caller (process-boundary trust — see the header of
// `src/main/pipe/handlers/a2a.channel.rpc.ts`). Only the unforgeable D5 pin
// (senderPtyId resolution on the pipe/MCP path) gates writes, and this hook
// performs no writes.
//
// Triggers (all best-effort, idempotent — `setChannels` replaces the catalog
// wholesale while preserving per-channel message caches):
//   1. mount — covers the reload case where the daemon was already connected.
//   2. `daemon.whenReady()` — covers the cold-boot case where the daemon
//      finishes connecting shortly after the renderer mounts.
//   3. `daemon.onConnected` — covers respawn/reconnect after the first
//      hydration already ran.
//
// Scope note (FIX-MULTI-WS): the daemon's `list(verifiedWorkspaceId)` returns
// every PUBLIC channel plus PRIVATE channels the passed workspace is a member
// of. With a single self-workspace, private channels owned by a different
// workspace stay hidden until the multi-workspace identity follow-up lands.
// Public channels (the create modal's default) always hydrate.
//
// The core list→getMembers→setChannels logic is extracted into the pure
// `hydrateChannelsCatalog` (mirroring the `createLateReconcileOnConnect` /
// `reconcileWithReQuery` extract-for-test pattern) so it can be unit-tested
// with a mock bridge without rendering a React tree.

import { useEffect } from 'react';
import { useStore } from '../stores';
import type { Channel, ChannelMember } from '../../shared/channels';

/** Dependencies for the pure hydration routine. */
export interface ChannelHydrationDeps {
  /** Read RPC bridge (`__wmuxChannelsRpc.rpc`). Returns the daemon's raw
   *  `{ ok, ... }` envelope (see preload `rpc.invoke`). */
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** The renderer's resolved "self" workspace. Empty string ⇒ no identity. */
  workspaceId: string;
  /** Catalog setter (`channelsSlice.setChannels`). */
  setChannels: (channels: Channel[], members: Record<string, ChannelMember[]>) => void;
  /** Liveness guard. When it returns false the routine bails before
   *  dispatching (the hook passes `() => !disposed`). Defaults to always-live
   *  for tests. */
  isCurrent?: () => boolean;
}

function isOkObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && (v as { ok?: unknown }).ok === true;
}

/**
 * The renderer `rpc` bridge (electronAPI.rpc.invoke → pipe RpcRouter) wraps
 * the daemon reply in the RPC protocol envelope `{ id, ok, result }`, where
 * `result` is the daemon's own `{ ok, channels }` / `{ ok, members }` reply.
 * (Confirmed via live CDP; PluginFrame's events.poll loop reads `resp.result`
 * the same way.) Peel the transport envelope so callers see the daemon reply.
 * Falls back to the value itself if it's already unwrapped (defensive).
 */
function unwrapRpc(res: unknown): unknown {
  if (
    res !== null &&
    typeof res === 'object' &&
    'result' in res &&
    (res as { result?: unknown }).result !== null &&
    typeof (res as { result?: unknown }).result === 'object'
  ) {
    return (res as { result: unknown }).result;
  }
  return res;
}

/**
 * Pure hydration: `a2a.channel.list` → per-channel `a2a.channel.getMembers`
 * → `setChannels`. Best-effort throughout — any RPC error, non-ok envelope,
 * malformed shape, missing identity, or a disposed guard short-circuits to a
 * no-op (no partial dispatch). Returns the number of channels hydrated (0 on
 * any early bail) so callers/tests can assert progress.
 */
export async function hydrateChannelsCatalog(deps: ChannelHydrationDeps): Promise<number> {
  const { rpc, workspaceId, setChannels } = deps;
  const isCurrent = deps.isCurrent ?? (() => true);
  if (!workspaceId) return 0;

  let listRes: unknown;
  try {
    listRes = await rpc('a2a.channel.list', { workspaceId, verifiedWorkspaceId: workspaceId });
  } catch {
    // Daemon not connected yet / transient pipe failure — a later trigger retries.
    return 0;
  }
  if (!isCurrent()) return 0;
  const listEnv = unwrapRpc(listRes);
  if (!isOkObject(listEnv)) return 0;
  const rawChannels = (listEnv as { channels?: unknown }).channels;
  if (!Array.isArray(rawChannels)) return 0;
  const channels = rawChannels as Channel[];

  // Fetch members per channel in parallel (best-effort — a channel whose
  // getMembers fails hydrates with no member entry and is reconciled on the
  // next trigger).
  const members: Record<string, ChannelMember[]> = {};
  await Promise.all(
    channels.map(async (ch) => {
      try {
        const mRes = await rpc('a2a.channel.getMembers', {
          channelId: ch.id,
          workspaceId,
          verifiedWorkspaceId: workspaceId,
        });
        const mEnv = unwrapRpc(mRes);
        if (isOkObject(mEnv)) {
          const raw = (mEnv as { members?: unknown }).members;
          if (Array.isArray(raw)) members[ch.id] = raw as ChannelMember[];
        }
      } catch {
        /* best-effort per channel */
      }
    }),
  );
  if (!isCurrent()) return 0;
  setChannels(channels, members);
  return channels.length;
}

/** Single-method facade over the channels bridge `useRpcBridge` installs.
 *  Only the read `rpc` method is needed here. */
interface ChannelsRpcBridge {
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}

interface ChannelsBridgeWindow {
  __wmuxChannelsRpc?: ChannelsRpcBridge;
}

function readChannelsRpc(): ChannelsRpcBridge | undefined {
  return (window as unknown as ChannelsBridgeWindow).__wmuxChannelsRpc;
}

/** Resolve the renderer's "self" workspace for channel reads. Prefer the
 *  in-app Company CEO workspace when Company mode is active; otherwise fall
 *  back to the active workspace so channels work without a company. Empty
 *  string means "no resolvable identity yet" — the caller skips the cycle. */
function resolveSelfWorkspaceId(): string {
  const s = useStore.getState();
  return s.company?.ceoWorkspaceId ?? s.activeWorkspaceId ?? '';
}

/**
 * Mount once in AppLayout (parallel to `useChannelsEventSubscription`).
 * Owns nothing in React state — it dispatches into the store and tears down
 * its daemon listener on unmount.
 */
export function useChannelsHydration(): void {
  useEffect(() => {
    let disposed = false;

    const hydrate = (): void => {
      const bridge = readChannelsRpc();
      if (!bridge) return; // useRpcBridge installs this first (hook order); a miss self-heals on the next trigger.
      void hydrateChannelsCatalog({
        rpc: bridge.rpc,
        workspaceId: resolveSelfWorkspaceId(),
        setChannels: useStore.getState().setChannels,
        isCurrent: () => !disposed,
      });
    };

    hydrate();
    void window.electronAPI.daemon.whenReady().then(() => {
      if (!disposed) hydrate();
    });
    const offConnected = window.electronAPI.daemon.onConnected(() => {
      if (!disposed) hydrate();
    });

    return () => {
      disposed = true;
      offConnected();
    };
  }, []);
}
