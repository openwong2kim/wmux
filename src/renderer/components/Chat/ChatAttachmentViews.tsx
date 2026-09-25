import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { previewAttachment, type ChatAttachment } from './chatAttachments';
import { validChatImagePath } from '../../../shared/transcript/chatAttachments';

const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

/** Staged composer images: removable with × (or Backspace at the start of the input). */
export function ChatAttachmentChips({ items, onRemove }: { items: readonly ChatAttachment[]; onRemove: (path: string) => void }) {
  const t = useT();
  if (!items.length) return null;
  return <div className="wmux-chat-attachments" role="list" aria-label={t('chat.attachments')}>
    {items.map((item) => <span key={item.path} role="listitem" className="wmux-chat-attachment" title={item.path}>
      {item.thumbnail ? <img src={item.thumbnail} alt="" /> : <span className="wmux-chat-attachment-blank" aria-hidden="true" />}
      <span className="wmux-chat-attachment-name">{item.name}</span>
      <button type="button" aria-label={t('chat.attach.remove', { name: item.name })} title={t('chat.attach.remove', { name: item.name })}
        onClick={() => onRemove(item.path)}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </span>)}
  </div>;
}

function SentImage({ path, thumbnail }: { path: string; thumbnail?: string }) {
  const t = useT();
  const [src, setSrc] = useState(thumbnail ?? '');
  useEffect(() => {
    if (thumbnail) return;
    let live = true;
    void previewAttachment(path).then((preview) => { if (live && preview.ok) setSrc(preview.thumbnail); });
    return () => { live = false; };
  }, [path, thumbnail]);
  const name = baseName(path);
  return <button type="button" className="wmux-chat-image" title={t('chat.openImage', { name })} aria-label={t('chat.openImage', { name })}
    onClick={() => void window.electronAPI?.shell?.openPath?.(path)}>
    {src ? <img src={src} alt="" /> : <span className="wmux-chat-image-name">{name}</span>}
  </button>;
}

/** Images a sent (or queued) message carried; click opens the file. */
export function ChatSentImages({ images }: { images: readonly (string | ChatAttachment)[] }) {
  // A transcript path opens on click, so only image files are offered.
  const shown = images.filter((image) => validChatImagePath(typeof image === 'string' ? image : image.path));
  if (!shown.length) return null;
  return <div className="wmux-chat-images">
    {shown.map((image) => typeof image === 'string'
      ? <SentImage key={image} path={image} />
      : <SentImage key={image.path} path={image.path} thumbnail={image.thumbnail || undefined} />)}
  </div>;
}
