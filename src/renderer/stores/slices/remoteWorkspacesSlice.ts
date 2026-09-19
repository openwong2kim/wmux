/**
 * Task 6 — renderer state for attached remote workspaces (Remote Workspace
 * Attach plan). Deliberately a SEPARATE array from `workspaces[]` so
 * `removeWorkspace`, `duplicateWorkspace`, pane-tree actions, and session
 * persistence can never reach a remote entry by construction — a remote
 * workspace is a live mirror of another host's daemon, not a local pane tree.
 *
 * This array itself stays out of SessionData / loadSession. What survives a
 * reload and an app restart is the DESCRIPTOR (no panes), persisted in the
 * main process by RemoteAttachmentsStore and replayed on boot by
 * useRemoteAttachmentsLifecycle — the panes are always re-fetched, never
 * restored from disk.
 */
import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { RemoteAttachmentDescriptor, RemotePaneSummary } from '../../../shared/remoteHosts';

export interface AttachedRemoteWorkspace {
  key: string;                    // `${hostId}:${workspaceId}` — selection + dedup key
  hostId: string;
  hostLabel: string;
  workspaceId: string;
  name: string;                   // remote name snapshot ('' → UI falls back to workspaceId prefix)
  panes: RemotePaneSummary[];     // refreshed on re-attach / exit event / poll
  /**
   * #1086 — local-side aliases. `label` renames the SIDEBAR ROW without
   * touching the remote host (which owns the real name); `color` is a
   * WorkspaceColorId in the same grammar as local workspaces. Both persist
   * with the descriptor.
   */
  label?: string;
  color?: string;
  /** The host could not be reached, or the workspace is gone from it. The
   *  entry deliberately STAYS in the sidebar — dropping a user's attachment
   *  because a laptop slept would be silent data loss — it just renders
   *  disconnected until a refresh succeeds or the user detaches. */
  stale?: boolean;
  /**
   * #1329 — this row exists ONLY to drive the per-host poll for a
   * remote-terminal SURFACE (the "New remote pane" / "Split right|down —
   * remote" flows), not because the user attached a mirror.
   *
   * `attachRemoteWorkspace` fuses three things into one row: the poll input,
   * a permanent sidebar mirror, and an on-disk descriptor replayed on every
   * boot. A surface wants the FIRST only — it is a "tab = mine to operate"
   * leaf in a local pane tree, not a "mirror = watching" attachment
   * (remoteSessionTeardown.ts states that split). So an ephemeral row is:
   *
   *   - invisible: filtered out by `selectAttachedRemoteWorkspaces`, which
   *     both the sidebar and WorkspaceCenter read (an unfiltered row would
   *     also mount a SECOND RemoteWorkspaceView and double-attach the same
   *     SSE stream);
   *   - unpersisted: no `attachmentsAdd`, so it can never resurrect on a
   *     later boot as an unreapable `stale: true` ghost;
   *   - never selected: `activeRemoteKey` is not touched when one lands.
   *
   * Reaped by reconciliation, not by teardown call sites — see
   * `pruneRemoteSurfaceWorkspaces`.
   */
  ephemeral?: boolean;
  /** Bumped every time this entry recovers from `stale`. A host that slept
   *  long enough for RemoteHostClient to give up reconnecting comes back with
   *  the SAME remote sessionIds, so the pane list is byte-identical and
   *  nothing below would otherwise re-attach — every mirror would stay blank
   *  forever with no visible error. PaneCell keys its attach effect off this
   *  counter, so a recovery re-opens the streams. */
  attachEpoch?: number;
}

/** Fire-and-forget descriptor persistence. Guarded for the node test
 *  environment (no `window`) and for a preload without the remote bridge. */
function persistApi() {
  if (typeof window === 'undefined') return undefined;
  return window.electronAPI?.remote;
}

function toDescriptor(w: AttachedRemoteWorkspace): RemoteAttachmentDescriptor {
  return {
    key: w.key,
    hostId: w.hostId,
    hostLabel: w.hostLabel,
    workspaceId: w.workspaceId,
    name: w.name,
    ...(w.label ? { label: w.label } : {}),
    ...(w.color ? { color: w.color } : {}),
  };
}

