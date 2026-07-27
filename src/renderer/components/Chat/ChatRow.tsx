// One conversation row (plan PR-7, PRD §4.2).
//
// DESIGN.md: hierarchy from typography, NOT decoration — "You" is muted 600,
// the agent label is main 700, and neither side gets a bubble or an area wash.
// Prose is sans; every machine artefact (meta lines, code chips, thinking) is
// mono.

import React from 'react';
import type {
  AssistantTextEvent,
  CodeBlockRef,
  MetaEvent,
  TurnEvent,
  UserTextEvent,
} from '../../../shared/transcript/turnEvents';
import { useT } from '../../hooks/useT';
import { CodeChip } from './CodeChip';
import { Prose } from './Prose';

export interface ChatRowProps {
  event: TurnEvent;
  /** Display name for the assistant side (pane label / agent name). */
  agentName?: string;
  /** Optimistic composer echo — rendered at reduced emphasis until it lands. */
  pending?: boolean;
  /**
   * False when the row continues the previous speaker's turn — consecutive
   * events from one speaker read as ONE turn under ONE label (a tool run
   * between two assistant texts does not restart it).
   */
  showSpeaker?: boolean;
  onFetchBody?: (eventId: string, n: number) => Promise<string>;
}

/**
 * Inline code marker emitted by the daemon projector in place of a fenced block.
 *
 * NUL-delimited ONLY. The backtick form used to be accepted as well, "so a
 * projector-side delimiter choice cannot leave markers as visible garbage" — but
 * backticks are ordinary prose an assistant writes constantly, so that fallback
 * let assistant-authored text drive this parser: `` `code:2` `` in a reply
 * either forged a chip pointing at some other block or, with no matching block,
 * DELETED that run of prose from the row. NUL cannot appear in prose (the
 * projector strips it from every text event before inserting its own markers),
 * which is the entire basis for treating a marker as trustworthy.
 */
const CODE_MARKER = /\u0000code:(\d+)\u0000/g;

type Segment = { text: string } | { blockN: number; literal: string };

/** Split prose into text runs and code-block handles, in order. */
export function splitCodeMarkers(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  CODE_MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_MARKER.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    // `literal` is what the row shows if the ref turns out to be unknown. A
    // marker whose block is missing must never make text disappear — a
    // truncated page or a rotated file is exactly when the user needs to see
    // that something was there.
    out.push({ blockN: Number(m[1]), literal: m[0].split('\u0000').join('') });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function SpeakerLabel({ children, self }: { children: React.ReactNode; self: boolean }): React.ReactElement {
  return (
    <span
      className={
        self
          ? 'text-[11px] font-semibold text-[var(--text-muted)]'
          : 'text-[11px] font-bold text-[var(--text-main)]'
      }
      data-chat-speaker={self ? 'you' : 'agent'}
    >
      {children}
    </span>
  );
}

/**
 * Raised card treatment for the operator's own turn (DESIGN.md "gpui-style
 * control surfacing"): faint surface fill + a text-main hairline + the top 1px
 * inset highlight, 7px card radius. Deliberately NOT a coloured bubble — the
 * "amber never fills areas" / no-wash rules are untouched, and every value is a
 * color-mix on a token so light themes (hinomaru/taegeuk) inherit it.
 */
const USER_CARD_STYLE: React.CSSProperties = {
  background: 'color-mix(in srgb, var(--bg-surface) 72%, transparent)',
  border: '1px solid color-mix(in srgb, var(--text-main) 10%, transparent)',
  boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--text-main) 6%, transparent)',
  borderRadius: 7,
};

