// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/features/sessions/ui/AgentTranscript.tsx), MIT License, Copyright (c) 2026 Nick
// The user bubble (full-round on one line, rounded-xl once it wraps), the
// "+N tool calls" collapse with a turning chevron, and the always-visible turn
// receipt under a finished turn. Styles live in ./chatMono.css.
import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import { MessagePrimitive, useAuiState } from '@assistant-ui/react';
import type { CodeBlockRef, ToolBody, TurnEvent } from '../../../shared/transcript/turnEvents';
import { renderBrainMarkdown } from '../Deck/BrainMarkdown';
import { formatChatTime } from '../Deck/deckBrain';
import { IconCheck, IconChevron, IconCopy } from '../icons';
import { useT } from '../../hooks/useT';
import type { ChatRow, TurnReceipt } from './chatMessages';
import { ChatSentImages } from './ChatAttachmentViews';
import { withoutImageTokens } from './chatAttachments';

export const ChatPtyContext = createContext('');

function Body({ eventId, body, label }: { eventId: string; body: ToolBody | CodeBlockRef; label: string }) {
  const t = useT();
  const ptyId = useContext(ChatPtyContext);
  const initial = 'inline' in body ? body.inline : undefined;
  const [text, setText] = useState(initial);
  const [loaded, setLoaded] = useState(initial !== undefined && (!body.truncated || body.srcOffset === undefined));
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const fetchBody = async () => {
    if (loaded || loading) return;
    setLoading(true); setFailed(false);
    try {
      if (body.srcOffset === undefined) throw new Error('missing handle');
      const result = await window.electronAPI.chat.codeBlock({ ptyId, eventId, srcOffset: body.srcOffset, n: body.n });
      if (!result) throw new Error('body unavailable');
      setText(result.body); setLoaded(true);
    } catch { setFailed(true); }
    finally { setLoading(false); }
  };
  return <details className="wmux-chat-detail" open={open} onToggle={(e) => {
    const next = e.currentTarget.open; setOpen(next); if (next) void fetchBody();
  }}>
    <summary>{label}</summary>
    {loading && <span role="status">{t('chat.loading')}</span>}
    {failed && <button type="button" className="ui-btn" onClick={() => void fetchBody()}>{t('chat.bodyRetry')}</button>}
    {text !== undefined && <pre>{text}</pre>}
    {body.truncated && <p className="wmux-chat-caption">{t('chat.truncated')}</p>}
  </details>;
}

function Prose({ event }: { event: Extract<TurnEvent, { kind: 'assistant_text' }> }) {
  const t = useT();
  const marker = String.fromCharCode(0);
  return <>{event.text.split(new RegExp(`(${marker}code:\\d+${marker})`, 'g')).map((part, i) => {
    const match = part.startsWith(`${marker}code:`) && part.endsWith(marker)
      ? /^code:(\d+)$/.exec(part.slice(1, -1)) : null;
    if (!match) return <div key={i}>{renderBrainMarkdown(part)}</div>;
    const block = event.codeBlocks?.find((b) => b.n === Number(match[1]));
    return block ? <Body key={`${event.id}:${block.n}`} eventId={event.id} body={block}
      label={`${block.lang || t('chat.code')} · ${block.lines} ${t('chat.lines')}${block.path ? ` · ${block.path}` : ''}`} /> : null;
  })}</>;
}

/** Elapsed time as `55s`, `4m 3s` or `1h 2m`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), sec = total % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}

/** The turn's reply prose with each code-block marker replaced by its fetched body. */
async function receiptText(ptyId: string, receipt: TurnReceipt): Promise<string> {
  const marker = String.fromCharCode(0);
  const parts = await Promise.all(receipt.replies.map(async (event) => {
    const pieces = await Promise.all(event.text.split(new RegExp(`(${marker}code:\\d+${marker})`, 'g')).map(async (part) => {
      const match = part.startsWith(`${marker}code:`) && part.endsWith(marker) ? /^code:(\d+)$/.exec(part.slice(1, -1)) : null;
      if (!match) return part;
      const block = event.codeBlocks?.find((b) => b.n === Number(match[1]));
      // A cut body would copy short with nothing saying so: refuse instead.
      if (block?.srcOffset === undefined || block.truncated) throw new Error('body incomplete');
      const result = await window.electronAPI.chat.codeBlock({ ptyId, eventId: event.id, srcOffset: block.srcOffset, n: block.n });
      if (!result) throw new Error('body unavailable');
      return `\n\`\`\`${block.lang ?? ''}\n${result.body}\n\`\`\`\n`;
    }));
    return pieces.join('').trim();
  }));
  return parts.filter(Boolean).join('\n\n');
}