/** Merges a freshly fetched pane set into the current one with STABLE
 *  ordering: panes that are still there keep their slot (so the mirror grid
 *  never reshuffles when an unrelated pane closes), panes that are gone drop
 *  out, and newly opened panes append at the end. Field updates (shell/cwd)
 *  from the fetch always win.
 *
 *  sessionId is also the React key of a pane cell, so the result is
 *  deduplicated: the pane list comes off another machine and a remote that
 *  reports the same sessionId twice must not render two cells under one key. */
export function mergePaneSets(
  current: RemotePaneSummary[],
  next: RemotePaneSummary[],
): RemotePaneSummary[] {
  const nextById = new Map(next.map((p) => [p.sessionId, p]));
  const merged: RemotePaneSummary[] = [];
  const seen = new Set<string>();
  for (const pane of current) {
    const fresh = nextById.get(pane.sessionId);
    if (!fresh || seen.has(pane.sessionId)) continue;
    seen.add(pane.sessionId);
    merged.push(fresh);
  }
  for (const pane of next) {
    if (seen.has(pane.sessionId)) continue;
    seen.add(pane.sessionId);
    merged.push(pane);
  }
  return merged;
}

/** Whether a merge result is indistinguishable from what is already in the
 *  store — the 10s poll runs forever, so an unchanged fetch must not push a
 *  new array identity and re-render every mirror. Agent fields participate
 *  (#1163): a remote agent's status flip must re-render its roster row. */
