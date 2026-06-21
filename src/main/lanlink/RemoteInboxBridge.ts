import type { BrowserWindow } from 'electron';
import type { DaemonClient } from '../DaemonClient';
import { IPC } from '../../shared/constants';
import {
  BODY_MAX,
  clampText,
  PEER_NAME_MAX,
  type InboxRecord,
  type RemoteInboxItem,
} from '../../shared/lanlink';

// Backstop interval (ms). The nudge (lanlink:nudge) is the fast path; this
// interval recovers a dropped nudge. Short enough to feel live, long enough to
// be negligible against the named-pipe RPC cost.
const POLL_INTERVAL_MS = 3_000;

// Main-side delivery cursor, retained ACROSS onInstall router re-creation
// (reconnect/respawn). The bridge instance is disposable; the cursor is the
// durable delivery position, so it lives in module scope.
//
// The cursor ALONE is not sufficient for exactly-once to the RENDERER, for two
// reasons the cursor-pull guarantee (which is about the daemon↔main seam) does
// not cover:
//   (1) RENDERER reload — crash recovery / unresponsive recovery call
//       mainWindow.reload() (main/index.ts), which wipes the renderer zustand
//       store but leaves main (and this module-scope cursor) alive, so a plain
//       pull returns nothing and the UI stays empty.
//   (2) COLD START — start()'s first pull can run before useRemoteInboxBridge
//       installs its onRemote listener, so that batch is sent into the void.
// Both are recovered by the renderer-driven `resync()` handshake: the renderer
// calls it on mount (AFTER its listener is installed); resync resets the cursor
// to 0 and re-pulls the full live inbox, and the renderer's isNew guard makes
// the replay idempotent. A full MAIN restart also resets this to 0 (module
// re-eval) and is likewise safe.
let lanlinkCursor = 0;

/** Test-only: reset the module-scope cursor between cases. */
export function __resetLanlinkCursorForTest(): void {
  lanlinkCursor = 0;
}

/** Test-only: read the module-scope cursor. */
export function __getLanlinkCursorForTest(): number {
  return lanlinkCursor;
}

/**
 * LanLink PR-2 — main-process cursor-pull bridge. Owns the pull loop and the
 * read-only materialization tee. Triggers: connect (start → immediate pull),
 * nudge ('lanlink:nudge' Node event from DaemonClient), and a short interval
 * backstop. The daemon cannot emit to the renderer (the EventBus is main-only),
 * so delivery starts in the daemon, crosses the broadcast/cursor-pull seam, and
 * this bridge re-emits to the renderer over a DEDICATED IPC channel.
 *
 * **No-paste wall (the security crux):** the ONLY exit is
 * `win.webContents.send(IPC.LANLINK_REMOTE, item)`. This module imports 0 of
 * useRpcBridge / submitToPty / deliverPty* / _bridge / a2a.rpc — enforced by
 * the source-scan test `remoteInboxNoPaste.test.ts`. An `origin:'remote'` item
 * is therefore structurally read-only: it can never reach a terminal paste or
 * the a2a execute path.
 */
export class RemoteInboxBridge {
  private inFlight = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private cleanups: Array<() => void> = [];
  private client: DaemonClient | null = null;

  constructor(private getWindow: () => BrowserWindow | null) {}

  start(client: DaemonClient): void {
    this.client = client;
    const onNudge = (): void => {
      void this.runPull();
    };
    client.on('lanlink:nudge', onNudge);
    this.cleanups.push(() => client.off('lanlink:nudge', onNudge));
    this.interval = setInterval(() => {
      void this.runPull();
    }, POLL_INTERVAL_MS);
    // Pull immediately on (re)connect to replay anything that landed on disk
    // while main was disconnected (C3 reconnect replay). The renderer's own
    // resync() on mount covers the case where this first pull beats the
    // renderer's listener.
    void this.runPull();
  }

  /**
   * Renderer-driven replay. useRemoteInboxBridge calls this on mount, AFTER its
   * onRemote listener is installed. Resets the delivery cursor to 0 and re-pulls
   * the full live inbox so a reloaded/just-mounted renderer re-materializes
   * every record it is missing; the renderer's isNew guard dedups, so it is safe
   * to call repeatedly. This is the fix for both the renderer-reload gap (store
   * wiped while main+cursor survive) and the cold-start race (first pull before
   * the listener exists).
   */
  resync(): void {
    lanlinkCursor = 0;
    void this.runPull();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const off of this.cleanups) {
      try {
        off();
      } catch {
        /* defensive — a cleanup must never throw out of stop() */
      }
    }
    this.cleanups = [];
    this.client = null;
  }

  private async runPull(): Promise<void> {
    const client = this.client;
    if (!client || !client.isConnected) return; // avoid RPC on a dead client
    // Resolve the renderer BEFORE advancing the cursor: with no window to
    // deliver to, we must not consume records — leave the cursor and retry on
    // the next nudge/interval (the disk inbox keeps them).
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    if (this.inFlight) return; // single concurrent pull
    this.inFlight = true;
    try {
      const { items } = await client.inboxPoll(lanlinkCursor);
      // Advance the cursor only past records the renderer ACTUALLY received.
      // `materialize` returns false when the send was dropped (window destroyed
      // or a mid-reload throw); we stop at the first failure so the undelivered
      // tail is re-pulled on the next nudge/interval. Coupling cursor-advance to
      // delivery success is what makes the renderer side exactly-once: a
      // transient renderer outage can no longer silently skip a record.
      let delivered = lanlinkCursor;
      for (const rec of items) {
        if (!this.materialize(win, rec)) break;
        delivered = rec.seq;
      }
      if (delivered > lanlinkCursor) lanlinkCursor = delivered;
    } catch {
      // Swallow — the next nudge/interval retries (health-probe pattern). A
      // failed pull leaves the cursor untouched so nothing is skipped.
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Materialize a durable record into a read-only renderer item and push it over
   * the dedicated IPC.LANLINK_REMOTE channel. Returns true if the send was
   * handed to a live renderer, false if it was dropped (destroyed window or a
   * mid-reload throw) — the caller holds the cursor at the last delivered seq so
   * a dropped record is re-pulled, never silently skipped. Length-clamped again
   * defensively (the daemon already clamped on inject). NEVER touches
   * submitToPty / deliverPty* / sendToRenderer('a2a.task.*').
   */
  private materialize(win: BrowserWindow, rec: InboxRecord): boolean {
    if (win.isDestroyed()) return false;
    const item: RemoteInboxItem = {
      recordId: rec.id,
      origin: 'remote',
      peerName: clampText(rec.peerName, PEER_NAME_MAX),
      text: clampText(rec.text, BODY_MAX),
      seq: rec.seq,
      receivedAt: rec.receivedAt,
    };
    try {
      win.webContents.send(IPC.LANLINK_REMOTE, item);
      return true;
    } catch {
      // renderer mid-reload: hold the cursor here; the next pull re-delivers and
      // the renderer's isNew guard dedups any overlap.
      return false;
    }
  }
}
