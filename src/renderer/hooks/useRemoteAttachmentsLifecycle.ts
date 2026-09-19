import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../stores';
import { useWindowDisplayed } from './useWindowDisplayed';
import { collectRemoteSurfaceWorkspaces } from '../../shared/paneUtils';
import { remoteAttachmentKey, REMOTE_POLL_INTERVAL_MS } from '../../shared/remoteHosts';
import type {
  RemoteAttachmentDescriptor,
  RemotePaneSummary,
  RemoteWorkspaceSummary,
} from '../../shared/remoteHosts';
import type { Workspace } from '../../shared/types';

// ─── Remote attachment lifecycle ─────────────────────────────────────────────
//
// The SINGLE owner of two things AppLayout has no other place for:
//
//  ① RESTORE. remoteWorkspacesSlice is memory-only, so a reload (Cmd+R) or an
//     app restart recreates it empty. Main persists the descriptors; this hook
//     replays them on boot, re-fetching each host's CURRENT panes rather than
//     trusting anything on disk. A host that cannot be reached, or a workspace
//     that no longer exists there, is restored in a `stale` state instead of
//     being dropped — a sleeping laptop must not delete the user's attachment.
//     Every row appears IMMEDIATELY (stale), before any host is contacted, and
//     the fetch only fills panes in: an unreachable host costs a full request
//     timeout, and the sidebar must not sit empty for that long.
//
//  ② PANE MEMBERSHIP. The remote wire carries no topology events, so pane
//     open/close on the remote never reaches us directly. A pane CLOSE does
//     surface indirectly (its PTY dies → SSE exit → REMOTE_PANE_EXIT), which
//     is used here as a refresh trigger; a pane OPEN produces nothing at all,
//     which is what the 10s poll is for. Both go through the same
//     refetch-and-diff, and both are debounced/serialised so an exit burst
//     costs one round of requests. No daemon-side change is involved, so this
//     keeps working against older remote builds (version skew is real here).
//
//     THE POLL'S CADENCE COMES FROM MAIN (#1391), not from a renderer timer.
//     Chromium throttles timers in a hidden or occluded renderer, and the 10s
//     interval was measured stretching to 17s and then 60s with the window in
//     the background — a user watching a remote agent from a background window
//     read minute-old status. Main's timers are never throttled, so main owns
//     the tick and the renderer owns everything the tick means:
//
//        main                                     renderer
//        ────                                     ────────
//        REMOTE_POLL_SUBSCRIBE  ◀──── while ≥1 workspace is attached
//        setInterval(10s) ─── TICK ────▶ refresh()  ─┐
//                                                    ├─ host set, backoff,
//        (no subscriber ⇒ no timer at all)           │  serialisation: all
//        REMOTE_POLL_UNSUBSCRIBE ◀── last detach     ┘  unchanged, all here
//
//     The tick carries no payload. `visibilitychange`→visible and window
//     `focus` additionally refresh straight away, so the first frame after
//     coming back is fresh rather than up to one tick old.
//
//  ③ SURFACE ROWS (#1329). A remote-terminal SURFACE — "New remote pane",
//     "Split right|down — remote" — is not an attachment: it lives in a local
//     pane tree and nothing ever put it in `remoteWorkspaces`. But ① and ②
//     above derive the polled host set from exactly that array, so such a pane
//     had no liveness feed at all, and both readers of the feed (the sidebar's
//     WorkspaceAgentRoster and `pane.list`'s `agents:` builder) reported no
//     agent no matter what was really running on the host (#1322).
//
//     Fixed by giving each such surface an EPHEMERAL row (invisible,
//     unpersisted — see AttachedRemoteWorkspace.ephemeral) and RECONCILING
//     that set against the surfaces that actually exist:
//
//        surfaces in state.workspaces          remoteWorkspaces
//        ────────────────────────────          ────────────────────────
//        remote-terminal + hostId
//          + remoteWorkspaceId   ──track──▶    { …, ephemeral: true }
//                                                     │
//        (tab closed / Ctrl+W / pane            prune │ key no longer
//         teardown / workspace delete /        ◀──────┘ produced by any
//         split rolled back / app quit)                 surface
//
//     Derivation is the whole point. The nine explicit teardown call sites
//     that destroy a remote session would each have needed a matching detach,
//     and any close path nobody enumerated would still have leaked a row.
//     Here every one of them ends the same way — the surface is gone from
//     `state.workspaces` — so the next reconcile drops the row and, with it,
//     the poll. Two panes on one host share one row, so there is never a
//     second poller for the same workspace.
//
// Every host in a round is queried in PARALLEL and every response is treated
// as untrusted: one dead or misbehaving machine must not delay, or abort, the
// round for the healthy ones.
//
// Actions are read via useStore.getState() so the effect deps stay minimal —
// mirrors useRemoteInboxBridge.

