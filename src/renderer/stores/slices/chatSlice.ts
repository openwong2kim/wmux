// Chat View data layer (plan PR-5) — the renderer-side mirror of the daemon
// TranscriptProjector, keyed by ptyId.
//
// Everything here is TRANSIENT: none of these fields enter buildSessionData's
// explicit allowlist (AppLayout.tsx), so a restored session never replays a
// stale conversation projection. The transcript on disk is the record; this
// slice is a bounded window onto it, exactly like surfaceActivity /
// surfacePendingQuestion are bounded windows onto live pane state.
//
// The append path is defensive on purpose: the projector's `seq` is the only
// thing that can tell a dropped event (main's control buffer can drop an
// oversized frame — eng-review A3) from an ordinary delta. A gap therefore
// does NOT try to patch the hole; it raises `chatNeedsResnapshot` so the
// consumer re-snapshots and the user never reads a conversation with a silent
// hole in it.

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type {
  TranscriptAppendData,
  TranscriptCursor,
  TranscriptPage,
  TranscriptStatus,
  TurnEvent,
} from '../../../shared/transcript/turnEvents';

/** Per-pane row cap. Head-dropped (oldest first) — the newest turn always wins. */
export const MAX_ROWS_IN_MEMORY = 2000;

/**
 * A pending composer echo with no matching `user_text` after this long is
 * dropped rather than left hanging. Causes: the pane wasn't at a prompt, the
 * agent discarded the queued line, or the transcript writer never flushed it.
 * A ghost row that never resolves is worse than no row.
 */
export const PENDING_ECHO_TTL_MS = 60_000;

export interface ChatPendingEcho {
  id: string;
  text: string;
  /** Epoch ms of the local send. */
  at: number;
}

export interface ChatSlice {
  /** Keyed by ptyId. Bounded to MAX_ROWS_IN_MEMORY per pane, head-dropped. */
  chatEvents: Record<string, TurnEvent[]>;
  chatCursor: Record<string, TranscriptCursor | undefined>;
  chatStatus: Record<string, TranscriptStatus | undefined>;
  /** Last applied projector sequence per pane; undefined until the first append. */
  chatSeq: Record<string, number | undefined>;
  /** True when a seq gap was observed — the consumer must re-snapshot. */
  chatNeedsResnapshot: Record<string, boolean>;
  /** Optimistic composer echoes, cleared when a matching user_text arrives. */
  chatPending: Record<string, ChatPendingEcho[]>;

  /** Apply one projector delta (or a `reset:true` full replace). */
  applyChatAppend: (ptyId: string, data: TranscriptAppendData) => void;
  /** Prepend an older backward page ("Load earlier"). */
  prependChatPage: (ptyId: string, page: TranscriptPage) => void;
  setChatStatus: (ptyId: string, status: TranscriptStatus) => void;
  pushChatPending: (ptyId: string, text: string) => void;
  /** Drop echoes past PENDING_ECHO_TTL_MS. `now` is injectable for tests. */
  reconcileChatPending: (ptyId: string, now?: number) => void;
  /** Forget one pane entirely (surface close, pane close, workspace close). */
  clearChatSurface: (ptyId: string) => void;
}

/** Monotonic suffix so two echoes sent in the same millisecond stay distinct. */
let pendingEchoCounter = 0;

/** Normalized form used to match a local echo against a transcript user turn. */
function echoKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Append with the head-drop ring rule applied. */
function capRows(rows: TurnEvent[]): TurnEvent[] {
  return rows.length > MAX_ROWS_IN_MEMORY ? rows.slice(rows.length - MAX_ROWS_IN_MEMORY) : rows;
}

/**
 * Drop pending echoes matched by an incoming batch's `user_text` events, plus
 * any that aged out. Matching is by normalized text: the transcript echoes the
 * line the user typed, but whitespace can be reflowed by the paste bracket.
 */
function reconcilePending(
  pending: ChatPendingEcho[],
  incoming: readonly TurnEvent[],
  now: number,
): ChatPendingEcho[] {
  if (pending.length === 0) return pending;
  const arrived = new Set<string>();
  for (const ev of incoming) {
    if (ev.kind === 'user_text') arrived.add(echoKey(ev.text));
  }
  return pending.filter((p) => !arrived.has(echoKey(p.text)) && now - p.at < PENDING_ECHO_TTL_MS);
}

