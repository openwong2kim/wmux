// Chat View — the supervision lens over one pane's transcript (plan PR-7).
//
// Store-driven: rows come from chatSlice (PR-5), which useChatProjection fills
// from the daemon projector once the preload `chat` channel exists (PR-4). The
// hook is feature-detected, so this component renders its empty state instead
// of throwing while that wiring is still in flight.
//
// The gate props (`needsInput` / `pendingQuestion`) are NOT derived here — they
// arrive from the hook-authoritative source the integration wave supplies
// (eng-review A1/A2). Same for `onFetchBody` / `onOpenDiff`: this surface asks,
// it does not reach for IPC itself.
//
// DESIGN.md: no bubbles, no area washes, prose sans / evidence mono, the
// terminal grid stays the hero — Chat View lives inside one pane's box.

import React, { useCallback, useEffect, useMemo } from 'react';
import { useStore } from '../../stores';
import { useChatProjection } from '../../hooks/useChatProjection';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { ChatRow } from './ChatRow';
import { ToolRunLine } from './ToolRunLine';
import { DiffChip } from './DiffChip';
import { ChatComposer } from './ChatComposer';
import { TrustSeam } from './TrustSeam';
import { foldToolRuns } from './foldToolRuns';
import { useRowWindow, ROW_GAP } from './useRowWindow';
import type { TurnEvent } from '../../../shared/transcript/turnEvents';

export interface ChatViewProps {
  ptyId: string;
  surfaceId: string;
  workspaceId: string;
  /** Pane focus — drives composer autofocus, not visibility. */
  isActive: boolean;
  /** display:flex vs none. Mirrors TerminalProps.visible. */
  visible?: boolean;
  /** Trust-seam arrow: flip this surface back to the terminal rendering. */
  onJumpToTerminal: () => void;

  // ─── Supplied by the integration wave (PR-6/PR-8) ───────────────────────
  /** Hard composer gate. Never derived from agentStatus (A1/A2). */
  needsInput?: boolean;
  /** Question the pane is blocked on, shown above the locked composer. */
  pendingQuestion?: string;
  agentStatus?: 'running' | 'idle' | 'complete';
  /** Projection lags the PTY → the trust seam takes the warning treatment. */
  stale?: boolean;
  /** Agent display name for the assistant speaker label. */
  agentName?: string;
  /** Resolves a code block body on expand (bodies are never on the wire, A3). */
  onFetchBody?: (eventId: string, n: number) => Promise<string>;
  /** Opens the existing workspace-diff surface for a diff-shaped result. */
  onOpenDiff?: (eventId: string) => void;
}

const EMPTY_EVENTS: TurnEvent[] = [];

/** Stable measurement key for the row window (module scope = stable identity). */
const rowKey = (row: { id: string }): string => row.id;