function samePanes(a: RemotePaneSummary[], b: RemotePaneSummary[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((pane, i) =>
    pane.sessionId === b[i].sessionId
    && pane.shell === b[i].shell
    && pane.cwd === b[i].cwd
    && pane.agentName === b[i].agentName
    && pane.agentStatus === b[i].agentStatus
    // #1342 — the resume offer and BOTH of its liveness signals. This function
    // decides whether a poll result is worth storing, so a field missing from
    // it is a field that never updates after the first snapshot: the chip's
    // "never type into a live agent" gate would answer from whatever the host
    // happened to say the first time and never hear that the agent came back.
    && pane.commandRunning === b[i].commandRunning
    && pane.agentProcessAlive === b[i].agentProcessAlive
    && pane.resume?.agent === b[i].resume?.agent
    && pane.resume?.sessionId === b[i].resume?.sessionId
    && pane.resume?.cwdMatches === b[i].resume?.cwdMatches
    && pane.resume?.permissionMode === b[i].resume?.permissionMode);
}

export interface RemoteWorkspacesSlice {
  remoteWorkspaces: AttachedRemoteWorkspace[];
  /** Which sidebar entry is selected: a local workspace id (existing
   * activeWorkspaceId) or a remote key. Remote selection does NOT touch
   * activeWorkspaceId — WorkspaceCenter checks this field first. */
  activeRemoteKey: string | null;
  /** Dedup by key (re-attach refreshes the existing entry's snapshot in
   * place), then select it. Also persists the descriptor so the attachment
   * survives a reload. */
  attachRemoteWorkspace: (w: AttachedRemoteWorkspace) => void;
  /** Boot-time replay of a persisted descriptor: adds the entry WITHOUT
   * selecting it (a restore must not steal the user's view) and without
   * re-persisting what it just read. ADDITIVE ONLY — see the implementation. */
  restoreRemoteWorkspace: (w: AttachedRemoteWorkspace) => void;
  /** #1329 — register the invisible, unpersisted poll input a remote-terminal
   * SURFACE needs (see `AttachedRemoteWorkspace.ephemeral`). ADDITIVE ONLY:
   * a key that is already present wins, so a real sidebar attachment on the
   * same `hostId:workspaceId` is never demoted to an invisible row. */
  trackRemoteSurfaceWorkspace: (w: AttachedRemoteWorkspace) => void;
  /** #1329 — drop every EPHEMERAL row whose key is not in `keepKeys`. Rows the
   * user attached are never touched, so pane teardown can never reap an
   * attachment. Nothing is unpersisted because nothing was persisted. */
  pruneRemoteSurfaceWorkspaces: (keepKeys: ReadonlySet<string>) => void;
  /** Remove the entry AND its persisted descriptor; clears activeRemoteKey
   * only if it was the active one. */
  detachRemoteWorkspace: (key: string) => void;
  /** Applies a freshly fetched pane set (exit event / poll) with stable
   * ordering, and clears `stale` — a successful fetch means reachable. No-ops
   * when nothing changed. `name` follows the remote when the fetch carries
   * one, so a workspace renamed on the other machine renames here too. */
  setRemoteWorkspacePanes: (key: string, panes: RemotePaneSummary[], name?: string) => void;
  /** Marks the entry unreachable (or reachable again) without dropping it. */
  setRemoteWorkspaceStale: (key: string, stale: boolean) => void;
  /** #1086 — rename the row LOCALLY (the remote host owns the real name).
   *  Empty clears the alias; the remote snapshot name shows again. */
  renameRemoteWorkspace: (key: string, label: string | null) => void;
  /** #1086 — color-tag the row in the same grammar as local workspaces.
   *  undefined clears the tag. */
  setRemoteWorkspaceColor: (key: string, color: string | undefined) => void;
  /** Selecting a LOCAL workspace calls this with null. */
  setActiveRemoteKey: (key: string | null) => void;
}

/**
 * #1086 — the ONE definition of "a remote mirror is what's on screen".
 *
 * WorkspaceCenter renders the local pane tree and every attached mirror at
 * once and picks with display:none, so this predicate decides which surface
 * the user is looking at. Keeping it here (rather than re-deriving
 * `activeRemoteKey ? …` at each call site) means the local-vs-remote gate has
 * a single reading, and it adds the check the raw flag cannot make on its
 * own: a key with no live entry behind it selects nothing, so it must fall
 * back to the local tree instead of hiding everything.
 */
export function isRemoteMirrorVisible(state: {
  remoteWorkspaces: AttachedRemoteWorkspace[];
  activeRemoteKey: string | null;
}): boolean {
  if (!state.activeRemoteKey) return false;
  // #1329 — an EPHEMERAL row is a poll input, not a mirror: nothing renders it,
  // so treating one as visible would hide the local tree behind a blank centre.
  // Nothing sets activeRemoteKey to an ephemeral key today; this keeps the two
  // halves of the gate reading the same list rather than relying on that.
  return state.remoteWorkspaces.some((r) => r.key === state.activeRemoteKey && !r.ephemeral);
}

/**
 * #1329 — the ONE definition of "a remote mirror the user attached", i.e. every
 * row that renders: a sidebar entry and a mounted RemoteWorkspaceView.
 *
 * Kept here, next to `isRemoteMirrorVisible`, for the same reason that
 * predicate lives here: the sidebar and WorkspaceCenter must never disagree
 * about which rows exist. A row they disagreed on would either be clickable
 * with nothing behind it, or would silently double-attach an SSE stream the
 * user cannot see.
 *
 * Subscribe through `useShallow`, never bare. `remoteWorkspaces` gets a new
 * array identity on every 10s poll round that changes ANY row — including the
 * invisible ones behind remote-terminal panes, whose agent status flips are
 * deliberately part of `samePanes` — so a bare subscription would re-render
 * the whole sidebar and every mounted mirror on a tick that changed nothing
 * they display. Shallow-comparing the filtered result is what keeps an
 * ephemeral row's churn off the visible components entirely.
 */
export function selectAttachedRemoteWorkspaces(state: {
  remoteWorkspaces: AttachedRemoteWorkspace[];
}): AttachedRemoteWorkspace[] {
  return state.remoteWorkspaces.some((r) => r.ephemeral)
    ? state.remoteWorkspaces.filter((r) => !r.ephemeral)
    : state.remoteWorkspaces;
}

export const createRemoteWorkspacesSlice: StateCreator<StoreState, [['zustand/immer', never]], [], RemoteWorkspacesSlice> = (set) => ({
  remoteWorkspaces: [],
  activeRemoteKey: null,

  attachRemoteWorkspace: (w) => {
    // Persist the MERGED entry, not `w`: a re-attach hands us a fresh snapshot
    // without the #1086 aliases, so writing `w` would wipe the carried-over
    // label/color from disk and lose them on the next reload. Built inside
    // the producer (a draft must not escape set()).
    let descriptor: RemoteAttachmentDescriptor | undefined;
    set((state: StoreState) => {
      const idx = state.remoteWorkspaces.findIndex((r: AttachedRemoteWorkspace) => r.key === w.key);
      if (idx === -1) {
        state.remoteWorkspaces.push(w);
      } else {
        // Carry the epoch across a re-attach: its only job is to be different
        // from the value the mounted PaneCells last saw, and resetting it
        // would tear down streams that are perfectly healthy. The #1086
        // aliases survive too — a re-attach (re-attach flow, bootstrap) hands
        // us a fresh snapshot with no label/color, and letting it overwrite
        // would silently wipe the user's rename/tag.
        const prev = state.remoteWorkspaces[idx];
        state.remoteWorkspaces[idx] = {
          ...w,
          attachEpoch: prev.attachEpoch,
          ...(prev.label && !w.label ? { label: prev.label } : {}),
          ...(prev.color && !w.color ? { color: prev.color } : {}),
        };
      }
      state.activeRemoteKey = w.key;
      const entry = state.remoteWorkspaces.find((r: AttachedRemoteWorkspace) => r.key === w.key);
      if (entry) descriptor = toDescriptor(entry);
    });
    // Fire-and-forget: a failed write only costs this attachment its
    // restore-after-reload, and the attach itself has already happened. The
    // method check covers an older preload bundle without these routes.
    const api = persistApi();
    if (descriptor && api?.attachmentsAdd) void api.attachmentsAdd(descriptor).catch(() => { /* see above */ });
  },

  // ADDITIVE ONLY. A boot restore fetches each host's panes before it lands,
  // which can take a full request timeout per unreachable host, and the user
  // is free to act on the same key meanwhile. Overwriting would blank a mirror
  // they just attached (panes: [], stale: true), and re-adding a key they
  // detached would resurrect a ghost row with no descriptor behind it. Present
  // key wins, always.
  restoreRemoteWorkspace: (w) => set((state: StoreState) => {
    if (state.remoteWorkspaces.some((r: AttachedRemoteWorkspace) => r.key === w.key)) return;
    state.remoteWorkspaces.push(w);
  }),

  // ADDITIVE ONLY, for the same class of reason restoreRemoteWorkspace is.
  // The mint flows behind a remote-terminal surface create a REAL workspace on
  // the host (`remote-pane-*`), which AttachRemoteModal lists like any other —
  // so the user can legitimately attach the very same `hostId:workspaceId` as
  // a visible mirror. Present key wins, always: overwriting would hide a row
  // the user is looking at, wipe its #1086 label/color, and orphan its
  // persisted descriptor. The reverse order is safe without extra code —
  // attachRemoteWorkspace replaces the entry with a snapshot that carries no
  // `ephemeral`, promoting the row to a real attachment.
  trackRemoteSurfaceWorkspace: (w) => set((state: StoreState) => {
    if (state.remoteWorkspaces.some((r: AttachedRemoteWorkspace) => r.key === w.key)) return;
    state.remoteWorkspaces.push({ ...w, ephemeral: true });
  }),

  pruneRemoteSurfaceWorkspaces: (keepKeys) => set((state: StoreState) => {
    // Plain strings, captured BEFORE the array is rebuilt: a draft that has
    // been detached from the tree is not something to keep reading fields off.
    const doomed = new Set<string>(
      state.remoteWorkspaces
        .filter((r: AttachedRemoteWorkspace) => r.ephemeral === true && !keepKeys.has(r.key))
        .map((r: AttachedRemoteWorkspace) => r.key),
    );
    if (doomed.size === 0) return; // no new array identity on a no-op round
    // The `ephemeral` re-check is belt and braces: keys are unique across both
    // kinds of row, so `doomed` alone would do. "Prune never reaps an
    // attachment" is the invariant this whole design rests on, and it should
    // not depend on a uniqueness argument made somewhere else.
    state.remoteWorkspaces = state.remoteWorkspaces.filter(
      (r: AttachedRemoteWorkspace) => !(r.ephemeral === true && doomed.has(r.key)),
    );
    // Defensive: nothing selects an ephemeral row, but a dangling
    // activeRemoteKey would make isRemoteMirrorVisible disagree with what is
    // mounted. Cheap to keep the two in step here rather than reason about it.
    if (state.activeRemoteKey && doomed.has(state.activeRemoteKey)) {
      state.activeRemoteKey = null;
    }
  }),

  detachRemoteWorkspace: (key) => {
    set((state: StoreState) => {
      const idx = state.remoteWorkspaces.findIndex((r: AttachedRemoteWorkspace) => r.key === key);
      if (idx === -1) return;
      state.remoteWorkspaces.splice(idx, 1);
      if (state.activeRemoteKey === key) state.activeRemoteKey = null;
    });
    const api = persistApi();
    if (api?.attachmentsRemove) void api.attachmentsRemove(key).catch(() => { /* fire-and-forget, as above */ });
  },

  setRemoteWorkspacePanes: (key, panes, name) => set((state: StoreState) => {
    const entry = state.remoteWorkspaces.find((r: AttachedRemoteWorkspace) => r.key === key);
    if (!entry) return;
    // The pane list originates on another machine: refuse a non-array rather
    // than letting it throw here and abort the caller's whole refresh round.
    if (!Array.isArray(panes)) return;
    const merged = mergePaneSets(entry.panes, panes);
    if (!samePanes(entry.panes, merged)) entry.panes = merged;
    if (name !== undefined && name !== entry.name) entry.name = name;
    if (entry.stale) {
      entry.stale = false;
      entry.attachEpoch = (entry.attachEpoch ?? 0) + 1;
    }
  }),

  setRemoteWorkspaceStale: (key, stale) => set((state: StoreState) => {
    const entry = state.remoteWorkspaces.find((r: AttachedRemoteWorkspace) => r.key === key);
    if (!entry) return;
    // Normalise before comparing: a never-flagged entry has `undefined`, not
    // `false`, and treating that as a real transition would bump the epoch —
    // and tear down live streams — on the very first successful fetch.
    const wasStale = entry.stale === true;
    if (wasStale === stale) return;
    entry.stale = stale;
    if (!stale) entry.attachEpoch = (entry.attachEpoch ?? 0) + 1;
  }),

  renameRemoteWorkspace: (key, label) => {
    // The descriptor is built INSIDE the producer (a draft that escapes set()
    // is a revoked proxy — the same trap stashPane's comments warn about) and
    // persisted as a plain object.
    let descriptor: RemoteAttachmentDescriptor | undefined;
    set((state: StoreState) => {
      const entry = state.remoteWorkspaces.find((r: AttachedRemoteWorkspace) => r.key === key);
      if (!entry) return;
      const trimmed = label?.trim();
      if (trimmed) entry.label = trimmed;
      else delete entry.label;
      descriptor = toDescriptor(entry);
    });
    // Re-adding the same key overwrites its descriptor in place (the store's
    // own upsert rule), which is how the alias survives a reload.
    const api = persistApi();
    if (descriptor && api?.attachmentsAdd) {
      void api.attachmentsAdd(descriptor).catch(() => { /* best-effort, same as attach */ });
    }
  },

  setRemoteWorkspaceColor: (key, color) => {
    let descriptor: RemoteAttachmentDescriptor | undefined;
    set((state: StoreState) => {
      const entry = state.remoteWorkspaces.find((r: AttachedRemoteWorkspace) => r.key === key);
      if (!entry) return;
      if (color) entry.color = color;
      else delete entry.color;
      descriptor = toDescriptor(entry);
    });
    const api = persistApi();
    if (descriptor && api?.attachmentsAdd) {
      void api.attachmentsAdd(descriptor).catch(() => { /* best-effort */ });
    }
  },

  setActiveRemoteKey: (key) => set((state: StoreState) => {
    state.activeRemoteKey = key;
  }),
});
