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
// workspace is the reserved unified human seat (ws-human, P5) — so channels
// hydrate (and stay visible) independent of which workspace is active. Reads
// ride the `rpc` bridge (the pipe RpcRouter); the main-side
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
// Scope note: the daemon's `list(verifiedWorkspaceId)` returns every PUBLIC
// channel plus PRIVATE channels the passed workspace is a member of. Since the
// self-workspace is now the unified ws-human seat (P5), every private channel
// the human joined hydrates; public channels (the create modal's default)
// always hydrate.
//
// The core list→getMembers→setChannels logic is extracted into the pure
// `hydrateChannelsCatalog` (mirroring the `createLateReconcileOnConnect` /
// `reconcileWithReQuery` extract-for-test pattern) so it can be unit-tested
// with a mock bridge without rendering a React tree.

import { useEffect } from 'react';
import { useStore } from '../stores';
import type { Channel, ChannelMember, ChannelMessage } from '../../shared/channels';
import { HUMAN_WORKSPACE_ID, CHANNELS_EPOCH } from '../../shared/channels';
import { unwrapRpc } from '../utils/unwrapRpc';

/** Dependencies for the pure hydration routine. */
export interface ChannelHydrationDeps {
  /** Read RPC bridge (`__wmuxChannelsRpc.rpc`). Returns the daemon's raw
   *  `{ ok, ... }` envelope (see preload `rpc.invoke`). */
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** The renderer's resolved "self" workspace. Empty string ⇒ no identity. */
  workspaceId: string;
  /** Catalog setter (`channelsSlice.setChannels`). */
  setChannels: (channels: Channel[], members: Record<string, ChannelMember[]>) => void;
  /** Ship review C1 — stale-daemon signal. Called with `true` when the daemon's
   *  `a2a.channel.list` reply carries a missing/lower `channelsEpoch` (a
   *  long-lived pre-P5 daemon survived the app upgrade: the human's channel
   *  identity can't resolve until it restarts), `false` when the epoch is
   *  current. Optional so tests/legacy callers are untouched. */
  setDaemonStale?: (stale: boolean) => void;
  /** Liveness guard. When it returns false the routine bails before
   *  dispatching (the hook passes `() => !disposed`). Defaults to always-live
   *  for tests. */
  isCurrent?: () => boolean;
}

function isOkObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && (v as { ok?: unknown }).ok === true;
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

  // Ship review C1 — stale-daemon detection. A CURRENT daemon stamps
  // `channelsEpoch >= CHANNELS_EPOCH` on the list reply; a pre-P5 daemon omits
  // the field. Signal BOTH directions so the banner self-clears once the daemon
  // restarts (this routine re-runs on every reconnect).
  const rawEpoch = (listEnv as { channelsEpoch?: unknown }).channelsEpoch;
  const epoch = typeof rawEpoch === 'number' && Number.isFinite(rawEpoch) ? rawEpoch : 0;
  deps.setDaemonStale?.(epoch < CHANNELS_EPOCH);

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

/** Recent-history load limit (P0). Channels have NO message cap (the daemon's
 *  `ChannelService.post` pushes unbounded; only the idempotency map is
 *  LRU-capped) and NO expiry (the 7-day TTL reaps only zero-member channels),
 *  so a full `getMessages` would drag the entire unbounded history on open. We
 *  load the most recent N by flooring `sinceSeq` at `nextSeq - N`; scroll-up
 *  "load older" is deferred (P0.5). */
export const CHANNEL_HISTORY_LOAD_LIMIT = 200;

/** Dependencies for the pure channel-history load routine. */
export interface ChannelHistoryDeps {
  /** Read RPC bridge (`__wmuxChannelsRpc.rpc`). */
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  channelId: string;
  /** The channel's current `nextSeq` (from the hydrated catalog). Floors
   *  `sinceSeq` so we only fetch the most recent `limit` messages. */
  nextSeq: number;
  /** Renderer "self" workspace (Company CEO ws, else active ws). */
  workspaceId: string;
  /** Store action that merges the fetched rows (`channelsSlice.hydrateChannelMessages`). */
  apply: (channelId: string, messages: ChannelMessage[]) => void;
  /** Max messages to load. Defaults to `CHANNEL_HISTORY_LOAD_LIMIT`. */
  limit?: number;
  /** Liveness guard (the caller passes `() => !disposed`). */
  isCurrent?: () => boolean;
}

/**
 * Load a channel's RECENT message history into the store on channel open (P0).
 * `a2a.channel.getMessages` with `sinceSeq = max(0, nextSeq - limit)` →
 * `hydrateChannelMessages`. Best-effort: any RPC error / non-ok envelope /
 * malformed shape / missing identity / disposed guard short-circuits to a
 * no-op. Returns the number of messages applied (0 on any early bail).
 *
 * Identity alignment (critical): `workspaceId` is stamped as BOTH the read
 * scope and `verifiedWorkspaceId`, and MUST be the same workspace the
 * ChannelView uses to pick its `viewer` (`company?.ceoWorkspaceId ??
 * activeWorkspaceId`). Otherwise the daemon's per-member `historyFromSeq`
 * floor and the view's visibility filter disagree and silently drop rows.
 */
export async function loadChannelHistory(deps: ChannelHistoryDeps): Promise<number> {
  const { rpc, channelId, nextSeq, workspaceId, apply } = deps;
  const isCurrent = deps.isCurrent ?? (() => true);
  const limit = deps.limit ?? CHANNEL_HISTORY_LOAD_LIMIT;
  if (!workspaceId || !channelId) return 0;
  const sinceSeq = Math.max(0, nextSeq - limit);
  let res: unknown;
  try {
    res = await rpc('a2a.channel.getMessages', {
      channelId,
      sinceSeq,
      workspaceId,
      verifiedWorkspaceId: workspaceId,
    });
  } catch {
    // Daemon not connected / transient pipe failure — a later open or resync retries.
    return 0;
  }
  if (!isCurrent()) return 0;
  const env = unwrapRpc(res);
  if (!isOkObject(env)) return 0;
  const raw = (env as { messages?: unknown }).messages;
  if (!Array.isArray(raw)) return 0;
  const messages = raw as ChannelMessage[];
  apply(channelId, messages);
  return messages.length;
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


/**
 * Mount once in AppLayout (parallel to `useChannelsEventSubscription`).
 * Owns nothing in React state — it dispatches into the store and tears down
 * its daemon listener on unmount.
 */
export function useChannelsHydration(): void {
  // P5 (unified human identity): the catalog hydrates as the reserved human
  // workspace — every public channel plus every private channel the HUMAN is
  // a member of, independent of which workspace is active. This also removes
  // the old boot race (identity used to wait on activeWorkspaceId).
  const workspaceId = HUMAN_WORKSPACE_ID;
  useEffect(() => {
    let disposed = false;

    const hydrate = (): void => {
      const bridge = readChannelsRpc();
      if (!bridge) return; // useRpcBridge installs this first (hook order); a miss self-heals on the next trigger.
      if (!workspaceId) return; // identity not resolved yet; the effect re-runs when it is.
      void hydrateChannelsCatalog({
        rpc: bridge.rpc,
        workspaceId,
        setChannels: useStore.getState().setChannels,
        setDaemonStale: useStore.getState().setChannelsDaemonStale,
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
  }, [workspaceId]);
}