export function ChatView({
  ptyId,
  surfaceId,
  isActive,
  visible = true,
  onJumpToTerminal,
  needsInput = false,
  pendingQuestion,
  agentStatus,
  stale,
  agentName,
  onFetchBody,
  onOpenDiff,
}: ChatViewProps): React.ReactElement {
  const t = useT();
  const events = useStore((s) => s.chatEvents[ptyId]) ?? EMPTY_EVENTS;
  const pending = useStore((s) => s.chatPending[ptyId]);
  const status = useStore((s) => s.chatStatus[ptyId]);
  const cursor = useStore((s) => s.chatCursor[ptyId]);
  const needsResnapshot = useStore((s) => s.chatNeedsResnapshot[ptyId]);
  const pushChatPending = useStore((s) => s.pushChatPending);

  const { loadEarlier, resnapshot } = useChatProjection(ptyId, visible);

  // A seq gap means the window has a hole we cannot stitch — re-seed instead of
  // showing a conversation that silently skips turns.
  useEffect(() => {
    if (needsResnapshot) void resnapshot();
  }, [needsResnapshot, resnapshot]);

  const rows = useMemo(() => foldToolRuns(events), [events]);

  // PR-9 row windowing: only the rows near the viewport (plus overscan) are in
  // the DOM; the rest are two spacer heights. Falls back to the full list while
  // the container is unmeasured, so a row is never missing because of this.
  const { scrollRef, visibleRows, padTop, padBottom, measureRow } = useRowWindow(rows, rowKey);

  const onSend = useCallback(
    (text: string) => {
      pushChatPending(ptyId, text);
    },
    [pushChatPending, ptyId],
  );

  const unavailableReason = status && !status.available ? status.reason : undefined;
  const unavailableText = unavailableReason
    ? unavailableReason === 'not-claude'
      ? t('chat.unavailable.notClaude')
      : unavailableReason === 'no-transcript-path'
        ? t('chat.unavailable.noTranscriptPath')
        : t('chat.unavailable.generic')
    : undefined;

  return (
    <div
      data-chat-view={surfaceId}
      className="min-h-0 overflow-hidden"
      // The host is `<div className="flex-1 relative overflow-hidden">` (Pane's
      // SplitSurfaceView) — a BLOCK box, not a flex column. `flex-1` on this
      // root therefore did nothing: the view sized to its content, the inner
      // `overflow-y-auto` never got shorter than its rows (so the wheel did
      // nothing) and the composer + trust seam were pushed past the host's clip.
      // Fill the pane box exactly, the same way TerminalComponent's root does.
      style={{
        display: visible ? 'flex' : 'none',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        position: 'relative',
      }}
    >
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-2 flex flex-col"
        // Row spacing comes from ROW_GAP, not a `gap-2.5` class: the windowing
        // spacers have to be computed from the same number.
        style={{ gap: ROW_GAP }}
        data-chat-scroll
      >
        {cursor && cursor.headOffset > 0 && (
          <button
            type="button"
            data-chat-load-earlier
            onClick={() => void loadEarlier()}
            className={`self-center text-[11px] font-mono text-[var(--text-muted)] hover:text-[var(--accent-blue)] transition-colors ${FOCUS_RING}`}
          >
            {t('chat.loadEarlier')}
          </button>
        )}

        {unavailableText && (
          <div className="text-[12px] text-[var(--text-muted)]" data-chat-unavailable={unavailableReason}>
            {unavailableText}
          </div>
        )}

        {!unavailableText && rows.length === 0 && (
          <div className="text-[12px] text-[var(--text-muted)]" data-chat-empty>
            {t('chat.empty')}
          </div>
        )}

        {padTop > 0 && <div data-chat-pad="top" style={{ height: padTop, flex: 'none' }} />}

        {visibleRows.map((row) => (
          <div key={row.id} ref={measureRow(row.id)} data-chat-row={row.id}>
            {row.kind === 'tool_run' ? (
              <ToolRunLine run={row} />
            ) : row.kind === 'diff' ? (
              <DiffChip event={row.event} onOpenDiff={onOpenDiff} />
            ) : (
              <ChatRow event={row.event} agentName={agentName} onFetchBody={onFetchBody} />
            )}
          </div>
        ))}

        {padBottom > 0 && <div data-chat-pad="bottom" style={{ height: padBottom, flex: 'none' }} />}

        {/* Optimistic echoes: the line the user just sent, before it round-trips
            through the transcript (PRD §4.3, second bullet). */}
        {pending?.map((echo) => (
          <ChatRow
            key={echo.id}
            event={{ id: echo.id, kind: 'user_text', text: echo.text }}
            pending
          />
        ))}
      </div>

      <ChatComposer
        ptyId={ptyId}
        needsInput={needsInput}
        pendingQuestion={pendingQuestion}
        agentStatus={agentStatus}
        isActive={isActive}
        onJumpToTerminal={onJumpToTerminal}
        onSend={onSend}
      />

      <TrustSeam
        transcriptBasename={status?.transcriptBasename}
        stale={stale}
        onJumpToTerminal={onJumpToTerminal}
      />
    </div>
  );
}

export default ChatView;
