import { createContext, useContext, useState } from 'react';
import { MessagePrimitive, useAuiState } from '@assistant-ui/react';
import type { CodeBlockRef, ToolBody, TurnEvent } from '../../../shared/transcript/turnEvents';
import { renderBrainMarkdown } from '../Deck/BrainMarkdown';
import { useT } from '../../hooks/useT';
import type { ChatRow } from './chatMessages';

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

export function ChatMessage() {
  const row = useAuiState((s) => s.message.metadata.custom.row) as ChatRow | undefined;
  const role = useAuiState((s) => s.message.role);
  // assistant-ui may briefly expose its optimistic send before a transcript
  // event exists (including a send the daemon later refuses).
  if (!row) return <MessagePrimitive.Root className={`wmux-chat-message ${role === 'user' ? 'wmux-chat-user' : 'wmux-chat-assistant'}`}>
    <div className={role === 'user' ? 'wmux-chat-user-text' : 'wmux-chat-prose'}><MessagePrimitive.Parts /></div>
  </MessagePrimitive.Root>;
  return <MessagePrimitive.Root><ChatRowContent row={row} /></MessagePrimitive.Root>;
}

function ChatRowContent({ row }: { row: ChatRow }) {
  const t = useT();
  if (row.activity) return <details className="wmux-chat-activity"><summary>{t('chat.activity')} · {row.activity.length}</summary>
    {row.activity.map((child) => <ChatRowContent key={child.event.id} row={child} />)}
  </details>;
  const { event, result } = row;
  if (event.kind === 'meta') return <div className="wmux-chat-meta">{event.label}</div>;
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
  return <div className={`wmux-chat-message ${user ? 'wmux-chat-user' : 'wmux-chat-assistant'}`}>
    {user ? <div className="wmux-chat-user-text">{event.text}{event.hasImage && <p>{t('chat.imageInTerminal')}</p>}</div>
      : event.thinking ? <details className="wmux-chat-thinking"><summary>{t('chat.thinking')}</summary><Prose event={event} /></details>
      : <div className="wmux-chat-prose"><Prose event={event} />{event.truncated && <p>{t('chat.truncated')}</p>}</div>}
  </div>;
}