function UserRow({
  event,
  pending,
  showSpeaker = true,
}: {
  event: UserTextEvent;
  pending?: boolean;
  showSpeaker?: boolean;
}): React.ReactElement {
  const t = useT();
  return (
    <div
      // Right-aligned and width-capped: chat convention for the human's own
      // messages (owner decision 2026-07-28). Agent turns stay left/full-width.
      //
      // The cap is 88%, not 78%: at 78% a long paste wrapped much earlier than
      // the agent's reply next to it and the human side read as a footnote.
      // Short lines still size to their content (`w-fit`), with a floor so a
      // one-word message is a card rather than a chip.
      className="flex flex-col gap-1 items-end ml-auto w-fit min-w-[6rem] max-w-[88%]"
      data-chat-row="user"
      data-chat-align="right"
      data-chat-pending={pending ? '1' : undefined}
    >
      {/* The label sits ABOVE the card, on the same baseline grammar as the
          agent's — inside the card's top-right it read as cramped chrome. */}
      {showSpeaker && <SpeakerLabel self>{t('chat.you')}</SpeakerLabel>}
      <div className="w-full px-3 py-2" style={USER_CARD_STYLE} data-chat-user-card>
        <Prose
          text={event.text}
          className={`text-[13px] leading-relaxed ${
            pending ? 'text-[var(--text-muted)]' : 'text-[var(--text-main)]'
          }`}
        />
      </div>
      {pending && (
        <span className="text-[11px] font-mono text-[var(--text-muted)]" role="status">
          {t('chat.sending')}
        </span>
      )}
    </div>
  );
}

function AssistantRow({
  event,
  agentName,
  showSpeaker = true,
  onFetchBody,
}: {
  event: AssistantTextEvent;
  agentName?: string;
  showSpeaker?: boolean;
  onFetchBody?: (eventId: string, n: number) => Promise<string>;
}): React.ReactElement {
  const t = useT();
  const blocks = new Map<number, CodeBlockRef>((event.codeBlocks ?? []).map((b) => [b.n, b]));
  const referenced = new Set<number>();
  for (const s of splitCodeMarkers(event.text)) if ('blockN' in s) referenced.add(s.blockN);
  // Blocks the prose never referenced still exist in the transcript — append
  // them rather than losing evidence to a marker mismatch.
  const orphans = (event.codeBlocks ?? []).filter((b) => !referenced.has(b.n));

  // Marker → chip. Returning null (unknown block) makes Prose fall back to the
  // literal marker text, so a truncated page never deletes a run of prose.
  const renderCodeRef = (n: number): React.ReactNode => {
    const block = blocks.get(n);
    if (!block) return null;
    return <CodeChip eventId={event.id} block={block} onFetchBody={onFetchBody} />;
  };

  return (
    <div
      // Full width by contract, minus a right gutter: without it the agent ran
      // edge-to-edge while the human's card stopped at 88%, and the two sides
      // read as two unrelated column treatments instead of one conversation.
      className="flex flex-col gap-1 pr-[10%]"
      data-chat-row={event.thinking ? 'thinking' : 'assistant'}
      data-chat-align="full"
    >
      {showSpeaker && <SpeakerLabel self={false}>{agentName || t('chat.agent')}</SpeakerLabel>}
      <Prose
        text={event.text}
        renderCodeRef={renderCodeRef}
        className={
          event.thinking
            ? 'text-[11px] font-mono leading-relaxed text-[var(--text-muted)]'
            : 'text-[13px] leading-relaxed text-[var(--text-main)]'
        }
      />
      {orphans.length > 0 && (
        <div className="flex flex-col items-start gap-0.5">
          {orphans.map((block) => (
            <CodeChip key={`o${block.n}`} eventId={event.id} block={block} onFetchBody={onFetchBody} />
          ))}
        </div>
      )}
    </div>
  );
}

function MetaRow({ event }: { event: MetaEvent }): React.ReactElement {
  return (
    <div
      className="flex items-baseline gap-1.5 text-[11px] font-mono text-[var(--text-muted)]"
      data-chat-row="meta"
      data-chat-meta-subtype={event.subtype}
    >
      <span aria-hidden="true">»</span>
      <span className="truncate">{event.label}</span>
    </div>
  );
}

export function ChatRow({
  event,
  agentName,
  pending,
  showSpeaker = true,
  onFetchBody,
}: ChatRowProps): React.ReactElement | null {
  if (event.kind === 'user_text') {
    return <UserRow event={event} pending={pending} showSpeaker={showSpeaker} />;
  }
  if (event.kind === 'assistant_text') {
    return (
      <AssistantRow
        event={event}
        agentName={agentName}
        showSpeaker={showSpeaker}
        onFetchBody={onFetchBody}
      />
    );
  }
  if (event.kind === 'meta') return <MetaRow event={event} />;
  // tool_use / tool_result never reach here — foldToolRuns owns them.
  return null;
}

export default ChatRow;