/** An exit burst (a whole remote workspace being closed) must collapse into
 *  one refetch. */
const REFRESH_DEBOUNCE_MS = 400;

/** Coming back to the window refreshes immediately, but the three triggers that
 *  mean "the user is looking again" overlap (a single alt-tab can fire two of
 *  them), and a user flicking between windows would otherwise turn every flick
 *  into a round of requests against every attached host. One round per this
 *  many ms is enough to make the first frame fresh. */
const FOREGROUND_REFRESH_MIN_GAP_MS = 2_000;

/** How long a subscribed renderer tolerates silence from main's tick before it
 *  falls back to its own interval (#1391). Three intervals, so an ordinary late
 *  tick is never mistaken for a dead subscription. */
const TICK_WATCHDOG_MS = REMOTE_POLL_INTERVAL_MS * 3;

/** A permanently unreachable host would otherwise be retried at full poll rate
 *  forever. Consecutive failures back the host off exponentially from one poll
 *  interval up to this ceiling; the first success clears it. */
const BACKOFF_MAX_MS = 5 * 60_000;

/** What a host answered in one round. Never a rejection: the body comes off
 *  another machine, and letting it throw would skip every host queued behind
 *  it — during boot restore, that means descriptors that never restore at all. */
type HostResult =
  | { ok: true; workspaces: RemoteWorkspaceSummary[] }
  | { ok: false };

interface BackoffEntry {
  failures: number;
  nextAttemptAt: number;
}

type RemoteApi = NonNullable<NonNullable<typeof window.electronAPI>['remote']>;

async function fetchHost(remote: RemoteApi, hostId: string): Promise<HostResult> {
  let res: Awaited<ReturnType<RemoteApi['workspacesList']>>;
  try {
    res = await remote.workspacesList(hostId);
  } catch {
    return { ok: false };
  }
  if (!res?.ok) return { ok: false };
  // Defensive even though RemoteHostClient normalises: this is a trust
  // boundary, and `.find()` on a non-array is a thrown TypeError.
  return { ok: true, workspaces: Array.isArray(res.workspaces) ? res.workspaces : [] };
}

/** Applies one host's answer to every attached workspace on it. Reads the
 *  store fresh: an attach/detach may have landed while the request was in
 *  flight, and both actions no-op on a key that is no longer there. */
function applyHostResult(hostId: string, result: HostResult): void {
  const attached = useStore.getState().remoteWorkspaces.filter((w) => w.hostId === hostId);
  for (const w of attached) {
    const found = result.ok
      ? result.workspaces.find((ws) => ws?.id === w.workspaceId)
      : undefined;
    // No workspace, or a malformed one — keep the row, flag it, and let the
    // user decide. Dropping it would be silent data loss.
    if (!found || !Array.isArray(found.panes)) {
      useStore.getState().setRemoteWorkspaceStale(w.key, true);
      continue;
    }
    const panes: RemotePaneSummary[] = found.panes;
    useStore.getState().setRemoteWorkspacePanes(
      w.key,
      panes,
      typeof found.name === 'string' ? found.name : undefined,
    );
  }
}