/** Under a finished turn: check · duration · time · copy. Shows only what the transcript recorded. */
function Receipt({ receipt, label }: { receipt: TurnReceipt; label?: string }) {
  const t = useT();
  const ptyId = useContext(ChatPtyContext);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const { start, end } = receipt;
  const duration = start !== undefined && end !== undefined && end >= start ? formatDuration(end - start) : null;
  const copyTurn = async () => {
    try {
      await window.clipboardAPI.writeText(await receiptText(ptyId, receipt));
      setCopy('copied');
      setTimeout(() => setCopy('idle'), 1500);
    } catch { setCopy('failed'); }
  };
  const copyLabel = t(copy === 'copied' ? 'common.copied' : copy === 'failed' ? 'chat.controlFailed' : 'common.copy');
  return <div className="wmux-chat-receipt" data-chat-receipt>
    <span role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} className="inline-flex"><IconCheck size={14} /></span>
    {duration && <span data-chat-receipt-duration>{duration}</span>}
    {duration && end !== undefined && <span className="wmux-chat-receipt-dot" aria-hidden="true" />}
    {end !== undefined && <time className="wmux-chat-receipt-time" dateTime={new Date(end).toISOString()}>{formatChatTime(end)}</time>}
    {receipt.replies.length > 0 && <button type="button" className="wmux-chat-receipt-copy" onClick={() => void copyTurn()}
      aria-label={copyLabel} title={copyLabel}>
      {copy === 'copied' ? <IconCheck size={14} /> : <IconCopy size={14} />}
    </button>}
  </div>;
}

/** The user bubble is full-round while it fits one line, rounded-xl once it wraps. */
export function UserText({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [wrapped, setWrapped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setWrapped(el.clientHeight > 44);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} className="wmux-chat-user-text" data-wrapped={wrapped}>{children}</div>;
}

export function ChatMessage() {
  const row = useAuiState((s) => s.message.metadata.custom.row) as ChatRow | undefined;
  const role = useAuiState((s) => s.message.role);
  // assistant-ui may briefly expose its optimistic send before a transcript
  // event exists (including a send the daemon later refuses).
  const empty = useAuiState((s) => s.message.content.length === 0);
  if (!row && empty) return null;
  if (!row) return <MessagePrimitive.Root className={`wmux-chat-message ${role === 'user' ? 'wmux-chat-user' : 'wmux-chat-assistant'}`}>
    <div className={role === 'user' ? 'wmux-chat-user-text' : 'wmux-chat-prose'}><MessagePrimitive.Parts /></div>
  </MessagePrimitive.Root>;
  return <MessagePrimitive.Root><ChatRowContent row={row} /></MessagePrimitive.Root>;
}

function ChatRowContent({ row }: { row: ChatRow }) {
  const t = useT();
  if (row.activity) return <details className="wmux-chat-activity"><summary><IconChevron size={12} />{t('chat.activity')} · {row.activity.length}</summary>
    {row.activity.map((child) => <ChatRowContent key={child.event.id} row={child} />)}
  </details>;
  const { event, result } = row;
  // A recorded turn end reads as its receipt; the label names the check mark.
  if (event.kind === 'meta') return row.receipt ? <Receipt receipt={row.receipt} label={event.label} /> : <div className="wmux-chat-meta">{event.label}</div>;
  if (event.kind === 'tool_result' && event.files?.length) return <div className="wmux-chat-files">
    {event.files.map((file, index) => <details className="wmux-chat-file" key={`${file.path}:${index}`}>
      <summary><span>{file.path}</span><span className="wmux-chat-file-counts">
        {file.additions !== undefined && <span className="wmux-chat-added">+{file.additions}</span>}
        {file.deletions !== undefined && <span className="wmux-chat-deleted">−{file.deletions}</span>}
      </span><span>{t('chat.reviewChanges')}</span></summary>
      <pre>{file.patch}</pre>{file.truncated && <p>{t('chat.truncated')}</p>}
    </details>)}
  </div>;
  if (event.kind === 'tool_use' || event.kind === 'tool_result') {
    const output = event.kind === 'tool_result' ? event : result;
    return <div className="wmux-chat-tool">
      <div className="wmux-chat-tool-label"><span aria-hidden="true">{output ? (output.ok ? '✓' : '✕') : '·'}</span>
        <strong>{event.kind === 'tool_use' ? event.name : t('chat.toolResult')}</strong>
        <span>{output ? (output.ok ? t('chat.toolDone') : t('chat.toolError')) : t('chat.toolPending')}</span>
      </div>
      {event.kind === 'tool_use' && <p className="wmux-chat-tool-summary">{event.argSummary}</p>}
      {event.kind === 'tool_use' && event.input && <Body eventId={event.id} body={event.input} label={t('chat.toolInput')} />}
      {output?.output && <Body eventId={output.id} body={output.output} label={output.diffLike ? t('chat.diff') : t('chat.toolResult')} />}
    </div>;
  }
  const user = event.kind === 'user_text';
  const images = user ? [...(event.images ?? []), ...(row.images ?? [])] : [];
  return <div className={`wmux-chat-message ${user ? 'wmux-chat-user' : 'wmux-chat-assistant'}`}>
    {user ? <>{images.length ? <ChatSentImages images={images} /> : null}
      <UserText>{event.hasImage ? withoutImageTokens(event.text) : event.text}
        {event.hasImage && !images.length && <p>{t('chat.imageInTerminal')}</p>}</UserText></>
      : event.thinking ? <details className="wmux-chat-thinking"><summary>{t('chat.thinking')}</summary><Prose event={event} /></details>
      : <div className="wmux-chat-prose"><Prose event={event} />{event.truncated && <p>{t('chat.truncated')}</p>}</div>}
    {row.receipt && !user && <Receipt receipt={row.receipt} />}
  </div>;
}