export const createChatSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  ChatSlice
> = (set) => ({
  chatEvents: {},
  chatCursor: {},
  chatStatus: {},
  chatSeq: {},
  chatNeedsResnapshot: {},
  chatPending: {},

  applyChatAppend: (ptyId, data) => set((draft: StoreState) => {
    const prevSeq = draft.chatSeq[ptyId];
    const now = Date.now();

    if (data.reset) {
      // Full replace: rotation, truncation, or a reused pane starting a new
      // agent session. Anything we held is about a conversation that no longer
      // exists at these offsets.
      draft.chatEvents[ptyId] = capRows([...data.events]);
      draft.chatCursor[ptyId] = data.cursor;
      draft.chatSeq[ptyId] = data.seq;
      draft.chatNeedsResnapshot[ptyId] = false;
      draft.chatPending[ptyId] = reconcilePending(draft.chatPending[ptyId] ?? [], data.events, now);
      return;
    }

    // Stale or duplicate delivery (a replayed frame after a re-snapshot):
    // already applied, and re-appending would duplicate rows.
    if (prevSeq !== undefined && data.seq <= prevSeq) return;

    // A hole. Append what arrived so the live tail keeps moving, but flag the
    // pane so the consumer re-snapshots — we cannot fabricate the missing span.
    if (prevSeq !== undefined && data.seq !== prevSeq + 1) {
      draft.chatNeedsResnapshot[ptyId] = true;
    }

    const existing = draft.chatEvents[ptyId] ?? [];
    const seen = new Set(existing.map((e) => e.id));
    const fresh = data.events.filter((e) => !seen.has(e.id));
    draft.chatEvents[ptyId] = capRows([...existing, ...fresh]);
    draft.chatCursor[ptyId] = data.cursor;
    draft.chatSeq[ptyId] = data.seq;
    draft.chatPending[ptyId] = reconcilePending(draft.chatPending[ptyId] ?? [], data.events, now);
  }),

  prependChatPage: (ptyId, page) => set((draft: StoreState) => {
    const existing = draft.chatEvents[ptyId] ?? [];
    const seen = new Set(existing.map((e) => e.id));
    const older = page.events.filter((e) => !seen.has(e.id));
    // Over-cap after a prepend keeps the NEWEST rows: the same head-drop rule
    // as the live path, so "load earlier" is a no-op on a full ring instead of
    // silently evicting the turn the user is reading.
    draft.chatEvents[ptyId] = capRows([...older, ...existing]);
    const prev = draft.chatCursor[ptyId];
    draft.chatCursor[ptyId] = {
      // Only the head moves head-ward; the live tail mark and the file stats
      // belong to the newest delta we have seen.
      headOffset: page.cursor.headOffset,
      tailOffset: prev?.tailOffset ?? page.cursor.tailOffset,
      fileSize: prev?.fileSize ?? page.cursor.fileSize,
      mtimeMs: prev?.mtimeMs ?? page.cursor.mtimeMs,
    };
  }),

  setChatStatus: (ptyId, status) => set((draft: StoreState) => {
    draft.chatStatus[ptyId] = status;
  }),

  pushChatPending: (ptyId, text) => set((draft: StoreState) => {
    pendingEchoCounter += 1;
    const list = draft.chatPending[ptyId] ?? [];
    list.push({ id: `pending-${Date.now()}-${pendingEchoCounter}`, text, at: Date.now() });
    draft.chatPending[ptyId] = list;
  }),

  reconcileChatPending: (ptyId, now) => set((draft: StoreState) => {
    const list = draft.chatPending[ptyId];
    if (!list || list.length === 0) return;
    draft.chatPending[ptyId] = reconcilePending(list, [], now ?? Date.now());
  }),

  clearChatSurface: (ptyId) => set((draft: StoreState) => {
    delete draft.chatEvents[ptyId];
    delete draft.chatCursor[ptyId];
    delete draft.chatStatus[ptyId];
    delete draft.chatSeq[ptyId];
    delete draft.chatNeedsResnapshot[ptyId];
    delete draft.chatPending[ptyId];
  }),
});