function noteHostResult(backoff: Map<string, BackoffEntry>, hostId: string, ok: boolean): void {
  if (ok) {
    backoff.delete(hostId);
    return;
  }
  const failures = (backoff.get(hostId)?.failures ?? 0) + 1;
  const delay = Math.min(REMOTE_POLL_INTERVAL_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
  backoff.set(hostId, { failures, nextAttemptAt: Date.now() + delay });
}

/**
 * #1329 — every (host, remote workspace) a remote-terminal surface anywhere in
 * the local workspaces needs a liveness feed for, plus a stable string key for
 * that set.
 *
 * MEMOISED ON THE `workspaces` ARRAY IDENTITY, deliberately. A zustand
 * selector re-runs on EVERY store update, and the busiest of them (terminal
 * output, agent status, hook events) live in other slices and leave
 * `workspaces` untouched — so without this cache a single noisy pane would
 * re-walk every pane tree in the app dozens of times a second. Writes that DO
 * touch `workspaces` (a shell's OSC title, say) still pay the walk; the cache
 * removes the common case, not every case.
 *
 * Sound because every write goes through immer, which replaces the whole path
 * including the top-level array — a content change can never reuse an
 * identity. Writing a module slot from inside a selector is a render-phase
 * write, but an idempotent one: concurrent renders can thrash the single slot,
 * which costs a recompute and can never produce a wrong answer.
 */
let surfaceWorkspacesCache:
  | { source: readonly Workspace[]; keys: ReadonlyMap<string, { hostId: string; workspaceId: string }>; signature: string }
  | null = null;

/** The result is CACHED and shared — treat `keys` as read-only, or the next
 *  selector call gets a corrupted answer. */
function remoteSurfaceWorkspaces(workspaces: readonly Workspace[]): {
  keys: ReadonlyMap<string, { hostId: string; workspaceId: string }>;
  signature: string;
} {
  if (surfaceWorkspacesCache?.source === workspaces) return surfaceWorkspacesCache;
  const keys = new Map<string, { hostId: string; workspaceId: string }>();
  for (const ws of workspaces) {
    for (const ref of collectRemoteSurfaceWorkspaces(ws)) {
      keys.set(remoteAttachmentKey(ref.hostId, ref.workspaceId), ref);
    }
  }
  const signature = [...keys.keys()].sort().join('\n');
  surfaceWorkspacesCache = { source: workspaces, keys, signature };
  return surfaceWorkspacesCache;
}

export function useRemoteAttachmentsLifecycle(): void {
  // A refresh round is serialised: while one is in flight, further triggers
  // set `pending` and are coalesced into a single follow-up round.
  const inFlight = useRef(false);
  const pending = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmounted = useRef(false);
  /** hostId → when the poll may talk to it again. Entries for hosts nothing is
   *  attached to any more are dropped each round, so detach + re-attach starts
   *  from a clean slate. */
  const backoff = useRef(new Map<string, BackoffEntry>());
  /** When the foreground catch-up last actually ran (#1391) — its own rate
   *  limit. Not a substitute for inFlight/pending: those serialise rounds, this
   *  one decides whether to ask for another at all. */
  const lastForegroundRefreshAt = useRef(0);

  // Stable for the renderer's lifetime — it closes over refs only, so the
  // effects below can depend on it without ever re-subscribing. NEVER rejects:
  // each host is contained below, so no caller needs a rejection handler.
  const refresh = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    const remote = window.electronAPI?.remote;
    if (!remote) return;
    inFlight.current = true;
    try {
      // One workspacesList per HOST, not per attached workspace — several
      // mirrors of the same machine share a single round trip.
      const hostIds = [...new Set(useStore.getState().remoteWorkspaces.map((w) => w.hostId))];
      for (const hostId of [...backoff.current.keys()]) {
        if (!hostIds.includes(hostId)) backoff.current.delete(hostId);
      }
      const now = Date.now();
      const due = hostIds.filter((h) => (backoff.current.get(h)?.nextAttemptAt ?? 0) <= now);

      // PARALLEL: a host that is asleep burns the full request timeout, and
      // serialising would make every healthy host wait behind it.
      await Promise.all(due.map(async (hostId) => {
        try {
          const result = await fetchHost(remote, hostId);
          if (unmounted.current) return;
          noteHostResult(backoff.current, hostId, result.ok);
          applyHostResult(hostId, result);
        } catch {
          // One misbehaving host must never abort the round: the hosts queued
          // behind it would be skipped, and on boot their descriptors would
          // never be filled in at all.
        }
      }));
    } finally {
      inFlight.current = false;
      if (pending.current && !unmounted.current) {
        pending.current = false;
        void refresh();
      }
    }
  }, []);

  /**
   * A HEARTBEAT refresh (#1391). Dropped outright while a round is in flight,
   * where `refresh` would coalesce it into a queued follow-up.
   *
   * The difference matters because one round against an unreachable host can
   * take 20s — a `/api/config` probe timeout plus a `/api/workspaces` timeout —
   * while ticks keep arriving every 10s. Queueing them would make the `finally`
   * fire the next round the instant the last one ends, turning a backgrounded
   * window with one sleeping host into a continuous request loop. Backoff does
   * not save us: it only engages once a round COMPLETES and fails.
   *
   * An exit event or a new surface still queues, and should: those carry
   * information, and a tick carries none — the next one is 10s away.
   */
  const refreshTick = useCallback((): void => {
    if (inFlight.current) return;
    void refresh();
  }, [refresh]);

  /**
   * "The user is looking at this window again" (#1391). Refreshes now instead of
   * waiting out a tick, and lifts the backoff DEADLINE first.
   *
   * Lifting the deadline is the whole point, not a detail. The case this exists
   * for is a window left in the background while a laptop slept: by the time the
   * user comes back the host is backed off up to BACKOFF_MAX_MS, so a plain
   * refresh would filter it out of `due` and make no request at all — the rows
   * would stay stale for another five minutes with the user staring at them.
   * Coming back to the window is the user saying to try it now, exactly like
   * opening a pane on a host is in the reconcile below.
   *
   * THREE things keep that from becoming a request storm against a dead host:
   *
   *   · `nextAttemptAt`, not the whole entry. Dropping the entry would reset
   *     `failures` to 0, so the exponential ladder could never climb past one
   *     step while the user keeps switching windows — #1385's backoff, disarmed
   *     by a feature that is only supposed to skip one wait.
   *   · the in-flight drop, for the reason spelled out on `refreshTick`. A round
   *     against a sleeping host runs 20s while focus events keep arriving; if
   *     these queued, the `finally` would start the next round the instant the
   *     last one ended. The heartbeat path is guarded and this one has the same
   *     exposure — `focus` is bound raw, so alt-tab, DevTools closing, a tray
   *     show and a notification click all land here.
   *   · its OWN clock. Deliberately not `refresh`'s: a tick round in which every
   *     host is backed off issues no request at all, and letting that count as
   *     "just refreshed" would swallow the next return to the window — which is
   *     precisely the moment this function exists to serve.
   */
  const refreshForeground = useCallback((): void => {
    if (inFlight.current) return;
    if (Date.now() - lastForegroundRefreshAt.current < FOREGROUND_REFRESH_MIN_GAP_MS) return;
    lastForegroundRefreshAt.current = Date.now();
    for (const entry of backoff.current.values()) entry.nextAttemptAt = 0;
    void refresh();
  }, [refresh]);

  // ① Boot restore — once per renderer lifetime.
  useEffect(() => {
    unmounted.current = false;
    const remote = window.electronAPI?.remote;
    if (!remote) return;
    let cancelled = false;

    void (async () => {
      let descriptors: RemoteAttachmentDescriptor[];
      try {
        descriptors = await remote.attachmentsList();
      } catch {
        return; // older preload bundle / main not ready — nothing to restore
      }
      if (cancelled || !Array.isArray(descriptors) || descriptors.length === 0) return;

      // Rows first, panes second. Restore is additive, so a workspace the user
      // attached (or detached) while attachmentsList was in flight wins.
      for (const d of descriptors) {
        useStore.getState().restoreRemoteWorkspace({
          key: d.key,
          hostId: d.hostId,
          hostLabel: d.hostLabel,
          workspaceId: d.workspaceId,
          name: d.name,
          // #1086 — local aliases survive the reload with the descriptor.
          ...(d.label ? { label: d.label } : {}),
          ...(d.color ? { color: d.color } : {}),
          // Panes ALWAYS come from the live fetch below, never from disk.
          panes: [],
          stale: true,
        });
      }
      if (cancelled) return;
      // Exactly the same refetch-and-diff the poll uses — a host that answers
      // clears `stale` and fills the panes in, one that does not stays stale.
      await refresh();
    })();

    return () => {
      cancelled = true;
      unmounted.current = true;
    };
  }, [refresh]);

  // ②-a Exit events → debounced refetch. Subscribed once; an exit carries only
  //     an attachId, so the refresh covers every attached host rather than
  //     trying to map it back to one workspace.
  useEffect(() => {
    const remote = window.electronAPI?.remote;
    if (!remote) return;
    const off = remote.onPaneExit(() => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = null;
        void refresh();
      }, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
  }, [refresh]);

  // ③ Surface rows — reconcile the ephemeral set against the remote-terminal
  //   surfaces that exist. Subscribed to a SIGNATURE, not to either list, so
  //   this effect fires when the two diverge and at no other time; a pane
  //   merely printing output, or a poll round rewriting pane snapshots, never
  //   re-runs it.
  //
  //   The signature carries BOTH terms on purpose. The surface set alone would
  //   miss the case where the rows go away under a pane that is still open:
  //   the user attaches the same host workspace from the sidebar (which
  //   PROMOTES the ephemeral row to a real one) and then detaches it, or
  //   removes the host entirely — `handleRemoveHost` drops every row it has.
  //   The pane's surfaces never changed, so a surface-only signature would sit
  //   still and that pane would stay agent-less for the rest of the session:
  //   #1322, silently restored. Naming the missing keys makes the effect
  //   re-mint them instead. It converges: once tracked, they are no longer
  //   missing, and the signature settles.
  const reconcileSignature = useStore((s) => {
    const want = remoteSurfaceWorkspaces(s.workspaces);
    if (want.keys.size === 0) return '';
    const have = new Set(s.remoteWorkspaces.map((r) => r.key));
    const missing = [...want.keys.keys()].filter((k) => !have.has(k)).sort();
    return missing.length === 0 ? want.signature : `${want.signature}|missing:${missing.join(',')}`;
  });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const refs = remoteSurfaceWorkspaces(useStore.getState().workspaces).keys;
      // Labels are cosmetic (the roster's origin badge) and this list is a
      // local IPC read, so a missing route on an older preload bundle, or a
      // rejection, degrades to the hostId rather than costing the pane its
      // agent. Only fetched when there is something to label.
      let labels = new Map<string, string>();
      if (refs.size > 0) {
        try {
          const hosts = await window.electronAPI?.remote?.hostsList?.();
          if (Array.isArray(hosts)) {
            labels = new Map(hosts.map((h) => [h.id, h.label || h.origin || h.id]));
          }
        } catch {
          /* see above — hostId is a correct, if terse, label */
        }
      }
      if (cancelled) return;
      // Re-read: the await above may have let a pane close under us, and a row
      // for a surface that is gone would poll a host for nothing until the
      // next reconcile. Prune LAST so a key that is both tracked and kept in
      // the same round is never briefly dropped.
      const current = remoteSurfaceWorkspaces(useStore.getState().workspaces).keys;
      const had = new Set(useStore.getState().remoteWorkspaces.map((r) => r.key));
      for (const [key, ref] of current) {
        // A host that failed a few rounds is backed off up to BACKOFF_MAX_MS,
        // and it stays in `hostIds` (an ephemeral row keeps it there), so the
        // backoff would survive and the refresh below would skip it — turning
        // "a new pane gets its agent immediately" into a five-minute wait.
        // Opening a pane on a host is the user saying to try it now, exactly
        // like detach-then-reattach starting from a clean slate.
        if (!had.has(key)) backoff.current.delete(ref.hostId);
        useStore.getState().trackRemoteSurfaceWorkspace({
          key,
          hostId: ref.hostId,
          hostLabel: labels.get(ref.hostId) ?? ref.hostId,
          workspaceId: ref.workspaceId,
          name: '',
          // Panes always come from the poll below, never assumed. `stale`
          // until a host actually answers, so no reader can report an agent
          // this desktop has never heard of.
          panes: [],
          stale: true,
        });
      }
      useStore.getState().pruneRemoteSurfaceWorkspaces(new Set(current.keys()));
      if (cancelled || current.size === 0) return;
      // A fresh row would otherwise wait a full poll interval for its first
      // answer, so a brand-new remote pane would sit agent-less for 10s.
      await refresh();
    })();
    return () => { cancelled = true; };
  }, [reconcileSignature, refresh]);

  // ②-b Safety-net poll — armed only while something is attached, so an app
  //     with no mirrors makes no periodic requests at all.
  //
  //     The CADENCE comes from main (#1391). A renderer `setInterval` here was
  //     throttled to a minute once the window went to the background, which is
  //     exactly when a remote agent is the thing the user is watching.
  //
  //     The renderer interval survives only as a FALLBACK, armed the moment the
  //     tick cannot be had. THREE ways it can't, and the third is why a
  //     watchdog exists rather than just a rejection handler:
  //
  //       · no route at all — an older preload bundle, the same defence
  //         attachmentsList/hostsList already carry
  //       · the subscribe REJECTS — no handler registered on the main side
  //       · the subscribe SUCCEEDS and then the ticks simply stop. Main drops
  //         every subscriber on `will-quit` and in its disposer without telling
  //         anyone, and neither is a rejection. Without the watchdog the
  //         renderer sits on a live listener it believes is subscribed and
  //         polls nothing for the rest of the session — which is the one
  //         outcome this whole fallback exists to rule out.
  //
  //     Losing the tick must cost freshness, never the poll itself. Exactly one
  //     driver is ever live: arming the fallback tears the tick listener down.
  const hasAttachments = useStore((s) => s.remoteWorkspaces.length > 0);
  useEffect(() => {
    if (!hasAttachments) return;
    const remote = window.electronAPI?.remote;
    let cancelled = false;
    let offTick: (() => void) | null = null;
    let unsubscribe: (() => void) | null = null;
    let fallbackId: ReturnType<typeof setInterval> | null = null;
    let watchdogId: ReturnType<typeof setInterval> | null = null;
    let lastTickAt = Date.now();

    const stopWatchdog = (): void => {
      if (watchdogId === null) return;
      clearInterval(watchdogId);
      watchdogId = null;
    };

    const armFallback = (): void => {
      if (cancelled || fallbackId !== null) return;
      stopWatchdog();
      // Tear the tick listener down FIRST. If main is in fact still ticking
      // (a subscribe whose reply was lost, say), leaving both installed would
      // poll at double rate rather than fall back.
      offTick?.();
      offTick = null;
      fallbackId = setInterval(refreshTick, REMOTE_POLL_INTERVAL_MS);
    };

    if (remote?.pollSubscribe && remote.onPollTick) {
      // Listener first: a tick that lands between subscribe resolving and the
      // listener being installed would otherwise be dropped.
      offTick = remote.onPollTick(() => {
        lastTickAt = Date.now();
        refreshTick();
      });
      void remote.pollSubscribe().then((off) => {
        // The effect may have torn down while the invoke was in flight.
        if (cancelled) { off(); return; }
        unsubscribe = off;
      }).catch(armFallback);
      // Wall-clock, so a throttled watchdog reads late but never wrongly: it
      // compares timestamps rather than counting its own firings.
      watchdogId = setInterval(() => {
        if (Date.now() - lastTickAt < TICK_WATCHDOG_MS) return;
        armFallback();
      }, TICK_WATCHDOG_MS);
    } else {
      armFallback();
    }

    return () => {
      cancelled = true;
      stopWatchdog();
      offTick?.();
      unsubscribe?.();
      if (fallbackId !== null) clearInterval(fallbackId);
    };
  }, [hasAttachments, refreshTick]);

  // ②-c Foreground catch-up. Even an unthrottled tick can be most of an
  //     interval away when the user comes back, and "the status I see the
  //     instant I look" is the whole point.
  //
  //     THREE triggers, because no one of them covers this on every platform:
  //
  //       useWindowDisplayed  minimize/restore, hide/show to tray, lock/unlock,
  //                           suspend/resume — main-owned, and the ONLY one of
  //                           the three that works on Windows (#882 measured
  //                           `document.visibilityState` there as a constant:
  //                           still 'visible' while minimized or fully covered)
  //       focus               alt-tab back to a window that was never hidden —
  //                           the case #1391 was actually dogfooded on
  //                           (two wmux instances side by side)
  //       visibilitychange    macOS/Linux occlusion, where it does work
  const windowDisplayed = useWindowDisplayed();
  const wasDisplayed = useRef(windowDisplayed);
  useEffect(() => {
    const became = windowDisplayed && !wasDisplayed.current;
    wasDisplayed.current = windowDisplayed;
    if (!hasAttachments || !became) return;
    refreshForeground();
  }, [hasAttachments, windowDisplayed, refreshForeground]);

  useEffect(() => {
    if (!hasAttachments) return;
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return;
      refreshForeground();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', refreshForeground);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', refreshForeground);
    };
  }, [hasAttachments, refreshForeground]);
}
