// Chat View subscription bridge (plan PR-5).
//
// Owns the `chat.*` preload channel for ONE pane: probes status, subscribes,
// seeds the store from a snapshot, applies live appends, replays on
// `daemon:connected`, and ages out unmatched composer echoes.
//
// FEATURE-DETECTED throughout. The preload `chat` surface lands in PR-4; until
// then (and on any older preload bundle a packaged app may load) every call
// site is optional-chained and the hook degrades to a no-op instead of
// throwing at mount. This mirrors useDeckStream's `if (!api) return` guard.

import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../stores';
import type {
  TranscriptAppendData,
  TranscriptPage,
  TranscriptStatus,
} from '../../shared/transcript/turnEvents';

/**
 * The shape PR-4's preload will expose. Declared locally (not in
 * src/shared/electron.d.ts) so this PR does not touch the preload contract the
 * integration wave owns; the cast below is the only coupling point.
 */
export interface ChatBridge {
  status?: (ptyId: string) => Promise<TranscriptStatus | null | undefined>;
  snapshot?: (ptyId: string, before?: number) => Promise<TranscriptPage | null>;
  subscribe?: (ptyId: string) => Promise<unknown>;
  unsubscribe?: (ptyId: string) => Promise<unknown>;
  onAppend?: (cb: (ptyId: string, data: TranscriptAppendData) => void) => () => void;
}

/** How often unmatched pending echoes are aged out (TTL is 60s in the slice). */
const PENDING_SWEEP_MS = 15_000;

export function getChatBridge(): ChatBridge | undefined {
  const api = (globalThis as { window?: { electronAPI?: { chat?: ChatBridge } } }).window
    ?.electronAPI;
  return api?.chat;
}

export interface ChatProjectionControls {
  /** Page one chunk further back from the current head offset. */
  loadEarlier: () => Promise<void>;
  /** Re-seed from a fresh snapshot (used after a seq gap). */
  resnapshot: () => Promise<void>;
}

/**
 * @param ptyId  the pane whose transcript is projected
 * @param enabled  false while the surface is rendering the terminal — an
 *                 unopened Chat surface must cost zero watchers in the daemon
 */
export function useChatProjection(ptyId: string, enabled: boolean): ChatProjectionControls {
  // Guards every async continuation: a pane can be closed (or the surface
  // toggled back) while a status/snapshot promise is still in flight.
  const liveRef = useRef(true);

  const seed = useCallback(async (id: string): Promise<void> => {
    const chat = getChatBridge();
    if (!chat) return;
    const status = await chat.status?.(id).catch(() => undefined);
    if (!liveRef.current) return;
    if (status) useStore.getState().setChatStatus(id, status);
    // No positive availability signal (probe failed, or an older preload that
    // has no `status` at all) → never subscribe blind. A watcher the daemon
    // holds for a pane that cannot project is pure leak.
    if (!status?.available) return;
    await chat.subscribe?.(id).catch(() => undefined);
    if (!liveRef.current) return;
    const page = await chat.snapshot?.(id).catch(() => null);
    if (!liveRef.current || !page) return;
    // A snapshot is authoritative for the whole visible window, so it lands as
    // a reset — not an append onto whatever the store happened to hold.
    useStore.getState().applyChatAppend(id, {
      seq: 0,
      reset: true,
      events: page.events,
      cursor: page.cursor,
    });
  }, []);

  useEffect(() => {
    liveRef.current = true;
    if (!enabled || !ptyId) return;

    const chat = getChatBridge();
    if (!chat) return;

    void seed(ptyId);

    const offAppend = chat.onAppend?.((incomingPtyId, data) => {
      if (incomingPtyId !== ptyId) return;
      useStore.getState().applyChatAppend(ptyId, data);
    });

    // A daemon respawn loses the subscription and every append that landed
    // while the pipe was down — re-probe and re-seed, same contract as
    // useChannelsHydration's onConnected path.
    const daemon = (
      globalThis as { window?: { electronAPI?: { daemon?: { onConnected?: (cb: () => void) => () => void } } } }
    ).window?.electronAPI?.daemon;
    const offConnected = daemon?.onConnected?.(() => {
      if (liveRef.current) void seed(ptyId);
    });

    const sweep = setInterval(() => {
      useStore.getState().reconcileChatPending(ptyId);
    }, PENDING_SWEEP_MS);

    return () => {
      liveRef.current = false;
      clearInterval(sweep);
      offAppend?.();
      offConnected?.();
      void chat.unsubscribe?.(ptyId)?.catch?.(() => undefined);
    };
  }, [ptyId, enabled, seed]);

  const loadEarlier = useCallback(async (): Promise<void> => {
    const chat = getChatBridge();
    if (!chat || !ptyId) return;
    const head = useStore.getState().chatCursor[ptyId]?.headOffset;
    if (head === undefined || head <= 0) return; // nothing older to fetch
    const page = await chat.snapshot?.(ptyId, head).catch(() => null);
    if (!liveRef.current || !page) return;
    useStore.getState().prependChatPage(ptyId, page);
  }, [ptyId]);

  const resnapshot = useCallback(async (): Promise<void> => {
    if (!ptyId) return;
    await seed(ptyId);
  }, [ptyId, seed]);

  return { loadEarlier, resnapshot };
}
