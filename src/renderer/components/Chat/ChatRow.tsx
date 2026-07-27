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

export interface ChatRowProps {
  event: TurnEvent;
  /** Display name for the assistant side (pane label / agent name). */
  agentName?: string;
  /** Optimistic composer echo — rendered at reduced emphasis until it lands. */
  pending?: boolean;
  onFetchBody?: (eventId: string, n: number) => Promise<string>;
}

/**
 * Inline code marker emitted by the daemon projector in place of a fenced
 * block. Tolerates both delimiter forms the P1 spec used (NUL-wrapped and
 * backtick-wrapped) so a projector-side delimiter choice cannot silently leave
 * markers as visible garbage in the prose.
 */
const CODE_MARKER = /(?:\u0000|`)\s*code:(\d+)\s*(?:\u0000|`)/g;

type Segment = { text: string } | { blockN: number };

/** Split prose into text runs and code-block handles, in order. */
export function splitCodeMarkers(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  CODE_MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_MARKER.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ blockN: Number(m[1]) });
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

function UserRow({ event, pending }: { event: UserTextEvent; pending?: boolean }): React.ReactElement {
  const t = useT();
  return (
    <div className="flex flex-col gap-0.5" data-chat-row="user" data-chat-pending={pending ? '1' : undefined}>
      <SpeakerLabel self>{t('chat.you')}</SpeakerLabel>
      <div
        className={`text-[13px] leading-relaxed whitespace-pre-wrap break-words ${
          pending ? 'text-[var(--text-muted)]' : 'text-[var(--text-main)]'
        }`}
        data-chat-text
      >
        {event.text}
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
  onFetchBody,
}: {
  event: AssistantTextEvent;
  agentName?: string;
  onFetchBody?: (eventId: string, n: number) => Promise<string>;
}): React.ReactElement {
  const t = useT();
  const blocks = new Map<number, CodeBlockRef>((event.codeBlocks ?? []).map((b) => [b.n, b]));
  const segments = splitCodeMarkers(event.text);
  const referenced = new Set<number>();
  for (const s of segments) if ('blockN' in s) referenced.add(s.blockN);
  // Blocks the prose never referenced still exist in the transcript — append
  // them rather than losing evidence to a marker mismatch.
  const orphans = (event.codeBlocks ?? []).filter((b) => !referenced.has(b.n));

  return (
    <div className="flex flex-col gap-0.5" data-chat-row={event.thinking ? 'thinking' : 'assistant'}>
      <SpeakerLabel self={false}>{agentName || t('chat.agent')}</SpeakerLabel>
      <div
        className={
          event.thinking
            ? 'text-[11px] font-mono leading-relaxed text-[var(--text-muted)] whitespace-pre-wrap break-words'
            : 'text-[13px] leading-relaxed text-[var(--text-main)] whitespace-pre-wrap break-words'
        }
        data-chat-text
      >
        {segments.map((seg, i) => {
          if ('text' in seg) return <React.Fragment key={`t${i}`}>{seg.text}</React.Fragment>;
          const block = blocks.get(seg.blockN);
          if (!block) return null;
          return (
            <CodeChip
              key={`c${seg.blockN}`}
              eventId={event.id}
              block={block}
              onFetchBody={onFetchBody}
            />
          );
        })}
      </div>
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

export function ChatRow({ event, agentName, pending, onFetchBody }: ChatRowProps): React.ReactElement | null {
  if (event.kind === 'user_text') return <UserRow event={event} pending={pending} />;
  if (event.kind === 'assistant_text') {
    return <AssistantRow event={event} agentName={agentName} onFetchBody={onFetchBody} />;
  }
  if (event.kind === 'meta') return <MetaRow event={event} />;
  // tool_use / tool_result never reach here — foldToolRuns owns them.
  return null;
}

export default ChatRow;
